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
      "100% { filter: drop-shadow(0 0 10px rgba(66,133,244,0)); } }" +
      // Cerchio semitrasparente che si espande e svanisce nel punto esatto
      // di ogni click ("ripple"): il cursore disegnato sopra resta piccolo
      // e può passare inosservato su uno schermo di dimensioni ridotte
      // (tipicamente un telefono, dove il video LinkedIn viene guardato più
      // spesso che su desktop), mentre un cerchio che si espande è
      // riconoscibile anche rimpicciolito.
      ".__clipdev_ripple { position: fixed; top: 0; left: 0; width: 20px; height: 20px; " +
      "margin-left: -10px; margin-top: -10px; border-radius: 50%; " +
      "background: radial-gradient(circle, rgba(66,133,244,0.55) 0%, rgba(66,133,244,0.15) 60%, rgba(66,133,244,0) 100%); " +
      "border: 2px solid rgba(66,133,244,0.65); pointer-events: none; z-index: 2147483646; " +
      "animation: __clipdev_ripple_expand 0.6s ease-out forwards; }" +
      "@keyframes __clipdev_ripple_expand { 0% { transform: scale(0.4); opacity: 0.9; } " +
      "100% { transform: scale(7); opacity: 0; } }";
    document.documentElement.appendChild(style);

    const cursor = document.createElement("div");
    cursor.id = ID;
    document.documentElement.appendChild(cursor);

    // Posizione corrente del cursore, aggiornata ad ogni movimento reale
    // del mouse: usata sia per disegnare il cursore stesso sia come punto
    // di partenza per il ripple generato da un click (vedi
    // window.__clipdevCursorClick più sotto), invece di dover interrogare
    // di nuovo la posizione del mouse in quel momento.
    let lastX = 0;
    let lastY = 0;

    // Ogni spostamento del mouse durante la registrazione genera un
    // evento reale nel browser: questo listener lo intercetta e sposta di
    // conseguenza il cursore visibile disegnato sopra.
    document.addEventListener(
      "mousemove",
      (event) => {
        lastX = event.clientX;
        lastY = event.clientY;
        cursor.style.transform = "translate(" + lastX + "px, " + lastY + "px)";
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

      // Posizionato con left/top (non con transform, come il cursore):
      // l'animazione CSS del ripple anima anch'essa la proprietà transform
      // (per l'effetto di espansione), e le due dichiarazioni andrebbero in
      // conflitto se la posizione venisse espressa nello stesso modo.
      const ripple = document.createElement("div");
      ripple.className = "__clipdev_ripple";
      ripple.style.left = lastX + "px";
      ripple.style.top = lastY + "px";
      document.documentElement.appendChild(ripple);
      // Il ripple si rimuove da sé al termine della propria animazione (o,
      // in via cautelativa, dopo un tempo fisso se per qualche motivo
      // l'evento non dovesse scattare): senza questa pulizia, ogni click
      // lascerebbe un elemento vuoto accumulato nella pagina.
      const removeRipple = () => ripple.remove();
      ripple.addEventListener("animationend", removeRipple, { once: true });
      setTimeout(removeRipple, 900);
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

// --- Stabilità dell'elemento prima di un'interazione -------------------------
//
// Tempo massimo complessivo di attesa prima di rinunciare e procedere
// comunque con l'ultima posizione osservata: un'animazione insolitamente
// lunga (o infinita, come uno spinner di caricamento) non deve bloccare
// l'intera registrazione, che ha comunque un tempo massimo di durata
// previsto (vedi VIDEO_TARGET_MAX_MS in pipeline/clipDevPipeline.js).
const STABILITY_MAX_WAIT_MS = 2_000;
// Intervallo tra due misurazioni successive della posizione/dimensione
// dell'elemento.
const STABILITY_CHECK_INTERVAL_MS = 50;
// Numero di misurazioni consecutive pressoché identiche richieste prima di
// considerare l'elemento stabile: una sola misurazione "ferma" potrebbe
// cadere per caso tra due fotogrammi di un'animazione ancora in corso.
const STABILITY_REQUIRED_STILL_CHECKS = 3;
// Tolleranza, in pixel, entro cui due misurazioni successive sono
// considerate "la stessa posizione": un valore diverso da zero perché il
// rendering del browser può introdurre variazioni sub-pixel anche su un
// elemento che, a tutti gli effetti, non si sta muovendo.
const STABILITY_POSITION_EPSILON_PX = 0.5;

function isSameBoundingBox(a, b) {
  return (
    Math.abs(a.x - b.x) < STABILITY_POSITION_EPSILON_PX &&
    Math.abs(a.y - b.y) < STABILITY_POSITION_EPSILON_PX &&
    Math.abs(a.width - b.width) < STABILITY_POSITION_EPSILON_PX &&
    Math.abs(a.height - b.height) < STABILITY_POSITION_EPSILON_PX
  );
}

// Attende che l'elemento indicato dal selettore sia visibile e smetta di
// muoversi/ridimensionarsi prima di procedere con un'interazione (click o
// fill, vedi runAction in tools/browser/recordDemoTool.js). Necessario
// perché quel codice non usa i metodi di alto livello di Playwright
// (locator.click()/locator.fill(), che includono già un'attesa di
// stabilità equivalente), ma calcola il punto di destinazione una sola
// volta e poi muove il cursore visibile verso quel punto con un movimento
// realistico (vedi moveMouseHumanLike sopra): se l'elemento fosse ancora in
// movimento per una transizione CSS o un rendering asincrono in corso (un
// menu che si apre con un'animazione, un banner che si sposta mentre la
// pagina finisce di caricarsi), il punto calcolato all'inizio rischierebbe
// di non corrispondere più alla posizione reale dell'elemento nel momento
// in cui il click avviene davvero. Non interrompe la registrazione se il
// tempo massimo scade senza che l'elemento si sia mai stabilizzato: in
// quel caso si procede comunque con l'ultima posizione osservata, che
// resta comunque la stima più recente disponibile.
export async function waitForElementStable(page, selector, timeoutMs = STABILITY_MAX_WAIT_MS) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: timeoutMs });

  const deadline = Date.now() + timeoutMs;
  let previousBox = await locator.boundingBox();
  let stillChecks = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(STABILITY_CHECK_INTERVAL_MS);
    const box = await locator.boundingBox();
    if (box && previousBox && isSameBoundingBox(box, previousBox)) {
      stillChecks += 1;
      if (stillChecks >= STABILITY_REQUIRED_STILL_CHECKS) return;
    } else {
      stillChecks = 0;
    }
    previousBox = box;
  }
}

