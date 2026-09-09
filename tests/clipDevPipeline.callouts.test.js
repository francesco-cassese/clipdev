// tests/clipDevPipeline.callouts.test.js
//
// Verifica mapRawTimeToEditedTime() e buildCalloutsFromActionTimings()
// (vedi pipeline/clipDevPipeline.js), che sincronizzano le callout testuali
// al momento REALE in cui ciascuna sezione dell'outline è stata
// effettivamente dimostrata durante la registrazione, invece che alla
// stima fatta dall'Analyst Agent prima ancora che il Director Agent
// scegliesse le interazioni vere. Un errore qui produrrebbe callout
// sfasate rispetto a quello che si vede davvero nel video (il difetto
// concreto che ha motivato questa funzionalità), quindi vale la pena
// verificare a fondo i casi limite del mapping temporale, non solo il
// caso semplice senza alcun taglio.

import { test } from "node:test";
import assert from "node:assert/strict";

// pipeline/clipDevPipeline.js importa, tra gli altri, gli agenti basati su
// ChatAnthropic: al caricamento del modulo serve solo che una chiave sia
// presente, non che sia valida, perché qui non viene mai effettuata alcuna
// chiamata reale al servizio.
process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-dummy-key";

const { mapRawTimeToEditedTime, buildCalloutsFromActionTimings } = await import("../pipeline/clipDevPipeline.js");

test("mapRawTimeToEditedTime restituisce lo stesso istante senza alcun taglio", () => {
  assert.equal(mapRawTimeToEditedTime(10, []), 10);
});

test("mapRawTimeToEditedTime sottrae un taglio interamente precedente", () => {
  // Un secondo di caricamento tagliato (0-1s): un istante grezzo a 10s
  // diventa 9s nella timeline finale.
  const cutRanges = [{ startSeconds: 0, endSeconds: 1 }];
  assert.equal(mapRawTimeToEditedTime(10, cutRanges), 9);
});

test("mapRawTimeToEditedTime somma correttamente più tagli precedenti", () => {
  const cutRanges = [
    { startSeconds: 0, endSeconds: 1 }, // caricamento iniziale
    { startSeconds: 5, endSeconds: 7 }, // attesa di un'interazione
  ];
  // 10s grezzi - 1s - 2s = 7s nella timeline finale.
  assert.equal(mapRawTimeToEditedTime(10, cutRanges), 7);
});

test("mapRawTimeToEditedTime ignora un taglio successivo all'istante indicato", () => {
  const cutRanges = [{ startSeconds: 20, endSeconds: 25 }];
  assert.equal(mapRawTimeToEditedTime(10, cutRanges), 10);
});

test("mapRawTimeToEditedTime riporta un istante caduto dentro un taglio all'inizio di quel taglio", () => {
  const cutRanges = [{ startSeconds: 0, endSeconds: 1 }, { startSeconds: 5, endSeconds: 8 }];
  // 6s grezzi cadono dentro il taglio 5-8s: nella timeline finale
  // corrispondono esattamente al punto in cui inizia quel taglio (5s meno
  // il secondo già tagliato all'inizio = 4s).
  assert.equal(mapRawTimeToEditedTime(6, cutRanges), 4);
});

test("mapRawTimeToEditedTime non scende mai sotto zero", () => {
  const cutRanges = [{ startSeconds: 0, endSeconds: 5 }];
  assert.equal(mapRawTimeToEditedTime(2, cutRanges), 0);
});

const SAMPLE_SECTIONS = [
  { title: "Hook", content: "...", calloutText: "Filtro budget globale" },
  { title: "Sync", content: "...", calloutText: "Stato persistente tra pagine" },
  { title: "Nav", content: "...", calloutText: "Navigazione filtrata" },
];

test("buildCalloutsFromActionTimings restituisce un elenco vuoto senza azioni taggate", () => {
  assert.deepEqual(buildCalloutsFromActionTimings([], SAMPLE_SECTIONS, []), []);
});

test("buildCalloutsFromActionTimings crea una finestra per ogni sezione realmente toccata", () => {
  const actionTimings = [
    { sectionNumber: 1, rawStartSeconds: 2 },
    { sectionNumber: 2, rawStartSeconds: 9 },
  ];
  const callouts = buildCalloutsFromActionTimings(actionTimings, SAMPLE_SECTIONS, []);

  assert.equal(callouts.length, 2);
  assert.equal(callouts[0].text, "Filtro budget globale");
  assert.equal(callouts[0].startSeconds, 2);
  assert.equal(callouts[0].endSeconds, 9); // finisce dove inizia la sezione successiva
  assert.equal(callouts[1].text, "Stato persistente tra pagine");
  assert.equal(callouts[1].startSeconds, 9);
});

test("buildCalloutsFromActionTimings esclude le sezioni mai toccate da nessuna azione", () => {
  // Solo la sezione 1 viene toccata: le sezioni 2 e 3, pur avendo un
  // calloutText nell'outline, non devono comparire — mostrarle
  // sarebbe promettere a schermo qualcosa che il video non mostra davvero.
  const actionTimings = [{ sectionNumber: 1, rawStartSeconds: 0 }];
  const callouts = buildCalloutsFromActionTimings(actionTimings, SAMPLE_SECTIONS, []);
  assert.equal(callouts.length, 1);
  assert.equal(callouts[0].text, "Filtro budget globale");
});

test("buildCalloutsFromActionTimings ignora più tocchi consecutivi della stessa sezione", () => {
  const actionTimings = [
    { sectionNumber: 1, rawStartSeconds: 0 },
    { sectionNumber: 1, rawStartSeconds: 1 }, // stessa sezione, non genera una seconda finestra
    { sectionNumber: 2, rawStartSeconds: 5 },
  ];
  const callouts = buildCalloutsFromActionTimings(actionTimings, SAMPLE_SECTIONS, []);
  assert.equal(callouts.length, 2);
  assert.equal(callouts[0].startSeconds, 0); // il primo tocco, non il secondo
});

test("buildCalloutsFromActionTimings applica una durata minima anche tra due tocchi ravvicinati", () => {
  const actionTimings = [
    { sectionNumber: 1, rawStartSeconds: 0 },
    { sectionNumber: 2, rawStartSeconds: 0.2 }, // troppo vicino per essere leggibile da solo
  ];
  const callouts = buildCalloutsFromActionTimings(actionTimings, SAMPLE_SECTIONS, []);
  assert.ok(callouts[0].endSeconds - callouts[0].startSeconds >= 1.5);
});

test("buildCalloutsFromActionTimings traduce i tempi grezzi nella timeline già tagliata", () => {
  const cutRanges = [{ startSeconds: 0, endSeconds: 1 }]; // 1s di caricamento tagliato
  const actionTimings = [{ sectionNumber: 1, rawStartSeconds: 3 }];
  const callouts = buildCalloutsFromActionTimings(actionTimings, SAMPLE_SECTIONS, cutRanges);
  assert.equal(callouts[0].startSeconds, 2); // 3s grezzi - 1s tagliato = 2s nel video finale
});

test("buildCalloutsFromActionTimings salta le sezioni prive di calloutText nell'outline", () => {
  const sectionsWithoutCallout = [{ title: "Hook", content: "..." }]; // nessun calloutText
  const actionTimings = [{ sectionNumber: 1, rawStartSeconds: 0 }];
  assert.deepEqual(buildCalloutsFromActionTimings(actionTimings, sectionsWithoutCallout, []), []);
});
