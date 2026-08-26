# ClipDev

ClipDev genera automaticamente, a partire dalla descrizione di un progetto software, un pacchetto pronto per un post su LinkedIn: un **video dimostrativo** (registrato navigando davvero nell'applicazione), una **scaletta tecnica** della demo e il **testo del post** da pubblicare.

Non richiede editing video né scrittura manuale del post: basta indicare il progetto e l'indirizzo a cui è raggiungibile in locale, e ClipDev si occupa di analizzarlo, decidere cosa mostrare, registrarlo e scrivere il testo di accompagnamento.

## Cosa produce

Per ogni esecuzione, ClipDev crea tre file:

| File | Contenuto | Cartella |
|---|---|---|
| `<progetto>-outline-<data>.json` | La scaletta della demo: obiettivo, tecnologie usate, sezioni del video, punti tecnici rilevanti | `output/` |
| `demo.mp4` | Il video della demo, Full HD (1920×1080), con cursore visibile e interazioni realistiche, ottimizzato per la durata consigliata da LinkedIn (15-30 secondi) | `recordings/<slug-progetto>/` |
| `<progetto>-social-post-<data>.md` | Il testo del post LinkedIn, pronto per essere copiato e pubblicato | `output/` |

## Come funziona

ClipDev non è un unico strumento monolitico, ma una sequenza coordinata di passaggi, ciascuno con una responsabilità precisa:

1. **Analisi del progetto** — un agente (Claude Haiku 4.5, tramite LangChain.js) legge la descrizione del progetto (testo libero, README, changelog) e la trasforma in una scaletta strutturata per un video breve, seguendo le linee guida ufficiali di LinkedIn per i contenuti video.
2. **Ispezione della pagina** — in parallelo, Playwright apre un browser Chromium che visita l'indirizzo indicato, attende che la pagina sia completamente caricata (non solo il primo evento di caricamento, ma anche eventuali dati richiesti in modo asincrono all'avvio) e individua gli elementi reali con cui si può interagire (pulsanti, link, campi di input).
3. **Pianificazione delle interazioni** — un secondo agente (stesso modello, stesso framework) sceglie quali interazioni mostrare nel video (click, digitazione, scorrimento), **solo tra gli elementi realmente presenti sulla pagina**: non vengono mai inventati elementi che non esistono.
4. **Registrazione** — le interazioni scelte vengono eseguite con Playwright nello stesso browser, con un cursore visibile che si muove in modo naturale (non a scatti). Se un'interazione fa comparire contenuti caricati da un servizio esterno (ad esempio le card di un catalogo prodotti), l'intervallo di attesa viene registrato e rimosso per intero in fase di montaggio (lo stesso "taglio del tempo morto" usato dagli strumenti professionali di registrazione demo), così nel video non compare mai lo stato di caricamento intermedio. Il risultato viene registrato in un video WebM, poi convertito in MP4 con ffmpeg, che si occupa anche di questo taglio.
5. **Scrittura del post** — un terzo agente (stesso framework) trasforma la scaletta in un testo professionale pronto per LinkedIn.
6. **Salvataggio** — scaletta, video e post vengono scritti su disco.

Gli agenti che compiono i passaggi 1, 3 e 5 sono basati su intelligenza artificiale ma **non decidono autonomamente l'ordine delle operazioni**: la sequenza è coordinata da codice deterministico (`pipeline/clipDevPipeline.js`), che gestisce anche i casi di errore, i tempi di attesa e la sicurezza delle interazioni scelte (ad esempio, scarta automaticamente qualunque interazione che sembri distruttiva, come un pulsante di logout o di eliminazione).

## Stack tecnologico

