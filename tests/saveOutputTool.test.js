// tests/saveOutputTool.test.js
//
// Verifica SaveOutputSchema (le regole che definiscono un outline o un post
// validi, vedi tools/saveOutputTool.js) e saveClipDevOutput(), che le usa
// per controllare i dati prima di scriverli su disco. A differenza degli
// altri test in questa cartella, questi toccano davvero il filesystem (la
// cartella output/ dello stesso progetto usata in un'esecuzione reale): i
// file creati da ogni test vengono quindi rimossi subito dopo, per non
// lasciare residui.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

import { SaveOutputSchema, saveClipDevOutput } from "../tools/saveOutputTool.js";

const SAMPLE_OUTLINE = {
  goal: "Dimostrare la generazione automatica di demo per LinkedIn",
  techStack: ["Node.js", "Playwright"],
  sections: [{ title: "Hook iniziale", content: "Mostra la funzionalità principale" }],
  technicalHighlights: ["Pipeline coordinata in modo deterministico"],
};

test("SaveOutputSchema accetta un outline valido", () => {
  const result = SaveOutputSchema.safeParse({ type: "outline", projectSlug: "clipdev-demo", outline: SAMPLE_OUTLINE });
  assert.equal(result.success, true);
});

test("SaveOutputSchema rifiuta un projectSlug con lettere maiuscole o spazi", () => {
  const result = SaveOutputSchema.safeParse({ type: "outline", projectSlug: "ClipDev Demo", outline: SAMPLE_OUTLINE });
  assert.equal(result.success, false);
});

test("SaveOutputSchema rifiuta un outline senza sezioni", () => {
  const invalidOutline = { ...SAMPLE_OUTLINE, sections: [] };
  const result = SaveOutputSchema.safeParse({ type: "outline", projectSlug: "clipdev-demo", outline: invalidOutline });
  assert.equal(result.success, false);
});

test("SaveOutputSchema rifiuta un post per LinkedIn vuoto", () => {
  const result = SaveOutputSchema.safeParse({ type: "social-post", projectSlug: "clipdev-demo", content: "" });
  assert.equal(result.success, false);
});

test("saveClipDevOutput salva un outline valido come JSON leggibile", async () => {
  const result = await saveClipDevOutput({ type: "outline", projectSlug: "test-save-outline", outline: SAMPLE_OUTLINE });
  try {
    assert.equal(result.success, true);
    assert.match(result.path, /test-save-outline-outline-.*\.json$/);
  } finally {
    await rm(result.path, { force: true });
  }
});

test("saveClipDevOutput salva un post per LinkedIn come testo Markdown", async () => {
  const content = "Un post di prova pronto per LinkedIn.";
  const result = await saveClipDevOutput({ type: "social-post", projectSlug: "test-save-post", content });
  try {
    assert.equal(result.success, true);
    assert.match(result.path, /test-save-post-social-post-.*\.md$/);
  } finally {
    await rm(result.path, { force: true });
  }
});

test("saveClipDevOutput restituisce success:false (non lancia un'eccezione) con dati non validi", async () => {
  const result = await saveClipDevOutput({ type: "outline", projectSlug: "Slug Non Valido", outline: SAMPLE_OUTLINE });
  assert.equal(result.success, false);
  assert.ok(result.error);
});
