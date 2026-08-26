// ai/models/anthropic.js
//
// Punto unico di creazione dei modelli linguistici Anthropic usati dai tre
// agenti di ClipDev (Analyst, Director, Copywriter): un solo file a cui
// ciascun agente si rivolge, invece di ripetere la stessa configurazione di
// base in tre punti diversi del codice.
//
// Il controllo sulla chiave ANTHROPIC_API_KEY avviene qui, prima di creare
// qualunque modello. Questo file è il primo, in tutto il programma, ad aver
// davvero bisogno di quella chiave (la libreria Anthropic la richiede subito
// alla creazione del modello, non solo quando lo si usa): controllandola qui
// stesso, l'utente vede il messaggio chiaro qui sotto invece del messaggio
// tecnico generico che la libreria genererebbe altrimenti.

import { ChatAnthropic } from "@langchain/anthropic";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "Errore: variabile d'ambiente ANTHROPIC_API_KEY non impostata.\n" +
      "Crea un file .env (copia .env.example) con la tua chiave, poi avvia con:\n" +
      "  node --env-file=.env index.js ...\n" +
      "(--env-file carica il file PRIMA che questo script parta: se vedi comunque questo errore, " +
      "controlla di aver usato il flag e che .env contenga davvero ANTHROPIC_API_KEY=...)"
  );
  process.exit(1);
}

// Modello scelto per tutti e tre gli agenti, per la sua rapidità e il suo
// costo contenuto: nessuno dei tre compiti (leggere requisiti, scegliere
// tra opzioni già definite, scrivere un post) richiede il modello più
// sofisticato disponibile.
const MODEL_ID = "claude-haiku-4-5";

// Numero di tentativi automatici condiviso, in caso di errore temporaneo
// nella comunicazione con il servizio. Un valore più basso del previsto di
// libreria (che ne prevede fino a sei) garantisce che, in presenza di un
// problema persistente, l'errore venga segnalato in tempi ragionevoli
// invece di far attendere l'utente per diversi minuti.
const MAX_RETRIES = 2;

// Crea un modello con la configurazione condivisa da tutti gli agenti
// (modello, tentativi automatici), lasciando personalizzabile solo la
// temperatura: l'unico parametro che deve davvero variare da agente ad
// agente, a seconda che il compito richieda risposte coerenti e ripetibili
// (valore basso) o un margine di variazione creativa (valore più alto).
function createModel(temperature) {
  return new ChatAnthropic({ model: MODEL_ID, temperature, maxRetries: MAX_RETRIES });
}

// Modello usato dall'Analyst Agent: legge i requisiti del progetto e li
// trasforma in una scaletta per il video. Temperatura bassa: le risposte
// devono restare coerenti e ripetibili a parità di informazioni fornite in
// ingresso, non introdurre variazioni creative non necessarie.
export const analystModel = createModel(0.2);

// Modello usato dal Director Agent: sceglie quali interazioni mostrare
// durante la registrazione del video. Stessa motivazione dell'Analyst per
// la temperatura bassa (scegliere tra opzioni già definite, non generare
// testo libero).
export const directorModel = createModel(0.2);

// Modello usato dal Copywriter Agent: trasforma la scaletta del video in un
// post pronto per LinkedIn. Temperatura più alta rispetto agli altri due:
// qui il compito è scrivere un testo persuasivo e naturale, un lavoro
// creativo che beneficia di un margine di variazione maggiore rispetto a
// un'elaborazione puramente strutturata.
export const copywriterModel = createModel(0.7);
