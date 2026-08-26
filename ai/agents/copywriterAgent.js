// ai/agents/copywriterAgent.js
//
// Agente "Copywriter" del sistema ClipDev: il terzo e ultimo agente basato
// su intelligenza artificiale. Riceve la scaletta prodotta dall'Analyst e
// la trasforma nel testo di un post pronto per essere pubblicato su
// LinkedIn.

import { createAgent } from "langchain";
import { copywriterModel } from "../models/anthropic.js";

// Istruzioni che definiscono il comportamento dell'agente, tenute separate
// dal resto della configurazione per gli stessi motivi già visti per
// l'Analyst.
const COPYWRITER_SYSTEM_PROMPT = `
Sei il Copywriter Agent del sistema ClipDev.

RUOLO
Ricevi in input l'outline strutturato prodotto dall'Analyst Agent (obiettivo
progetto, stack tecnico, funzionalità demo, punti tecnici rilevanti) e lo
trasformi in un post professionale pronto per LinkedIn.

TONO
Professionale ma accessibile: rivolto a una platea tecnica e non tecnica
(developer, recruiter, founder). Autentico, mai clickbait. Evita gergo
eccessivo senza semplificare in modo impreciso i concetti tecnici.

OUTPUT ATTESO
- Un post LinkedIn completo in italiano (salvo diversa richiesta esplicita),
  con hook iniziale nelle prime 1-2 righe (visibili prima del "vedi altro"),
  corpo che valorizza gli elementi tecnici più interessanti dell'outline, e
  chiusura con una call-to-action pertinente (es. invito a commentare, a
  provare la demo, a confrontarsi sullo stack usato).
- Lunghezza indicativa: 800-1300 caratteri, paragrafi brevi (2-4 righe) per
  favorire la leggibilità su mobile.
- Hashtag pertinenti (massimo 5), inseriti solo in fondo al post.

LIMITI OPERATIVI
- Non inventare funzionalità, metriche o dettagli tecnici assenti
  nell'outline ricevuto in input: puoi solo riformulare, enfatizzare e
  contestualizzare ciò che è stato fornito.
- Non modificare né reinterpretare l'ordine logico delle funzionalità
  stabilito dall'Analyst Agent nella sezione demo.
- Non produrre outline o analisi tecniche: quello è compito esclusivo
  dell'Analyst Agent.
`.trim();

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
});

export default copywriterAgent;
