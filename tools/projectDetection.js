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
