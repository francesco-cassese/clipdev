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
// configurazione. Per questo resta sempre sovrascrivibile con --url, e
// quando viene usato lo si segnala esplicitamente, per trasparenza.
export const FRAMEWORK_DEFAULT_PORTS = [
  { dep: "next", port: 3000 },
  { dep: "vite", port: 5173 },
  { dep: "react-scripts", port: 3000 },
  { dep: "@angular/cli", port: 4200 },
  { dep: "@vue/cli-service", port: 8080 },
  { dep: "nuxt", port: 3000 },
];

export function guessDevServerUrl(pkg) {
  if (!pkg) return null;
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const match = FRAMEWORK_DEFAULT_PORTS.find(({ dep }) => dep in allDeps);
  return match ? `http://localhost:${match.port}` : null;
}
