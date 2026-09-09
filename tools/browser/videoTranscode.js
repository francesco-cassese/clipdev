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
// registrato usando ffmpeg (che deve essere installato sul sistema),
// applicando in un solo passaggio anche tre rifiniture pensate per
// l'engagement sul feed LinkedIn: il taglio del tempo morto, le callout
// testuali sincronizzate con l'outline e, quando richiesto, l'incapsulamento
// in un canvas quadrato per il feed mobile.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as z from "zod";

import { CANVAS_FORMATS, CanvasFormatSchema, DEFAULT_CANVAS_FORMAT, VIDEO_HEIGHT, VIDEO_WIDTH } from "./recordingConfig.js";

// --- Callout testuali --------------------------------------------------------
//
// Pillole di testo semitrasparenti sovrimpresse al video, sincronizzate con
// i passaggi salienti della scaletta prodotta dall'Analyst Agent (vedi
// calloutText/calloutStartSeconds/calloutEndSeconds in OutlineSectionSchema,
// tools/saveOutputTool.js). Rilette qui in fase di montaggio, non lasciate
// alla registrazione: un testo bruciato nel video con ffmpeg resta nitido a
// qualunque risoluzione di visualizzazione, cosa che un overlay disegnato
// nella pagina durante la registrazione non garantirebbe altrettanto bene.

export const CalloutSchema = z
  .object({
    text: z.string().min(1).max(40),
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive(),
  })
  .refine((callout) => callout.endSeconds > callout.startSeconds, {
    error: "endSeconds deve essere maggiore di startSeconds",
    path: ["endSeconds"],
  });

// I timestamp indicati dall'Analyst Agent sono indicativi (pensati per la
// scaletta narrativa del video, non calcolati a fotogramma esatto): vengono
// applicati qui direttamente sulla timeline FINALE, cioè già ripulita dal
// taglio del tempo morto (vedi più sotto), così restano coerenti con il
// ritmo che l'Analyst Agent aveva in mente quando ha suddiviso le sezioni.

const CALLOUT_MAX_CHARS = 40; // coerente con il limite già imposto da CalloutSchema: una difesa aggiuntiva, non l'unica.
const CALLOUT_FADE_SECONDS = 0.3; // dissolvenza in entrata/uscita: una pillola che compare/scompare di scatto distrae in un video pensato per essere guardato senza audio.
const CALLOUT_FONT_SIZE = 40;

// Percorsi di font grassetto comuni sui tre principali sistemi operativi,
// in ordine di preferenza: usato il primo che risulta effettivamente
// presente sul sistema. drawtext richiede un file di font esplicito (non
// può affidarsi a fontconfig, spesso assente o non configurato, come
// osservato concretamente su Windows), quindi senza uno di questi percorsi
// disponibili le callout non hanno modo di essere disegnate.
const CALLOUT_FONT_CANDIDATES = [
  "C:/Windows/Fonts/arialbd.ttf",
  "C:/Windows/Fonts/segoeuib.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
];

// La ricerca del font (accesso al filesystem) viene fatta al più una volta
// per l'intera esecuzione del processo, non ad ogni video generato: il
// risultato non può cambiare tra una chiamata e l'altra nella stessa
// esecuzione. `undefined` distingue "non ancora cercato" da "cercato e non
// trovato" (`null`), che altrimenti sarebbero indistinguibili.
let cachedCalloutFontPath;
function findCalloutFontPath() {
  if (cachedCalloutFontPath === undefined) {
    cachedCalloutFontPath = CALLOUT_FONT_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
  }
  return cachedCalloutFontPath;
}

// All'interno di un valore drawtext protetto da apici singoli, ffmpeg
// richiede comunque di sfuggire il backslash e i due punti (i due punti
// restano il separatore chiave=valore del filtro anche dentro le
// virgolette: una particolarità verificata direttamente contro il binario
// ffmpeg usato da questo progetto, non solo dedotta dalla documentazione).
// L'apice singolo, non rappresentabile dentro un valore già racchiuso da
// apici singoli senza un secondo livello di escaping, viene sostituito con
// il suo equivalente tipografico piuttosto che complicare il parsing.
function escapeDrawtextValue(value) {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019");
}

// La virgola separa i filtri all'interno di una filterchain: comparendo
// spesso nelle espressioni matematiche di drawtext (between(), if(), ...),
// va sfuggita esplicitamente anche quando l'espressione è già tra apici
// singoli — le virgolette, per questo motivo, non bastano da sole a
// proteggerla (verificato empiricamente, non solo per prudenza).
function escapeExprCommas(expression) {
  return expression.replace(/,/g, "\\,");
}

