// tests/projectDetection.test.js
//
// Verifica parseFlags() e guessDevServerUrl() (vedi
// tools/projectDetection.js), la logica di rilevamento automatico usata
// dal comando globale `clipdev`. Sono funzioni pure, quindi testabili senza
// simulare un'intera esecuzione da riga di comando (che leggerebbe file
// reali e potrebbe terminare il processo con `process.exit`).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseFlags,
  guessDevServerUrl,
  guessPortFromScripts,
  guessEntityRoutePaths,
} from "../tools/projectDetection.js";

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

test("guessDevServerUrl riconosce Astro, Gatsby e Parcel", () => {
  assert.equal(guessDevServerUrl({ dependencies: { astro: "^4.0.0" } }), "http://localhost:4321");
  assert.equal(guessDevServerUrl({ dependencies: { gatsby: "^5.0.0" } }), "http://localhost:8000");
  assert.equal(guessDevServerUrl({ devDependencies: { parcel: "^2.0.0" } }), "http://localhost:1234");
});

test("guessPortFromScripts legge --port dallo script dev", () => {
  const pkg = { scripts: { dev: "vite --port 5174" } };
  assert.equal(guessPortFromScripts(pkg), 5174);
});

test("guessPortFromScripts legge -p con segno uguale dallo script start", () => {
  const pkg = { scripts: { start: "next start -p=4001" } };
  assert.equal(guessPortFromScripts(pkg), 4001);
});

test("guessPortFromScripts restituisce null senza porta esplicita né script", () => {
  assert.equal(guessPortFromScripts({}), null);
  assert.equal(guessPortFromScripts({ scripts: { dev: "vite" } }), null);
});

test("guessDevServerUrl preferisce la porta esplicita dello script al default del framework", () => {
  const pkg = { dependencies: { next: "^14.0.0" }, scripts: { dev: "next dev -p 4000" } };
  assert.equal(guessDevServerUrl(pkg), "http://localhost:4000");
});

test("guessDevServerUrl usa la porta esplicita anche senza un framework noto tra le dipendenze", () => {
  const pkg = { dependencies: { lodash: "^4.0.0" }, scripts: { dev: "node server.js --port=9090" } };
  assert.equal(guessDevServerUrl(pkg), "http://localhost:9090");
});

test("guessEntityRoutePaths restituisce un elenco vuoto senza testo", () => {
  assert.deepEqual(guessEntityRoutePaths(null), []);
  assert.deepEqual(guessEntityRoutePaths(""), []);
});

test("guessEntityRoutePaths restituisce un elenco vuoto se nessuna parola chiave nota compare nel testo", () => {
  assert.deepEqual(guessEntityRoutePaths("Un semplice tool CLI per convertire file audio."), []);
});

test("guessEntityRoutePaths riconosce un catalogo/prodotti in italiano e in inglese", () => {
  assert.deepEqual(guessEntityRoutePaths("Un e-commerce con catalogo prodotti e carrello."), [
    "/prodotti",
    "/products",
    "/catalogo",
    "/catalog",
    "/shop",
    "/store",
  ]);
  assert.deepEqual(guessEntityRoutePaths("An online store with a product catalog."), [
    "/prodotti",
    "/products",
    "/catalogo",
    "/catalog",
    "/shop",
    "/store",
  ]);
});

test("guessEntityRoutePaths unisce le rotte di più entità citate, senza duplicati", () => {
  const paths = guessEntityRoutePaths("Un blog con articoli e una pagina contatti.");
  assert.deepEqual(paths, ["/blog", "/articoli", "/articles", "/posts", "/contatti", "/contact", "/contacts"]);
});