// --- Dati realistici per i campi di digitazione -------------------------------
//
// Etichette di valori chiaramente segnaposto, in italiano e in inglese: un
// video destinato a un pubblico professionale non deve mostrare un campo
// compilato con un valore palesemente finto, che comunicherebbe una demo
// raffazzonata invece di un prodotto curato.
const GENERIC_PLACEHOLDER_PATTERN =
  /^(test|test\d*|testing|asdf\w*|qwerty\w*|foo|foobar|bar|baz|lorem\s*ipsum|placeholder|xxx+|1234+|abc123|sample|example|esempio|prova\d*|input)$/i;

// Valori plausibili scelti in base a ciò che il selettore dell'elemento
// suggerisce sul suo significato (vedi pickRealisticFillValue più sotto): i
// selettori prodotti da tools/browser/pageInspection.js includono già il
// nome accessibile dell'elemento (es. `role=textbox[name="Cerca prodotto"]`),
// quindi cercare un riscontro direttamente nel testo del selettore è
// sufficiente, senza bisogno di interrogare di nuovo la pagina.
const FIELD_HINT_VALUES = [
  { pattern: /e-?mail/i, value: "marco.rossi@example.com" },
  { pattern: /cerca|search|query/i, value: "budget mensile" },
  { pattern: /nome|first[\s-]?name/i, value: "Marco" },
  { pattern: /cognome|last[\s-]?name|surname/i, value: "Rossi" },
  { pattern: /telefono|phone|tel\b/i, value: "+39 345 123 4567" },
  { pattern: /citt[aà]|city/i, value: "Milano" },
  { pattern: /indirizzo|address/i, value: "Via Roma 12" },
  { pattern: /prezzo|price|budget|importo|amount/i, value: "1200" },
  { pattern: /data|date/i, value: "2026-09-09" },
  { pattern: /url|sito|website/i, value: "https://example.com" },
  { pattern: /utente|username/i, value: "marco.rossi" },
  { pattern: /titolo|title|oggetto|subject/i, value: "Report mensile Q3" },
  { pattern: /descrizione|description|note|messaggio|message/i, value: "Sincronizzazione dati in tempo reale" },
];

// Valore di ripiego quando nessuna delle euristiche sopra trova un
// riscontro: resta comunque un testo plausibile e leggibile, non un
// segnaposto palesemente finto.
const GENERIC_FALLBACK_VALUE = "Progetto Demo";

// Sostituisce, solo quando necessario, un valore da digitare in un campo
// (vedi ActionSchema, azione "fill", in tools/browser/recordDemoTool.js) con
// uno semanticamente più plausibile: se il Director Agent ha già fornito un
// valore che non somiglia a un segnaposto generico, quel valore non viene
// toccato, perché è già una scelta informata sul contesto reale della
// pagina. Interviene solo come ultima rete di sicurezza, non come
// meccanismo principale di scelta del contenuto (quello resta compito del
// Director Agent, che vede l'intera pagina).
export function pickRealisticFillValue(selector, value) {
  const trimmed = value.trim();
  if (trimmed && !GENERIC_PLACEHOLDER_PATTERN.test(trimmed)) return value;

  const match = FIELD_HINT_VALUES.find(({ pattern }) => pattern.test(selector));
  return match ? match.value : GENERIC_FALLBACK_VALUE;
}
