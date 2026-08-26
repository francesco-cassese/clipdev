#!/usr/bin/env node
// bin/clipdev.js
//
// Comando globale `clipdev`. A differenza di index.js (che richiede nome
// progetto, descrizione e indirizzo del sito da riga di comando), questo
// script è pensato per essere installato una sola volta e poi lanciato
// semplicemente digitando `clipdev` da dentro la cartella di qualunque
// altro progetto: rileva da solo il nome e la descrizione del progetto
// leggendo i suoi file (package.json, README) e prova a indovinare
// l'indirizzo del server di sviluppo in base al framework usato. Nome,
// descrizione e indirizzo restano comunque sovrascrivibili con parametri
// espliciti, perché ogni rilevamento automatico può sbagliare.

import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { parseFlags, guessDevServerUrl } from "../tools/projectDetection.js";

// Carica la chiave API da un file nella cartella personale dell'utente
// (~/.clipdev.env), non dalla cartella dove è installato ClipDev. Questo è
// necessario perché, una volta installato globalmente, ClipDev viene
// copiato in una cartella separata che non include i file riservati (come
// .env). La cartella personale dell'utente resta invece sempre accessibile,
// esattamente come fanno altri strumenti da riga di comando per le proprie
// credenziali.
const globalEnvPath = path.join(os.homedir(), ".clipdev.env");
if (typeof process.loadEnvFile !== "function") {
  // process.loadEnvFile() (a differenza del flag --env-file usato da
  // index.js) richiede Node.js 20.12 o successivo: su una versione più
  // vecchia questa chiamata non esisterebbe nemmeno, producendo un errore
  // tecnico difficile da collegare alla vera causa. Meglio segnalarlo qui,
  // subito e in modo chiaro.
  console.error(
    `Questa funzionalità richiede Node.js 20.12 o successivo (rilevata: ${process.version}).\n` +
      "Aggiorna Node.js, oppure imposta ANTHROPIC_API_KEY come variabile d'ambiente permanente del sistema."
  );
  process.exit(1);
}
try {
  process.loadEnvFile(globalEnvPath);
} catch {
  // Il file potrebbe semplicemente non esistere: non è un errore bloccante,
  // perché la chiave potrebbe essere già disponibile in altro modo (una
  // variabile d'ambiente impostata permanentemente sul sistema). Il
  // controllo più sotto verificherà comunque che la chiave sia presente in
  // un modo o nell'altro, e segnalerà un errore chiaro se manca del tutto.
}

// La cartella da cui è stato lanciato il comando `clipdev`: quando viene
// eseguito da dentro un altro progetto, è la cartella di quel progetto —
// nessuna configurazione manuale richiesta.
const targetProjectDir = process.cwd();

const flags = parseFlags(process.argv.slice(2));

// --- Lettura "sicura" dei file del progetto target --------------------------
// Il progetto in cui viene lanciato `clipdev` potrebbe non avere un
// package.json valido o un file README: in quel caso queste funzioni
// restituiscono semplicemente "nessun dato" invece di interrompere
// l'esecuzione, così il programma può provare la fonte di informazioni
// successiva.
async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    return null;
  }
}

async function readTextSafe(filePath) {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

const packageJson = await readJsonSafe(path.join(targetProjectDir, "package.json"));

// --- Rilevamento automatico del nome del progetto ---------------------------
// Ordine di priorità: parametro esplicito (--name) prima di tutto, poi il
// nome indicato in package.json, infine il nome della cartella stessa
// (funziona sempre, anche per progetti senza package.json).
const projectName = flags.name ?? packageJson?.name ?? path.basename(targetProjectDir);

// --- Rilevamento automatico della descrizione tecnica -----------------------
// Ordine di priorità: parametro esplicito (--summary), poi il contenuto del
// README, infine la descrizione indicata in package.json. Il README è la
// fonte preferita perché normalmente descrive già le funzionalità e le
// tecnologie usate: è proprio il tipo di informazione utile per generare
// una demo pertinente.
const README_CANDIDATES = ["README.md", "Readme.md", "readme.md"];
const MAX_SUMMARY_LENGTH = 6000; // limite di lunghezza, per non appesantire l'elaborazione con README molto estesi

let projectSummary = flags.summary;
if (!projectSummary) {
  for (const candidate of README_CANDIDATES) {
    const content = await readTextSafe(path.join(targetProjectDir, candidate));
    if (content) {
      projectSummary = content.slice(0, MAX_SUMMARY_LENGTH);
      break;
    }
  }
}
if (!projectSummary) {
  projectSummary = packageJson?.description || undefined;
}

if (!projectSummary) {
  console.error(
    `Impossibile rilevare automaticamente una descrizione del progetto in ${targetProjectDir}\n` +
      `(nessun ${README_CANDIDATES.join("/")} né "description" in package.json).\n` +
      'Passala esplicitamente: clipdev --summary="descrizione tecnica del progetto"'
  );
  process.exit(1);
}

let url = flags.url;
let urlWasGuessed = false;
if (!url) {
  url = guessDevServerUrl(packageJson);
  urlWasGuessed = Boolean(url);
}

if (!url) {
  console.error(
    "Impossibile indovinare l'URL del dev server (nessun framework noto tra le dipendenze di package.json).\n" +
      'Specificalo esplicitamente: clipdev --url="http://localhost:PORTA"'
  );
  process.exit(1);
}

if (urlWasGuessed) {
  // Se la porta indovinata è sbagliata, meglio che l'utente lo scopra
  // subito qui piuttosto che dopo un'attesa e un errore di navigazione più
  // avanti nel processo.
  console.log(`URL non specificato: indovinato dalle dipendenze -> ${url} (sovrascrivi con --url se sbagliato)`);
}

// --- Verifica della chiave API prima di avviare il resto del programma -----
// Stessa ragione di index.js: caricare subito il resto del programma
// predisporrebbe già la connessione al servizio Anthropic, e un errore di
// chiave mancante emergerebbe come un messaggio tecnico generico invece che
// come l'avviso chiaro qui sotto. A questo punto la chiave, se presente,
// arriva o dal file personale caricato più sopra, o da una variabile
// d'ambiente impostata sul sistema. Se manca in entrambi i casi, il
// messaggio suggerisce la soluzione più rapida.
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "Errore: ANTHROPIC_API_KEY non trovata.\n" +
      `Crea il file ${globalEnvPath} con dentro:\n` +
      "  ANTHROPIC_API_KEY=sk-ant-...\n" +
      'In alternativa, impostala come variabile persistente: setx ANTHROPIC_API_KEY "sk-ant-..." (richiede un nuovo terminale).'
  );
  process.exit(1);
}

