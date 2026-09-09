// tools/browser/recordDemoTool.js
//
// Gestisce la registrazione della demo: apre il sito da mostrare, esegue
// una sequenza di interazioni (click, digitazione, scorrimento) e registra
// il tutto in un video Full HD pronto per accompagnare un post su
// LinkedIn. Le parti più specifiche sono divise in moduli dedicati,
// importati qui sotto: la simulazione di un'interazione umana (cursore
// visibile, movimento del mouse, scorrimento) in tools/browser/humanInteraction.js;
// la lettura degli elementi della pagina in tools/browser/pageInspection.js; la
// conversione del video nel formato finale in tools/browser/videoTranscode.js.

import * as z from "zod";
import { chromium } from "playwright";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { CanvasFormatSchema, DEFAULT_CANVAS_FORMAT, VIDEO_WIDTH, VIDEO_HEIGHT } from "./recordingConfig.js";
import {
  CURSOR_INIT_SCRIPT,
  moveMouseHumanLike,
  pickRealisticFillValue,
  randomDelay,
  scrollPageSmooth,
  SCROLL_AMOUNT_PX,
  waitForElementStable,
} from "./humanInteraction.js";
import {
  createNetworkIdleTracker,
  extractInteractiveElements,
  getPageOverflowInfo,
  locateActionTarget,
  waitForDomStability,
  waitForImagesToLoad,
} from "./pageInspection.js";
import { CalloutSchema, transcodeToMp4 } from "./videoTranscode.js";

// Breve pausa dopo l'ultima interazione eseguita, prima di terminare la
// registrazione: garantisce che il risultato di un'azione (ad esempio un
// contenuto appena comparso) resti visibile per un momento nel video,
// invece di sparire nello stesso istante in cui la registrazione si ferma.
const ACTION_SETTLE_MS = 1_500;

// Tempo massimo di attesa per il risultato di un'azione che avvia
// un'elaborazione sul sito mostrato (ad esempio un pulsante che genera un
// contenuto tramite un servizio esterno, che può richiedere più tempo di
// un semplice cambio di pagina). Questo limite resta comunque finito: se
// il sito non termina mai l'elaborazione (ad esempio per un aggiornamento
// continuo dei dati), la registrazione non resta bloccata all'infinito, ma
// prosegue comunque dopo questo tempo, mostrando lo stato raggiunto fino a
// quel momento.
const RESULT_WAIT_TIMEOUT_MS = 90_000;

// Cartella principale in cui vengono salvati i video, calcolata rispetto
// alla cartella da cui viene eseguito il programma. La sottocartella
// nascosta ospita i file video intermedi prima della conversione finale:
// sono file temporanei, tenuti separati dal risultato definitivo per
// evitare confusione su quale file sia quello da usare.
const RECORDINGS_DIR = path.resolve(process.cwd(), "recordings");
const RAW_VIDEO_DIR = path.join(RECORDINGS_DIR, ".raw");

// Indirizzi consentiti per la navigazione: solo siti in esecuzione sul
// computer locale (localhost). L'agente che sceglie le interazioni da
// registrare è pensato per lavorare esclusivamente su applicazioni in
// sviluppo locale; questo limite impedisce che un indirizzo diverso da
// quello previsto possa far aprire al programma un sito esterno non
// controllato.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Esportato (oltre che usato internamente) per poter essere verificato
// direttamente da test automatici mirati, senza dover aprire un browser
// reale solo per controllare le regole di validazione.
export const TargetUrlSchema = z
  .url("url deve essere un URL assoluto valido (es. http://localhost:3000)")
  .refine(
    (value) => {
      try {
        return LOCAL_HOSTNAMES.has(new URL(value).hostname);
      } catch {
        return false;
      }
    },
    { error: "Per sicurezza il Director Agent naviga solo verso host locali (localhost / 127.0.0.1)" }
  );

// Percorso del file video in uscita, relativo alla cartella dei video.
// Deve terminare con estensione .mp4 (l'unico formato prodotto da questo
// strumento) e non può contenere riferimenti a cartelle superiori, per
// impedire che il file venga scritto al di fuori della cartella prevista.
// Esportato per lo stesso motivo di TargetUrlSchema sopra.
export const OutputPathSchema = z
  .string()
  .min(1)
  .regex(/\.mp4$/i, "outputPath deve terminare con estensione .mp4")
  .refine((value) => !value.includes(".."), { error: "outputPath non può contenere '..' (path traversal)" });

