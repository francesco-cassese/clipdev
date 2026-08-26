// tests/pageInspection.test.js
//
// Verifica parseInteractiveElementsFromSnapshot() (vedi
// tools/browser/pageInspection.js), la logica pura che trasforma
// un'istantanea di accessibilità di Playwright (mode: "ai") nell'elenco di
// elementi interattivi offerto al Director Agent. È una funzione pura,
// testabile direttamente su stringhe già pronte, senza dover aprire un
// browser reale per ogni caso.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseInteractiveElementsFromSnapshot } from "../tools/browser/pageInspection.js";

test("riconosce un bottone nativo con nome accessibile", () => {
  const snapshot = `- generic [active] [ref=e1]:\n  - button "Salva" [ref=e2]`;
  const elements = parseInteractiveElementsFromSnapshot(snapshot);
  assert.deepEqual(elements, [{ selector: "aria-ref=e2", tag: "button", label: "Salva" }]);
});

test("include un elemento generico senza ruolo ARIA se il browser lo segnala come cliccabile", () => {
  const snapshot = `- generic [ref=e3] [cursor=pointer]: Card cliccabile`;
  const elements = parseInteractiveElementsFromSnapshot(snapshot);
  assert.deepEqual(elements, [{ selector: "aria-ref=e3", tag: "generic", label: "Card cliccabile" }]);
});

test("esclude un elemento generico senza ruolo ARIA e senza cursore a puntatore", () => {
  const snapshot = `- generic [ref=e4]: Testo qualunque non interattivo`;
  assert.deepEqual(parseInteractiveElementsFromSnapshot(snapshot), []);
});

test("esclude un elemento disabilitato anche se il ruolo è interattivo", () => {
  const snapshot = `- button "Invia" [disabled] [ref=e5]`;
  assert.deepEqual(parseInteractiveElementsFromSnapshot(snapshot), []);
});

test("esclude un elemento senza [ref=...] (non referenziabile)", () => {
  const snapshot = `- button "Invia"`;
  assert.deepEqual(parseInteractiveElementsFromSnapshot(snapshot), []);
});

test("riconosce campi di input con vari ruoli (textbox, checkbox, combobox, searchbox)", () => {
  const snapshot = [
    `- textbox "Nome" [ref=e1]`,
    `- checkbox [ref=e2]`,
    `- combobox [ref=e3]`,
    `- searchbox "Cerca..." [ref=e4]`,
  ].join("\n");
  const elements = parseInteractiveElementsFromSnapshot(snapshot);
  assert.deepEqual(
    elements.map((el) => el.tag),
    ["textbox", "checkbox", "combobox", "searchbox"]
  );
  assert.equal(elements[1].label, "checkbox"); // nessun nome accessibile: usa il ruolo come etichetta
});

test("estrae correttamente un elemento dentro una Shadow DOM (indistinguibile da uno normale nell'istantanea)", () => {
  const snapshot = [
    `- generic [active] [ref=e1]:`,
    `  - button "Real Button" [ref=e2]`,
    `  - button "Inside Shadow DOM" [ref=e5]`,
  ].join("\n");
  const elements = parseInteractiveElementsFromSnapshot(snapshot);
  assert.equal(elements.length, 2);
  assert.equal(elements[1].selector, "aria-ref=e5");
});

test("limita il risultato a 30 elementi", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `- button "Bottone ${i}" [ref=e${i}]`);
  const elements = parseInteractiveElementsFromSnapshot(lines.join("\n"));
  assert.equal(elements.length, 30);
});