// --- Verifica che il server di sviluppo sia realmente raggiungibile --------
// Un URL sbagliato (indovinato male dalle dipendenze, oppure passato a mano
// ma non ancora avviato) altrimenti verrebbe scoperto solo molto più avanti
// nel processo, dentro Playwright, con un errore di timeout più difficile
// da collegare alla causa reale — dopo che gli agenti IA hanno già girato.
// Verificarlo qui, prima di caricare il resto della pipeline, rende
// l'errore immediato ed esplicito. Non interessa la risposta ottenuta (va
// bene anche un errore HTTP): significa comunque che qualcosa sta
// rispondendo su quell'indirizzo.
async function isDevServerReachable(targetUrl) {
  try {
    await fetch(targetUrl, { signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

if (!(await isDevServerReachable(url))) {
  console.error(
    `Impossibile raggiungere ${url}${urlWasGuessed ? " (porta indovinata dalle dipendenze/script del progetto)" : ""}.\n` +
      "Assicurati che il server di sviluppo del progetto sia già in esecuzione prima di lanciare clipdev" +
      (urlWasGuessed ? ', oppure specifica la porta corretta con --url="http://localhost:PORTA".' : ".")
  );
  process.exit(1);
}

// Il resto del programma viene caricato solo ora, dopo il controllo sulla
// chiave e sulla raggiungibilità del server. Il percorso di importazione è
// relativo alla posizione di questo file (dentro l'installazione di
// ClipDev), non alla cartella del progetto target: per questo funziona
// correttamente indipendentemente da dove viene lanciato il comando
// `clipdev`.
const { runClipDevPipeline } = await import("../pipeline/clipDevPipeline.js");

// `--headless=false` permette di vedere il browser durante la
// registrazione, utile per verificare cosa sta succedendo; di default resta
// invisibile ("headless").
const headless = flags.headless !== "false";

// `--duration=<ms>` sovrascrive la durata minima del video (di default 5
// secondi). Questo parametro è particolarmente rilevante da riga di
// comando, perché `clipdev` non permette di specificare manualmente le
// interazioni da mostrare nel video (vedi nota più sotto): senza
// interazioni esplicite, questa durata minima è di fatto la lunghezza
// dell'intero video.
let minDurationMs;
if (flags.duration) {
  minDurationMs = Number(flags.duration);
  // Se il valore fornito non è un numero valido, meglio segnalarlo subito
  // con un messaggio chiaro piuttosto che lasciarlo propagare fino a un
  // controllo interno più difficile da collegare all'origine del problema.
  if (!Number.isFinite(minDurationMs)) {
    console.error(`--duration deve essere un numero di millisecondi valido (ricevuto: "${flags.duration}")`);
    process.exit(1);
  }
}

try {
  console.log(`\nProgetto rilevato: "${projectName}"`);
  console.log(`Registro la demo da: ${url}\n`);

  // Le interazioni da mostrare nel video (click, digitazione nei campi,
  // ecc.) non sono configurabili da riga di comando, perché richiedono
  // dettagli troppo tecnici per essere scritti a mano in un comando da
  // terminale. Senza indicazioni esplicite, la generazione della demo
  // sceglie da sola le interazioni più sensate osservando la pagina reale
  // e la descrizione del progetto: il video prodotto da `clipdev` mostra
  // comunque interazioni vere, non solo la pagina ferma. Chi vuole
  // controllare le interazioni manualmente deve usare ClipDev come
  // libreria all'interno del proprio codice.
  const result = await runClipDevPipeline({ projectName, projectSummary, url, headless, minDurationMs });

  // I percorsi dei file restituiti sono relativi alla cartella del
  // progetto target: outline, video e post finiscono dentro il progetto
  // che si sta presentando, non dentro l'installazione di ClipDev.
  console.log("Pipeline completata con successo.\n");
  console.log(`Outline salvato in:       ${result.files.outlinePath}`);
  console.log(`Video salvato in:         ${result.files.videoPath}`);
  console.log(`Post LinkedIn salvato in: ${result.files.socialPostPath}\n`);
  console.log("--- Post LinkedIn generato ---\n");
  console.log(result.socialPost);
} catch (error) {
  console.error(`Pipeline fallita: ${error.message}`);
  process.exit(1);
}
