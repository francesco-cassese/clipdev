// tools/projectDetection.js
//
// Logica di rilevamento automatico usata dal comando globale `clipdev`
// (bin/clipdev.js): interpretazione dei parametri da riga di comando e
// individuazione della porta di sviluppo in base al framework usato dal
// progetto target. Tenuta separata dallo script di avvio (che esegue
// codice immediatamente al caricamento, incluse letture da disco e
// eventuali `process.exit`) perché queste due funzioni sono pure — stesso
// input, stesso output, nessun effetto collaterale — e possono quindi
// essere verificate da test automatici senza dover simulare un'intera
// esecuzione da riga di comando.

// --- Lettura dei parametri passati da riga di comando (--nome=valore) ------
// Con solo quattro parametri stabili, un'analisi scritta a mano resta più
// semplice da mantenere di una libreria dedicata, e non appesantisce
// l'installazione globale del comando.
export function parseFlags(argv) {
  const flags = {};
  for (const arg of argv) {
    const match = arg.match(/^--([a-zA-Z-]+)=(.*)$/s);
    if (match) {
      flags[match[1]] = match[2];
    }
  }
  return flags;
}

// --- Rilevamento (indicativo) dell'indirizzo del server di sviluppo --------
// Associa ogni framework più diffuso alla porta che usa per default sul
// proprio server di sviluppo. È un rilevamento indicativo, non una
// certezza: un progetto potrebbe aver cambiato porta nella propria
// configurazione (per questo viene usato solo come ripiego, dopo
// guessPortFromScripts qui sotto). Per questo resta sempre sovrascrivibile
// con --url, e quando viene usato lo si segnala esplicitamente, per
// trasparenza.
export const FRAMEWORK_DEFAULT_PORTS = [
  { dep: "next", port: 3000 },
  { dep: "vite", port: 5173 },
  { dep: "react-scripts", port: 3000 },
  { dep: "@angular/cli", port: 4200 },
  { dep: "@vue/cli-service", port: 8080 },
  { dep: "nuxt", port: 3000 },
  { dep: "astro", port: 4321 },
  { dep: "@remix-run/dev", port: 3000 },
  { dep: "gatsby", port: 8000 },
  { dep: "parcel", port: 1234 },
  { dep: "webpack-dev-server", port: 8080 },
];

// Riconosce una porta esplicita (--port o -p) dentro lo script "dev" (o, in
// mancanza, "start") del progetto. Questa è un'informazione specifica del
// progetto reale, quindi più affidabile della porta di default del
// framework: un progetto può aver cambiato porta senza che questo sia in
// alcun modo visibile dalle sole dipendenze elencate in package.json.
const EXPLICIT_PORT_PATTERN = /(?:--port|-p)[= ]+(\d{2,5})/i;

export function guessPortFromScripts(pkg) {
  const scripts = pkg?.scripts;
  if (!scripts) return null;
  for (const scriptName of ["dev", "start"]) {
    const match = scripts[scriptName]?.match(EXPLICIT_PORT_PATTERN);
    if (match) return Number(match[1]);
  }
  return null;
}

export function guessDevServerUrl(pkg) {
  if (!pkg) return null;

  // La porta dichiarata esplicitamente in uno script ha sempre la
  // precedenza: riflette la configurazione reale di questo progetto
  // specifico, non solo un'ipotesi basata sul framework usato. Per questo
  // motivo si applica anche quando nessun framework tra quelli noti sopra
  // viene riconosciuto tra le dipendenze.
  const explicitPort = guessPortFromScripts(pkg);
  if (explicitPort) return `http://localhost:${explicitPort}`;

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const match = FRAMEWORK_DEFAULT_PORTS.find(({ dep }) => dep in allDeps);
  return match ? `http://localhost:${match.port}` : null;
}

// --- Rilevamento (indicativo) della rotta di un'entità citata nei requisiti -
// Parole chiave (italiano/inglese) associate a un tipo di contenuto tipico
// di un'applicazione web, con le rotte più comuni sotto cui quel contenuto
// suole trovarsi. Usata per far partire la registrazione direttamente sulla
// pagina giusta invece di far scoprire all'agente, partendo alla cieca dalla
// home page, che quella rotta esiste (spesso dietro un menu collassato): se
// la descrizione del progetto cita un catalogo/dei prodotti, non serve
// un'AI per sapere che vale la pena provare "/prodotti" o "/products" prima
// di chiedere a un agente di navigare fin lì da solo. Resta un'ipotesi, non
// una certezza — per questo ogni candidato viene poi verificato realmente
// (vedi tryResolveEntityRoute in tools/browser/recordDemoTool.js) prima di
// essere adottato, invece di essere usato alla cieca.
const ENTITY_ROUTE_HINTS = [
  { keywords: ["prodott", "product", "catalog", "shop", "negozio", "store"], paths: ["/prodotti", "/products", "/catalogo", "/catalog", "/shop", "/store"] },
  { keywords: ["articol", "post", "blog"], paths: ["/blog", "/articoli", "/articles", "/posts"] },
  { keywords: ["progett", "project", "portfolio"], paths: ["/progetti", "/projects", "/portfolio"] },
  { keywords: ["contatt", "contact"], paths: ["/contatti", "/contact", "/contacts"] },
  { keywords: ["servizi", "service"], paths: ["/servizi", "/services"] },
  { keywords: ["dashboard"], paths: ["/dashboard"] },
];

// Restituisce le rotte candidate (senza duplicati, nell'ordine dei gruppi
// sopra) la cui parola chiave compare nel testo fornito (tipicamente la
// descrizione del progetto data in input all'Analyst Agent). Un array vuoto
// significa "nessun'ipotesi", non un errore: molti progetti non hanno
// un'entità di questo tipo, ed è un esito normale quanto trovarne una.
export function guessEntityRoutePaths(text) {
  if (!text) return [];
  const lowerText = text.toLowerCase();
  const matchedPaths = [];
  for (const hint of ENTITY_ROUTE_HINTS) {
    if (hint.keywords.some((keyword) => lowerText.includes(keyword))) {
      for (const path of hint.paths) {
        if (!matchedPaths.includes(path)) matchedPaths.push(path);
      }
    }
  }
  return matchedPaths;
}