// Descrizione di una singola interazione da eseguire sulla pagina prima di
// terminare la registrazione. Ogni tipo di interazione (click, digitazione
// in un campo, attesa di un elemento, pausa, scorrimento) richiede
// informazioni diverse: questa struttura garantisce che vengano fornite
// esattamente quelle necessarie per ciascun caso. È condivisa con l'agente
// che sceglie le interazioni (ai/agents/directorAgent.js), così la stessa
// struttura descrive sia l'interazione scelta dall'agente sia quella
// effettivamente eseguita.
export const ActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click"),
    selector: z.string().min(1),
  }),
  z.object({
    type: z.literal("fill"),
    selector: z.string().min(1),
    value: z.string(),
  }),
  z.object({
    type: z.literal("waitForSelector"),
    selector: z.string().min(1),
    // Il limite massimo è coerente con RESULT_WAIT_TIMEOUT_MS, così è
    // possibile attendere in modo affidabile un elemento che compare solo
    // dopo un'elaborazione lenta avviata da un'azione precedente.
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  }),
  z.object({
    type: z.literal("wait"),
    timeoutMs: z.number().int().positive().max(60_000),
  }),
  z.object({
    type: z.literal("scroll"),
    direction: z.enum(["down", "up"]),
    // Viene usata un'indicazione descrittiva ("poco", "abbastanza",
    // "molto") invece di un valore preciso in pixel, perché l'agente che
    // sceglie le interazioni non ha modo di sapere in anticipo quanti
    // pixel corrispondano a "un po' più in basso" per una pagina che non
    // ha ancora misurato: la conversione in pixel avviene in
    // tools/browser/humanInteraction.js.
    amount: z.enum(["small", "medium", "large"]).default("medium"),
  }),
]);

// Esegue una singola interazione sulla pagina, in base al suo tipo. Il
// click e la digitazione in un campo non avvengono in modo istantaneo:
// prima viene calcolato il punto esatto dell'elemento coinvolto, poi il
// cursore visibile vi si sposta con un movimento naturale (vedi
// moveMouseHumanLike in tools/browser/humanInteraction.js), e solo a quel punto
// avviene l'interazione vera e propria — così il video mostra chiaramente
// il mouse che si muove e agisce, non un'azione che compare dal nulla.
async function runAction(page, step, cursorState) {
  switch (step.type) {
    case "click": {
      // Prima di calcolare il punto esatto verso cui muovere il cursore,
      // si attende che l'elemento sia visibile e abbia smesso di
      // muoversi/ridimensionarsi (vedi waitForElementStable in
      // tools/browser/humanInteraction.js): senza questa attesa, un
      // elemento ancora in transizione (un menu che si sta aprendo, un
      // banner che si sposta durante il caricamento) rischierebbe di non
      // trovarsi più nel punto calcolato nel momento in cui il click
      // avviene davvero.
      await waitForElementStable(page, step.selector);
      const target = await locateActionTarget(page, step.selector);
      await moveMouseHumanLike(page, cursorState, target.x, target.y, target.width);
      await page.evaluate(() => window.__clipdevCursorClick?.());
      // Breve pausa prima di premere, poi pressione, un'ulteriore pausa e
      // rilascio: un click reale non avviene nell'istante esatto in cui il
      // mouse arriva a destinazione, né dura sempre lo stesso tempo.
      await page.waitForTimeout(randomDelay(60, 160));
      await page.mouse.down();
      await page.waitForTimeout(randomDelay(60, 140));
      await page.mouse.up();
      break;
    }
    case "fill": {
      await waitForElementStable(page, step.selector);
      const target = await locateActionTarget(page, step.selector);
      await moveMouseHumanLike(page, cursorState, target.x, target.y, target.width);
      await page.evaluate(() => window.__clipdevCursorClick?.());
      await page.waitForTimeout(randomDelay(60, 160));
      await page.mouse.down();
      await page.waitForTimeout(randomDelay(60, 140));
      await page.mouse.up();
      // Il campo viene svuotato (potrebbe già contenere del testo)
      // istantaneamente, prima di iniziare a digitare: non è necessario
      // mostrare la cancellazione di un valore precedente carattere per
      // carattere.
      await page.locator(step.selector).first().fill("");
      // Se il valore scelto dal Director Agent somiglia a un segnaposto
      // generico ("test", "asdf", ...), viene sostituito con uno
      // semanticamente coerente con l'elemento (vedi
      // pickRealisticFillValue in tools/browser/humanInteraction.js): un
      // video professionale non deve mostrare un campo compilato con un
      // valore palesemente finto. Il testo viene poi digitato un carattere
      // alla volta, con un breve ritardo realistico tra l'uno e l'altro,
      // così la digitazione risulta visibile e credibile nel video invece
      // che comparire tutta insieme.
      const fillValue = pickRealisticFillValue(step.selector, step.value);
      await page.locator(step.selector).first().pressSequentially(fillValue, { delay: 45 });
      break;
    }
    case "waitForSelector":
      // Utile quando un elemento della pagina compare solo dopo che
      // un'informazione richiesta al server è arrivata (ad esempio in
      // seguito a un click precedente).
      await page.waitForSelector(step.selector, { timeout: step.timeoutMs ?? 10_000 });
      break;
    case "wait":
      // Pausa semplice, da usare con parsimonia perché allunga il video di
      // un tempo fisso, ma a volte necessaria per lasciare respirare
      // un'animazione a schermo prima di procedere.
      await page.waitForTimeout(step.timeoutMs);
      break;
    case "scroll": {
      const deltaY = SCROLL_AMOUNT_PX[step.amount] * (step.direction === "up" ? -1 : 1);
      await scrollPageSmooth(page, deltaY);
      break;
    }
    default:
      // In condizioni normali questo caso non si verifica mai, perché il
      // tipo di ogni interazione è già stato controllato in precedenza.
      // Questo controllo esplicito serve solo come rete di sicurezza, per
      // segnalare subito ed esplicitamente un'eventuale incoerenza futura
      // nel codice, invece di lasciarla passare inosservata.
      throw new Error(`runAction: tipo di azione non gestito: "${step.type}"`);
  }
}

