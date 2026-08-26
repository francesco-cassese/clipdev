// tests/projectDetection.test.js
//
// Verifica parseFlags() e guessDevServerUrl() (vedi
// tools/projectDetection.js), la logica di rilevamento automatico usata
// dal comando globale `clipdev`. Sono funzioni pure, quindi testabili senza
// simulare un'intera esecuzione da riga di comando (che leggerebbe file
// reali e potrebbe terminare il processo con `process.exit`).

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseFlags, guessDevServerUrl } from "../tools/projectDetection.js";

test("parseFlags legge coppie --nome=valore", () => {
  const flags = parseFlags(["--name=Il Mio Progetto", "--url=http://localhost:5173"]);
  assert.deepEqual(flags, { name: "Il Mio Progetto", url: "http://localhost:5173" });
});

test("parseFlags ignora argomenti che non seguono il formato --nome=valore", () => {
  const flags = parseFlags(["ciao", "--headless", "--duration=8000"]);
  assert.deepEqual(flags, { duration: "8000" });
});

test("parseFlags accetta un valore vuoto dopo il segno uguale", () => {
  const flags = parseFlags(["--summary="]);
  assert.deepEqual(flags, { summary: "" });
});

test("guessDevServerUrl restituisce null se non viene passato alcun package.json", () => {
  assert.equal(guessDevServerUrl(null), null);
});

test("guessDevServerUrl restituisce null se nessuna dipendenza nota è presente", () => {
  const pkg = { dependencies: { lodash: "^4.0.0" } };
  assert.equal(guessDevServerUrl(pkg), null);
});

test("guessDevServerUrl riconosce Vite tra le dependencies", () => {
  const pkg = { dependencies: { vite: "^5.0.0" } };
  assert.equal(guessDevServerUrl(pkg), "http://localhost:5173");
});

test("guessDevServerUrl riconosce Next.js anche tra le devDependencies", () => {
  const pkg = { devDependencies: { next: "^14.0.0" } };
  assert.equal(guessDevServerUrl(pkg), "http://localhost:3000");
});
