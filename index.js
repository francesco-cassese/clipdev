// index.js
//
// Punto di avvio di ClipDev da riga di comando. Prima di fare qualunque
// altra cosa, controlla che la chiave API di Anthropic sia disponibile,
// così un errore di configurazione viene segnalato subito e con un
// messaggio chiaro, invece di emergere a metà elaborazione. Dopo il
// controllo, legge i parametri passati da riga di comando e avvia la
// generazione della demo.
//
// La chiave API non viene gestita con librerie esterne: viene letta
// direttamente dal file .env grazie a una funzionalità nativa di Node
// (`--env-file`), che carica quel file nell'ambiente del processo prima
// che questo script parta. Per usarlo: copia .env.example in .env,
// inserisci la tua chiave (non va mai condivisa né inclusa nel codice
// versionato: .env è escluso di proposito), poi avvia con:
//   node --env-file=.env index.js "Nome Progetto" "Riassunto tecnico..." "http://localhost:3000"
// oppure, in modo equivalente:
//   pnpm start -- "Nome Progetto" "Riassunto tecnico..." "http://localhost:3000"

// Il controllo sulla chiave API (comprese le istruzioni su come impostarla)
// avviene in ai/models/anthropic.js, il primo file dell'intero programma ad
// averne davvero bisogno: viene eseguito automaticamente non appena questo
// import viene caricato, prima che qualunque altra riga di questo file
// venga eseguita.
import { runClipDevPipeline } from "./pipeline/clipDevPipeline.js";
import { CANVAS_FORMATS, CanvasFormatSchema, DEFAULT_CANVAS_FORMAT } from "./tools/browser/recordingConfig.js";

// Parametri letti da riga di comando, nell'ordine in cui vanno indicati.
// La lista di interazioni da mostrare nel video (click, digitazione, ecc.)
// non è configurabile da qui, perché richiede dettagli troppo tecnici
// (i punti esatti della pagina su cui agire) per essere scritta a mano in
// un comando da terminale: chi vuole controllarla manualmente deve usare
// ClipDev come libreria, non da riga di comando. Il quarto e quinto
// parametro sono invece facoltativi, perché hanno un default sensato.
const [projectName, projectSummary, url, canvasFormatArg, mobileRecordingArg] = process.argv.slice(2);

// L'elenco dei formati validi nei due messaggi sotto è derivato da
// CANVAS_FORMATS invece che ripetuto a mano, per non rischiare che i due
// finiscano per divergere quando in futuro si aggiunge un formato (vedi lo
// stesso principio in bin/clipdev.js).
const validCanvasFormats = Object.keys(CANVAS_FORMATS).map((format) => `"${format}"`).join(", ");

if (!projectName || !projectSummary || !url) {
  console.error(
    "Uso: node index.js <projectName> <projectSummary> <url> [canvasFormat] [mobileRecording]\n" +
      'Esempio: node index.js "ClipDev Demo" "App Node.js che genera outline e post LinkedIn da un progetto" "http://localhost:3000"\n' +
      `[canvasFormat] è facoltativo: uno tra ${validCanvasFormats}; se omesso, il default dipende da [mobileRecording] ` +
      `("vertical" se true, "${DEFAULT_CANVAS_FORMAT}" altrimenti).\n` +
      '[mobileRecording] è facoltativo: "true" registra con il viewport di un vero dispositivo mobile invece che a ' +
      "risoluzione desktop, per mostrare il vero layout responsive (default: false)."
  );
  process.exit(1);
}

// A differenza di canvasFormatArg, qui non viene applicato alcun default:
// se non indicato esplicitamente resta `undefined`, ed è runClipDevPipeline
// a scegliere il valore giusto in base a mobileRecording (vedi il commento
// nella sua firma, in pipeline/clipDevPipeline.js), invece di forzarlo qui a
// "widescreen" a prescindere.
let canvasFormat;
if (canvasFormatArg !== undefined) {
  const canvasFormatResult = CanvasFormatSchema.safeParse(canvasFormatArg);
  if (!canvasFormatResult.success) {
    console.error(`Il quarto parametro deve essere uno tra ${validCanvasFormats} (ricevuto: "${canvasFormatArg}")`);
    process.exit(1);
  }
  canvasFormat = canvasFormatResult.data;
}
const mobileRecording = mobileRecordingArg === "true";

try {
  // La generazione della demo gestisce già al suo interno gli errori di
  // ogni singolo passaggio (analisi del progetto, registrazione del video,
  // scrittura del post, salvataggio dei file): qui serve solo intercettare
  // un eventuale fallimento complessivo e segnalarlo con un codice di
  // uscita diverso da zero, utile se questo script viene lanciato in modo
  // automatico (ad esempio da un altro script o da un sistema di CI).
  const result = await runClipDevPipeline({ projectName, projectSummary, url, canvasFormat, mobileRecording });

  console.log("Pipeline completata con successo.\n");
  console.log(`Outline salvato in:                ${result.files.outlinePath}`);
  console.log(`Video salvato in:                  ${result.files.videoPath}`);
  console.log(`Post LinkedIn (variante A) in:      ${result.files.socialPostVariantAPath}`);
  console.log(`Post LinkedIn (variante B) in:      ${result.files.socialPostVariantBPath}\n`);
  console.log("--- Variante A: Ingegneristica/Storytelling ---\n");
  console.log(result.socialPostVariantA);
  console.log("\n--- Variante B: Product Showcase ---\n");
  console.log(result.socialPostVariantB);
} catch (error) {
  console.error(`Pipeline fallita: ${error.message}`);
  process.exit(1);
}