// Costruisce il singolo filtro drawtext per una callout: una pillola di
// testo semitrasparente, centrata orizzontalmente e vicina al bordo
// inferiore, visibile solo nella finestra temporale indicata e con una
// breve dissolvenza ai due estremi.
function buildCalloutFilter({ text, startSeconds, endSeconds }, fontPath) {
  const safeText = escapeDrawtextValue(text.slice(0, CALLOUT_MAX_CHARS));
  const safeFont = escapeDrawtextValue(fontPath);

  // La dissolvenza non può durare più della metà della finestra visibile,
  // altrimenti su una callout molto breve l'entrata e l'uscita
  // finirebbero per sovrapporsi.
  const fade = Math.min(CALLOUT_FADE_SECONDS, (endSeconds - startSeconds) / 2) || 0.001;
  const fadeInEnd = startSeconds + fade;
  const fadeOutStart = endSeconds - fade;

  const alphaExpr = escapeExprCommas(
    `if(lt(t,${startSeconds}),0,` +
      `if(lt(t,${fadeInEnd}),(t-${startSeconds})/${fade},` +
      `if(lt(t,${fadeOutStart}),1,` +
      `if(lt(t,${endSeconds}),(${endSeconds}-t)/${fade},0))))`
  );
  const enableExpr = escapeExprCommas(`between(t,${startSeconds},${endSeconds})`);

  return (
    `drawtext=fontfile='${safeFont}':text='${safeText}':fontcolor=white:fontsize=${CALLOUT_FONT_SIZE}:` +
    `x=(w-text_w)/2:y=h-(h*0.13):box=1:boxcolor=0x111318@0.6:boxborderw=18:` +
    `alpha='${alphaExpr}':enable='${enableExpr}'`
  );
}

// --- Canvas quadrato per il feed mobile --------------------------------------
//
// La viewport 16:9 registrata viene rimpicciolita e incapsulata al centro
// di un canvas 1080x1080, con angoli arrotondati, una leggera ombra e uno
// sfondo scuro minimale — pensato per il feed mobile di LinkedIn, dove un
// video 1:1 occupa più spazio verticale nello schermo rispetto a un
// widescreen "a bande nere".

const CANVAS_CORNER_RADIUS_PX = 28;
const CANVAS_BG_COLOR = "0x141414";
// Percentuale della larghezza del canvas occupata dalla viewport
// incorniciata: il margine restante lascia spazio all'ombra attorno ad
// essa, che altrimenti verrebbe tagliata ai bordi del canvas.
const CANVAS_FRAME_MARGIN_RATIO = 0.92;
const SHADOW_BLUR_SIGMA = 16;
const SHADOW_OPACITY = 0.55;
const SHADOW_OFFSET_Y_PX = 16; // "leggero" drop-shadow: solo un piccolo spostamento verticale, non un alone marcato

// Espressione geq che produce, per una qualunque dimensione W x H (le due
// variabili built-in di ffmpeg per il fotogramma corrente, non hardcoded
// qui), un canale alfa opaco ovunque tranne nei quattro angoli, dove resta
// opaco solo entro il raggio indicato dal centro dell'arco dell'angolo:
// esattamente la maschera di un rettangolo con angoli arrotondati.
function buildRoundedRectAlphaExpr(radius) {
  return (
    `if(lt(X,${radius})*lt(Y,${radius}),if(lte(hypot(${radius}-X,${radius}-Y),${radius}),255,0),` +
    `if(gt(X,W-${radius})*lt(Y,${radius}),if(lte(hypot(X-(W-${radius}),${radius}-Y),${radius}),255,0),` +
    `if(lt(X,${radius})*gt(Y,H-${radius}),if(lte(hypot(${radius}-X,Y-(H-${radius})),${radius}),255,0),` +
    `if(gt(X,W-${radius})*gt(Y,H-${radius}),if(lte(hypot(X-(W-${radius}),Y-(H-${radius})),${radius}),255,0),255))))`
  );
}

// Arrotonda una dimensione al numero pari più vicino per difetto: richiesto
// dalla codifica yuv420p (che sottocampiona il colore a coppie di
// fotogrammi), evita artefatti o un rifiuto diretto da parte dell'encoder.
function roundToEven(value) {
  const rounded = Math.round(value);
  return rounded - (rounded % 2);
}

