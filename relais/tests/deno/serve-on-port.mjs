/* global Deno */
// Lanceur des tests : charge une fonction Edge en imposant son port à Deno.serve. Le moteur de Supabase
// (compatible Deno 2.1) ne lit pas DENO_SERVE_ADDRESS ; chaque fonction écoute sinon sur le port 8000.
// Usage : deno run … tests/deno/serve-on-port.mjs <port> <chemin de index.ts>
const [port, entry] = Deno.args;
if (!port || !entry) throw new Error('usage: serve-on-port.mjs <port> <entry>');

const serve = Deno.serve.bind(Deno);
Object.defineProperty(Deno, 'serve', {
    value: (handler) => serve({ hostname: '127.0.0.1', port: Number(port), onListen() {} }, handler)
});
await import(new URL(entry, `file://${Deno.cwd()}/`).href);
