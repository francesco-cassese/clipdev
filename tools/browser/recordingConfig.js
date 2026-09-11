// tools/browser/recordingConfig.js
//
// Dimensioni del video condivise tra i moduli che gestiscono la
// registrazione (tools/browser/recordDemoTool.js) e la simulazione del
// movimento del mouse (tools/browser/humanInteraction.js, dove servono per
// calcolare distanze di scorrimento proporzionate all'altezza del video).
// Definite una sola volta qui per evitare che i due moduli finiscano per
// usare valori diversi se in futuro la risoluzione cambia.
//
// Le dimensioni corrispondono allo standard raccomandato da LinkedIn per i
// video destinati al feed desktop (Full HD, formato 16:9). ClipDev registra
// e produce solo in questo formato per il momento: la registrazione con il
// viewport di un vero dispositivo mobile e l'esportazione in un canvas
// verticale/quadrato per il feed mobile sono pianificate ma non ancora
// implementate (vedi "Prossimi sviluppi" nel README).
export const VIDEO_WIDTH = 1920;
export const VIDEO_HEIGHT = 1080;
