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
// video destinati al feed desktop (Full HD, formato 16:9). È la risoluzione
// usata di default per la registrazione nel browser, indipendentemente dal
// formato di canvas scelto per l'esportazione finale (vedi CANVAS_FORMATS
// più sotto): è solo in fase di conversione, in tools/browser/videoTranscode.js,
// che il fotogramma registrato viene eventualmente incapsulato in un canvas
// differente. Fa eccezione la registrazione mobile reale (vedi MOBILE_DEVICE
// più sotto, attivata da --realMobile in bin/clipdev.js): in quel caso la
// registrazione avviene con il viewport di un vero dispositivo, non a questa
// risoluzione, proprio per mostrare il layout responsive reale invece di un
// desktop ritagliato.
export const VIDEO_WIDTH = 1920;
export const VIDEO_HEIGHT = 1080;

import * as z from "zod";
import { devices } from "playwright";

// Emulazione di un dispositivo mobile reale per la registrazione del vero
// layout responsive (menu hamburger, colonne ridotte, ecc.), invece di
// limitarsi a ritagliare al centro la stessa pagina renderizzata per
// desktop (vedi CANVAS_FORMATS più sotto, che da solo non cambia il layout
// mostrato, solo l'inquadratura finale). Viewport, pixel ratio, user agent e
// supporto touch vengono presi dal preset ufficiale di Playwright — che
// Chromium supporta nativamente anche senza passare a WebKit, nonostante il
// preset stesso suggerisca quest'ultimo come browser di default — invece di
// essere indovinati a mano, così restano allineati a un dispositivo
// realmente in uso oggi invece che a numeri arbitrari.
export const MOBILE_DEVICE_NAME = "iPhone 13";
export const MOBILE_DEVICE = devices[MOBILE_DEVICE_NAME];

// Dimensione a cui registrare il video quando si usa MOBILE_DEVICE: pari al
// viewport del dispositivo in pixel CSS, NON moltiplicato per il suo pixel
// ratio. Non è la scelta più ovvia (si potrebbe pensare che la risoluzione
// FISICA, cioè viewport × deviceScaleFactor, sia quella "giusta" per non
// sprecare nitidezza — un tentativo fatto concretamente in una versione
// precedente di questa costante), ma `recordVideo` di Playwright cattura i
// fotogrammi alla dimensione del viewport in pixel CSS a prescindere dal
// pixel ratio, e la sua opzione `size` può solo RIMPICCIOLIRE quel
// fotogramma per farlo entrare nelle dimensioni indicate, mai ingrandirlo:
// un valore più alto (come viewport × deviceScaleFactor) non produce quindi
// un video più nitido, produce un video con il contenuto reale confinato in
// un angolo e il resto del fotogramma vuoto — difetto osservato
// concretamente (un video mobile con l'hero rimpicciolito in un angolo e
// una grande area grigia sotto). La nitidezza aggiuntiva del pixel ratio va
// comunque persa a questo passaggio; viene recuperata solo in parte
// dall'ingrandimento (stavolta sì verso l'alto) applicato in fase di
// montaggio in tools/browser/videoTranscode.js, che scala comunque
// qualunque risoluzione di partenza fino al canvas finale.
export const MOBILE_RECORD_VIDEO_SIZE = {
  width: MOBILE_DEVICE.viewport.width,
  height: MOBILE_DEVICE.viewport.height,
};

// Formati di canvas supportati in fase di esportazione finale del video
// (vedi tools/browser/videoTranscode.js). "widescreen" è il formato
// classico da feed desktop, identico alla risoluzione di registrazione, e
// non richiede alcuna elaborazione aggiuntiva. "square" e "vertical" sono
// pensati per il feed mobile di LinkedIn, dove un video più alto che largo
// occupa più spazio verticale nello schermo rispetto a un widescreen "a
// bande nere": la viewport registrata viene ritagliata al centro (non
// semplicemente rimpicciolita: un frame 16:9 non riempirebbe comunque un
// canvas più stretto/alto, lasciando bande vuote sopra e sotto) e
// incapsulata in un canvas con angoli arrotondati, una leggera ombra e uno
// sfondo scuro minimale attorno. "vertical" (4:5, 1080x1350) è il formato
// che LinkedIn privilegia per il feed mobile nel 2026 (resta visibile testo
// del post e commenti, a differenza di un 9:16 che attiva la modalità
// immersiva); "square" (1:1) resta un'alternativa più "sicura", identica su
// desktop e mobile.
export const CANVAS_FORMATS = {
  widescreen: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
  square: { width: 1080, height: 1080 },
  vertical: { width: 1080, height: 1350 },
};

export const DEFAULT_CANVAS_FORMAT = "widescreen";

// Regola di validazione condivisa per il formato canvas: usata sia dal
// comando da riga di comando (bin/clipdev.js, per il flag --canvas) sia
// dalla pipeline (pipeline/clipDevPipeline.js), così un valore non
// riconosciuto viene sempre segnalato con lo stesso messaggio chiaro,
// invece di propagarsi fino a ffmpeg come un formato silenziosamente
// ignorato.
export const CanvasFormatSchema = z.enum(Object.keys(CANVAS_FORMATS));