// Chiude il browser in modo sicuro: se la chiusura stessa dovesse fallire
// (ad esempio perché il browser si è già arrestato per conto proprio), il
// problema viene registrato ma non interrompe il resto del programma —
// altrimenti un errore secondario nella chiusura finirebbe per nascondere
// l'errore originale che aveva reso necessaria questa chiusura, rendendo
// più difficile capire cosa sia realmente andato storto. Usata anche da
// pipeline/clipDevPipeline.js, che ha lo stesso identico bisogno.
export async function safeCloseBrowser(browser) {
  if (!browser) return;
  try {
    await browser.close();
  } catch (error) {
    console.error(`Chiusura del browser fallita (ignorata): ${error.message}`);
  }
}

// --- Fase 0: analisi della pagina (senza ancora registrare) -----------------
//
// Apre il browser, visita l'indirizzo indicato e ne individua gli elementi
// con cui si può interagire, senza però avviare alcuna registrazione. Le
// informazioni raccolte qui servono all'agente che sceglie le interazioni
// (ai/agents/directorAgent.js) per decidere cosa mostrare nel video — una
// decisione che richiede un'elaborazione che può durare qualche secondo.
// Tenendo questa fase separata dalla registrazione vera e propria, quei
// secondi di attesa non finiscono per allungare il video con una pagina
// immobile in apertura.
//
// Il browser aperto in questa fase resta attivo e viene riutilizzato nella
// fase successiva, sia per evitare il costo di aprirne uno nuovo, sia
// perché la visita fatta qui "riscalda" il sito da registrare: molti
// strumenti di sviluppo impiegano diversi secondi a preparare la pagina la
// primissima volta che viene richiesta, un tempo che in questo modo non
// ricade sulla parte effettivamente registrata.
export async function inspectClipDevPage(rawInput) {
  const url = TargetUrlSchema.parse(rawInput.url);
  const headless = rawInput.headless ?? true;

  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext({ viewport: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT } });
    const page = await context.newPage();

    // Il tracciamento delle richieste di rete deve partire PRIMA della
    // navigazione: alcune pagine avviano le proprie richieste di dati
    // (es. un fetch verso un'API) nello stesso istante in cui iniziano a
    // caricarsi, e andrebbero perse se il tracciamento cominciasse solo
    // dopo page.goto().
    const networkTracker = createNetworkIdleTracker(page);
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });

    // Il completamento del caricamento non garantisce che i DATI della
    // pagina siano già arrivati: un'applicazione che li richiede con un
    // fetch al proprio avvio (ad esempio un catalogo prodotti) mostra
    // tipicamente un messaggio di caricamento fisso, senza alcuna modifica
    // del DOM, per tutta la durata dell'attesa — waitForDomStability da
    // sola scambierebbe questo per "pagina già pronta" (difetto osservato
    // concretamente: la scansione catturava solo la scritta "Caricamento
    // prodotti...", zero elementi interattivi). Attendere prima che le
    // richieste di rete si siano concluse intercetta anche questo caso;
    // solo dopo ha senso verificare la stabilità del DOM, per lasciare il
    // tempo al conseguente aggiornamento dell'interfaccia (es. il
    // re-render dopo l'arrivo dei dati) di completarsi a sua volta.
    await networkTracker.waitForIdle(500, RESULT_WAIT_TIMEOUT_MS);
    networkTracker.stop();
    await waitForDomStability(page, { timeoutMs: RESULT_WAIT_TIMEOUT_MS });

    // Elenco reale degli elementi con cui si può interagire sulla pagina:
    // è il materiale su cui l'agente baserà la scelta delle interazioni da
    // mostrare (vedi tools/browser/pageInspection.js).
    const elements = await extractInteractiveElements(page);
    // Allo stesso modo, viene misurato quanto contenuto della pagina non è
    // ancora visibile: senza questa informazione, la scelta di scorrere la
    // pagina non avrebbe alcun dato reale su cui basarsi.
    const overflow = await getPageOverflowInfo(page);

    // Solo la sessione di analisi viene chiusa qui: il browser resta
    // aperto e verrà riutilizzato per la registrazione vera e propria. Un
    // eventuale problema nella chiusura di questa sessione viene solo
    // registrato, senza far fallire un'analisi che è già andata a buon
    // fine.
    try {
      await context.close();
    } catch (closeError) {
      console.error(`Chiusura del contesto di ispezione fallita (ignorata): ${closeError.message}`);
    }

    return { browser, url, headless, elements, overflow };
  } catch (error) {
    await safeCloseBrowser(browser);
    throw error;
  }
}

