// ai/agents/copywriterAgent.js
//
// Agente "Copywriter" del sistema ClipDev: il terzo e ultimo agente basato
// su intelligenza artificiale. Riceve la scaletta prodotta dall'Analyst e
// la trasforma nel testo di un post pronto per essere pubblicato su
// LinkedIn.

import { createAgent } from "langchain";
import * as z from "zod";
import { copywriterModel } from "../models/anthropic.js";

// Istruzioni che definiscono il comportamento dell'agente, tenute separate
// dal resto della configurazione per gli stessi motivi già visti per
// l'Analyst.
// Prompt corto e assertivo, stessa motivazione di ai/agents/directorAgent.js
// e ai/agents/analystAgent.js.
const COPYWRITER_SYSTEM_PROMPT = `
Sei il Copywriter Agent di ClipDev: trasformi l'outline dell'Analyst Agent
in DUE varianti di post LinkedIn pronte per la pubblicazione.

TONO: professionale ma accessibile (developer, recruiter, founder).
Autentico, mai clickbait.

GANCIO (regola più importante, vale per ENTRAMBE le varianti)
Le prime 1-2 righe sono l'unica parte visibile prima del "vedi altro":
devono sollevare una sfida tecnica concreta o un insight architetturale
tratto dall'outline (un tradeoff, un vincolo non ovvio) — MAI una formula da
annuncio aziendale ("Excited to share", "Oggi vi mostro", "Ho il piacere di
presentare") né un'emoji decorativa in apertura.

VARIANTI (stesso outline, nessuna invenzione)
- A — Ingegneristica/Storytelling: una scelta architetturale o un tradeoff
  reale (usa technicalHighlights come materiale primario). Pubblico tecnico:
  developer, tech lead.
- B — Product Showcase: il beneficio per chi usa il prodotto e la fluidità
  mostrata nel video. Pubblico più ampio, anche non tecnico.
Le due varianti devono restare chiaramente diverse nell'apertura e
nell'angolazione, non riformulate una sull'altra.

CHIUSURA (obbligatoria per entrambe)
1. Una domanda tecnica aperta che stimoli il dibattito nei commenti,
   coerente con l'angolazione della variante — mai generica ("Cosa ne
   pensate?" senza un aggancio tecnico specifico).
2. L'indicazione esplicita che il link al repository si trova nel primo
   commento (mai un URL scritto direttamente nel testo del post).

OUTPUT ATTESO (per ciascuna variante)
Post LinkedIn completo in italiano, 800-1300 caratteri, paragrafi brevi
(2-4 righe). Hashtag pertinenti (massimo 5), solo in fondo, dopo la
chiusura.

LIMITI OPERATIVI
- Non inventare funzionalità, metriche o dettagli tecnici assenti
  nell'outline: puoi solo riformulare, enfatizzare e contestualizzare ciò
  che è stato fornito.
- Non modificare l'ordine logico delle sezioni stabilito dall'Analyst Agent.
- Non produrre outline: è compito esclusivo dell'Analyst Agent.
`.trim();

// Forma della risposta richiesta al Copywriter Agent: due varianti
// complete e indipendenti, invece di un unico testo libero da cui
// bisognerebbe poi separare le due parti con un'analisi testuale fragile.
// Costringere anche questo agente a un formato strutturato (come già fanno
// Analyst e Director, vedi ai/agents/analystAgent.js e
// ai/agents/directorAgent.js) mantiene coerente in tutta la pipeline il
// principio per cui ogni scambio tra agenti e strumenti passa da uno schema
// Zod, non da testo da interpretare.
const CopywriterVariantSchema = z.object({
  post: z.string().min(1, "Il testo del post non può essere vuoto"),
});

const CopywriterOutputSchema = z.object({
  variantA: CopywriterVariantSchema,
  variantB: CopywriterVariantSchema,
});

// Il modello linguistico usato da questo agente è condiviso con gli altri
// due (definito, insieme alla motivazione della sua configurazione, in
// ai/models/anthropic.js).
export const copywriterAgent = createAgent({
  // Nome che identifica questo agente all'interno del programma.
  name: "clipdev-copywriter",

  model: copywriterModel,

  systemPrompt: COPYWRITER_SYSTEM_PROMPT,

  // Come per l'Analyst, questo agente non usa alcuno strumento aggiuntivo:
  // il salvataggio del risultato è gestito dal programma che coordina
  // l'intero processo, non da questo agente.
  tools: [],

  // Obbliga la risposta a contenere entrambe le varianti già nella forma
  // finale attesa (vedi CopywriterOutputSchema sopra), così il programma
  // che coordina il processo (pipeline/clipDevPipeline.js) può salvarle
  // entrambe senza dover interpretare un testo libero.
  responseFormat: CopywriterOutputSchema,
});

export default copywriterAgent;
