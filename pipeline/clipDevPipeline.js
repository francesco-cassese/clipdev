// pipeline/clipDevPipeline.js
//
// Coordina l'intero processo di generazione di ClipDev: analisi del
// progetto, registrazione del video, scrittura del post e salvataggio dei
// risultati. Questo file non contiene la logica interna di ciascun
// passaggio (quella vive negli agenti e negli strumenti dedicati): si
// occupa solo di metterli in sequenza nell'ordine corretto, eseguendo in
// parallelo i passaggi che non dipendono l'uno dall'altro invece di
// attendere ciascuno per intero prima di iniziare il successivo.

import { analystAgent } from "../ai/agents/analystAgent.js";
import { copywriterAgent } from "../ai/agents/copywriterAgent.js";
import { planDirectorActions } from "../ai/agents/directorAgent.js";
import { saveClipDevOutput } from "../tools/saveOutputTool.js";
import {
  inspectClipDevPage,
  startClipDevRecording,
  runClipDevActionBatch,
  finalizeClipDevRecording,
  abortClipDevRecording,
  safeCloseBrowser,
} from "../tools/browser/recordDemoTool.js";
import { extractInteractiveElements, getPageOverflowInfo } from "../tools/browser/pageInspection.js";

// Durata massima indicativa del video, in linea con quanto indicato
// all'Analyst Agent. Serve come riferimento per decidere quando smettere
// di cercare ulteriori interazioni da aggiungere durante la
// ripianificazione (vedi più sotto): il vincolo reale non è "quanti turni
// di ripianificazione fare", ma quanto tempo resta disponibile nella
// finestra di durata prevista per il video. Per questo motivo il processo
// si ferma in base al tempo di registrazione già trascorso, non a un
// numero fisso di tentativi: si adatta da solo alla velocità reale di
// ciascun progetto, invece di richiedere una nuova taratura manuale ogni
// volta.
//
// Il criterio principale di arresto resta comunque un altro, descritto più
// sotto: l'agente stesso comunica di non avere altro da aggiungere.
const VIDEO_TARGET_MAX_MS = 30_000;
// Margine sottratto al limite sopra, per lasciare spazio alla breve pausa
// finale e al tempo necessario a completare il video, che si aggiungono
// dopo l'ultimo turno di ripianificazione: senza questo margine, un turno
// accettato proprio a ridosso del limite farebbe comunque superare la
// durata massima prevista.
const REPLAN_TIME_SAFETY_MARGIN_MS = 3_000;
const REPLAN_TIME_BUDGET_MS = VIDEO_TARGET_MAX_MS - REPLAN_TIME_SAFETY_MARGIN_MS;
// Numero massimo di turni di ripianificazione, usato solo come rete di
// sicurezza aggiuntiva rispetto ai criteri di arresto già descritti sopra:
// volutamente alto, così da non diventare mai il vincolo reale in condizioni
// normali. Se venisse mai raggiunto, sarebbe il segnale che qualcos'altro
// non sta funzionando come previsto, non un motivo per alzarlo ulteriormente.
const MAX_REPLAN_ROUNDS_SAFETY_NET = 8;

// Tempo massimo concesso alle richieste dell'Analyst Agent e del
// Copywriter Agent. A differenza del Director Agent, queste due richieste
// non avvengono durante la registrazione del video, quindi possono
// permettersi un margine più ampio — ma resta comunque un limite esplicito:
// se il servizio linguistico smette di rispondere, il processo deve
// fallire con un errore chiaro in un tempo prevedibile, invece di restare
// in attesa indefinitamente.
const LLM_CALL_TIMEOUT_MS = 60_000;

