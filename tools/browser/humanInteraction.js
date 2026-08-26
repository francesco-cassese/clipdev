// tools/browser/humanInteraction.js
//
// Simulazione di un'interazione umana con la pagina durante la
// registrazione del video: un cursore visibile che si muove sullo schermo
// seguendo un percorso naturale invece di scattare istantaneamente da un
// punto all'altro, e uno scorrimento della pagina morbido invece che a
// scatti. Questo modulo è indipendente dal resto della registrazione:
// riceve la pagina su cui operare come parametro e non dipende da nient'altro.

import { VIDEO_HEIGHT } from "./recordingConfig.js";

// Script che viene inserito in ogni pagina registrata (vedi
// startClipDevRecording in tools/browser/recordDemoTool.js) per disegnare un
// cursore visibile e farlo seguire i movimenti reali del mouse. È
// necessario perché il browser usato per la registrazione non mostra il
// puntatore del sistema operativo nei video che produce: senza questo
// accorgimento, il video mostrerebbe azioni (click, digitazione) senza che
// si veda alcun cursore muoversi verso i punti coinvolti.
//
// Attenzione tecnica sulle virgolette usate nel codice qui sotto: la
// combinazione di virgolette scelta è necessaria per evitare un problema
// di visualizzazione riscontrato in fase di verifica, in cui il cursore
// veniva inserito nella pagina senza generare errori ma restava invisibile.
export const CURSOR_INIT_SCRIPT = `
(() => {
  const ID = "__clipdev_cursor__";
  const CURSOR_SVG =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>" +
      "<path d='M3 2 L3 19 L7.5 15.5 L10.5 21.5 L13 20.2 L10 14.3 L16 14 Z' " +
      "fill='white' stroke='black' stroke-width='1.3' stroke-linejoin='round' stroke-linecap='round'/></svg>"
    );

  function setup() {
    if (document.getElementById(ID)) return;

    const style = document.createElement("style");
    style.textContent =
      "#" + ID + " { position: fixed; top: 0; left: 0; width: 24px; height: 24px; " +
      "background-image: url(\\"" + CURSOR_SVG + "\\"); background-size: contain; " +
      "pointer-events: none; z-index: 2147483647; will-change: transform; }" +
      "#" + ID + ".__clipdev_click { animation: __clipdev_pulse 0.35s ease-out; }" +
      "@keyframes __clipdev_pulse { 0% { filter: drop-shadow(0 0 0 rgba(66,133,244,0.9)); } " +
      "100% { filter: drop-shadow(0 0 10px rgba(66,133,244,0)); } }";
    document.documentElement.appendChild(style);

    const cursor = document.createElement("div");
    cursor.id = ID;
    document.documentElement.appendChild(cursor);

    // Ogni spostamento del mouse durante la registrazione genera un
    // evento reale nel browser: questo listener lo intercetta e sposta di
    // conseguenza il cursore visibile disegnato sopra.
    document.addEventListener(
      "mousemove",
      (event) => {
        cursor.style.transform = "translate(" + event.clientX + "px, " + event.clientY + "px)";
      },
      { capture: true, passive: true }
    );

    // Funzione richiamata subito prima di un click (vedi runAction in
    // tools/browser/recordDemoTool.js) per mostrare un breve effetto visivo nel
    // punto esatto in cui avviene, così l'azione risulta più chiara a chi
    // guarda il video.
    window.__clipdevCursorClick = () => {
      cursor.classList.remove("__clipdev_click");
      void cursor.offsetWidth; // permette di far ripartire l'effetto visivo anche su click ravvicinati
      cursor.classList.add("__clipdev_click");
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();
`;

