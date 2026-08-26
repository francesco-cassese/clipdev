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

// Parametri letti da riga di comando, nell'ordine in cui vanno indicati.
// La lista di interazioni da mostrare nel video (click, digitazione, ecc.)
// non è configurabile da qui, perché richiede dettagli troppo tecnici
// (i punti esatti della pagina su cui agire) per essere scritta a mano in
// un comando da terminale: chi vuole controllarla manualmente deve usare
// ClipDev come libreria, non da riga di comando.
const [projectName, projectSummary, url] = process.argv.slice(2);

if (!projectName || !projectSummary || !url) {
  console.error(
    "Uso: node index.js <projectName> <projectSummary> <url>\n" +
      'Esempio: node index.js "ClipDev Demo" "App Node.js che genera outline e post LinkedIn da un progetto" "http://localhost:3000"'
  );
  process.exit(1);
}

try {
  // La generazione della demo gestisce già al suo interno gli errori di
  // ogni singolo passaggio (analisi del progetto, registrazione del video,
  // scrittura del post, salvataggio dei file): qui serve solo intercettare
  // un eventuale fallimento complessivo e segnalarlo con un codice di
  // uscita diverso da zero, utile se questo script viene lanciato in modo
  // automatico (ad esempio da un altro script o da un sistema di CI).
  const result = await runClipDevPipeline({ projectName, projectSummary, url });

  console.log("Pipeline completata con successo.\n");
  console.log(`Outline salvato in:   ${result.files.outlinePath}`);
  console.log(`Video salvato in:     ${result.files.videoPath}`);
  console.log(`Post LinkedIn salvato in: ${result.files.socialPostPath}\n`);
  console.log("--- Post LinkedIn generato ---\n");
  console.log(result.socialPost);
} catch (error) {
  console.error(`Pipeline fallita: ${error.message}`);
  process.exit(1);
}
