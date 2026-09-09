// ai/agents/directorAgent.js
//
// Agente "Director" del sistema ClipDev: il secondo dei tre agenti basati
// su intelligenza artificiale. A differenza degli altri due, non scrive
// testo per un pubblico: decide quali interazioni mostrare durante la
// registrazione del video (tools/browser/recordDemoTool.js), scegliendole solo tra
// gli elementi realmente presenti sulla pagina — mai inventati — per
// evitare che venga scelta un'interazione su un elemento che in realtà non
// esiste. È un agente separato dagli altri due perché il suo compito
// (scegliere interazioni concrete su una pagina reale) non ha nulla a che
// vedere con l'analisi dei requisiti o la scrittura del post.

import { createAgent } from "langchain";
import { directorModel } from "../models/anthropic.js";
import * as z from "zod";

// Riusa la stessa struttura che descrive un'interazione valida, definita
// in tools/browser/recordDemoTool.js: la stessa struttura descrive sia
// l'interazione scelta da questo agente sia quella effettivamente
// eseguita durante la registrazione, senza bisogno di due definizioni
// separate.
import { ActionSchema } from "../../tools/browser/recordDemoTool.js";

// Forma della risposta richiesta al Director Agent: un breve elenco di
// interazioni. Il limite di 6 è intenzionalmente basso ed è coerente con
// la durata di 15-30 secondi indicata all'Analyst Agent: più interazioni
// di così, in un video così breve, produrrebbero un ritmo confuso invece
// di una demo pulita.
const DirectorPlanSchema = z.object({
  actions: z.array(ActionSchema).max(6),
});

// Tempo massimo concesso a ogni singola richiesta di questo agente. È più
// basso di quello usato per Analyst e Copywriter perché questa richiesta
// può avvenire anche a registrazione già iniziata (durante la fase di
// scelta di eventuali interazioni aggiuntive): un tempo di attesa troppo
// lungo qui non allungherebbe solo un'elaborazione interna, ma il video
// stesso.
const DIRECTOR_CALL_TIMEOUT_MS = 30_000;

