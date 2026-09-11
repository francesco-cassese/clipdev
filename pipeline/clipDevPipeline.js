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
import { planNextDirectorAction } from "../ai/agents/directorAgent.js";
import { invokeAgentWithRetry } from "../ai/agents/invokeWithRetry.js";
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

// Numero massimo di AZIONI totali proposte durante l'ESPLORAZIONE (vedi
// FASE 1.5 più sotto): il Director Agent viene interpellato una volta per
// ciascuna, ricevendo ogni volta lo stato REALE della pagina dopo l'azione
// precedente — mai un lotto di più azioni decise insieme (vedi il commento
// sopra DirectorPlanSchema in ai/agents/directorAgent.js per la
// motivazione, verificata contro le fonti ufficiali di più strumenti reali
// di automazione browser guidata da agenti). Con un video di 15-30
// secondi, più interazioni di così non lascerebbero comunque margine per
// mostrare qualcosa di nuovo nel video stesso: garantirebbero solo che
// l'agente inizi a vagare, scegliendo elementi sempre meno pertinenti. Il
// criterio principale di arresto resta comunque un altro, verificato
// sempre per primo: l'agente stesso restituisce null quando non ha più
// nulla da aggiungere.
const MAX_EXPLORATION_ACTIONS = 6;

// Insieme dei selettori già usati in questa registrazione (sequenza
// iniziale e turno di follow-up): un'azione proposta dal Director Agent su
// un selettore già presente qui viene scartata PRIMA di essere eseguita, a
// prescindere da cosa dica il prompt in proposito. Un blocco deterministico
// nel codice, non una richiesta all'agente di "non ripetersi": un modello
// veloce come quello usato qui (vedi directorModel in ai/models/anthropic.js)
// può comunque proporre di ricliccare lo stesso elemento già usato — qui
// quella scelta smette semplicemente di avere effetto.
export function dedupeActionsAgainstUsedSelectors(actions, usedSelectors) {
  const deduped = [];
  for (const action of actions) {
    if (action.selector) {
      if (usedSelectors.has(action.selector)) continue;
      usedSelectors.add(action.selector);
    }
    deduped.push(action);
  }
  return deduped;
}

// Tempo massimo concesso alle richieste dell'Analyst Agent. A differenza
// del Director Agent, questa richiesta non avviene durante la
// registrazione del video, quindi può permettersi un margine più ampio —
// ma resta comunque un limite esplicito: se il servizio linguistico smette
// di rispondere, il processo deve fallire con un errore chiaro in un tempo
// prevedibile, invece di restare in attesa indefinitamente.
const LLM_CALL_TIMEOUT_MS = 60_000;

// Tempo massimo concesso alla richiesta del Copywriter Agent: più ampio di
// quello usato per l'Analyst (vedi LLM_CALL_TIMEOUT_MS sopra), non per lo
// stesso identico motivo (nessuno dei due avviene durante la registrazione)
// ma perché il Copywriter, da solo, è documentato come il più soggetto al
// bug di LangChain.js assorbito da invokeAgentWithRetry (vedi
// ai/agents/invokeWithRetry.js): il tempo che il meccanismo di
// "riparazione" interno di LangChain.js spende PRIMA di arrivare a
// restituire quell'errore noto si somma al tempo della richiesta vera e
// propria, ed è quello che ha già fatto scattare un timeout di 60s
// osservato concretamente in un'esecuzione reale, senza che l'errore noto
// facesse in tempo a manifestarsi. Un margine più ampio riduce la
// probabilità che questo accada di nuovo, invece di limitarsi a confidare
// nel nuovo tentativo (vedi il commento aggiornato in invokeWithRetry.js).
const COPYWRITER_CALL_TIMEOUT_MS = 90_000;

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

