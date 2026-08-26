// tests/recordDemoTool.schemas.test.js
//
// Verifica le due regole di sicurezza definite in tools/browser/recordDemoTool.js:
// TargetUrlSchema (naviga solo verso host locali) e OutputPathSchema
// (impedisce che il video venga scritto fuori dalla cartella prevista,
// vedi anche il controllo aggiuntivo con path.resolve/startsWith in
// finalizeClipDevRecording). Sono le uniche due barriere contro un
// indirizzo o un percorso file non sicuro, quindi vengono testate qui in
// isolamento: non richiedono un browser, solo la validazione dei dati.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TargetUrlSchema, OutputPathSchema } from "../tools/browser/recordDemoTool.js";

test("TargetUrlSchema accetta localhost e 127.0.0.1", () => {
  assert.equal(TargetUrlSchema.safeParse("http://localhost:3000").success, true);
  assert.equal(TargetUrlSchema.safeParse("http://127.0.0.1:5173").success, true);
});

test("TargetUrlSchema rifiuta un host esterno", () => {
  assert.equal(TargetUrlSchema.safeParse("https://esempio-esterno.com").success, false);
});

test("TargetUrlSchema rifiuta un valore che non è un URL", () => {
  assert.equal(TargetUrlSchema.safeParse("non-un-url").success, false);
});

test("OutputPathSchema accetta un percorso .mp4 valido dentro la cartella prevista", () => {
  assert.equal(OutputPathSchema.safeParse("mio-progetto/demo.mp4").success, true);
});

test("OutputPathSchema rifiuta un percorso con path traversal", () => {
  assert.equal(OutputPathSchema.safeParse("../../fuori-dalla-cartella/demo.mp4").success, false);
});

test("OutputPathSchema rifiuta un'estensione diversa da .mp4", () => {
  assert.equal(OutputPathSchema.safeParse("mio-progetto/demo.webm").success, false);
});