const DIRECTOR_SYSTEM_PROMPT = `
Sei il Director Agent del sistema ClipDev: ragioni come un "LinkedIn 2026
Tech Video Director", unendo l'occhio di un Senior Tech Recruiter (riconosce
al volo cosa dimostra competenza ingegneristica reale) e quello di un Growth
Hacker specializzato nell'algoritmo LinkedIn (sa cosa trattiene lo scroll nei
primi secondi).

RUOLO
Ricevi in input l'outline del video prodotto dall'Analyst Agent e un elenco
di elementi REALMENTE presenti sulla pagina web che sta per essere
registrata (bottoni, link, campi di input, cursori/slider), ciascuno con un
selettore Playwright già pronto all'uso. Il tuo compito è scegliere una
breve sequenza di azioni (click, fill, drag, wait, waitForSelector, scroll)
da eseguire durante la registrazione, per mostrare al meglio il progetto in
modo coerente con quanto descritto nell'outline.

TONO
Pratico e concreto: non stai scrivendo testo per un pubblico, stai
pianificando un'interazione tecnica su una pagina reale.

FASE 1 — DISCOVERY DELLA KILLER FEATURE
Prima di scegliere le azioni, individua l'UNICA funzionalità che dimostra la
maggiore complessità ingegneristica reale (gestione dello stato, CRUD,
flusso asincrono, UI/UX non banale) tra quelle descritte nell'outline E
effettivamente raggiungibili con gli elementi che hai a disposizione — non
ha senso puntare a una sezione dell'outline se nessun elemento reale la
rende eseguibile. Le sezioni dell'outline sono un ordine "suggerito", non
vincolante: se un'altra sezione, meno prioritaria nell'outline ma più
dimostrabile con gli elementi reali presenti, produce una sequenza più
efficace, preferisci quella. Un solo workflow lineare (punto A -> punto B)
mostrato bene vale più di un elenco di funzionalità diverse toccate a metà.

LIMITI OPERATIVI (fondamentali, hanno priorità su tutto il resto)
- MICRO-HOOK: lo scroll su LinkedIn è velocissimo. Non aprire la sequenza
  con azioni su campi di login/registrazione/onboarding a meno che
  l'autenticazione stessa non sia la killer feature del progetto: la pagina
  iniziale deve mostrare, o rendere raggiungibile in 1-2 azioni, la
  funzionalità di maggior valore individuata in FASE 1.
- SHOW, DON'T TELL: preferisci sempre una sequenza che porta a termine UN
  workflow completo e coerente rispetto a toccare più funzionalità
  scollegate tra loro — meglio mostrare bene una cosa che accennarne tre.
- INQUADRATURA: il video viene registrato a piena pagina (1920x1080); a
  parità di efficacia, preferisci elementi posizionati nella parte centrale
  dello schermo (non ai margini/agli angoli estremi) cosi la sequenza regge
  bene anche se il clip verrà poi ricentrato/croppato in un formato
  verticale per il feed mobile.
- Usa ESCLUSIVAMENTE i selettori presenti nella lista fornita. Non
  inventare MAI un selettore che non compare in quella lista, anche se ti
  sembra plausibile che esista sulla pagina.
- Non scegliere MAI un'azione il cui elemento sembra distruttivo,
  irreversibile o sensibile: eliminare/cancellare/rimuovere qualcosa,
  effettuare il logout, confermare un pagamento, inviare un ordine reale.
  Se hai un dubbio sul significato di un elemento, NON selezionarlo.
- Preferisci azioni che mostrano visivamente il valore del progetto
  (aprire una sezione, compilare un campo con un dato di esempio
  plausibile, cliccare su una funzionalità chiave) rispetto ad azioni
  neutre o puramente esplorative.
- Se un campo di testo va compilato prima di un click correlato (es. un
  form di ricerca prima del bottone "Cerca"), inserisci la "fill" PRIMA
  del "click" corrispondente, nell'ordine in cui devono essere eseguite.
- Ogni azione (di qualunque tipo) può includere sectionNumber: il numero
  (a partire da 1) della sezione dell'outline — tra quelle elencate in
  "Sezioni del video" più sotto, con la stessa numerazione — che
  quell'azione sta dimostrando. Indicalo SEMPRE quando l'azione dimostra
  chiaramente una sezione precisa: viene usato per sincronizzare le
  callout testuali al momento reale in cui ciascuna sezione compare nel
  video, non a una stima. Se un'azione è solo strumentale (es. aprire un
  menu prima del vero passaggio dimostrativo) e non rappresenta da sola
  nessuna sezione precisa, ometti pure sectionNumber per quell'azione.
- Massimo 6 azioni: il video target è di 15-30 secondi (linee guida
  ufficiali LinkedIn), non c'è spazio per una sequenza lunga. Se non trovi
  elementi sensati da usare per l'outline fornito, restituisci un elenco
  vuoto piuttosto che forzare azioni non pertinenti: un video "statico" ma
  pulito è meglio di uno con interazioni a caso.
- Non usare mai "wait" con timeoutMs superiore a 2000: è una pausa cieca
  che allunga il video senza mostrare nulla di nuovo, usala solo per
  lasciare respirare una transizione/animazione.
- "scroll" (direction: "up"/"down", amount: "small"/"medium"/"large") non
  ha un selettore: usala SOLO quando il messaggio "Contenuto SOTTO la piega"
  nel prompt conferma che c'è davvero altro non ancora visibile (è una
  misura reale del DOM, non una tua supposizione) — se dice che non c'è
  nulla sotto, NON scegliere "scroll", indipendentemente da cosa suggerisce
  l'outline. Non basta però che ci sia QUALCOSA sotto la piega: se la
  percentuale indicata è piccola (meno di circa un terzo del viewport,
  tipicamente un residuo di poche righe), scorrere non rivelerebbe
  abbastanza da giustificare l'interruzione — non usare "scroll" in quel
  caso. Quando invece la percentuale è ampia, usala comunque con
  parsimonia e solo se è funzionale a un'azione successiva della stessa
  sequenza (es. serve a portare in vista una lista di elementi tra cui poi
  scegli cosa cliccare, o precede un'azione su un elemento più in basso):
  non sceglierla come gesto isolato "per far vedere che c'è altro" se poi
  la sequenza non ci fa nulla — un "medium" verso il basso è quasi sempre
  la scelta giusta quando è davvero funzionale al resto della sequenza.
- "drag" (selector, targetPercent: 0-100) serve per i cursori di prezzo/gli
  slider (elementi con ruolo "slider" nell'elenco): NON usare "click" per
  spostarne il valore (al più apre un pannello, non lo sposta) né "fill"
  (un cursore non si digita). targetPercent è una posizione relativa lungo
  il range del controllo (0 = minimo, 100 = massimo), non un valore assoluto
  — non puoi conoscere i valori min/max reali dell'elemento, vengono letti
  dal DOM al momento dell'esecuzione. Scegli un valore che produca un
  effetto visibile e dimostrabile (tipicamente un valore intermedio, non 0
  o 100 salvo che l'outline chieda esplicitamente di mostrare un estremo).
- Se un click innesca un'operazione che richiede tempo per completarsi (un
  bottone con testo tipo "Genera", "Invia", "Crea", "Salva", "Cerca" o
  simile — qualunque cosa avvii un'elaborazione lato server, non un'azione
  istantanea come aprire un menu), quel click deve essere SEMPRE l'ULTIMA
  azione della sequenza. Il Director Tool aspetta che il risultato compaia
  prima di terminare la registrazione: se dopo quel click pianifichi
  un'altra azione (es. cambiare scheda per "mostrare dove finirà il
  risultato"), la pagina cambia PRIMA che il risultato sia pronto, e il
  video finisce per mostrare una schermata ferma e SBAGLIATA (non il
  risultato dell'azione generativa, che nel frattempo continua a caricare
  fuori vista) per la maggior parte della sua durata — un difetto grave,
  osservato concretamente in una registrazione reale di questo strumento.

RIPIANIFICAZIONE (può capitare che tu venga interpellato una seconda volta)
A volte ricevi in input anche un elenco di azioni GIÀ ESEGUITE in un turno
precedente: in quel caso l'elenco di elementi che ricevi non descrive più la
pagina "com'era all'inizio", ma la pagina COM'È ADESSO, dopo quelle azioni
(es. dopo aver cliccato un bottone "Genera", potresti vedere comparire un
link o un messaggio di conferma che prima non esisteva). Il tuo compito in
quel turno è SOLO decidere se c'è un'azione aggiuntiva sensata per mostrare
meglio l'esito appena ottenuto (tipicamente: aprire/cliccare un elemento di
conferma o risultato comparso solo ora) — non ripetere azioni già fatte, non
inventare interazioni per riempire la sequenza. Se la pagina attuale mostra
già bene il risultato, o non c'è nulla di utile da aggiungere, restituisci un
elenco vuoto: è l'esito corretto e atteso nella maggior parte dei casi. Se
decidi di aggiungere qualcosa, massimo 2 azioni.
`.trim();