// Traduce un istante espresso in secondi "grezzi" (relativi all'inizio
// della registrazione, prima di qualunque taglio) nell'istante
// corrispondente nella timeline FINALE, già ripulita dal tempo morto:
// sottrae la durata di ogni intervallo tagliato che precede quel punto. Se
// il punto cade dentro un intervallo tagliato, corrisponde esattamente al
// momento in cui inizia quel taglio nella timeline finale (l'istante
// stesso non esiste più nel video, per definizione). Richiede `cutRanges`
// ordinato per startSeconds crescente — garantito dal modo in cui viene
// costruito più sotto (il taglio iniziale del caricamento per primo, poi
// le attese accumulate in ordine cronologico durante la registrazione).
export function mapRawTimeToEditedTime(rawSeconds, cutRanges) {
  let removedBefore = 0;
  for (const range of cutRanges) {
    if (range.endSeconds <= rawSeconds) {
      removedBefore += range.endSeconds - range.startSeconds;
    } else if (range.startSeconds <= rawSeconds) {
      removedBefore += rawSeconds - range.startSeconds;
      break;
    } else {
      break;
    }
  }
  return Math.max(0, rawSeconds - removedBefore);
}

// Durata minima di una callout, per restare leggibile: anche se due tocchi
// della stessa sezione avvenissero a pochi istanti di distanza, la
// finestra non scende mai sotto questo valore.
const MIN_CALLOUT_DURATION_SECONDS = 1.5;
// Durata per la callout dell'ultima sezione toccata, che altrimenti non
// avrebbe un confine naturale (nessuna sezione successiva la delimita):
// resta visibile per un tempo ragionevole, non per tutto il resto del
// video.
const LAST_CALLOUT_DURATION_SECONDS = 8;

