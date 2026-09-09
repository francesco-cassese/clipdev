// tools/saveOutputTool.js
//
// Salvataggio su disco dei risultati prodotti da ClipDev: l'outline della
// demo (in formato JSON) e il post per LinkedIn (in formato Markdown).
// Contiene anche le regole di validazione condivise che descrivono come
// deve essere fatto un outline valido: queste regole sono definite una sola
// volta qui e riusate anche da ai/agents/analystAgent.js, per costringere il
// modello a restituire dati nel formato corretto e per evitare che le due
// definizioni si discostino nel tempo.

import * as z from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Cartella di destinazione dei file salvati, calcolata rispetto alla
// cartella da cui viene eseguito il programma, così il comportamento è
// prevedibile indipendentemente da dove questo file viene importato.
const OUTPUT_DIR = path.resolve(process.cwd(), "output");

// Identificativo del progetto usato nel nome del file: essendo l'unico
// valore che finisce direttamente in un percorso su disco, viene
// controllato con più attenzione degli altri campi, per impedire caratteri
// che potrebbero causare la scrittura di file fuori dalla cartella
// prevista o problemi di compatibilità tra sistemi operativi diversi.
const ProjectSlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9-]+$/, "projectSlug deve contenere solo lettere minuscole, cifre e trattini");

// Descrizione di una singola sezione della demo. La durata stimata è
// facoltativa perché non sempre è possibile calcolarla con sicurezza (ad
// esempio quando la descrizione del progetto fornita è troppo vaga), e non
// deve essere un motivo di blocco per il resto dell'outline. Per lo stesso
// motivo sono facoltativi anche i tre campi della callout testuale
// (calloutText e i suoi timestamp indicativi): letti da
// tools/browser/videoTranscode.js per sovrimprimere una pillola di testo
// sincronizzata con questa sezione (vedi CalloutSchema in quel modulo, che
// valida di nuovo questi stessi dati al momento di usarli — qui vengono
// solo accettati o rifiutati nella forma, non nel significato temporale
// relativo alle altre sezioni, che resta responsabilità dell'Analyst
// Agent).
export const OutlineSectionSchema = z
  .object({
    title: z.string().min(1, "Il titolo della sezione non può essere vuoto"),
    content: z.string().min(1, "Il contenuto della sezione non può essere vuoto"),
    estimatedDurationSeconds: z.number().int().positive().optional(),
    // Etichetta breve (indicativamente 4-5 parole) da sovrimprimere nel
    // video come callout testuale durante questa sezione.
    calloutText: z.string().min(1).max(40, "calloutText deve restare breve (indicativamente 4-5 parole)").optional(),
    calloutStartSeconds: z.number().nonnegative().optional(),
    calloutEndSeconds: z.number().positive().optional(),
  })
  .refine(
    (section) =>
      section.calloutStartSeconds === undefined ||
      section.calloutEndSeconds === undefined ||
      section.calloutEndSeconds > section.calloutStartSeconds,
    { error: "calloutEndSeconds deve essere maggiore di calloutStartSeconds", path: ["calloutEndSeconds"] }
  );

// Struttura completa di un outline valido: obiettivo del progetto,
// tecnologie usate, sezioni della demo e punti tecnici di rilievo.
// Definita qui e riusata anche come formato di risposta richiesto
// all'agente che genera l'outline (ai/agents/analystAgent.js).
export const OutlineContentSchema = z.object({
  goal: z.string().min(1, "goal è obbligatorio"),
  techStack: z.array(z.string().min(1)).min(1, "techStack deve avere almeno un elemento"),
  sections: z.array(OutlineSectionSchema).min(1, "sections deve avere almeno una voce"),
  technicalHighlights: z
    .array(z.string().min(1))
    .min(1, "technicalHighlights deve avere almeno una voce"),
});

// Regole di validazione per l'input di questa funzione di salvataggio: a
// seconda del tipo di contenuto (outline oppure post per LinkedIn), i campi
// richiesti sono diversi. Distinguere i due casi esplicitamente impedisce
// di accettare combinazioni non valide, come un post senza testo o un
// outline nel formato sbagliato.
export const SaveOutputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("outline"),
    projectSlug: ProjectSlugSchema,
    outline: OutlineContentSchema,
  }),
  z.object({
    type: z.literal("social-post"),
    projectSlug: ProjectSlugSchema,
    // Il post per LinkedIn è testo libero: qui basta garantire che non sia
    // vuoto.
    content: z.string().min(1, "content non può essere vuoto"),
  }),
]);

// Salva su disco un outline o un post, dopo averne controllato la
// correttezza. Restituisce sempre un risultato con l'indicazione di
// successo o fallimento, piuttosto che interrompere l'esecuzione con un
// errore: chi la richiama (la pipeline di generazione) può così gestire
// l'esito con un semplice controllo, senza dover intercettare eccezioni.
export async function saveClipDevOutput(rawInput) {
  try {
    // I dati in ingresso vengono sempre controllati qui, anche quando
    // arrivano da codice interno già considerato affidabile: è l'unico
    // punto in cui questo controllo avviene, per evitare di doverlo
    // ripetere altrove.
    const input = SaveOutputSchema.parse(rawInput);

    // Data e ora nel nome del file, in un formato compatibile con i nomi
    // file su ogni sistema operativo, così da ottenere nomi univoci e
    // ordinabili cronologicamente.
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    // L'estensione e il contenuto del file dipendono dal tipo: un outline
    // viene salvato come JSON leggibile, un post per LinkedIn come testo
    // Markdown così com'è stato generato.
    const isOutline = input.type === "outline";
    const extension = isOutline ? "json" : "md";
    const fileContent = isOutline
      ? JSON.stringify(input.outline, null, 2)
      : input.content;

    const fileName = `${input.projectSlug}-${input.type}-${timestamp}.${extension}`;
    const filePath = path.join(OUTPUT_DIR, fileName);

    // Crea la cartella di destinazione se non esiste ancora, senza
    // generare errori se invece esiste già.
    await mkdir(OUTPUT_DIR, { recursive: true });

    await writeFile(filePath, fileContent, "utf-8");

    // In caso di successo viene restituito un risultato positivo con il
    // percorso del file, non un'eccezione: questo semplifica la gestione
    // da parte di chi chiama questa funzione.
    return { success: true, path: filePath, type: input.type };
  } catch (error) {
    // Sia gli errori di dati non validi sia quelli legati alla scrittura
    // su disco (ad esempio permessi mancanti o spazio esaurito) vengono
    // gestiti qui, restituendo un risultato negativo con un messaggio
    // comprensibile invece di interrompere l'esecuzione del chiamante.
    return { success: false, error: error.message };
  }
}