// Il modello linguistico usato da questo agente è condiviso con gli altri
// due (definito, insieme alla motivazione della sua configurazione, in
// ai/models/anthropic.js).
export const directorAgent = createAgent({
  name: "clipdev-director",
  model: directorModel,
  systemPrompt: DIRECTOR_SYSTEM_PROMPT,
  // Questo agente non esegue nulla direttamente: si limita a decidere un
  // piano di interazioni. L'esecuzione vera e propria è affidata al
  // programma che coordina l'intero processo, che riceve questo piano e
  // lo mette in atto.
  tools: [],
  responseFormat: DirectorPlanSchema,
});

// Elenco di parole (in italiano e in inglese) che indicano un'azione
// potenzialmente pericolosa o irreversibile su un'applicazione reale.
// Questo è un controllo di sicurezza aggiuntivo rispetto alle istruzioni
// già date all'agente: anche se le istruzioni scoraggiano esplicitamente
// azioni di questo tipo, un controllo automatico indipendente riduce
// ulteriormente il rischio che una scelta indesiderata venga comunque
// eseguita.
const DANGEROUS_LABEL_PATTERN =
  /delete|remove|elimina|cancella|rimuovi|logout|esci|disconnetti|sign\s*out|reset|annulla|pay|paga|checkout|acquista|invia ordine|conferma ordine|submit order/i;

// Verifica che un'interazione proposta dal Director Agent sia
// effettivamente sicura da eseguire: l'elemento indicato deve corrispondere
// a uno realmente presente nell'elenco fornito, e la sua etichetta non deve
// suggerire un'operazione pericolosa o irreversibile.
export function isActionSafe(action, elements) {
  if (action.type === "wait" || action.type === "scroll") {
    // Queste due interazioni non fanno riferimento a un elemento
    // specifico della pagina (lo scorrimento agisce sulla pagina intera),
    // quindi sono sempre considerate sicure.
    return true;
  }
  const matchedElement = elements.find((el) => el.selector === action.selector);
  if (!matchedElement) {
    // L'elemento indicato non è tra quelli realmente presenti sulla
    // pagina: molto probabilmente una scelta errata dell'agente, da
    // scartare a prescindere da quanto sembri plausibile.
    return false;
  }
  return !DANGEROUS_LABEL_PATTERN.test(matchedElement.label);
}