// Costruisce le callout testuali sincronizzate al momento REALE in cui
// ciascuna sezione dell'outline è stata effettivamente dimostrata,
// ricavato da actionTimings (vedi runClipDevActionBatch in
// tools/browser/recordDemoTool.js) — più preciso della sola stima fatta
// dall'Analyst Agent prima ancora che il Director Agent scegliesse le
// interazioni vere, perché quella stima non poteva sapere, ad esempio,
// quanti secondi avrebbe richiesto una navigazione iniziale non prevista.
// Le sezioni mai toccate da nessuna azione vengono semplicemente escluse,
// non mostrate con un tempismo indovinato: un video non deve promettere a
// schermo qualcosa che non mostra davvero.
export function buildCalloutsFromActionTimings(actionTimings, sections, cutRanges) {
  const tagged = actionTimings
    .filter((timing) => sections[timing.sectionNumber - 1]?.calloutText)
    .sort((a, b) => a.rawStartSeconds - b.rawStartSeconds);

  // Raggruppa i tocchi consecutivi che appartengono alla stessa sezione:
  // ognuno diventa una finestra continua, dal primo tocco di quella
  // sezione fino al primo tocco della sezione successiva diversa.
  const touches = [];
  for (const timing of tagged) {
    const last = touches[touches.length - 1];
    if (last && last.sectionNumber === timing.sectionNumber) continue;
    touches.push(timing);
  }

  return touches.map((touch, index) => {
    const section = sections[touch.sectionNumber - 1];
    const startSeconds = mapRawTimeToEditedTime(touch.rawStartSeconds, cutRanges);
    const nextTouch = touches[index + 1];
    const rawEndSeconds = nextTouch
      ? nextTouch.rawStartSeconds
      : touch.rawStartSeconds + LAST_CALLOUT_DURATION_SECONDS;
    const endSeconds = Math.max(
      startSeconds + MIN_CALLOUT_DURATION_SECONDS,
      mapRawTimeToEditedTime(rawEndSeconds, cutRanges)
    );
    return { text: section.calloutText, startSeconds, endSeconds };
  });
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
    invokeAgentWithRetry(
      analystAgent,
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
  console.log(`URL di partenza per la registrazione: ${inspectedSession.url}`);
  console.log(`Elementi interattivi rilevati sulla pagina: ${inspectedSession.elements.length}`);
  console.log(`Px sotto la piega: ${Math.round(inspectedSession.overflow.pxBelowFold)}`);

  // FASE 1.5 — ESPLORAZIONE: risolve l'INTERA sequenza di interazioni da
  // mostrare nel video PRIMA di avviare la registrazione vera, eseguendo
  // per davvero ogni turno sulla pagina di ispezione (inspectedSession.page,
  // vedi inspectClipDevPage in tools/browser/recordDemoTool.js) — non su
  // quella che verrà registrata, ancora da aprire. Se le interazioni sono
  // state indicate esplicitamente (uso come libreria), questa fase non
  // serve: quelle azioni vengono eseguite così come sono state fornite,
  // senza interpellare mai il Director Agent.
  //
  // Rispetto a uno schema precedente (un turno iniziale, poi fino a due
  // turni di "ripianificazione" durante la registrazione vera), risolvere
  // tutto qui, prima, ha due vantaggi concreti: il Director Agent non è mai
  // vincolato dal tempo che la registrazione consumerebbe nel frattempo (un
  // turno più lento del previsto non ruba più secondi al video), e un
  // eventuale fallimento a metà esplorazione non butta via nessun secondo
  // di girato, perché la registrazione non è ancora cominciata.
  let resolvedActions = actions;
  const usedDirector = resolvedActions.length === 0;
  // Selettori già usati in questa esplorazione (vedi
  // dedupeActionsAgainstUsedSelectors sopra): applicato solo alle scelte del
  // Director Agent, non alle azioni fornite esplicitamente da chi usa
  // ClipDev come libreria — un utente che scrive le proprie azioni a mano
  // può avere un motivo legittimo per ripetere un selettore.
  const usedSelectors = new Set();
  if (usedDirector) {
    try {
      let currentElements = inspectedSession.elements;
      let currentOverflow = inspectedSession.overflow;
      let accumulatedActions = [];
      const explorationCursorState = { x: 0, y: 0 };
      // Un'azione alla volta, non un lotto: il Director Agent vede lo
      // stato REALE della pagina — misurato di nuovo ogni volta, mai
      // presunto dal tipo di azione appena eseguita — prima di ciascuna
      // decisione (vedi planNextDirectorAction in ai/agents/directorAgent.js
      // per la motivazione completa). Il ciclo si ferma per uno di due
      // motivi indipendenti: (1) l'agente stesso restituisce null — il
      // criterio principale, verificato sempre per primo; (2) il numero
      // massimo di azioni consentito (MAX_EXPLORATION_ACTIONS), una rete di
      // sicurezza che in condizioni normali non dovrebbe mai scattare prima
      // del primo motivo.
      for (let step = 0; step < MAX_EXPLORATION_ACTIONS; step += 1) {
        const proposedAction = await planNextDirectorAction({
          outline,
          elements: currentElements,
          previousActions: accumulatedActions,
          overflow: currentOverflow,
        });
        if (!proposedAction) {
          console.log(`Esplorazione (passo ${step + 1}): nessuna azione ulteriore proposta, esplorazione conclusa.`);
          break;
        }
        // Stesso blocco deterministico anti-repeat usato in precedenza,
        // applicato qui a un'unica azione: un array di un solo elemento in
        // ingresso, o vuoto se il selettore è già stato usato. Se l'agente
        // ripropone un selettore già usato, la pagina è comunque rimasta
        // nello stesso stato che ha già portato a quella scelta: non ha
        // senso continuare a interpellarlo.
        const [dedupedAction] = dedupeActionsAgainstUsedSelectors([proposedAction], usedSelectors);
        if (!dedupedAction) {
          console.log(`Esplorazione (passo ${step + 1}): selettore già usato in precedenza, esplorazione conclusa.`);
          break;
        }
        console.log(`Esplorazione (passo ${step + 1}): ${JSON.stringify(dedupedAction)}`);
        // Eseguita per davvero sulla pagina di esplorazione: è questo che
        // rivela lo stato REALE successivo (es. lo slider dentro un
        // pannello filtro appena aperto), non una supposizione.
        await runClipDevActionBatch({
          page: inspectedSession.page,
          actions: [dedupedAction],
          cursorState: explorationCursorState,
        });
        accumulatedActions = [...accumulatedActions, dedupedAction];
        currentElements = await extractInteractiveElements(inspectedSession.page);
        currentOverflow = await getPageOverflowInfo(inspectedSession.page);
      }
      resolvedActions = accumulatedActions;
    } catch (error) {
      await abortClipDevRecording(inspectedSession);
      throw new Error(`Director Agent fallito: ${error.message}`);
    }
    console.log(`Piano finale risolto dall'esplorazione: ${resolvedActions.length} azioni totali`);
  }

  // La pagina di esplorazione ha già servito al suo unico scopo (scoprire e
  // risolvere la sequenza completa): le interazioni appena eseguite su di
  // essa non fanno parte del video, che verrà girato da capo su una pagina
  // fresca (vedi FASE 1.6 sotto) — necessaria comunque, perché Playwright
  // richiede un context dedicato con la registrazione video attiva fin
  // dall'apertura, non attivabile a metà su un context già aperto.
  try {
    await inspectedSession.context.close();
  } catch (closeError) {
    console.error(`Chiusura del contesto di esplorazione fallita (ignorata): ${closeError.message}`);
  }

  // FASE 1.6 — Avvio della registrazione vera e propria: a questo punto
  // l'INTERA sequenza di interazioni è già stata decisa e validata, quindi
  // la registrazione si limita a rieseguirla in modo deterministico, senza
  // alcuna chiamata al Director Agent nel mezzo.
  let recordingSession;
  try {
    recordingSession = await startClipDevRecording({ browser: inspectedSession.browser, url: inspectedSession.url });
  } catch (error) {
    throw new Error(`Apertura della registrazione video fallita: ${error.message}`);
  }

  const cursorState = { x: 0, y: 0 };
  let hadActions = false;
  let cutRanges = [];
  // Istanti reali in cui ciascuna azione con sectionNumber ha iniziato ad
  // eseguire (vedi runClipDevActionBatch), usati più sotto per
  // sincronizzare le callout testuali al momento effettivo in cui ciascuna
  // sezione dell'outline compare nel video.
  let actionTimings = [];
  try {
    const batch = await runClipDevActionBatch({
      page: recordingSession.page,
      actions: resolvedActions,
      cursorState,
      recordingStartedAt: recordingSession.recordingStartedAt,
    });
    hadActions = batch.ranAnyAction;
    cutRanges = batch.cutRanges;
    actionTimings = batch.actionTimings;
  } catch (error) {
    // Se la registrazione fallisce a metà (un tempo di attesa superato,
    // ...), la sessione e il browser vengono chiusi qui. Un eventuale
    // problema nella chiusura stessa viene solo registrato: non deve
    // sostituire l'errore originale, che è l'informazione realmente utile
    // per capire cosa sia andato storto. Un singolo passo con un selettore
    // non più valido, invece, non arriva mai fin qui: viene già gestito
    // internamente da runClipDevActionBatch (vedi
    // tools/browser/recordDemoTool.js), che lo salta senza interrompere il
    // resto della sequenza.
    try {
      await recordingSession.context.close();
    } catch (closeError) {
      console.error(`Chiusura del contesto fallita (ignorata): ${closeError.message}`);
    }
    await safeCloseBrowser(recordingSession.browser);
    throw new Error(`Registrazione video fallita: ${error.message}`);
  }

  // Le callout testuali da sovrimprimere in fase di montaggio (vedi
  // tools/browser/videoTranscode.js) vengono sincronizzate al momento REALE
  // in cui ciascuna sezione dell'outline è stata effettivamente dimostrata
  // (vedi buildCalloutsFromActionTimings sopra), non alla stima fatta
  // dall'Analyst Agent prima ancora che il Director Agent scegliesse le
  // interazioni vere: quella stima non poteva sapere, ad esempio, quanti
  // secondi avrebbe richiesto una navigazione iniziale non prevista. Il
  // taglio del tempo morto viene ricalcolato qui (stessa formula usata
  // internamente da finalizeClipDevRecording) solo per tradurre
  // correttamente questi tempi, non per essere passato di nuovo a valle.
  const trimStartSeconds = Math.max(
    0,
    (recordingSession.pageReadyAt - recordingSession.recordingStartedAt) / 1000
  );
  const allCutRangesForCallouts =
    trimStartSeconds > 0 ? [{ startSeconds: 0, endSeconds: trimStartSeconds }, ...cutRanges] : cutRanges;
  const realCallouts = buildCalloutsFromActionTimings(actionTimings, outline.sections, allCutRangesForCallouts);

  // Se nessuna azione era taggata con una sezione — tipicamente quando le
  // interazioni sono state fornite manualmente da chi usa ClipDev come
  // libreria, non scelte dal Director Agent — non esiste alcun tempismo
  // reale a cui agganciarsi: si ricade sulla stima originale dell'Analyst
  // Agent, comunque meglio di nessuna callout.
  const callouts =
    realCallouts.length > 0
      ? realCallouts
      : outline.sections
          .filter(
            (section) =>
              section.calloutText !== undefined &&
              section.calloutStartSeconds !== undefined &&
              section.calloutEndSeconds !== undefined
          )
          .map((section) => ({
            text: section.calloutText,
            startSeconds: section.calloutStartSeconds,
            endSeconds: section.calloutEndSeconds,
          }));

  const videoResult = await finalizeClipDevRecording({
    ...recordingSession,
    outputPath: `${projectSlug}/demo.mp4`,
    minDurationMs,
    hadActions,
    cutRanges,
    callouts,
    // Card di branding finale (vedi showBrandingCard in
    // tools/browser/recordDemoTool.js): solo il nome del progetto, niente
    // call-to-action — quella vive già nel testo del post/primo commento
    // scritto dal Copywriter Agent.
    brandingText: projectName,
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
    invokeAgentWithRetry(
      copywriterAgent,
      { messages: [{ role: "user", content: copywriterInput }] },
      { timeout: COPYWRITER_CALL_TIMEOUT_MS }
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

  // Grazie al formato di risposta imposto al Copywriter Agent (vedi
  // CopywriterOutputSchema in ai/agents/copywriterAgent.js), il risultato è
  // già una struttura dati validata con le due varianti richieste, non un
  // testo libero da cui doverle separare con un'analisi testuale fragile.
  const copywriterOutput = copywriterOutcome.value.structuredResponse;
  if (!copywriterOutput) {
    throw new Error("Copywriter Agent: nessuna risposta strutturata restituita.");
  }

  // FASE 3 — Questo è l'unico passaggio rimasto in sequenza: dipende
  // direttamente dal testo appena ottenuto dal Copywriter, quindi non può
  // iniziare prima che quel testo sia disponibile. Le due varianti vengono
  // salvate come due file distinti (invece che un solo file con entrambe
  // concatenate) così chi pubblica può aprire, confrontare e scegliere
  // quella più adatta al momento senza dover prima separare manualmente i
  // due testi.
  const [postSaveA, postSaveB] = await Promise.all([
    saveClipDevOutput({
      type: "social-post",
      projectSlug: `${projectSlug}-variante-a`,
      content: copywriterOutput.variantA.post,
    }),
    saveClipDevOutput({
      type: "social-post",
      projectSlug: `${projectSlug}-variante-b`,
      content: copywriterOutput.variantB.post,
    }),
  ]);
  if (!postSaveA.success) {
    throw new Error(`Salvataggio post (variante A) fallito: ${postSaveA.error}`);
  }
  if (!postSaveB.success) {
    throw new Error(`Salvataggio post (variante B) fallito: ${postSaveB.error}`);
  }

  // FASE 4 — Risultato finale restituito a chi ha avviato il processo:
  // include sia i dati intermedi (l'outline) sia il risultato finale (le
  // due varianti del post) sia i percorsi di tutti i file salvati (outline,
  // le due varianti del post, video), così non è necessario rileggere nulla
  // da disco per accedervi.
  return {
    projectSlug,
    outline,
    socialPostVariantA: copywriterOutput.variantA.post,
    socialPostVariantB: copywriterOutput.variantB.post,
    files: {
      outlinePath: outlineSave.path,
      socialPostVariantAPath: postSaveA.path,
      socialPostVariantBPath: postSaveB.path,
      videoPath: videoResult.videoPath,
    },
  };
}

export default runClipDevPipeline;
