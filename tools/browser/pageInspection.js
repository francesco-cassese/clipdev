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

// Tiene traccia in tempo reale delle richieste di rete generate dalla
// pagina (fetch, script, immagini, ...), per sapere quando un caricamento
// di dati è davvero terminato. Serve come complemento a waitForDomStability
// sopra, non come sostituto: quest'ultima da sola non basta quando una
// pagina, in attesa di un fetch (es. il caricamento di un catalogo
// prodotti), mostra un messaggio di caricamento fisso — il DOM non cambia
// affatto durante l'attesa, quindi risulterebbe "stabile" da subito, ben
// prima che i dati veri siano arrivati (difetto osservato concretamente su
// un progetto reale: la scansione catturava la sola scritta "Caricamento
// prodotti...", zero elementi interattivi). A differenza del
// `waitForLoadState("networkidle")` di Playwright scartato sopra (che
// conta le CONNESSIONI di rete attive), qui si contano le singole
// RICHIESTE tramite i loro eventi di ciclo di vita: una connessione
// WebSocket mantenuta aperta a lungo — come quella usata dai server di
// sviluppo per l'hot-reload — non genera questi eventi e non impedisce mai
// di rilevare la pagina come "ferma".
export function createNetworkIdleTracker(page) {
  let pending = 0;

  const onRequest = () => {
    pending += 1;
  };
  const onSettle = () => {
    pending = Math.max(0, pending - 1);
  };

  page.on("request", onRequest);
  page.on("requestfinished", onSettle);
  page.on("requestfailed", onSettle);

  return {
    stop() {
      page.off("request", onRequest);
      page.off("requestfinished", onSettle);
      page.off("requestfailed", onSettle);
    },
    // Attende finché il numero di richieste in corso non resta a zero per
    // almeno `idleMs` millisecondi consecutivi, fino a un massimo di
    // `timeoutMs`: questo tetto massimo evita un'attesa indefinita su
    // pagine che mantengono connessioni aperte a lungo (ad esempio
    // aggiornamenti continui di dati).
    async waitForIdle(idleMs, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let idleSince = pending === 0 ? Date.now() : null;
      while (Date.now() < deadline) {
        if (pending > 0) {
          idleSince = null;
        } else if (idleSince === null) {
          idleSince = Date.now();
        } else if (Date.now() - idleSince >= idleMs) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}

// Attende che ogni immagine presente in questo momento sulla pagina abbia
// terminato di caricarsi (con successo o con un errore), invece di
// affidarsi solo all'assenza di richieste di rete in corso. Le due cose
// non sempre coincidono: quando una pagina mostra molte immagini caricate
// da un servizio esterno, queste arrivano spesso in modo scaglionato, con
// piccole pause tra l'una e l'altra — pause che l'osservazione della sola
// rete può scambiare per "pagina ferma", facendo terminare l'attesa prima
// che tutte le immagini siano davvero comparse (il difetto concretamente
// osservato: le immagini compaiono a scatti, una alla volta, invece che
// tutte insieme). Un tempo massimo di attesa evita comunque un blocco
// indefinito se un'immagine non termina mai di caricarsi.
export async function waitForImagesToLoad(page, timeoutMs = 15_000) {
  try {
    await page.evaluate(
      (timeoutMs) =>
        Promise.race([
          Promise.all(
            Array.from(document.images)
              .filter((img) => !img.complete)
              .map(
                (img) =>
                  new Promise((resolve) => {
                    img.addEventListener("load", resolve, { once: true });
                    img.addEventListener("error", resolve, { once: true });
                  })
              )
          ),
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]),
      timeoutMs
    );
  } catch {
    // Vedi il commento in waitForDomStability: un'attesa accessoria che
    // fallisce non deve bloccare il resto del processo.
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

// Ruoli di accessibilità che rappresentano di per sé un controllo con cui
// si può interagire (bottoni, link, campi, caselle, interruttori, ...):
// sono gli stessi ruoli che uno screen reader annuncia come "attivabili".
// Un elemento con uno di questi ruoli viene sempre incluso, a prescindere
// da come è stato costruito (tag nativo come <button>, oppure un
// componente custom con l'attributo role corretto).
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "menuitem",
  "option",
  "tab",
  "spinbutton",
  "slider",
]);

// Analizza ogni riga dell'istantanea di accessibilità (vedi
// extractInteractiveElements più sotto) ed estrae solo gli elementi
// realmente utilizzabili: quelli con un ruolo riconosciuto come
// interattivo, oppure — per coprire anche i controlli custom senza un
// ruolo ARIA esplicito (una card cliccabile, una voce di menu fatta con
// un semplice <div>) — quelli che il motore di accessibilità del browser
// segnala esplicitamente come cliccabili tramite `[cursor=pointer]`. Gli
// elementi disabilitati vengono sempre esclusi: non avrebbe senso
// proporli come interazione. Esportata (oltre che usata internamente) per
// poter essere verificata da test automatici mirati, senza dover aprire
// un browser reale solo per controllare la logica di selezione.
const SNAPSHOT_LINE_PATTERN = /-\s+([\w-]+)(?:\s+"([^"]*)")?((?:\s*\[[^\]]*\])*)(?::\s*(.*))?\s*$/;

// Rende sicuro l'uso di un testo dentro un selettore che richiede
// virgolette, sostituendo i caratteri che altrimenti interromperebbero la
// stringa.
function escapeForQuotedSelector(value) {
  return value.replace(/["\\]/g, "\\$&");
}

export function parseInteractiveElementsFromSnapshot(snapshot) {
  const elements = [];
  for (const rawLine of snapshot.split("\n")) {
    const match = rawLine.match(SNAPSHOT_LINE_PATTERN);
    if (!match) continue;
    const [, role, quotedName, attrsBlock, trailingText] = match;

    // La presenza di un riferimento (aria-ref=...) è usata solo per capire
    // se questa riga descrive un elemento concreto della pagina (non un
    // nodo puramente strutturale/testuale): il riferimento in sé NON viene
    // usato come selettore finale, perché è valido solo all'interno della
    // stessa istantanea/pagina in cui è stato generato. La registrazione
    // vera e propria avviene però su una pagina Playwright diversa da
    // quella usata qui per l'ispezione (un nuovo browser context, richiesto
    // da Playwright per attivare la registrazione video): su quella pagina
    // il riferimento non esiste più, e un selettore basato su di esso
    // fallirebbe con un timeout (difetto osservato concretamente). Un
    // selettore per ruolo+nome accessibile o per testo, invece, viene
    // ricalcolato dal vivo ogni volta che è usato, quindi resta valido su
    // qualunque pagina mostri lo stesso contenuto.
    if (!attrsBlock.includes("[ref=")) continue;

    if (/\[disabled\]/.test(attrsBlock)) continue;

    const isPointerCursor = /\[cursor=pointer\]/.test(attrsBlock);
    if (!INTERACTIVE_ROLES.has(role) && !isPointerCursor) continue;

    const name = (quotedName || trailingText || "").trim().slice(0, 60);
    const label = name || role;

    let selector;
    if (INTERACTIVE_ROLES.has(role) && name) {
      // Selettore per ruolo ARIA + nome accessibile: il modo più preciso e
      // portabile di indirizzare un controllo standard (bottone, link,
      // campo, ...), a prescindere da come è stato costruito nel markup.
      selector = `role=${role}[name="${escapeForQuotedSelector(name)}"]`;
    } else if (INTERACTIVE_ROLES.has(role)) {
      // Nessun nome accessibile disponibile (es. una casella di controllo
      // senza etichetta collegata): resta comunque utilizzabile per ruolo,
      // anche se meno preciso in presenza di più elementi con lo stesso
      // ruolo.
      selector = `role=${role}`;
    } else if (name) {
      // Elemento senza un vero ruolo ARIA (una card o una voce di menu
      // cliccabile realizzata con un semplice <div>, individuata solo
      // grazie al cursore a puntatore): il motore "role=" di Playwright non
      // calcola un nome accessibile per il ruolo generico, quindi qui
      // serve un selettore basato sul testo visibile.
      selector = `text="${escapeForQuotedSelector(name)}"`;
    } else {
      continue; // nessun modo affidabile e portabile di indirizzare l'elemento
    }

    elements.push({
      selector,
      tag: role,
      // Etichetta descrittiva pensata per essere letta e compresa
      // dall'agente che sceglie le interazioni, separata dal riferimento
      // tecnico usato per raggiungere l'elemento.
      label,
    });
  }
  return elements.slice(0, 30);
}

// Analizza la pagina reale ed estrae l'elenco degli elementi visibili con
// cui si può interagire (pulsanti, link, campi di input), con un
// riferimento pronto all'uso per ciascuno. Questo elenco è ciò che permette
// all'agente che sceglie le interazioni (ai/agents/directorAgent.js) di
// basarsi su ciò che esiste realmente sulla pagina, invece di indovinare
// elementi che potrebbero non corrispondere a nulla di reale.
//
// A differenza di una scansione manuale del DOM (che riconoscerebbe solo
// gli elementi costruiti in un modo previsto in anticipo — tag noti,
// attributi noti), questa usa l'istantanea di accessibilità di Playwright
// ("mode: ai"): lo stesso identico albero che consulta uno screen reader
// per capire cosa sia davvero interattivo su una pagina. Questo risolve il
// limite più concreto osservato: su progetti che usano componenti custom
// (Web Components con Shadow DOM, card cliccabili senza un vero <button>),
// una scansione basata solo su tag/attributi HTML non trova nulla, perché
// quegli elementi non esistono nel DOM "piatto" interrogabile da
// document.querySelectorAll — mentre l'albero di accessibilità li espone
// comunque, avendoli già risolti per conto proprio.
export async function extractInteractiveElements(page) {
  const snapshot = await page.ariaSnapshot({ mode: "ai", timeout: 15_000 });
  return parseInteractiveElementsFromSnapshot(snapshot);
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
