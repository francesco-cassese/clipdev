// tests/directorAgent.safety.test.js
//
// Verifica isActionSafe(), il controllo automatico indipendente (vedi
// ai/agents/directorAgent.js) che scarta un'interazione proposta dal Director
// Agent se punta a un elemento non realmente presente sulla pagina, o se
// la sua etichetta suggerisce un'azione distruttiva (logout, cancellazione,
// pagamento...). Essendo la difesa che impedisce a una scelta indesiderata
// dell'agente di essere eseguita davvero, è testata qui in isolamento,
// senza bisogno di un browser o di una chiave API reale.

import { test } from "node:test";
import assert from "node:assert/strict";

// ChatAnthropic (creato in ai/models/anthropic.js al caricamento di
// ai/agents/directorAgent.js) richiede solo che una chiave sia presente, non
// che sia valida: qui non viene mai effettuata alcuna chiamata reale al
// servizio.
process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-dummy-key";

const { isActionSafe } = await import("../ai/agents/directorAgent.js");

test("accetta un click su un elemento realmente presente e innocuo", () => {
  const elements = [{ selector: "#apri-menu", label: "Apri menu" }];
  const action = { type: "click", selector: "#apri-menu" };
  assert.equal(isActionSafe(action, elements), true);
});

test("scarta un click il cui selettore non corrisponde a nessun elemento reale", () => {
  const action = { type: "click", selector: "#inventato" };
  assert.equal(isActionSafe(action, []), false);
});

test("scarta un'azione la cui etichetta suggerisce un logout", () => {
  const elements = [{ selector: "#logout", label: "Esci dall'account" }];
  const action = { type: "click", selector: "#logout" };
  assert.equal(isActionSafe(action, elements), false);
});

test("scarta un'azione la cui etichetta suggerisce un'eliminazione", () => {
  const elements = [{ selector: "#del-item", label: "Elimina elemento" }];
  const action = { type: "click", selector: "#del-item" };
  assert.equal(isActionSafe(action, elements), false);
});

test("scarta un'azione la cui etichetta suggerisce un pagamento", () => {
  const elements = [{ selector: "#pay-now", label: "Conferma pagamento" }];
  const action = { type: "fill", selector: "#pay-now" };
  assert.equal(isActionSafe(action, elements), false);
});

test("accetta sempre un'azione di tipo wait, che non fa riferimento a un elemento", () => {
  const action = { type: "wait", timeoutMs: 500 };
  assert.equal(isActionSafe(action, []), true);
});

test("accetta sempre un'azione di tipo scroll, che non fa riferimento a un elemento", () => {
  const action = { type: "scroll", direction: "down", amount: "medium" };
  assert.equal(isActionSafe(action, []), true);
});

test("accetta un drag su uno slider realmente presente e innocuo", () => {
  const elements = [{ selector: "role=slider[name=\"Prezzo massimo\"]", label: "Prezzo massimo", tag: "slider" }];
  const action = { type: "drag", selector: "role=slider[name=\"Prezzo massimo\"]", targetPercent: 40 };
  assert.equal(isActionSafe(action, elements), true);
});

test("scarta un drag il cui selettore non corrisponde a nessun elemento reale", () => {
  const action = { type: "drag", selector: "role=slider[name=\"Inventato\"]", targetPercent: 40 };
  assert.equal(isActionSafe(action, []), false);
});

test("scarta un click su uno slider: va trascinato, non cliccato", () => {
  const elements = [{ selector: "role=slider[name=\"Prezzo massimo\"]", label: "Prezzo massimo", tag: "slider" }];
  const action = { type: "click", selector: "role=slider[name=\"Prezzo massimo\"]" };
  assert.equal(isActionSafe(action, elements), false);
});

test("scarta un drag su un elemento che non è uno slider", () => {
  const elements = [{ selector: "#apri-menu", label: "Apri menu", tag: "button" }];
  const action = { type: "drag", selector: "#apri-menu", targetPercent: 40 };
  assert.equal(isActionSafe(action, elements), false);
});
