// tools/browser/pageInspection.js
//
// Lettura della pagina web reale: individua gli elementi con cui si può
// interagire (pulsanti, link, campi di testo), misura quanto contenuto
// resta fuori dalla parte visibile dello schermo, e localizza sulla pagina
// il punto esatto in cui si trova un elemento. Questo è ciò che permette
// all'agente che decide le interazioni da mostrare (ai/agents/directorAgent.js)
// di scegliere azioni solo tra elementi realmente presenti sulla pagina,
// invece di indovinarli semplicemente leggendone una descrizione testuale.

// Attende che la pagina smetta di modificare la propria struttura (nuovi
// elementi che compaiono, testo che cambia, attributi aggiornati) per un
// breve intervallo consecutivo, invece di affidarsi al solo traffico di
// rete per capire se la pagina è visivamente stabile. La documentazione
// ufficiale di Playwright sconsiglia esplicitamente `waitForLoadState`
// con "networkidle" come indicatore di stabilità, perché una singola
// connessione mantenuta aperta a lungo (aggiornamenti in tempo reale,
// heartbeat di una connessione websocket) può impedire che quella
// condizione si verifichi mai, facendo attendere inutilmente fino al
// tempo massimo consentito. Osservare i cambiamenti reali del contenuto
// della pagina, invece del traffico di rete, non soffre di questo
// problema. Se la pagina naviga o si ricarica proprio mentre è in corso
// questa attesa, l'osservazione viene interrotta: si procede comunque,
// invece di far fallire l'intero processo per un'attesa accessoria.
export async function waitForDomStability(page, { idleMs = 500, timeoutMs = 90_000 } = {}) {
  try {
    await page.evaluate(
      ({ idleMs, timeoutMs }) =>
        new Promise((resolve) => {
          let idleTimer;
          let hardTimer;
          const finish = () => {
            observer.disconnect();
            clearTimeout(idleTimer);
            clearTimeout(hardTimer);
            resolve();
          };
          const scheduleIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(finish, idleMs);
          };
          const observer = new MutationObserver(scheduleIdle);
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
          // Tempo massimo complessivo: una pagina che continua a
          // modificarsi (ad esempio un contatore che si aggiorna ogni
          // secondo) non farebbe mai scattare `scheduleIdle`, quindi
          // serve comunque un limite oltre il quale si procede lo stesso.
          hardTimer = setTimeout(finish, timeoutMs);
          scheduleIdle();
        }),
      { idleMs, timeoutMs }
    );
  } catch {
    // Vedi commento sopra: un'attesa accessoria che fallisce non deve
    // bloccare il resto del processo.
  }
}

// Individua sulla pagina il punto centrale di un elemento identificato da
// un selettore, dopo essersi assicurato che sia visibile nello schermo.
// Serve sia per i click sia per la digitazione nei campi di testo (vedi
// runAction in tools/browser/recordDemoTool.js): in entrambi i casi occorre sapere
// esattamente dove muovere il cursore visibile e quanto è grande
// l'elemento, informazione usata per calcolare quanto tempo dovrebbe
// impiegare un movimento realistico del mouse (tools/browser/humanInteraction.js).
export async function locateActionTarget(page, selector) {
  const locator = page.locator(selector).first();
  // Se l'elemento non è visibile nella parte di schermo attualmente
  // inquadrata (perché la pagina è più lunga dello schermo), lo porta in
  // vista scorrendo la pagina: altrimenti il cursore si muoverebbe verso
  // un punto che non compare nel video.
  await locator.scrollIntoViewIfNeeded({ timeout: 10_000 });
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`Elemento non visibile/non trovato per il selettore: ${selector}`);
  }
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    // Viene usata la dimensione più piccola tra larghezza e altezza
    // dell'elemento: per un campo molto largo ma basso (come una barra di
    // ricerca a piena larghezza), è la sua altezza a determinare quanto sia
    // difficile centrarlo con precisione.
    width: Math.min(box.width, box.height),
  };
}

// Espressione che riconosce solo caratteri sicuri (lettere, numeri,
// trattini) da usare all'interno di un identificatore della pagina: serve
// a evitare che un identificatore contenente caratteri particolari possa
// alterare il significato del selettore costruito con esso.
const SAFE_ATTR_VALUE = /^[a-zA-Z0-9_-]+$/;

