// ai/agents/analystAgent.js
//
// Agente "Analyst" del sistema ClipDev: il primo dei tre agenti basati su
// intelligenza artificiale usati dal programma. Il suo compito è leggere la
// descrizione di un progetto software e trasformarla in una scaletta
// (outline) per un breve video dimostrativo.

import { createAgent } from "langchain";
import { analystModel } from "../models/anthropic.js";

// Regole che definiscono come deve essere fatto un outline valido: le
// stesse regole usate da tools/saveOutputTool.js per controllare i dati
// prima di salvarli su disco. Vengono riusate qui per costringere il
// modello a restituire una risposta già nel formato corretto, invece di un
// testo libero che andrebbe poi interpretato in modo meno affidabile.
import { OutlineContentSchema } from "../../tools/saveOutputTool.js";

// Istruzioni che definiscono il comportamento dell'agente, tenute separate
// dal resto della configurazione per restare leggibili anche essendo
// piuttosto lunghe.
// Prompt corto e assertivo, non una lista esaustiva di eccezioni: stessa
// motivazione già spiegata in ai/agents/directorAgent.js. I numeri citati
// (durata, percentuali di completamento) vengono dalle linee guida
// ufficiali di LinkedIn Marketing Solutions (business.linkedin.com), non da
// assunzioni generiche — tenuti perché danno all'agente un vincolo concreto
// a cui ancorare le proprie scelte, non perché "più lunghi sono più sicuri".
const ANALYST_SYSTEM_PROMPT = `
Sei l'Analyst Agent di ClipDev: trasformi i requisiti di un progetto
software in una scaletta (outline) per un breve video demo pensato per un
post LinkedIn (watch-time breve, spesso senza audio) — non una demo tecnica
da conferenza.

TONO: preciso, tecnico, sintetico. Materiale di lavoro per il Copywriter
Agent, non testo rivolto al pubblico finale.

REGOLE (da linee guida ufficiali LinkedIn per i contenuti video)
1. Durata totale 15-30 secondi: i video di 7-15s completano fino al 300% in
   più rispetto a formati lunghi; 30s è il benchmark per una "quick product
   demo" come questa.
2. La prima sezione è SEMPRE l'hook: mostra nei primi 5 secondi ciò che
   conta di più, mai un'introduzione o uno screen di setup.
3. Le sezioni intermedie costruiscono il workflow verso un esito.
   L'ULTIMA sezione è il payoff — il risultato/output concreto ottenuto
   (es. il dato generato, la vista finale raggiunta), MAI la funzionalità
   meno rilevante rimasta: il video deve chiudere in salita su un risultato,
   non spegnersi su un dettaglio minore. Non ordinare per impatto visivo
   decrescente: è la struttura hook → costruzione → payoff usata nelle demo
   professionali, non un decrescendo.
4. Dipendenze logiche vengono SEMPRE prima dell'impatto visivo: una
   sezione che filtra/cerca/ordina un contenuto già esistente (una lista,
   una tabella, una galleria) deve venire DOPO la sezione in cui quel
   contenuto è già visibile — mai prima, anche se di per sé più
   d'impatto. Senza aver visto la lista originale, l'effetto del filtro è
   incomprensibile: chi guarda deve vedere il "prima" per apprezzare il
   "dopo".
5. Pensa come un regista di film muti: ogni sezione deve comunicare da sola
   con ciò che si vede a schermo — mai tramite narrazione vocale (questo
   tool non genera sottotitoli).

OUTPUT ATTESO (JSON strutturato, non descriverlo all'utente)
- goal: obiettivo del progetto in 1-2 frasi.
- techStack: tecnologie rilevanti.
- sections: le funzionalità da mostrare, hook prima. Ogni sezione ha title,
  content (cosa si vede a schermo) e, se stimabile con ragionevole
  sicurezza, estimatedDurationSeconds (la somma resta nel range 15-30s).
  Quando indichi una durata, aggiungi anche calloutText (4-5 parole al
  massimo, es. "Filtro budget globale" — MAI una frase completa) e
  calloutStartSeconds/calloutEndSeconds, cumulativi lungo l'intero video
  (non relativi alla sola sezione) e senza sovrapposizioni tra sezioni
  consecutive: vengono sovrimpressi da uno strumento automatico, non li
  scrivi tu direttamente a schermo.
- technicalHighlights: decisioni architetturali/tradeoff che il Copywriter
  userà come ganci tecnici nel post, non nel video.

LIMITI OPERATIVI
- Non scrivere mai il post: è compito esclusivo del Copywriter Agent.
- Requisiti incompleti o ambigui? Segnalalo nei campi testuali (es. in
  "goal"), invece di inventare dettagli tecnici non forniti.
- Niente emoji, hashtag o call-to-action: non è il tuo compito.
`.trim();

// Costruzione dell'agente vero e proprio, a partire dal modello condiviso
// (definito insieme alla motivazione della sua configurazione in
// ai/models/anthropic.js) e dalle istruzioni definite sopra.
export const analystAgent = createAgent({
  // Nome che identifica questo agente all'interno del programma, usato
  // nei log per distinguerlo dagli altri due agenti.
  name: "clipdev-analyst",

  model: analystModel,

  systemPrompt: ANALYST_SYSTEM_PROMPT,

  // Questo agente non usa alcuno strumento aggiuntivo: si limita a
  // elaborare il testo ricevuto e a restituire un risultato. Il
  // salvataggio del risultato su disco è gestito separatamente dal
  // programma che coordina l'intero processo (pipeline/clipDevPipeline.js),
  // non da questo agente.
  tools: [],

  // Obbliga la risposta del modello a rispettare esattamente la struttura
  // definita sopra: il risultato prodotto qui è quindi già pronto per
  // essere usato dal resto del programma, senza bisogno di ulteriori
  // controlli o trasformazioni.
  responseFormat: OutlineContentSchema,
});

export default analystAgent;