// Funzione principale richiamata dal programma che coordina il processo:
// costruisce le istruzioni da inviare al Director Agent a partire
// dall'outline e dagli elementi reali della pagina, interpella l'agente e
// restituisce solo le interazioni che superano il controllo di sicurezza
// sopra. Non interrompe mai l'esecuzione anche se il risultato è vuoto o
// parzialmente scartato: restituisce semplicemente un elenco (anche
// vuoto), coerente con il fatto che un video senza interazioni resta
// comunque un risultato valido.
//
// Quando viene fornito un elenco di interazioni già eseguite in
// precedenza, significa che l'agente viene interpellato una seconda
// volta: in quel caso l'elenco di elementi ricevuto descrive lo stato
// della pagina dopo quelle interazioni, non lo stato iniziale. Questo
// permette all'agente di scoprire — e usare — un elemento comparso sulla
// pagina solo in seguito a un'interazione precedente, senza mai dover
// indovinare un riferimento a un elemento prima che esista realmente.
export async function planDirectorActions({ outline, elements, previousActions = [], overflow = null }) {
  if (!elements || elements.length === 0) {
    // Se la pagina non ha alcun elemento con cui interagire (una pagina
    // statica, o il cui contenuto non è raggiungibile in questo modo),
    // non ha senso interpellare l'agente: non ci sarebbe comunque nulla
    // tra cui scegliere.
    return [];
  }

  const elementsDescription = elements
    .map((el, index) => {
      const typeInfo = el.type ? ` | type: ${el.type}` : "";
      return `${index + 1}. selector: ${el.selector} | tag: ${el.tag}${typeInfo} | label: "${el.label}"`;
    })
    .join("\n");

  const sectionsDescription = outline.sections
    .map((section, index) => `${index + 1}. ${section.title} — ${section.content}`)
    .join("\n");

  const elementsLabel =
    previousActions.length > 0
      ? "Elementi interattivi REALMENTE presenti sulla pagina ADESSO, dopo le azioni già eseguite sotto (usa SOLO questi selettori)"
      : "Elementi interattivi REALMENTE presenti sulla pagina (usa SOLO questi selettori)";

  const promptParts = [
    `Obiettivo del progetto: ${outline.goal}`,
    `Sezioni del video (ordine e priorità suggeriti dall'Analyst Agent; la numerazione qui è quella da usare in sectionNumber):\n${sectionsDescription}`,
    `${elementsLabel}:\n${elementsDescription}`,
  ];

  // Questa informazione viene misurata direttamente sulla pagina reale
  // (non è una supposizione): comunica esplicitamente all'agente se
  // scorrere la pagina rivelerebbe davvero altro contenuto, invece di
  // lasciarlo indovinare dal solo testo dell'outline.
  if (overflow) {
    // Espresso anche come percentuale dell'altezza del viewport (non solo
    // in pixel assoluti): un numero come "128px" da solo non comunica se si
    // tratta di un'eccedenza reale o solo di qualche riga residua — la
    // percentuale permette all'agente di giudicare la differenza (vedi il
    // vincolo sulla soglia minima nel prompt più sotto), invece di dover
    // indovinare cosa significhi in pratica quel valore assoluto.
    const overflowPercent = Math.round((overflow.pxBelowFold / overflow.viewportHeight) * 100);
    const overflowLine =
      overflow.pxBelowFold > 0
        ? `Contenuto SOTTO la piega non ancora mostrato: SI, circa ${Math.round(overflow.pxBelowFold)}px (~${overflowPercent}% dell'altezza del viewport, misurato sul DOM, non una supposizione).`
        : `Contenuto SOTTO la piega non ancora mostrato: NO, la pagina è già interamente visibile nel viewport attuale — uno "scroll" verso il basso non mostrerebbe nulla di nuovo, non usarlo.`;
    promptParts.push(overflowLine);
  }

  if (previousActions.length > 0) {
    const previousActionsDescription = previousActions
      .map((action, index) => `${index + 1}. ${JSON.stringify(action)}`)
      .join("\n");
    promptParts.push(
      `Azioni GIÀ ESEGUITE in questa registrazione (non ripeterle, vedi sezione RIPIANIFICAZIONE):\n${previousActionsDescription}`
    );
  }

  const prompt = promptParts.join("\n\n");

  const result = await directorAgent.invoke(
    { messages: [{ role: "user", content: prompt }] },
    { timeout: DIRECTOR_CALL_TIMEOUT_MS }
  );
  const proposedActions = result.structuredResponse?.actions ?? [];

  // Quando si tratta di una seconda interpellazione (vedi sopra), il
  // numero di interazioni viene comunque limitato a due anche qui nel
  // codice, non solo tramite le istruzioni date all'agente: questo
  // secondo turno serve a rifinire il risultato già mostrato, non a
  // ripartire con una sequenza lunga quanto la prima.
  const cappedActions = previousActions.length > 0 ? proposedActions.slice(0, 2) : proposedActions;

  // Le interazioni che non superano il controllo di sicurezza vengono
  // semplicemente escluse, senza interrompere l'intero processo: un video
  // con meno interazioni del previsto resta un risultato accettabile,
  // mentre bloccare tutto per una singola scelta non valida dell'agente
  // non lo sarebbe.
  return cappedActions.filter((action) => isActionSafe(action, elements));
}

export default directorAgent;
