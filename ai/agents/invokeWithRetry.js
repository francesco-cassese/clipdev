// ai/agents/invokeWithRetry.js
//
// Riprova una chiamata .invoke() a uno dei tre agenti quando fallisce per un
// bug noto e non deterministico di LangChain.js, non per un problema del
// nostro codice o dei nostri prompt: quando la risposta strutturata attesa
// (responseFormat) non supera la validazione al primo tentativo, il
// meccanismo interno di "riparazione" di LangChain può ricostruire male la
// cronologia dei messaggi, lasciando un blocco tool_use senza il suo
// tool_result — Anthropic rifiuta allora la richiesta successiva con un
// errore 400 (vedi l'issue "Structured output does not retry on schema
// validation error", langchain-ai/langchainjs#9426). Osservato concretamente
// su questo progetto: capita anche con il prompt più semplice possibile, non
// solo con prompt lunghi o complessi — e non è mai riproducibile due volte
// di fila con lo stesso prompt (una chiamata identica, ripetuta da una
// conversazione pulita, spesso va a buon fine). Per questo la correzione non
// può stare nel testo del prompt: va assorbita qui, ritentando l'INTERA
// chiamata da zero (mai continuando la cronologia corrotta), così come
// un'implementazione professionale gestirebbe un errore infrastrutturale
// noto invece di continuare a riformulare istruzioni che non c'entrano.
//
// Un timeout (AbortSignal scaduto, messaggio "The operation was aborted due
// to timeout") viene trattato allo stesso modo, non solo il 400 sopra:
// osservato concretamente in un'esecuzione reale del Copywriter Agent, che
// ha esaurito l'intero timeout della chiamata (vedi COPYWRITER_CALL_TIMEOUT_MS
// in pipeline/clipDevPipeline.js) senza mai arrivare a restituire l'errore
// noto qui sopra — molto probabilmente perché proprio il meccanismo di
// "riparazione" interno di LangChain.js, quando scatta, può consumare da
// solo buona parte del tempo a disposizione prima ancora di fallire nel modo
// atteso. A differenza di un problema deterministico (chiave non valida,
// richiesta malformata dal nostro codice), un timeout è tipicamente un
// rallentamento transitorio della rete o del servizio Anthropic: un nuovo
// tentativo, con un budget di tempo fresco, ha una probabilità concreta di
// riuscire, invece di fallire di nuovo allo stesso modo con certezza.
const RETRYABLE_ERROR_PATTERNS = [
  /tool_use.*ids were found without.*tool_result/i,
  /aborted due to timeout/i,
];

// Osservato concretamente: con alcuni prompt (in particolare quello del
// Copywriter Agent, che richiede un testo libero lungo con una struttura di
// chiusura precisa) il tasso di fallimento per singolo tentativo può essere
// sorprendentemente alto (più della metà dei tentativi, in un campione
// osservato durante lo sviluppo) — 3 tentativi non sono un margine
// sufficiente in quel caso. Un tentativo che fallisce per il bug noto di
// LangChain.js (primo pattern sopra) fallisce quasi subito, a basso costo;
// un tentativo che fallisce per timeout (secondo pattern) consuma invece
// l'intero timeout della chiamata prima di essere ritentato — nel caso
// peggiore (un problema persistente, non transitorio, su ogni tentativo)
// questo valore può quindi tradursi in diversi minuti di attesa totale.
// Preferito comunque a un valore più basso: un fallimento isolato e
// transitorio (il caso tipico) si risolve già al secondo o terzo tentativo,
// e un'attesa più lunga resta preferibile a una pipeline che si interrompe
// per un rallentamento passeggero del servizio.
const DEFAULT_MAX_ATTEMPTS = 5;

export async function invokeAgentWithRetry(agent, input, options, { maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await agent.invoke(input, options);
    } catch (error) {
      lastError = error;
      // Un errore che non corrisponde a nessuno di questi due pattern è un
      // problema reale (chiave non valida, richiesta malformata dal nostro
      // codice, ...): non va mai nascosto da un nuovo tentativo, che quasi
      // certamente fallirebbe di nuovo allo stesso modo.
      const isRetryable = RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(error.message ?? ""));
      if (!isRetryable || attempt === maxAttempts) {
        throw error;
      }
      console.error(
        `${agent.name ?? "Agente"}: fallito per un errore transitorio noto (tentativo ${attempt}/${maxAttempts}), ` +
          `nuovo tentativo da una conversazione pulita: ${error.message}`
      );
    }
  }
  // Irraggiungibile in pratica (l'ultimo tentativo rilancia sempre sopra),
  // presente solo perché ESLint/TypeScript non possono dedurlo da soli.
  throw lastError;
}
