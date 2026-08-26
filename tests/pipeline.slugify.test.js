// tests/pipeline.slugify.test.js
//
// Verifica slugify() (vedi pipeline/clipDevPipeline.js), che trasforma il
// nome del progetto nell'identificatore usato nei nomi dei file di output
// e nel percorso del video: un risultato scorretto qui (ad esempio una
// stringa vuota) farebbe fallire il salvataggio dei risultati, quindi vale
// la pena verificarne il comportamento sui casi meno ovvi (accenti,
// maiuscole, caratteri non ammessi).

import { test } from "node:test";
import assert from "node:assert/strict";

// pipeline/clipDevPipeline.js importa, tra gli altri, gli agenti basati su
// ChatAnthropic: al caricamento del modulo serve solo che una chiave sia
// presente, non che sia valida, perché qui non viene mai effettuata alcuna
// chiamata reale al servizio.
process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-dummy-key";

const { slugify } = await import("../pipeline/clipDevPipeline.js");

test("converte in minuscolo e sostituisce gli spazi con trattini", () => {
  assert.equal(slugify("Il Mio Progetto"), "il-mio-progetto");
});

test("rimuove gli accenti", () => {
  assert.equal(slugify("città natale"), "citta-natale");
});

test("sostituisce sequenze di caratteri non ammessi con un solo trattino", () => {
  assert.equal(slugify("Progetto!! v2.0 (beta)"), "progetto-v2-0-beta");
});

test("rimuove i trattini iniziali e finali", () => {
  assert.equal(slugify("--Progetto--"), "progetto");
});

test("restituisce una stringa vuota per un nome composto solo da caratteri non ammessi", () => {
  assert.equal(slugify("!!!"), "");
});