// Calcola le dimensioni, sempre pari, a cui ridurre la viewport 16:9
// registrata perché entri, con il margine per l'ombra, nel canvas quadrato
// di destinazione — mantenendo le sue proporzioni originali.
function computeFramedViewportSize(canvasWidth) {
  const frameWidth = roundToEven(canvasWidth * CANVAS_FRAME_MARGIN_RATIO);
  const frameHeight = roundToEven((frameWidth * VIDEO_HEIGHT) / VIDEO_WIDTH);
  return { frameWidth, frameHeight };
}

// Costruisce la sequenza di filtri che compongono il canvas quadrato,
// operando sul pad d'ingresso indicato (l'esito del taglio/delle callout, o
// direttamente il video originale se nessuno dei due è stato richiesto).
// Angoli arrotondati e ombra vengono calcolati UNA SOLA VOLTA, su un
// singolo fotogramma statico (le maschere non dipendono dal contenuto, solo
// dalle dimensioni fisse del frame), invece che rivalutati ad ogni
// fotogramma del video: `alphamerge` ripete automaticamente l'unico
// fotogramma della maschera finché il flusso video reale non termina
// (comportamento di default della libreria di sincronizzazione dei filtri
// di ffmpeg), quindi l'espressione geq — la parte più costosa in termini di
// tempo di calcolo — non viene mai rivalutata sui singoli fotogrammi del
// video vero e proprio: un risparmio concreto su un video di 15-30 secondi
// (centinaia di fotogrammi), verificato empiricamente prima di scrivere
// questo codice.
function buildSquareCanvasStages(inputPad, canvasWidth, canvasHeight) {
  const { frameWidth, frameHeight } = computeFramedViewportSize(canvasWidth);
  const roundedAlpha = buildRoundedRectAlphaExpr(CANVAS_CORNER_RADIUS_PX);

  return [
    `${inputPad}scale=${frameWidth}:${frameHeight}[squareScaled]`,
    `color=c=white:s=${frameWidth}x${frameHeight}:d=0.04[cornerMaskBase]`,
    `[cornerMaskBase]geq=lum='${roundedAlpha}'[cornerMask]`,
    `[squareScaled]format=yuva420p[squareScaledFmt]`,
    `[squareScaledFmt][cornerMask]alphamerge[framedViewport]`,
    `color=c=black:s=${frameWidth}x${frameHeight}:d=0.04[shadowMaskBase]`,
    `[shadowMaskBase]geq=lum='${roundedAlpha}',gblur=sigma=${SHADOW_BLUR_SIGMA}[shadowMask]`,
    `color=c=black:s=${frameWidth}x${frameHeight}:d=0.04[shadowRgbBase]`,
    `[shadowRgbBase]format=yuva420p[shadowRgb]`,
    `[shadowRgb][shadowMask]alphamerge,colorchannelmixer=aa=${SHADOW_OPACITY}[shadow]`,
    `color=c=${CANVAS_BG_COLOR}:s=${canvasWidth}x${canvasHeight}:r=30[canvasBg]`,
    `[canvasBg][shadow]overlay=x=(W-w)/2:y=(H-h)/2+${SHADOW_OFFSET_Y_PX}[canvasWithShadow]`,
    // "shortest=1": il generatore "color" dello sfondo, senza questa
    // opzione, produrrebbe fotogrammi all'infinito — è questa condizione a
    // far terminare l'intero grafo di filtri non appena il video (finito)
    // in ingresso è esaurito, senza bisogno di conoscerne in anticipo la
    // durata esatta (verificato empiricamente).
    `[canvasWithShadow][framedViewport]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1`,
  ];
}

// --- Taglio del tempo morto ---------------------------------------------------

// Costruisce il filtro che rimuove per intero gli intervalli di tempo morto
// indicati (vedi il commento di transcodeToMp4 più sotto per il significato
// di `cutRanges`), oppure restituisce null se non c'è nulla da tagliare.
function buildCutFilterStage(cutRanges) {
  if (cutRanges.length === 0) return null;
  const excludedRanges = cutRanges
    .map(({ startSeconds, endSeconds }) => `between(t,${startSeconds.toFixed(3)},${endSeconds.toFixed(3)})`)
    .join("+");
  return `select='not(${excludedRanges})',setpts=N/FRAME_RATE/TB`;
}

// --- Conversione finale -------------------------------------------------------