// --- Fase 1: avvio della registrazione -------------------------------------
//
// Riceve il browser già aperto dalla fase precedente e prepara la sessione
// che verrà effettivamente registrata: da questo momento in poi, ogni
// istante conta ai fini del video finale. Questa fase è separata
// dall'esecuzione delle interazioni e dal completamento del video (vedi più
// sotto) perché chi coordina il processo deve poter esaminare la pagina e
// i suoi elementi prima di decidere cosa fare — decisione che ora avviene
// prima di questa fase, non più a registrazione già iniziata.
export async function startClipDevRecording({ browser, url }) {
  await mkdir(RAW_VIDEO_DIR, { recursive: true });

  try {
    // Viene creata una nuova sessione del browser con le dimensioni
    // corrette e la registrazione video attivata.
    const context = await browser.newContext({
      viewport: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
      recordVideo: {
        dir: RAW_VIDEO_DIR,
        size: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
      },
    });

    const page = await context.newPage();

    // Il cursore visibile viene inserito prima ancora di caricare la
    // pagina, così risulta già presente fin dal primo istante della
    // registrazione.
    await page.addInitScript({ content: CURSOR_INIT_SCRIPT });

    // Il riferimento al file video viene ottenuto subito dopo la
    // creazione della pagina, per evitare di dipendere dallo stato della
    // pagina in un momento successivo, quando la sessione verrà chiusa.
    const video = page.video();

    // Segna l'inizio della parte "utile" della registrazione, prima ancora
    // della navigazione: anche il tempo di caricamento della pagina fa
    // parte del video.
    const recordingStartedAt = Date.now();

    // Vedi il commento equivalente in inspectClipDevPage: il tracciamento
    // deve partire prima della navigazione, non dopo.
    const networkTracker = createNetworkIdleTracker(page);

    // Visita l'indirizzo da registrare. Grazie alla fase di analisi
    // precedente, il sito è già stato "riscaldato", quindi questo
    // caricamento risulta quasi immediato.
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });

    // Il completamento del caricamento della pagina non garantisce che
    // l'interfaccia sia già visivamente stabile, né che i suoi dati siano
    // già arrivati (vedi il commento in inspectClipDevPage): molti siti
    // continuano a richiedere dati o applicare stili subito dopo,
    // producendo un breve istante di schermo bianco o di caricamento nei
    // primi fotogrammi del video. Attendere qui che le richieste di rete
    // si concludano e che la pagina smetta di cambiare permette, più avanti
    // nel processo, di tagliare via questi primi istanti dal video finale,
    // invece di limitarsi ad aspettare più a lungo (cosa che allungherebbe
    // il video senza eliminare l'istante di caricamento già registrato).
    await networkTracker.waitForIdle(500, RESULT_WAIT_TIMEOUT_MS);
    networkTracker.stop();
    await waitForDomStability(page, { timeoutMs: RESULT_WAIT_TIMEOUT_MS });
    const pageReadyAt = Date.now();

    return { browser, context, page, video, recordingStartedAt, pageReadyAt };
  } catch (error) {
    // Se una qualunque di queste operazioni fallisce, il browser resta
    // comunque a carico di questa funzione: viene chiuso qui, perché non
    // ci sarà nessun passaggio successivo incaricato di farlo al posto
    // suo.
    await safeCloseBrowser(browser);
    throw error;
  }
}