// Calcola un punto intermedio che fa deviare leggermente il percorso del
// cursore da una linea retta perfetta: un movimento umano del mouse non è
// mai perfettamente rettilineo, quindi il percorso simulato include una
// leggera curva, in una direzione scelta casualmente ogni volta.
function computeCurveControlPoint(start, target) {
  const midX = (start.x + target.x) / 2;
  const midY = (start.y + target.y) / 2;
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const distance = Math.hypot(dx, dy) || 1;

  const perpX = -dy / distance;
  const perpY = dx / distance;

  const curveAmount = Math.min(distance * 0.25, 80) * (Math.random() < 0.5 ? -1 : 1);

  return {
    x: midX + perpX * curveAmount,
    y: midY + perpY * curveAmount,
  };
}

// Calcola un punto lungo il percorso curvo definito da punto di partenza,
// punto di controllo e punto di arrivo, in base a quanto il movimento è
// già avanzato (da 0, appena iniziato, a 1, arrivato a destinazione).
function quadraticBezierPoint(start, control, target, t) {
  const oneMinusT = 1 - t;
  return {
    x: oneMinusT * oneMinusT * start.x + 2 * oneMinusT * t * control.x + t * t * target.x,
    y: oneMinusT * oneMinusT * start.y + 2 * oneMinusT * t * control.y + t * t * target.y,
  };
}

// Curva di accelerazione e decelerazione che riproduce il modo naturale in
// cui una mano umana raggiunge un bersaglio: si parte lentamente, si
// accelera nella parte centrale del movimento e si rallenta di nuovo
// avvicinandosi al punto di arrivo, invece di muoversi a velocità costante.
function minimumJerkEase(t) {
  return 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5;
}

// Valori usati per stimare quanto tempo impiegherebbe una persona a
// raggiungere un bersaglio con il mouse, in base alla distanza da
// percorrere e alle dimensioni del bersaglio: un movimento verso un
// bersaglio piccolo e lontano richiede più tempo (e più precisione) di uno
// verso un bersaglio grande e vicino. Questi valori derivano da una
// formula ampiamente usata negli studi sull'interazione uomo-computer, e
// permettono al ritmo del cursore di adattarsi in modo realistico a ogni
// singolo movimento, invece di essere sempre identico.
const FITTS_INTERCEPT_MS = 1_030;
const FITTS_SLOPE_MS_PER_BIT = 96;

// Limiti minimo e massimo applicati alla durata calcolata: senza questi
// limiti, un bersaglio molto piccolo o lontano produrrebbe un movimento
// innaturalmente lento per un video così breve, mentre un bersaglio molto
// grande e vicino produrrebbe uno quasi istantaneo e poco leggibile.
const MIN_MOVE_DURATION_MS = 220;
const MAX_MOVE_DURATION_MS = 1_400;

// Dimensione del bersaglio usata quando non se ne conosce una precisa (ad
// esempio quando ci si sposta verso un punto qualsiasi, non verso un
// elemento specifico della pagina): una stima prudente delle dimensioni
// medie di un pulsante o di un campo.
const DEFAULT_TARGET_WIDTH_PX = 80;

// Ampiezza massima di un piccolo tremore casuale applicato lungo il
// percorso del movimento (mai al punto di arrivo finale, che resta sempre
// preciso): nessuna mano umana segue una curva perfettamente regolare, e
// questo dettaglio, volutamente sottile, rende il movimento più credibile.
const MOUSE_JITTER_PX = 2.5;

