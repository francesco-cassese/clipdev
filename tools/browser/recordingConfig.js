// tools/browser/recordingConfig.js
//
// Dimensioni del video condivise tra i moduli che gestiscono la
// registrazione (tools/browser/recordDemoTool.js) e la simulazione del movimento
// del mouse (tools/browser/humanInteraction.js, dove servono per calcolare distanze
// di scorrimento proporzionate all'altezza del video). Sono definite una
// sola volta qui per evitare che i due moduli finiscano per usare valori
// diversi se in futuro la risoluzione cambia.
//
// Le dimensioni corrispondono allo standard richiesto da LinkedIn per i
// video destinati al feed desktop (Full HD, formato 16:9). La registrazione
// nel browser avviene SEMPRE a questa risoluzione, indipendentemente dal
// formato di canvas scelto per l'esportazione finale (vedi CANVAS_FORMATS
// più sotto): è solo in fase di conversione, in tools/browser/videoTranscode.js,
// che il fotogramma registrato viene eventualmente incapsulato in un canvas
// differente.
export const VIDEO_WIDTH = 1920;
export const VIDEO_HEIGHT = 1080;

import * as z from "zod";

// Formati di canvas supportati in fase di esportazione finale del video
// (vedi tools/browser/videoTranscode.js). "widescreen" è il formato
// classico da feed desktop, identico alla risoluzione di registrazione, e
// non richiede alcuna elaborazione aggiuntiva. "square" è pensato per il
// feed mobile di LinkedIn, dove un video 1:1 occupa più spazio verticale
// nello schermo rispetto a un widescreen: la viewport registrata viene
// rimpicciolita e incapsulata al centro di un canvas 1080x1080, con angoli
// arrotondati, una leggera ombra e uno sfondo scuro minimale attorno.
export const CANVAS_FORMATS = {
  widescreen: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
  square: { width: 1080, height: 1080 },
};

export const DEFAULT_CANVAS_FORMAT = "widescreen";

// Regola di validazione condivisa per il formato canvas: usata sia dal
// comando da riga di comando (bin/clipdev.js, per il flag --canvas) sia
// dalla pipeline (pipeline/clipDevPipeline.js), così un valore non
// riconosciuto viene sempre segnalato con lo stesso messaggio chiaro,
// invece di propagarsi fino a ffmpeg come un formato silenziosamente
// ignorato.
export const CanvasFormatSchema = z.enum(Object.keys(CANVAS_FORMATS));