// Trasforma il nome del progetto in un identificatore adatto a essere
// usato nei nomi dei file di output (outline, post, video): tutto in
// minuscolo, senza spazi né caratteri speciali. Esportata (oltre che usata
// internamente) per poter essere verificata direttamente da test
// automatici mirati.
export function slugify(projectName) {
  return projectName
    .toLowerCase()
    // Rimuove gli accenti (ad esempio "città" diventa "citta").
    .normalize("NFD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    // Qualunque sequenza di caratteri non ammessi viene sostituita da un
    // singolo trattino.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Trasforma l'outline strutturato prodotto dall'Analyst Agent in un testo
// leggibile, nel formato che il Copywriter Agent si aspetta di ricevere.
// Questa conversione avviene qui, nel programma che coordina il processo,
// così ciascun agente resta responsabile solo del proprio compito, senza
// doversi accordare direttamente sul formato di scambio dei dati.
function formatOutlineForCopywriter(outline) {
  const sections = outline.sections
    .map((section, index) => {
      const duration = section.estimatedDurationSeconds
        ? ` (~${section.estimatedDurationSeconds}s)`
        : "";
      return `${index + 1}. ${section.title}${duration}\n   ${section.content}`;
    })
    .join("\n");

  const highlights = outline.technicalHighlights.map((point) => `- ${point}`).join("\n");

  return [
    `Obiettivo del progetto: ${outline.goal}`,
    `Stack tecnico: ${outline.techStack.join(", ")}`,
    `Sezioni della demo:\n${sections}`,
    `Punti tecnici rilevanti:\n${highlights}`,
  ].join("\n\n");
}

export async function runClipDevPipeline({
  projectName,
  projectSummary,
  url,
  actions = [],
  headless = true,
  minDurationMs,
}) {
  // I parametri ricevuti vengono controllati subito, prima di avviare
  // qualunque parte del processo: è preferibile segnalare un errore chiaro
  // fin da subito piuttosto che scoprire a metà lavorazione che manca
  // un'informazione necessaria.
  if (!projectName?.trim()) {
    throw new Error("runClipDevPipeline: 'projectName' è obbligatorio.");
  }
  if (!projectSummary?.trim()) {
    throw new Error("runClipDevPipeline: 'projectSummary' è obbligatorio.");
  }
  if (!url?.trim()) {
    throw new Error("runClipDevPipeline: 'url' è obbligatorio.");
  }

  const projectSlug = slugify(projectName);
  if (!projectSlug) {
    // Può succedere se il nome del progetto è composto solo da caratteri
    // che non possono essere usati in un nome file: meglio segnalarlo qui
    // che proseguire con un nome file vuoto o non valido.
    throw new Error(`runClipDevPipeline: impossibile derivare uno slug da projectName "${projectName}".`);
  }

  // FASE 1 — Le uniche due attività che non dipendono da alcun risultato
  // precedente sono l'analisi testuale del progetto e l'esame della
  // pagina da registrare: quest'ultima ha bisogno solo dell'indirizzo del
  // sito, già disponibile fin dall'inizio. Eseguendole in sequenza si
  // sommerebbero i tempi di entrambe (la richiesta al servizio
  // linguistico e la navigazione reale nel browser); eseguendole in
  // parallelo, questi tempi si sovrappongono, riducendo l'attesa
  // complessiva.
  //
  // È importante notare che la registrazione vera e propria non inizia
  // qui: questa fase apre il browser solo per osservare gli elementi reali
  // della pagina, senza avviare alcuna registrazione. Se la registrazione
  // fosse già attiva durante l'attesa delle richieste successive, il video
  // conterrebbe diversi secondi di pagina immobile prima che qualunque
  // interazione cominci. Tenendo questa fase separata, la parte
  // effettivamente registrata comincia solo quando le interazioni sono già
  // state decise.
  const [analystOutcome, inspectionOutcome] = await Promise.allSettled([
    analystAgent.invoke(
      { messages: [{ role: "user", content: projectSummary }] },
      { timeout: LLM_CALL_TIMEOUT_MS }
    ),
    inspectClipDevPage({ url, headless }),
  ]);

  // Se l'esame della pagina è andato a buon fine ma qualcos'altro più
  // avanti fallisce, il browser va chiuso esplicitamente qui: nessun altro
  // punto del programma se ne occuperebbe al posto nostro, e lasciarlo
  // aperto lascerebbe un processo del browser attivo senza motivo.
  const inspectedSession = inspectionOutcome.status === "fulfilled" ? inspectionOutcome.value : null;

  if (analystOutcome.status === "rejected") {
    if (inspectedSession) await abortClipDevRecording(inspectedSession);
    throw new Error(`Analyst Agent fallito: ${analystOutcome.reason.message}`);
  }

  // Grazie al formato di risposta imposto all'Analyst Agent, il risultato
  // è già una struttura dati validata (obiettivo, tecnologie, sezioni,
  // punti tecnici): non è necessario interpretare manualmente un testo
  // libero.
  const outline = analystOutcome.value.structuredResponse;
  if (!outline) {
    if (inspectedSession) await abortClipDevRecording(inspectedSession);
    throw new Error("Analyst Agent: nessuna risposta strutturata restituita.");
  }

  if (inspectionOutcome.status === "rejected") {
    throw new Error(`Ispezione della pagina fallita: ${inspectionOutcome.reason.message}`);
  }

  // Queste informazioni vengono registrate nel log per rendere visibile
  // cosa è stato effettivamente trovato sulla pagina: senza, un video
  // privo di interazioni risulterebbe indistinguibile da un'esecuzione
  // riuscita in ogni aspetto. Se qui il conteggio è zero, la causa è
  // immediatamente chiara (nessun elemento interattivo individuato sulla
  // pagina) senza dover indagare oltre.
  console.log(`Elementi interattivi rilevati sulla pagina: ${inspectedSession.elements.length}`);
  console.log(`Px sotto la piega: ${Math.round(inspectedSession.overflow.pxBelowFold)}`);

  // FASE 1.5 — Scelta delle interazioni da mostrare nel video. Se sono
  // già state indicate esplicitamente (ad esempio da uno script scritto a
  // mano per una demo già collaudata), quelle hanno sempre la precedenza;
  // il Director Agent viene interpellato solo quando non è stata fornita
  // alcuna indicazione esplicita — il caso tipico di quando ClipDev viene
  // usato da riga di comando. Il Director Agent sceglie le interazioni
  // solo tra gli elementi realmente presenti sulla pagina, guidato
  // dall'outline prodotto dall'Analyst Agent. Questa richiesta avviene
  // ancora prima di avviare la registrazione: il browser resta aperto ma
  // inattivo, senza costo aggiuntivo, mentre si attende la risposta.
  //
  // Il fatto che questa prima scelta sia stata decisa dall'agente (invece
  // che fornita esplicitamente) determina anche se, più avanti, ha senso
  // provare a integrarla con ulteriori interazioni (vedi FASE 1.7): chi ha
  // scritto le proprie interazioni a mano si aspetta che vengano eseguite
  // esattamente quelle, senza aggiunte impreviste.
  let resolvedActions = actions;
  const usedDirector = resolvedActions.length === 0;
  if (usedDirector) {
    try {
      resolvedActions = await planDirectorActions({
        outline,
        elements: inspectedSession.elements,
        overflow: inspectedSession.overflow,
      });
    } catch (error) {
      await abortClipDevRecording(inspectedSession);
      throw new Error(`Director Agent fallito: ${error.message}`);
    }
    // Se il conteggio qui è zero pur essendoci elementi disponibili
    // (vedi il log sopra), significa che il Director Agent ha scelto
    // deliberatamente di non proporre interazioni, oppure che le sue
    // scelte sono state escluse dal controllo di sicurezza: non è un
    // errore, ma il motivo per cui il video finale non conterrà
    // interazioni. Il dettaglio del piano viene registrato qui perché
    // questo è l'unico momento in cui è ancora disponibile come
    // informazione strutturata, prima di essere messo in pratica.
    console.log(`Director Agent: ${resolvedActions.length} azioni pianificate`);
    resolvedActions.forEach((action, index) => {
      console.log(`  ${index + 1}. ${JSON.stringify(action)}`);
    });
  }

  // FASE 1.6 — Avvio della registrazione vera e propria: a questo punto
  // la prima serie di interazioni è già stata decisa, quindi la
  // registrazione comincia già "pronta ad agire", senza ulteriori attese
  // nel mezzo.
  let recordingSession;
  try {
    recordingSession = await startClipDevRecording({ browser: inspectedSession.browser, url });
  } catch (error) {
    throw new Error(`Apertura della registrazione video fallita: ${error.message}`);
  }

  const cursorState = { x: 0, y: 0 };
  let hadActions = false;
  try {
    const firstBatch = await runClipDevActionBatch({
      page: recordingSession.page,
      actions: resolvedActions,
      cursorState,
    });
    hadActions = firstBatch.ranAnyAction;

    // FASE 1.7 — Ripianificazione: avviene solo se questa prima serie di
    // interazioni è stata decisa dal Director Agent (non fornita
    // esplicitamente) e ha effettivamente prodotto un cambiamento sulla
    // pagina (altrimenti non c'è nulla di nuovo da osservare). La pagina
    // viene esaminata di nuovo così com'è adesso — dopo le interazioni
    // appena eseguite — e all'agente viene data la possibilità di
    // scegliere un'interazione aggiuntiva basata su questo nuovo stato
    // reale (ad esempio, aprire un link di conferma comparso solo ora).
    // Questo è ciò che permette di mostrare il risultato di un'azione che
    // richiede tempo per completarsi, senza dover indovinare in anticipo
    // un riferimento a un elemento che, al momento dell'esame iniziale,
    // non esisteva ancora.
    //
    // Questo passaggio viene ripetuto in un ciclo, non con una singola
    // richiesta: un elemento comparso solo dopo un turno di
    // ripianificazione (ad esempio un collegamento che appare solo dopo
    // aver aperto una scheda cliccata nel turno precedente) resterebbe
    // altrimenti invisibile per sempre, perché nessun turno successivo
    // tornerebbe a esaminare di nuovo la pagina. Il ciclo si ferma per uno
    // di tre motivi indipendenti: (1) l'agente stesso non trova più nulla
    // di utile da aggiungere — il criterio principale, verificato sempre
    // per primo; (2) il tempo a disposizione nella finestra di durata
    // prevista per il video è esaurito, un limite che si adatta da solo
    // alla velocità reale di ciascun progetto; (3) il numero massimo di
    // turni consentiti, una rete di sicurezza che in condizioni normali
    // non dovrebbe mai scattare prima degli altri due motivi.
    if (usedDirector && hadActions) {
      let actionsSoFar = resolvedActions;
      for (let round = 1; round <= MAX_REPLAN_ROUNDS_SAFETY_NET; round += 1) {
        const elapsedMs = Date.now() - recordingSession.pageReadyAt;
        if (elapsedMs >= REPLAN_TIME_BUDGET_MS) {
          console.log(
            `Ripianificazione fermata al turno ${round}: budget di tempo esaurito (${Math.round(elapsedMs)}ms >= ${REPLAN_TIME_BUDGET_MS}ms).`
          );
          break;
        }
        try {
          const currentElements = await extractInteractiveElements(recordingSession.page);
          const currentOverflow = await getPageOverflowInfo(recordingSession.page);
          console.log(`Ripianificazione (turno ${round}) — elementi interattivi rilevati ora sulla pagina: ${currentElements.length}`);
          currentElements.forEach((el, index) => {
            console.log(`  ${index + 1}. ${el.selector} | tag: ${el.tag} | label: "${el.label}"`);
          });
          console.log(`Ripianificazione (turno ${round}) — px sotto la piega: ${Math.round(currentOverflow.pxBelowFold)}`);
          const followUpActions = await planDirectorActions({
            outline,
            elements: currentElements,
            previousActions: actionsSoFar,
            overflow: currentOverflow,
          });
          console.log(`Ripianificazione (turno ${round}) — azioni aggiuntive pianificate: ${followUpActions.length}`);
          if (followUpActions.length === 0) {
            // Se questo turno non ha trovato nulla, un turno successivo
            // vedrebbe la pagina esattamente nello stesso stato: non ha
            // senso proseguire.
            break;
          }
          await runClipDevActionBatch({
            page: recordingSession.page,
            actions: followUpActions,
            cursorState,
          });
          actionsSoFar = [...actionsSoFar, ...followUpActions];
        } catch (error) {
          // Un eventuale problema in questo turno (ad esempio un
          // riferimento a un elemento non più valido) non deve far
          // fallire l'intera registrazione: il video resta comunque
          // valido con le interazioni già eseguite fino a questo punto,
          // un risultato accettabile — la ripianificazione è un
          // miglioramento opportunistico, non un requisito per ottenere
          // un video valido. Il ciclo viene comunque interrotto, perché
          // non avrebbe senso tentare un turno successivo dopo un
          // fallimento, ma il problema viene comunque registrato nel log.
          console.log(`Ripianificazione (turno ${round}) fallita (non bloccante): ${error.message}`);
          break;
        }
      }
    }
  } catch (error) {
    // Se la prima serie di interazioni fallisce a metà (un elemento non
    // trovato, un tempo di attesa superato, ...), la sessione e il
    // browser vengono chiusi qui. Un eventuale problema nella chiusura
    // stessa viene solo registrato: non deve sostituire l'errore
    // originale, che è l'informazione realmente utile per capire cosa sia
    // andato storto.
    try {
      await recordingSession.context.close();
    } catch (closeError) {
      console.error(`Chiusura del contesto fallita (ignorata): ${closeError.message}`);
    }
    await safeCloseBrowser(recordingSession.browser);
    throw new Error(`Registrazione video fallita: ${error.message}`);
  }

  const videoResult = await finalizeClipDevRecording({
    ...recordingSession,
    outputPath: `${projectSlug}/demo.mp4`,
    minDurationMs,
    hadActions,
  });
  if (!videoResult.success) {
    throw new Error(`Registrazione video fallita: ${videoResult.error}`);
  }

  // FASE 2 — Ora che l'outline è disponibile, altre due attività
  // diventano indipendenti tra loro (anche se entrambe dipendono
  // dall'outline appena ottenuto): salvarlo su disco e trasformarlo nel
  // testo del post per LinkedIn. Nessuna delle due richiede il risultato
  // dell'altra, quindi vengono eseguite in parallelo anziché una dopo
  // l'altra.
  const copywriterInput = formatOutlineForCopywriter(outline);

  const [outlineSaveOutcome, copywriterOutcome] = await Promise.allSettled([
    saveClipDevOutput({ type: "outline", projectSlug, outline }),
    copywriterAgent.invoke(
      { messages: [{ role: "user", content: copywriterInput }] },
      { timeout: LLM_CALL_TIMEOUT_MS }
    ),
  ]);

  if (outlineSaveOutcome.status === "rejected") {
    throw new Error(`Salvataggio outline fallito: ${outlineSaveOutcome.reason.message}`);
  }
  if (!outlineSaveOutcome.value.success) {
    throw new Error(`Salvataggio outline fallito: ${outlineSaveOutcome.value.error}`);
  }
  const outlineSave = outlineSaveOutcome.value;

  if (copywriterOutcome.status === "rejected") {
    throw new Error(`Copywriter Agent fallito: ${copywriterOutcome.reason.message}`);
  }

  // Il Copywriter produce testo libero, non dati strutturati: il testo
  // finale viene quindi estratto dall'ultimo messaggio della risposta.
  const lastMessage = copywriterOutcome.value.messages.at(-1);
  const socialPost = lastMessage?.text?.trim();
  if (!socialPost) {
    throw new Error("Copywriter Agent: nessun post generato.");
  }

  // FASE 3 — Questo è l'unico passaggio rimasto in sequenza: dipende
  // direttamente dal testo appena ottenuto dal Copywriter, quindi non può
  // iniziare prima che quel testo sia disponibile.
  const postSave = await saveClipDevOutput({
    type: "social-post",
    projectSlug,
    content: socialPost,
  });
  if (!postSave.success) {
    throw new Error(`Salvataggio post fallito: ${postSave.error}`);
  }

  // FASE 4 — Risultato finale restituito a chi ha avviato il processo:
  // include sia i dati intermedi (l'outline) sia il risultato finale (il
  // post) sia i percorsi di tutti e tre i file salvati (outline, post,
  // video), così non è necessario rileggere nulla da disco per accedervi.
  return {
    projectSlug,
    outline,
    socialPost,
    files: {
      outlinePath: outlineSave.path,
      socialPostPath: postSave.path,
      videoPath: videoResult.videoPath,
    },
  };
}

export default runClipDevPipeline;