// Converte il video WebM registrato in un file MP4 compatibile con
// LinkedIn e con la maggior parte dei lettori video, applicando in un solo
// passaggio le tre rifiniture pensate per l'engagement sul feed:
//
// - `cutRanges`: elenco di intervalli (in secondi, riferiti alla
//   registrazione originale) da escludere per intero dal video finale — il
//   breve momento di schermo bianco o di caricamento catturato tra
//   l'apertura della pagina e il momento in cui è visivamente stabile, e
//   ogni successiva attesa del risultato di un'interazione (vedi
//   runClipDevActionBatch in tools/browser/recordDemoTool.js). È lo stesso
//   "taglio del tempo morto" usato dagli strumenti professionali di
//   registrazione demo: gli intervalli indicati smettono semplicemente di
//   esistere nel video finale, invece di essere nascosti in tempo reale
//   dietro un elemento sovrapposto alla pagina durante la registrazione.
// - `callouts`: pillole di testo da sovrimprimere, lette dall'outline
//   dell'Analyst Agent (vedi CalloutSchema sopra).
// - `canvasFormat`: "widescreen" (default, nessuna elaborazione aggiuntiva)
//   o "square", per il feed mobile (vedi CANVAS_FORMATS in
//   tools/browser/recordingConfig.js).
export function transcodeToMp4(inputWebmPath, outputMp4Path, options = {}) {
  const { cutRanges = [], callouts = [], canvasFormat = DEFAULT_CANVAS_FORMAT } = options;

  return new Promise((resolve, reject) => {
    // Gli stessi dati potrebbero già essere stati validati da chi chiama
    // questa funzione (vedi finalizeClipDevRecording in
    // tools/browser/recordDemoTool.js): vengono comunque controllati anche
    // qui, come per ogni altro strumento di questo progetto, per non dare
    // per scontato che un controllo esterno sia sempre stato eseguito.
    let parsedCallouts;
    let parsedCanvasFormat;
    try {
      parsedCallouts = z.array(CalloutSchema).parse(callouts);
      parsedCanvasFormat = CanvasFormatSchema.parse(canvasFormat);
    } catch (error) {
      reject(new Error(`Parametri di transcodifica non validi: ${error.message}`));
      return;
    }

    const stages = [];
    const cutStage = buildCutFilterStage(cutRanges);
    if (cutStage) stages.push(cutStage);

    if (parsedCallouts.length > 0) {
      const fontPath = findCalloutFontPath();
      if (fontPath) {
        for (const callout of parsedCallouts) {
          stages.push(buildCalloutFilter(callout, fontPath));
        }
      } else {
        // Nessun font disponibile tra quelli noti (vedi
        // CALLOUT_FONT_CANDIDATES): le callout vengono saltate, non è un
        // motivo per far fallire l'intera conversione — un video senza
        // callout resta comunque un risultato valido, coerente con lo
        // stesso principio già applicato altrove in questo progetto per le
        // rifiniture non essenziali.
        console.error(
          "Nessun font di sistema trovato tra quelli noti: le callout testuali vengono saltate per questo video " +
            "(il resto della conversione prosegue normalmente)."
        );
      }
    }

    const args = ["-y", "-i", inputWebmPath]; // -y: sovrascrive il file di destinazione se esiste già, senza chiedere conferma

    if (parsedCanvasFormat === "square") {
      const { width: canvasWidth, height: canvasHeight } = CANVAS_FORMATS.square;

      // Se un taglio o delle callout sono stati richiesti, vengono applicati
      // PRIMA di ridurre il fotogramma per il canvas quadrato: le callout,
      // in particolare, vengono così "bruciate" alla risoluzione originale
      // 1920x1080 e solo dopo rimpicciolite insieme al resto della
      // viewport, restando nitide e proporzionate esattamente come nel
      // formato widescreen, senza bisogno di una dimensione del testo
      // diversa per ciascun formato.
      const preparedTag = stages.length > 0 ? "[prepared]" : "[0:v]";
      const preparedStage = stages.length > 0 ? [`[0:v]${stages.join(",")}${preparedTag}`] : [];

      const squareStages = buildSquareCanvasStages(preparedTag, canvasWidth, canvasHeight);
      const lastIndex = squareStages.length - 1;
      squareStages[lastIndex] = `${squareStages[lastIndex]}[vout]`;

      const filterComplex = [...preparedStage, ...squareStages].join(";");
      args.push("-filter_complex", filterComplex, "-map", "[vout]");
    } else if (stages.length > 0) {
      args.push("-filter_complex", `[0:v]${stages.join(",")}[vout]`, "-map", "[vout]");
    }
    // Altrimenti (widescreen, senza taglio né callout): nessun filtro è
    // necessario, il flusso video originale viene incluso così com'è.

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
