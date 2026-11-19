// Serves the signal deck: `bun run demo`, then open http://localhost:3000.
// Bun bundles demo/index.html and the TypeScript it imports. The routes and
// graph files come from `bun run prep-bgp` (real data); routes can also come
// from `bun scripts/fake-routes.ts`. The worker and engine are served for the
// JS-versus-WASM race; a missing engine is reported by the page, not hidden.

import page from './index.html';

const ROUTES = process.env.ROUTES ?? 'data/routes.bin';
const GRAPH = process.env.GRAPH ?? 'data/graph.bin';
const ENGINE = process.env.ENGINE ?? 'dist/zamda-engine.wasm';
const port = Number(process.env.PORT ?? 3000);

// Bun's bundler does not bundle `new Worker(...)` (checked on Bun 1.4.4), so the
// engine's worker is built here and served as a module the page can start by URL.
let workerSource: string | null = null;
try {
  const built = await Bun.build({ entrypoints: ['src/backends/wasm/worker-entry.ts'], target: 'browser', format: 'esm' });
  if (!built.success) throw new Error(built.logs.join('\n'));
  workerSource = await built.outputs[0]!.text();
} catch (error) {
  console.error('The engine worker did not build:', error);
}

function wasmHeaders(): Record<string, string> {
  // Purpose: browser headers for the engine module, including HEAD checks
  return { 'content-type': 'application/wasm', 'cache-control': 'no-store' };
}

const server = Bun.serve({
  port,
  routes: {
    '/': page,
    '/data/routes.bin': function serveRoutes() {
      // Purpose: the routes file, or a 404 that says how to make one
      const file = Bun.file(ROUTES);
      return file.exists().then(function (exists) {
        // Purpose: respond with the file if it is there
        if (exists) return new Response(file, { headers: { 'content-type': 'application/octet-stream' } });
        return new Response(`No ${ROUTES}. Run \`bun run prep-bgp\` or \`bun scripts/fake-routes.ts\` first.`, { status: 404 });
      });
    },
    '/data/graph.bin': function serveGraph() {
      // Purpose: the AS graph file, or a 404 that says how to make one
      const file = Bun.file(GRAPH);
      return file.exists().then(function (exists) {
        // Purpose: respond with the file if it is there
        if (exists) return new Response(file, { headers: { 'content-type': 'application/octet-stream' } });
        return new Response(`No ${GRAPH}. Run \`bun run prep-bgp\` first.`, { status: 404 });
      });
    },
    '/worker-entry.js': function serveWorker() {
      // Purpose: the module the page gives to `new Worker`, built at startup
      if (workerSource === null) return new Response('The engine worker is unavailable', { status: 503 });
      return new Response(workerSource, { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' } });
    },
    '/engine.wasm': function serveEngine(request: Request) {
      // Purpose: the engine bytes, or a typed 404 the page can report honestly
      const file = Bun.file(ENGINE);
      return file.exists().then(function (exists) {
        // Purpose: answer HEAD without sending the module, and GET with the module
        if (!exists) return new Response(`No ${ENGINE}. Run \`bun run wasm:build\` first.`, { status: 404 });
        if (request.method === 'HEAD') return new Response(null, { headers: wasmHeaders() });
        return new Response(file, { headers: wasmHeaders() });
      });
    },
  },
  development: process.env.NODE_ENV !== 'production',
});

console.log(
  `zamda signal deck on ${server.url} (routes from ${ROUTES}, graph from ${GRAPH}, engine from ${ENGINE}; ` +
    `add ?live=sim for a simulated live feed)`,
);