// Sposta il cursore visibile verso un punto della pagina seguendo un
// percorso leggermente curvo, con una velocità che accelera e rallenta in
// modo naturale, e una durata calcolata in base alla distanza e alla
// dimensione del bersaglio: non un movimento a scatto e sempre della
// stessa durata, ma uno che si adatta ogni volta. `cursorState` tiene
// traccia della posizione attuale del cursore tra un movimento e l'altro
// nella stessa registrazione, così ogni nuovo movimento riparte da dove è
// arrivato il precedente.
export async function moveMouseHumanLike(page, cursorState, targetX, targetY, targetWidthPx = DEFAULT_TARGET_WIDTH_PX) {
  const start = { x: cursorState.x, y: cursorState.y };
  const target = { x: targetX, y: targetY };
  const control = computeCurveControlPoint(start, target);

  const distance = Math.hypot(target.x - start.x, target.y - start.y);
  const indexOfDifficulty = Math.log2(distance / Math.max(targetWidthPx, 1) + 1);
  const durationMs = Math.min(
    MAX_MOVE_DURATION_MS,
    Math.max(MIN_MOVE_DURATION_MS, FITTS_INTERCEPT_MS + FITTS_SLOPE_MS_PER_BIT * indexOfDifficulty)
  );
  // Un passo circa ogni 16 millisecondi produce un movimento fluido senza
  // generare più eventi di quanti ne servano per risultare leggibile nel
  // video.
  const steps = Math.max(8, Math.round(durationMs / 16));

  for (let i = 1; i <= steps; i += 1) {
    const linearT = i / steps;
    const easedT = minimumJerkEase(linearT);
    const point = quadraticBezierPoint(start, control, target, easedT);
    // Piccolo tremore casuale applicato a ogni passo intermedio, diverso
    // ogni volta: non influisce sulla precisione dell'atterraggio finale.
    const jitterX = (Math.random() - 0.5) * MOUSE_JITTER_PX;
    const jitterY = (Math.random() - 0.5) * MOUSE_JITTER_PX;
    await page.mouse.move(point.x + jitterX, point.y + jitterY);
    await page.waitForTimeout(durationMs / steps);
  }

  // L'ultimo passo posiziona il cursore esattamente sul bersaglio: la
  // curva e il tremore riguardano solo il tragitto, non il punto di
  // arrivo, che deve restare preciso perché il click successivo non manchi
  // l'elemento.
  await page.mouse.move(targetX, targetY);
  cursorState.x = targetX;
  cursorState.y = targetY;
}

// Restituisce un ritardo casuale compreso in un intervallo, usato per
// simulare la piccola esitazione naturale prima di premere o rilasciare il
// pulsante del mouse (vedi runAction in tools/browser/recordDemoTool.js): un click
// reale non ha mai una durata di pressione identica ogni volta.
export function randomDelay(minMs, maxMs) {
  return minMs + Math.random() * (maxMs - minMs);
}

// Traduce l'indicazione qualitativa scelta dall'agente che pianifica le
// interazioni (vedi ActionSchema in tools/browser/recordDemoTool.js, azione di
// tipo "scroll") in una distanza concreta in pixel, calcolata come
// proporzione dell'altezza del video: così lo scorrimento resta coerente
// anche se in futuro cambiasse la risoluzione del video.
export const SCROLL_AMOUNT_PX = {
  small: VIDEO_HEIGHT * 0.25,
  medium: VIDEO_HEIGHT * 0.5,
  large: VIDEO_HEIGHT * 0.85,
};

// Quantità di scorrimento coperta a ogni singolo passo dell'animazione:
// determina quanti passi (e quindi quanto tempo) richiede uno scorrimento,
// in base alla sua distanza complessiva.
const SCROLL_PX_PER_STEP = 40;

// Scorre la pagina di una certa quantità in più passi successivi, con
// accelerazione e decelerazione naturali, invece che con un singolo salto
// istantaneo: un salto secco risulterebbe innaturale nel video, mentre uno
// scorrimento morbido è più semplice da seguire per chi guarda. Il numero
// di passi è proporzionato alla distanza da percorrere, così uno
// scorrimento breve e uno lungo risultano entrambi fluidi invece che a
// velocità incoerenti tra loro.
export async function scrollPageSmooth(page, totalDeltaY) {
  const steps = Math.max(8, Math.min(40, Math.round(Math.abs(totalDeltaY) / SCROLL_PX_PER_STEP)));
  for (let i = 1; i <= steps; i += 1) {
    const linearT = i / steps;
    const easedT = minimumJerkEase(linearT);
    const previousEasedT = minimumJerkEase((i - 1) / steps);
    const stepDeltaY = (easedT - previousEasedT) * totalDeltaY;
    await page.mouse.wheel(0, stepDeltaY);
    await page.waitForTimeout(8 + Math.random() * 8);
  }
}
