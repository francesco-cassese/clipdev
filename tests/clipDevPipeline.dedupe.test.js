// tests/clipDevPipeline.dedupe.test.js
//
// Verifica dedupeActionsAgainstUsedSelectors() (vedi
// pipeline/clipDevPipeline.js): il blocco anti-repeat deterministico che
// impedisce di eseguire due volte lo stesso selettore in una registrazione
// (tipicamente un click che riapre un pannello già aperto), a prescindere da
// cosa proponga il Director Agent. Un errore qui vanificherebbe la
// protezione contro il loop osservato concretamente in produzione, quindi
// vale la pena verificarla isolatamente dal resto della pipeline.

import { test } from "node:test";
import assert from "node:assert/strict";

// pipeline/clipDevPipeline.js importa, tra gli altri, gli agenti basati su
// ChatAnthropic: al caricamento del modulo serve solo che una chiave sia
// presente, non che sia valida, perché qui non viene mai effettuata alcuna
// chiamata reale al servizio.
process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-dummy-key";

const { dedupeActionsAgainstUsedSelectors } = await import("../pipeline/clipDevPipeline.js");

test("lascia passare azioni con selettori mai visti prima", () => {
  const usedSelectors = new Set();
  const actions = [
    { type: "click", selector: "role=button[name=\"Filtra per prezzo\"]" },
    { type: "click", selector: "role=button[name=\"Applica\"]" },
  ];
  const result = dedupeActionsAgainstUsedSelectors(actions, usedSelectors);
  assert.deepEqual(result, actions);
  assert.equal(usedSelectors.size, 2);
});

test("scarta un'azione il cui selettore è già stato usato in un turno precedente", () => {
  const usedSelectors = new Set(["role=button[name=\"Filtra per prezzo\"]"]);
  const actions = [
    { type: "click", selector: "role=button[name=\"Filtra per prezzo\"]" },
    { type: "click", selector: "role=button[name=\"Applica\"]" },
  ];
  const result = dedupeActionsAgainstUsedSelectors(actions, usedSelectors);
  assert.deepEqual(result, [{ type: "click", selector: "role=button[name=\"Applica\"]" }]);
});

test("scarta anche un selettore ripetuto due volte all'interno della stessa proposta", () => {
  const usedSelectors = new Set();
  const actions = [
    { type: "click", selector: "role=button[name=\"Filtra per prezzo\"]" },
    { type: "click", selector: "role=button[name=\"Filtra per prezzo\"]" },
  ];
  const result = dedupeActionsAgainstUsedSelectors(actions, usedSelectors);
  assert.equal(result.length, 1);
});

test("non tocca le azioni senza selettore (wait, scroll)", () => {
  const usedSelectors = new Set();
  const actions = [
    { type: "wait", timeoutMs: 1000 },
    { type: "scroll", direction: "down", amount: "medium" },
  ];
  const result = dedupeActionsAgainstUsedSelectors(actions, usedSelectors);
  assert.deepEqual(result, actions);
  assert.equal(usedSelectors.size, 0);
});
