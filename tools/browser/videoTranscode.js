// tools/browser/videoTranscode.js
//
// Conversione del video registrato dal formato WebM al formato MP4,
// tramite lo strumento esterno ffmpeg. Isolato dal resto della logica di
// registrazione perché riguarda un processo esterno indipendente da tutto
// il resto.
//
// Perché serve questa conversione: lo strumento usato per registrare il
// video produce nativamente solo file WebM, mentre LinkedIn richiede il
// formato MP4 per il caricamento. Questo modulo converte quindi il file
// registrato usando ffmpeg (che deve essere installato sul sistema).

import { spawn } from "node:child_process";

// Converte il video WebM registrato in un file MP4 compatibile con
// LinkedIn e con la maggior parte dei lettori video. `cutRanges` è un
// elenco di intervalli (in secondi, riferiti alla registrazione originale)
// da escludere per intero dal video finale: il breve momento di schermo
// bianco o di caricamento catturato tra l'apertura della pagina e il
// momento in cui è visivamente stabile, e ogni successiva attesa del
// risultato di un'interazione (vedi runClipDevActionBatch). È lo stesso
// "taglio del tempo morto" usato dagli strumenti professionali di
// registrazione demo: gli intervalli indicati smettono semplicemente di
// esistere nel video finale, invece di essere nascosti in tempo reale
// dietro un elemento sovrapposto alla pagina durante la registrazione.
export function transcodeToMp4(inputWebmPath, outputMp4Path, cutRanges = []) {
  return new Promise((resolve, reject) => {
    const args = ["-y", "-i", inputWebmPath]; // -y: sovrascrive il file di destinazione se esiste già, senza chiedere conferma

    if (cutRanges.length > 0) {
      // "select" mantiene solo i fotogrammi che non ricadono in nessuno
      // degli intervalli esclusi; "setpts" ricalcola poi i tempi dei
      // fotogrammi rimasti in modo che scorrano senza vuoti né rallentamenti,
      // come se gli intervalli tagliati non fossero mai esistiti.
      const excludedRanges = cutRanges
        .map(({ startSeconds, endSeconds }) => `between(t,${startSeconds.toFixed(3)},${endSeconds.toFixed(3)})`)
        .join("+");
      args.push("-vf", `select='not(${excludedRanges})',setpts=N/FRAME_RATE/TB`);
    }

    args.push(
      "-c:v", "libx264", // codec video supportato universalmente da lettori e piattaforme
      "-pix_fmt", "yuv420p", // formato colore richiesto per la massima compatibilità, anche su dispositivi meno recenti
      "-preset", "medium", // equilibrio ragionevole tra velocità di conversione e qualità del risultato
      "-crf", "23", // livello di qualità costante, adeguato per un video breve come questo
      "-movflags", "+faststart", // predispone il file per essere riprodotto in streaming non appena inizia il download
      "-an", // il video registrato non contiene audio, quindi nessuna traccia audio viene elaborata
      outputMp4Path
    );

    const ffmpeg = spawn("ffmpeg", args);

    // ffmpeg scrive i propri messaggi di avanzamento su questo canale per
    // normale funzionamento, non solo in caso di errore: li raccogliamo per
    // poterli includere nel messaggio d'errore se la conversione fallisce.
    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on("error", (err) => {
      // Questo tipo di errore indica specificamente che ffmpeg non è
      // installato o non è raggiungibile sul sistema: è il problema più
      // comune, per cui viene segnalato con istruzioni chiare invece che
      // con un messaggio tecnico generico.
      if (err.code === "ENOENT") {
        reject(
          new Error(
            "ffmpeg non è stato trovato nel PATH di sistema. Installalo (es. 'winget install ffmpeg', " +
              "'brew install ffmpeg' su macOS, 'apt install ffmpeg' su Debian/Ubuntu) prima di usare questo tool."
          )
        );
        return;
      }
      reject(err);
    });

    ffmpeg.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
      } else {
        // Solo la parte finale del registro di ffmpeg viene inclusa
        // nell'errore: è sufficiente a capire la causa del problema senza
        // riportare un registro troppo lungo.
        reject(new Error(`ffmpeg terminato con codice ${exitCode}: ${stderr.slice(-500)}`));
      }
    });
  });
}