// Chiude in modo sicuro una sessione di registrazione avviata ma non
// ancora portata a termine, senza produrre alcun video: da usare quando
// qualcosa fallisce dopo l'apertura della pagina ma prima che le
// interazioni vengano eseguite (ad esempio se l'agente che sceglie le
// interazioni non risponde). Senza questa chiusura esplicita, il processo
// del browser resterebbe attivo in memoria senza che nessun altro punto
// del programma se ne occupi.
export async function abortClipDevRecording(session) {
  if (session?.context) {
    try {
      await session.context.close();
    } catch (error) {
      console.error(`Chiusura del contesto fallita (ignorata): ${error.message}`);
    }
  }
  await safeCloseBrowser(session?.browser);
}

// --- Fase 2: esecuzione delle interazioni e completamento del video --------
//
// Riceve la sessione avviata nella fase precedente e la lista di
// interazioni da eseguire (scelte da chi coordina il processo, dall'agente
// dedicato, oppure nessuna) e la esegue sulla pagina già in registrazione,
// attendendo che eventuali richieste di rete si concludano prima di
// restituire il controllo. Questa funzione può essere richiamata più volte
// nella stessa registrazione: un primo gruppo di interazioni scelto
// osservando la pagina iniziale, poi — dopo aver visto il risultato reale
// di quelle interazioni — un secondo gruppo per mostrarlo al meglio,
// invece di dover terminare subito la registrazione dopo il primo gruppo.
// La posizione del cursore visibile viene mantenuta tra una chiamata e
// l'altra, così ogni nuovo movimento continua da dove si trovava
// precedentemente, senza salti innaturali nel video. `recordingStartedAt`
// (l'istante di inizio dell'intera registrazione, vedi
// startClipDevRecording) permette di esprimere l'intervallo di attesa
// restituito da questa funzione in secondi relativi al video finale,
// invece che in orario assoluto: è quel valore che verrà poi tagliato via
// dal montaggio finale (vedi finalizeClipDevRecording).
export async function runClipDevActionBatch({ page, actions = [], cursorState = { x: 0, y: 0 }, recordingStartedAt }) {
  const parsedActions = z.array(ActionSchema).max(20).parse(actions);

  if (parsedActions.length === 0) {
    return { cursorState, ranAnyAction: false, cutRanges: [] };
  }

  // Il conteggio delle richieste di rete in corso viene avviato prima
  // dell'esecuzione delle interazioni, non dopo: una richiesta può partire
  // nello stesso istante in cui l'ultima interazione si conclude, e deve
  // già essere osservata quando questo accade.
  const networkTracker = createNetworkIdleTracker(page);
  let cutRange = null;
  try {
    // Esegue in sequenza tutte le interazioni richieste, nell'ordine in
    // cui sono state fornite: è questa la sequenza che finisce ripresa nel
    // video.
    for (const step of parsedActions) {
      await runAction(page, step, cursorState);
    }

    // Molte interazioni (in particolare l'ultimo click di una sequenza)
    // avviano un'elaborazione il cui risultato compare solo dopo qualche
    // istante. Senza attendere qui, il video passerebbe alla fase
    // successiva subito dopo l'azione, mostrando il click ma mai il suo
    // risultato — il difetto più grave possibile per una demo, perché chi
    // guarda non vedrebbe mai cosa fa davvero il prodotto. Il tempo
    // massimo di attesa resta comunque limitato, per non bloccare
    // indefinitamente la registrazione su pagine che restano a lungo in
    // comunicazione con il server.
    //
    // Questo intervallo di attesa viene registrato (in secondi relativi
    // all'inizio del video) invece di essere nascosto dal vivo con un
    // elemento sovrapposto alla pagina: se il caricamento del risultato
    // produce uno stato intermedio poco curato (contenuti che compaiono uno
    // alla volta, indicatori di caricamento), quello stato viene tagliato
    // via per intero nel montaggio finale (vedi finalizeClipDevRecording),
    // non semplicemente coperto. È lo stesso principio usato dagli
    // strumenti professionali di registrazione demo ("taglio del tempo
    // morto"): un'esclusione decisa in fase di montaggio è sempre esatta,
    // mentre un velo sovrapposto in tempo reale deve indovinare un colore e
    // un tempismo che possono non corrispondere all'aspetto reale del sito.
    const waitStartedAt = Date.now();
    await networkTracker.waitForIdle(500, RESULT_WAIT_TIMEOUT_MS);
    // La sola assenza di richieste di rete in corso non garantisce che le
    // immagini già richieste abbiano finito di comparire (vedi il commento
    // di waitForImagesToLoad in tools/browser/pageInspection.js): questa
    // attesa aggiuntiva viene inclusa nello stesso intervallo tagliato via.
    await waitForImagesToLoad(page);
    const waitEndedAt = Date.now();
    if (recordingStartedAt) {
      cutRange = {
        startSeconds: (waitStartedAt - recordingStartedAt) / 1000,
        endSeconds: (waitEndedAt - recordingStartedAt) / 1000,
      };
    }
  } finally {
    networkTracker.stop();
  }

  return { cursorState, ranAnyAction: true, cutRanges: cutRange ? [cutRange] : [] };
}

