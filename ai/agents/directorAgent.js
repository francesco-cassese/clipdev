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
import { invokeAgentWithRetry } from "./invokeWithRetry.js";

// Forma della risposta richiesta al Director Agent: UNA sola interazione
// per chiamata (o null). Non un lotto di più azioni pianificate in
// anticipo: verificato contro fonti primarie (repository ufficiali, non
// riassunti di terzi) che questo è il pattern che gli strumenti reali di
// automazione browser guidata da agenti usano — il server MCP ufficiale di
// Microsoft per Playwright (github.com/microsoft/playwright-mcp) espone
// tool che eseguono ciascuno un'unica azione discreta, senza restituire
// automaticamente un nuovo snapshot (va richiesto di nuovo esplicitamente
// prima della decisione successiva); Stagehand di Browserbase
// (github.com/browserbase/stagehand) dichiara esplicitamente nel proprio
// README "Use act() to execute individual actions", con observe() che
// restituisce candidati senza mai eseguirli. Il motivo per cui conviene
// anche qui: un lotto di più azioni decise insieme si basa per forza su uno
// stato della pagina che esisteva PRIMA che la prima azione del lotto fosse
// davvero eseguita — esattamente la causa di due difetti osservati
// concretamente in produzione con lo schema a lotti precedente (un filtro
// impostato seguito dall'apertura di un prodotto scelto dalla lista non
// ancora filtrata; un'attesa passiva scelta al posto di un click reale). Un
// action alla volta, con la pagina ri-osservata per davvero prima di ogni
// decisione successiva (vedi planNextDirectorAction più sotto), rende
// questi difetti strutturalmente impossibili invece di scoraggiati da una
// regola nel prompt che il modello può comunque non seguire.
const DirectorPlanSchema = z.object({
  action: ActionSchema.nullable(),
});

// Tempo massimo concesso a ogni singola richiesta di questo agente. È più
// basso di quello usato per Analyst e Copywriter perché questa richiesta
// può avvenire anche a registrazione già iniziata (durante la fase di
// scelta di eventuali interazioni aggiuntive): un tempo di attesa troppo
// lungo qui non allungherebbe solo un'elaborazione interna, ma il video
// stesso.
const DIRECTOR_CALL_TIMEOUT_MS = 30_000;