// Rende sicuro l'uso di un testo dentro un selettore che richiede
// virgolette, sostituendo i caratteri che altrimenti interromperebbero la
// stringa.
function escapeForQuotedSelector(value) {
  return value.replace(/["\\]/g, "\\$&");
}

// Costruisce, a partire da un elemento individuato sulla pagina, un modo
// affidabile per farvi riferimento in seguito. Ordine di preferenza: prima
// un identificativo univoco dell'elemento (se presente e sicuro da usare),
// poi un'etichetta descrittiva pensata per l'accessibilità, poi il ruolo
// dell'elemento combinato con il suo testo, infine il solo testo visibile.
// Se nessuna di queste informazioni è utilizzabile con sicurezza, restituisce
// "nessun riferimento disponibile": in quel caso l'elemento viene scartato
// dalla lista piuttosto che essere referenziato in un modo che potrebbe
// risultare ambiguo o errato.
function buildSelector(el) {
  if (el.id && SAFE_ATTR_VALUE.test(el.id)) {
    return `#${el.id}`;
  }
  if (el.dataTestId && SAFE_ATTR_VALUE.test(el.dataTestId)) {
    return `[data-testid="${el.dataTestId}"]`;
  }
  if (el.ariaLabel) {
    return `[aria-label="${escapeForQuotedSelector(el.ariaLabel)}"]`;
  }
  if (el.role && el.text) {
    return `role=${el.role}[name="${escapeForQuotedSelector(el.text)}"]`;
  }
  if (el.text) {
    return `text="${escapeForQuotedSelector(el.text)}"`;
  }
  return null;
}

// Analizza la pagina reale ed estrae l'elenco degli elementi visibili con
// cui si può interagire (pulsanti, link, campi di input), con un
// riferimento pronto all'uso per ciascuno. Questo elenco è ciò che permette
// all'agente che sceglie le interazioni (ai/agents/directorAgent.js) di
// basarsi su ciò che esiste realmente sulla pagina, invece di indovinare
// elementi che potrebbero non corrispondere a nulla di reale.
export async function extractInteractiveElements(page) {
  // Questa parte di codice viene eseguita direttamente dentro la pagina
  // web (nel browser), non nel programma Node: per questo ha accesso al
  // contenuto della pagina, ma non alle altre variabili di questo file. Il
  // riferimento finale per ogni elemento (buildSelector) viene invece
  // costruito fuori, lato programma, dove le regole di sicurezza sono
  // definite una volta sola.
  const rawElements = await page.evaluate(() => {
    const SELECTOR =
      'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [onclick]';
    return Array.from(document.querySelectorAll(SELECTOR))
      .filter((el) => {
        // Scarta gli elementi non visibili: non avrebbe senso mostrarli in
        // un video né sarebbe possibile interagirci.
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      })
      .slice(0, 40) // limite di sicurezza per pagine molto ricche di elementi
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || undefined,
        id: el.id || undefined,
        dataTestId: el.getAttribute("data-testid") || undefined,
        role: el.getAttribute("role") || undefined,
        ariaLabel: el.getAttribute("aria-label") || undefined,
        placeholder: el.getAttribute("placeholder") || undefined,
        text: (el.innerText || el.value || "").trim().slice(0, 60) || undefined,
      }));
  });

  // Il riferimento finale per ogni elemento viene calcolato qui, e gli
  // elementi per cui non è stato possibile costruirne uno affidabile
  // vengono scartati: è preferibile un elenco più corto ma sicuro rispetto
  // a uno completo ma con riferimenti poco affidabili.
  return rawElements
    .map((el) => ({
      selector: buildSelector(el),
      tag: el.tag,
      type: el.type,
      // Etichetta descrittiva pensata per essere letta e compresa
      // dall'agente che sceglie le interazioni, separata dal riferimento
      // tecnico usato per raggiungere l'elemento.
      label: el.text || el.ariaLabel || el.placeholder || el.tag,
    }))
    .filter((el) => el.selector !== null)
    .slice(0, 30);
}

// Misura quanto contenuto della pagina resta fuori dalla parte
// attualmente visibile dello schermo, sia sotto sia sopra. Questa
// informazione permette all'agente che sceglie le interazioni di sapere
// con certezza se scorrere la pagina rivelerebbe davvero altro contenuto,
// invece di doverlo supporre.
export async function getPageOverflowInfo(page) {
  return page.evaluate(() => {
    const scrollHeight = document.documentElement.scrollHeight;
    const viewportHeight = window.innerHeight;
    const scrollY = window.scrollY;
    return {
      viewportHeight,
      scrollHeight,
      scrollY,
      // Quantità di contenuto non ancora mostrata sotto la parte visibile
      // attuale dello schermo. Non può mai essere negativa.
      pxBelowFold: Math.max(0, scrollHeight - viewportHeight - scrollY),
      // Lo stesso, ma per il contenuto sopra la parte visibile attuale:
      // rilevante solo dopo che la pagina è già stata scorsa in precedenza.
      pxAboveFold: Math.max(0, scrollY),
    };
  });
}
