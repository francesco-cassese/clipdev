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
// video destinati al feed desktop (Full HD, formato 16:9).
export const VIDEO_WIDTH = 1920;
export const VIDEO_HEIGHT = 1080;