| Livello | Tecnologia | Ruolo in ClipDev |
|---|---|---|
| Agenti AI | [LangChain.js](https://docs.langchain.com/) v1 (`createAgent`) + Claude Haiku 4.5 (`@langchain/anthropic`) | Analisi del progetto, scelta delle interazioni, scrittura del post |
| Automazione browser | [Playwright](https://playwright.dev/) (Chromium) | Navigazione, individuazione degli elementi della pagina, esecuzione delle interazioni, registrazione del video |
| Validazione dati | [Zod](https://zod.dev/) | Controllo della forma di ogni dato scambiato tra agenti e strumenti (outline, interazioni, percorsi dei file) |
| Conversione video | ffmpeg (processo esterno) | Conversione del video registrato (WebM) nel formato finale (MP4, H.264) |
| Runtime | Node.js, moduli ES nativi | Esecuzione dell'intero processo, nessun framework web coinvolto |

## Requisiti

- **Node.js** 20.6 o successivo per l'uso da riga di comando con `index.js` (richiede il flag `--env-file`, supportato dalla 20.6); 20.12 o successivo per il comando globale `clipdev` (richiede `process.loadEnvFile()`, l'API nativa equivalente ma con un requisito di versione leggermente più alto)
- **pnpm** come gestore di pacchetti
- **ffmpeg** installato e raggiungibile da riga di comando (necessario per convertire il video registrato nel formato finale). Su Windows: `winget install ffmpeg`; su macOS: `brew install ffmpeg`; su Linux: `apt install ffmpeg` o equivalente.
- Una **chiave API di Anthropic**, ottenibile da [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)

## Installazione

```bash
pnpm install
npx playwright install chromium
```

Il secondo comando scarica il browser usato per la registrazione (necessario solo la prima volta).

## Configurazione della chiave API

Copia il file di esempio e inserisci la tua chiave:

```bash
cp .env.example .env
```

Poi modifica `.env` inserendo la chiave reale al posto del segnaposto:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Il file `.env` è escluso dal controllo di versione: non va mai condiviso né incluso in commit.

## Utilizzo

### Da riga di comando, con parametri espliciti

```bash
node --env-file=.env index.js "Nome Progetto" "Descrizione tecnica del progetto..." "http://localhost:3000"
```

oppure, tramite lo script equivalente:

```bash
pnpm start -- "Nome Progetto" "Descrizione tecnica del progetto..." "http://localhost:3000"
```

I tre parametri sono, nell'ordine: nome del progetto, descrizione tecnica (più è dettagliata, migliore sarà la scaletta prodotta) e indirizzo a cui è raggiungibile il progetto in locale.

### Come comando globale, dentro un altro progetto

Una volta installato come comando globale (una tantum, dalla cartella di ClipDev):

```bash
pnpm link --global
```

ClipDev può essere lanciato semplicemente digitando `clipdev` da dentro la cartella di qualunque altro progetto:

```bash
clipdev
```

In questa modalità, ClipDev rileva automaticamente il nome del progetto, la sua descrizione (leggendo `README.md` o `package.json`) e prova a indovinare l'indirizzo del server di sviluppo in base al framework usato (Next.js, Vite, Angular, ecc.). Ogni rilevamento automatico resta comunque sovrascrivibile:

La qualità della scaletta generata dipende direttamente dalla qualità di questa descrizione: un `README.md` che spiega davvero cosa fa il progetto e quali funzionalità offre produce un outline pertinente, mentre un README assente o troppo generico (solo badge, istruzioni di installazione, nessuna descrizione delle funzionalità) lascia l'agente con poco materiale su cui basarsi, con il rischio di una scaletta vaga o poco accurata. In questi casi conviene passare una descrizione più completa con `--summary`, invece di affidarsi al rilevamento automatico.

```bash
clipdev --name="Nome Progetto" --summary="Descrizione..." --url="http://localhost:5173"
```

Parametri disponibili:

| Parametro | Descrizione | Default |
|---|---|---|
| `--name` | Nome del progetto | rilevato automaticamente |
| `--summary` | Descrizione tecnica del progetto | rilevato automaticamente |
| `--url` | Indirizzo del sito da registrare | rilevato automaticamente |
| `--headless` | `false` per vedere il browser durante la registrazione | `true` |
| `--duration` | Durata minima del video, in millisecondi | `5000` |

Quando usato in questa modalità, la chiave API viene letta da `~/.clipdev.env` (nella cartella personale dell'utente), non dal file `.env` del progetto: crea quel file con lo stesso contenuto mostrato sopra, oppure imposta la variabile d'ambiente in modo permanente con `setx ANTHROPIC_API_KEY "sk-ant-..."` (Windows).

### Come libreria, per controllo completo

Per scegliere manualmente le interazioni da mostrare nel video (invece di lasciarle decidere all'agente), è possibile richiamare la funzione principale direttamente da uno script Node.js:

```js
import { runClipDevPipeline } from "./pipeline/clipDevPipeline.js";

const result = await runClipDevPipeline({
  projectName: "Nome Progetto",
  projectSummary: "Descrizione tecnica del progetto...",
  url: "http://localhost:3000",
  actions: [
    { type: "click", selector: "#apri-menu" },
    { type: "fill", selector: "#campo-ricerca", value: "esempio" },
    { type: "click", selector: "#cerca" },
  ],
  headless: true,
  minDurationMs: 8000,
});

console.log(result.socialPost);
```

## Struttura del progetto

```
index.js                    Punto di avvio da riga di comando (parametri espliciti)
bin/clipdev.js               Comando globale `clipdev` (rilevamento automatico)
pipeline/clipDevPipeline.js  Coordina l'intero processo, dall'analisi al salvataggio
ai/
  agents/
    analystAgent.js          Trasforma la descrizione del progetto in una scaletta
    directorAgent.js         Sceglie le interazioni da mostrare nel video
    copywriterAgent.js       Scrive il testo del post per LinkedIn
  models/
    anthropic.js             Crea i modelli Claude condivisi dai tre agenti; qui
                              avviene anche il controllo sulla chiave API
tools/
  browser/
    recordDemoTool.js        Coordina la registrazione: apertura pagina, esecuzione
                              interazioni, produzione del video
    humanInteraction.js      Simula un'interazione umana con la pagina (cursore
                              visibile, movimento del mouse, scorrimento)
    pageInspection.js        Individua gli elementi della pagina con cui interagire
    videoTranscode.js        Converte il video registrato nel formato finale
    recordingConfig.js       Dimensioni del video condivise tra i moduli
  saveOutputTool.js          Salva su disco scaletta e post
  projectDetection.js        Interpreta i parametri da riga di comando e indovina
                              l'URL del dev server, per il comando globale `clipdev`
tests/                       Test automatici (node --test) sulla logica pura e
                              di sicurezza: validazione, filtri, rilevamento
```

## Problemi comuni

**"ANTHROPIC_API_KEY non trovata"** — Verifica di aver creato il file `.env` (o `~/.clipdev.env` per il comando globale) con la chiave corretta, e di aver avviato con il flag `--env-file=.env` se usi `index.js` direttamente.

**"ffmpeg non è stato trovato nel PATH di sistema"** — ffmpeg non è installato, o non è raggiungibile da riga di comando. Installalo e riavvia il terminale.

**"Impossibile indovinare l'URL del dev server"** (solo con `clipdev` globale) — Il framework usato dal progetto non è tra quelli riconosciuti automaticamente, e nessuno script (`dev`/`start`) dichiara esplicitamente una porta (`--port`). Specifica l'indirizzo esplicitamente con `--url`.

**"Impossibile raggiungere http://localhost:PORTA"** (solo con `clipdev` globale) — L'indirizzo rilevato (o passato con `--url`) non risponde. Assicurati che il server di sviluppo del progetto sia già avviato prima di lanciare `clipdev`, oppure correggi la porta.

**Il video non contiene interazioni, solo la pagina ferma** — Può succedere se la pagina non ha elementi interattivi visibili al momento della registrazione (ad esempio se il contenuto è ancora in caricamento, o si trova dietro un `canvas`/`iframe`). Il log della console indica quanti elementi sono stati rilevati sulla pagina.

**La scaletta generata è vaga, generica o poco accurata** (solo con `clipdev` globale) — Il progetto non ha un `README.md` che descriva davvero le sue funzionalità, oppure ne è privo del tutto: senza una descrizione tecnica sufficiente, l'agente che genera l'outline ha poco materiale su cui basarsi. Passa una descrizione più dettagliata con `--summary="..."`.

## Nota sullo sviluppo

L'idea, l'obiettivo del prodotto e le scelte di design (come dev'essere fatto un video demo, cosa deve produrre lo strumento, quali garanzie di sicurezza deve rispettare) sono opera di chi lo ha ideato. Il codice è stato scritto con il supporto di un assistente AI e sottoposto, in seguito, a una revisione tecnica mirata, che ha incluso:

- controllo sistematico della gestione degli errori in ogni modulo (validazione degli input, timeout su ogni chiamata esterna — inclusa l'API di Anthropic —, pulizia delle risorse anche nei percorsi di fallimento);
- verifica dell'architettura scelta a confronto con la documentazione ufficiale di Anthropic e di LangChain.js, per accertare che il tipo di sistema realizzato (un processo coordinato in modo deterministico, non un agente pienamente autonomo) fosse davvero quello più adatto a questo caso d'uso;
- rimozione del codice non più utilizzato;
- suddivisione dei file più estesi in moduli con una responsabilità ciascuno, per maggiore chiarezza;
- riscrittura dei commenti nel codice in linguaggio chiaro e verificabile anche da chi non programma;
- verifica dei controlli di sicurezza già presenti (interazioni limitate a siti in esecuzione in locale, esclusione automatica di azioni potenzialmente distruttive come logout o eliminazioni, protezione contro percorsi di file non validi).

## Licenza

ISC