// Completa una registrazione già avvenuta (interazioni comprese):
// attende una breve pausa finale, garantisce una durata minima del video,
// chiude la sessione e converte il file registrato nel formato definitivo.
// È separata dall'esecuzione delle interazioni perché quest'ultima può
// essere stata richiamata più volte prima di arrivare a questo punto:
// questa funzione ha solo bisogno di sapere se è stata eseguita almeno
// un'interazione in totale, per decidere se applicare la pausa finale.
export async function finalizeClipDevRecording({
  browser,
  context,
  page,
  video,
  recordingStartedAt,
  // Se non viene indicato il momento in cui la pagina è risultata pronta,
  // si usa l'inizio della registrazione: in quel caso il taglio dei primi
  // istanti del video (più sotto) semplicemente non avviene, invece di
  // generare un errore.
  pageReadyAt = recordingStartedAt,
  outputPath,
  minDurationMs = 5_000,
  hadActions = false,
  // Intervalli di "tempo morto" (in secondi relativi all'inizio del
  // video) accumulati durante l'esecuzione delle interazioni — vedi
  // runClipDevActionBatch — da rimuovere dal video insieme al taglio dei
  // primissimi istanti calcolato più sotto.
  cutRanges = [],
  // Callout testuali da sovrimprimere in fase di montaggio, lette
  // dall'outline (vedi tools/browser/videoTranscode.js).
  callouts = [],
  // "widescreen" (default) o "square": vedi CANVAS_FORMATS in
  // tools/browser/recordingConfig.js.
  canvasFormat = DEFAULT_CANVAS_FORMAT,
}) {
  try {
    // I parametri ricevuti dall'esterno vengono controllati anche qui,
    // per non dare per scontato che siano già stati verificati altrove.
    const parsedOutputPath = OutputPathSchema.parse(outputPath);
    const parsedMinDurationMs = z.number().int().positive().max(120_000).parse(minDurationMs);
    const parsedCallouts = z.array(CalloutSchema).parse(callouts);
    const parsedCanvasFormat = CanvasFormatSchema.parse(canvasFormat);

    // Il percorso del file viene ricalcolato all'interno della cartella
    // prevista e si verifica che il risultato resti effettivamente
    // contenuto in quella cartella: un controllo ulteriore, oltre a quello
    // già fatto sul testo del percorso, per maggiore sicurezza.
    const resolvedOutputPath = path.resolve(RECORDINGS_DIR, parsedOutputPath);
    if (!resolvedOutputPath.startsWith(RECORDINGS_DIR + path.sep)) {
      throw new Error(`outputPath deve risolversi dentro la cartella recordings/ (ricevuto: "${parsedOutputPath}")`);
    }
    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });

    let rawWebmPath;
    try {
      // Pausa fissa dopo l'ultima interazione, indipendente dalla durata
      // minima calcolata più sotto: senza questa pausa, il risultato di
      // un'interazione (un testo digitato, un contenuto appena comparso)
      // sarebbe visibile solo per una frazione di secondo prima della fine
      // del video. Viene applicata solo se sono state eseguite interazioni:
      // senza interazioni non c'è alcun nuovo risultato da mostrare.
      if (hadActions) {
        await page.waitForTimeout(ACTION_SETTLE_MS);
      }

      // Se, sommando caricamento, interazioni ed eventuale pausa finale,
      // non si è ancora raggiunta la durata minima prevista (il caso di
      // una pagina leggera e senza interazioni, che produrrebbe altrimenti
      // un video di circa un secondo), si attende il tempo restante prima
      // di terminare la registrazione. Se la durata minima è già stata
      // superata, questo passaggio non ha alcun effetto. Il calcolo parte
      // dal momento in cui la pagina è risultata pronta, non dall'inizio
      // della registrazione, perché il tempo di caricamento verrà comunque
      // tagliato dal video finale e non deve quindi contribuire al
      // raggiungimento della durata minima.
      const elapsedMs = Date.now() - pageReadyAt;
      const remainingMs = parsedMinDurationMs - elapsedMs;
      if (remainingMs > 0) {
        await page.waitForTimeout(remainingMs);
      }
    } finally {
      // Il file video viene reso definitivo e leggibile solo alla chiusura
      // della sessione: questa chiusura avviene in un blocco eseguito
      // comunque, così il video viene salvato (anche se parziale) pure in
      // caso di problemi nei passaggi precedenti.
      await context.close();
      rawWebmPath = await video.path();
    }

    // Il periodo tra l'avvio della registrazione e il momento in cui la
    // pagina è risultata visivamente stabile (il breve istante di
    // caricamento che altrimenti aprirebbe ogni video) è, in tutto e per
    // tutto, un altro intervallo di tempo morto da escludere: viene quindi
    // trattato come il primo di una lista che comprende anche le attese
    // già raccolte durante le interazioni, invece di essere gestito con un
    // meccanismo separato.
    const trimStartSeconds = Math.max(0, (pageReadyAt - recordingStartedAt) / 1000);
    const allCutRanges =
      trimStartSeconds > 0 ? [{ startSeconds: 0, endSeconds: trimStartSeconds }, ...cutRanges] : cutRanges;

    // Converte il file video nel formato finale, nel percorso richiesto,
    // rimuovendo per intero gli intervalli di tempo morto individuati e
    // applicando le callout/il formato canvas richiesti.
    await transcodeToMp4(rawWebmPath, resolvedOutputPath, {
      cutRanges: allCutRanges,
      callouts: parsedCallouts,
      canvasFormat: parsedCanvasFormat,
    });

    // Il file intermedio non serve più una volta ottenuto il file finale:
    // viene rimosso per non lasciare file temporanei accumulati.
    await rm(rawWebmPath, { force: true });

    return { success: true, videoPath: resolvedOutputPath };
  } catch (error) {
    // Qualunque problema, sia nella validazione dei parametri sia
    // nell'esecuzione della registrazione o della conversione, viene
    // gestito qui restituendo un risultato negativo con un messaggio
    // chiaro, invece di interrompere l'esecuzione di chi ha chiamato
    // questa funzione.
    return { success: false, error: error.message };
  } finally {
    // Il browser viene sempre chiuso, anche se si è verificato un
    // problema prima di arrivare alla chiusura prevista nel normale
    // svolgimento: senza questo passaggio, il processo del browser
    // resterebbe attivo in memoria senza che nulla se ne occupi.
    await safeCloseBrowser(browser);
  }
}
