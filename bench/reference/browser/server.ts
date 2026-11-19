// Serves the browser benchmark: `bun run bench:browser`, then open http://localhost:3001
// (or set PORT); the worker check (T-409/T-410) is at /worker.html. Uses data/routes.bin, or ROUTES=path.

import page from './index.html';
import workerPage from './worker.html';

const ROUTES = process.env.ROUTES ?? 'data/routes.bin';
const ENGINE = process.env.ENGINE ?? 'dist/zamda-engine.wasm';
// Bun's bundler does not bundle `new Worker(...)` (checked on Bun 1.4.4), so the engine's worker is built here
// and served as a module the page can start by URL.
const built = await Bun.build({ entrypoints: ['src/backends/wasm/worker-entry.ts'], target: 'browser', format: 'esm' });
if (!built.success) throw new Error(`The engine worker did not build:\n${built.logs.join('\n')}`);
const workerSource = await built.outputs[0]!.text();
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3001),
  routes: {
    '/': page,
    '/worker.html': workerPage,
    '/worker': workerPage,
    '/worker-entry.js': () => new Response(workerSource, { headers: { 'content-type': 'text/javascript' } }),
    '/data/routes.bin': () => new Response(Bun.file(ROUTES)),
    '/engine.wasm': () => (Bun.file(ENGINE).size > 0 ? new Response(Bun.file(ENGINE), { headers: { 'content-type': 'application/wasm' } }) : new Response('no engine module', { status: 404 })),
  },
});
console.log(`routes: / , /worker.html , /worker-entry.js , /engine.wasm , /data/routes.bin`);
console.log(`zamda browser benchmark on ${server.url} (routes from ${ROUTES}, engine from ${ENGINE})`);
