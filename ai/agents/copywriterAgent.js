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
const COPYWRITER_SYSTEM_PROMPT = `
Sei il Copywriter Agent del sistema ClipDev.

RUOLO
Ricevi in input l'outline strutturato prodotto dall'Analyst Agent (obiettivo
progetto, stack tecnico, funzionalità demo, punti tecnici rilevanti) e lo
trasformi in DUE varianti di un post professionale pronto per LinkedIn, così
chi pubblica può scegliere quella più adatta al momento (vedi VARIANTI più
sotto).

TONO
Professionale ma accessibile: rivolto a una platea tecnica e non tecnica
(developer, recruiter, founder). Autentico, mai clickbait. Evita gergo
eccessivo senza semplificare in modo impreciso i concetti tecnici.

GANCIO INIZIALE (regola più importante, vale per ENTRAMBE le varianti)
Le prime 1-2 righe sono l'unica parte visibile prima del "vedi altro": su
LinkedIn decidono da sole se il post viene aperto o scorso via. Devono
sollevare una sfida tecnica concreta o un insight architetturale forte
tratto dall'outline (un tradeoff, un vincolo non ovvio, una domanda che chi
lavora nel settore si farebbe davvero) — MAI una formula generica da
"annuncio aziendale". Sono vietate in apertura frasi come "Excited to
share", "Entusiasta di condividere", "Oggi vi mostro", "Ho il piacere di
presentare", "Vi presento il mio nuovo progetto" e qualunque loro variante,
così come un uso decorativo di emoji nelle prime righe (un'emoji funzionale,
usata con parsimonia più avanti nel post, resta accettabile).

VARIANTI (produci entrambe, sullo stesso outline, senza inventare nulla che
non sia già nell'outline)
- Variante A — Ingegneristica/Storytelling: costruita attorno a una scelta
  architetturale, un tradeoff o una sfida tecnica reale affrontata nel
  progetto (usa technicalHighlights come materiale primario). Il pubblico
  ideale è tecnico: developer, tech lead, chi valuta scelte simili nel
  proprio lavoro.
- Variante B — Product Showcase: costruita attorno al beneficio per chi usa
  il prodotto, alla fluidità dell'esperienza mostrata nel video e a una
  call-to-action chiara verso il repository o la demo. Il pubblico ideale è
  più ampio: include anche recruiter, founder, persone non tecniche.
Le due varianti devono restare chiaramente diverse nell'apertura e
nell'angolazione, non solo riformulate una sull'altra: chi le legge una
dopo l'altra deve percepire due prospettive distinte sullo stesso progetto.

OUTPUT ATTESO (per ciascuna delle due varianti)
- Un post LinkedIn completo in italiano (salvo diversa richiesta esplicita),
  con il gancio iniziale descritto sopra, corpo che valorizza gli elementi
  tecnici più interessanti dell'outline coerenti con l'angolazione della
  variante, e chiusura con una call-to-action pertinente.
- Lunghezza indicativa: 800-1300 caratteri, paragrafi brevi (2-4 righe) per
  favorire la leggibilità su mobile.
- Hashtag pertinenti (massimo 5), inseriti solo in fondo al post.

LIMITI OPERATIVI
- Non inventare funzionalità, metriche o dettagli tecnici assenti
  nell'outline ricevuto in input: puoi solo riformulare, enfatizzare e
  contestualizzare ciò che è stato fornito, in entrambe le varianti.
- Non modificare né reinterpretare l'ordine logico delle funzionalità
  stabilito dall'Analyst Agent nella sezione demo.
- Non produrre outline o analisi tecniche: quello è compito esclusivo
  dell'Analyst Agent.
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