// Prompt volutamente corto e assertivo (dire cosa fare, non elencare ogni
// caso da evitare): con un modello veloce come quello usato qui (vedi
// directorModel in ai/models/anthropic.js) un prompt lungo pieno di
// eccezioni produce risultati meno affidabili di poche regole nette, non di
// più — le protezioni che contano davvero (niente azioni pericolose, niente
// selettori ripetuti) sono comunque applicate anche nel codice (vedi
// isActionSafe più sotto e pipeline/clipDevPipeline.js), non lasciate alla
// sola aderenza del modello al testo del prompt.
const DIRECTOR_SYSTEM_PROMPT = `
Sei il Director Agent di ClipDev: scegli, UN PASSO ALLA VOLTA, la prossima
interazione reale da mostrare durante la registrazione di una demo per
LinkedIn (15-30 secondi totali). Dopo ogni tua scelta, l'azione viene
eseguita per davvero e vieni interpellato di nuovo con lo stato REALE della
pagina a quel punto — non stai pianificando in anticipo, stai decidendo solo
il passo immediatamente successivo.

INPUT: obiettivo e sezioni dell'outline (ordine di priorità suggerito, non
vincolante — vedi regola 2), elenco di elementi REALMENTE presenti sulla
pagina ADESSO (ciascuno con un selettore Playwright già pronto all'uso), ed
eventuali azioni GIÀ ESEGUITE nei passi precedenti di questa stessa
esplorazione.

COMPITO: restituisci UNA sola azione (click, fill, drag, scroll, o — solo
nel raro caso della regola 11 — wait/waitForSelector) che faccia avanzare di
un passo concreto la demo, oppure null se non c'è più nulla di pertinente da
aggiungere: un workflow breve ma pulito batte un
tentativo di coprire tutto.

REGOLE
1. Usa SOLO i selettori dell'elenco fornito ADESSO. Non inventarne mai uno,
   e non riusare un selettore già tra le azioni GIÀ ESEGUITE.
2. L'ordine delle sezioni è un suggerimento, non un vincolo: se il
   contenuto della sezione più importante non è ancora visibile ma un
   elemento visibile (es. un link di navigazione legato a una sezione
   successiva) permette di raggiungerlo, scegli PRIMA quel click — è un
   passo strumentale valido, non un motivo per restituire null. Restituisci
   null SOLO se nessun percorso reale, nemmeno indiretto, porta a nessuna
   sezione dell'outline.
3. Se scegli di aprire un pannello/menu/filtro, fermati lì per questo
   passo: nel turno successivo vedrai per davvero cosa contiene (se
   qualcosa è comparso) e potrai scegliere se selezionare un'opzione reale
   al suo interno o lasciarlo così com'è — non decidere ora cosa fare dopo,
   non lo sai ancora.
4. Su un campo di testo (textbox/searchbox/combobox) non scegliere MAI
   "click" come passo a sé: "fill" include già il click che lo mette a
   fuoco, quindi un "click" separato su quello stesso campo non fa
   avanzare la demo di un solo passo — è un passo sprecato che, per la
   regola 1, ti impedirà anche di riusarlo dopo per il "fill" vero. Scegli
   direttamente "fill" per il campo, il "click" collegato che lo invia è
   sempre un passo successivo separato, mai lo stesso. "drag" (mai "click")
   per gli slider; targetPercent è relativo (0-100), non un valore
   assoluto. Per uno slider che filtra/restringe un elenco (es. un budget
   massimo), evita gli estremi (vicino a 0 o a 100): rischiano di azzerare
   i risultati, mostrando uno stato vuoto invece dell'elenco filtrato che
   la sezione vuole dimostrare. Preferisci un valore intermedio
   (indicativamente 40-70), salvo che l'outline chieda esplicitamente di
   mostrare un limite o uno stato vuoto.
5. Dopo un'azione che cambia un elenco di risultati (drag su uno slider di
   prezzo, fill+invio di una ricerca, click su un'opzione di
   ordinamento/filtro), l'elenco di elementi che ricevi nel turno
   successivo riflette GIÀ quel cambiamento: solo allora, guardando quel
   nuovo elenco (mai presumendolo), puoi scegliere un elemento specifico al
   suo interno (es. aprire un prodotto).
6. "scroll" solo se il messaggio "Contenuto sotto la piega" conferma che
   c'è davvero altro da vedere — mai altrimenti.
7. Non scegliere mai un'azione la cui etichetta sembri distruttiva o
   irreversibile (elimina, logout, pagamento, invia ordine): in caso di
   dubbio, restituisci null.
8. Aggiungi sectionNumber solo se l'azione dimostra chiaramente una sezione
   dell'outline; omettilo per un'azione solo strumentale (vedi regola 2).
9. Restituisci null solo quando nessuna azione ulteriore è pertinente: un
   video statico ma pulito batte interazioni scelte a caso.
10. Un'azione che avvia un'elaborazione (Genera/Invia/Cerca/Salva...) non
    richiede alcuna attesa esplicita da parte tua: il sistema attende già
    automaticamente il risultato prima di interpellarti di nuovo, quindi il
    turno successivo vedrà già l'esito, non uno stato intermedio.
11. "wait"/"waitForSelector" non ti servono quasi mai, proprio per il
    motivo della regola 10: il sistema attende già da solo il risultato di
    ogni azione prima di richiamarti. Usa "waitForSelector" SOLO nel raro
    caso di un elemento che potrebbe comparire dopo un'elaborazione
    insolitamente lenta — mai per un elemento GIÀ presente nell'elenco: se
    è già lì e visibile, l'interazione giusta è quella vera (click, fill,
    drag), non un'attesa che non fa avanzare la demo di un solo passo.
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
  // Un elemento con ruolo "slider" (vedi INTERACTIVE_ROLES in
  // tools/browser/pageInspection.js) si aziona SOLO trascinandolo: un
  // "click" su di esso non sposta il valore (nessun evento di drag reale
  // parte da un singolo click) e produce un'interazione che non mostra
  // alcun cambiamento. La regola 4 del prompt chiede già di usare "drag" e
  // mai "click" per gli slider, ma qui viene applicata anche come controllo
  // di codice indipendente — stesso principio già usato sopra per
  // DANGEROUS_LABEL_PATTERN — perché un'istruzione testuale può non essere
  // seguita in ogni singolo caso da un modello linguistico, mentre un
  // controllo deterministico lo è sempre. Per lo stesso motivo, l'inverso
  // (un'azione "drag" su un elemento che non è uno slider) viene scartato
  // qui invece di lasciarlo fallire più avanti a registrazione già iniziata
  // (readSliderRange in tools/browser/humanInteraction.js si aspetta un
  // vero slider).
  if (matchedElement.tag === "slider" && action.type !== "drag") {
    return false;
  }
  if (action.type === "drag" && matchedElement.tag !== "slider") {
    return false;
  }
  return !DANGEROUS_LABEL_PATTERN.test(matchedElement.label);
}

// Funzione principale richiamata dal programma che coordina il processo:
// costruisce le istruzioni da inviare al Director Agent a partire
// dall'outline e dagli elementi reali della pagina ADESSO, interpella
// l'agente per UNA sola azione e la restituisce solo se supera il
// controllo di sicurezza sopra — altrimenti null, esattamente come quando
// l'agente stesso decide di non proporre nulla. Non interrompe mai
// l'esecuzione per una scelta non valida: chi chiama tratta null come "per
// questo passo non c'è nulla da aggiungere", coerente con il fatto che un
// video con meno interazioni del previsto resta un risultato accettabile.
//
// Chi chiama è responsabile di ri-osservare per davvero la pagina (nuovo
// elenco di elementi, nuovo overflow) dopo aver eseguito l'azione
// restituita, prima di richiamare questa funzione per il passo successivo
// — mai di dedurre lo stato successivo dal solo tipo di azione appena
// eseguita. `previousActions` esiste solo per dire all'agente cosa è già
// stato mostrato (ed evitare selettori ripetuti), non per fargli
// ricostruire da solo lo stato attuale della pagina: quello arriva sempre
// da `elements`/`overflow`, misurati di nuovo ogni volta.
export async function planNextDirectorAction({ outline, elements, previousActions = [], overflow = null }) {
  if (!elements || elements.length === 0) {
    // Se la pagina non ha alcun elemento con cui interagire (una pagina
    // statica, o il cui contenuto non è raggiungibile in questo modo),
    // non ha senso interpellare l'agente: non ci sarebbe comunque nulla
    // tra cui scegliere.
    return null;
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
      `Azioni GIÀ ESEGUITE nei passi precedenti di questa esplorazione (non ripeterle):\n${previousActionsDescription}`
    );
  }

  const prompt = promptParts.join("\n\n");

  const result = await invokeAgentWithRetry(
    directorAgent,
    { messages: [{ role: "user", content: prompt }] },
    { timeout: DIRECTOR_CALL_TIMEOUT_MS }
  );
  const proposedAction = result.structuredResponse?.action ?? null;
  if (!proposedAction) return null;

  // Un'azione che non supera il controllo di sicurezza viene trattata come
  // se l'agente non avesse proposto nulla: un solo passo scartato non deve
  // far fallire l'intera esplorazione.
  return isActionSafe(proposedAction, elements) ? proposedAction : null;
}

export default directorAgent;
