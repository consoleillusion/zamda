// Serves only the standalone BGP topology demo: bun run demo, then open the URL.
// It serves graph.bin, the WASM engine, and a freshly built engine worker. No
// other demo page, table, or control is involved.

import page from './index.html';

const GRAPH = process.env.GRAPH ?? 'data/graph.bin';
const ENGINE = process.env.ENGINE ?? 'dist/zamda-engine.wasm';
const port = Number(process.env.PORT ?? 3000);

let workerSource: string | null = null;
try {
  // Purpose: Bun does not bundle `new Worker(...)`, so serve its entry as a module
  const built = await Bun.build({ entrypoints: ['src/backends/wasm/worker-entry.ts'], target: 'browser', format: 'esm' });
  if (!built.success) throw new Error(built.logs.join('\n'));
  workerSource = await built.outputs[0]!.text();
} catch (error) {
  console.error('The WASM worker did not build:', error);
}

function graphResponse(): Promise<Response> {
  // Purpose: the single data file this visualization needs, or an actionable error
  const file = Bun.file(GRAPH);
  return file.exists().then(function (exists): Response {
    if (exists) return new Response(file, { headers: { 'content-type': 'application/octet-stream' } });
    return new Response(`No ${GRAPH}. Run \`bun run prep-bgp\` first.`, { status: 404 });
  });
}

function engineResponse(request: Request): Promise<Response> {
  // Purpose: HEAD checks the engine and GET sends the module bytes
  const file = Bun.file(ENGINE);
  const headers = { 'content-type': 'application/wasm', 'cache-control': 'no-store' };
  return file.exists().then(function (exists): Response {
    if (!exists) return new Response(`No ${ENGINE}. Run \`bun run wasm:build\` first.`, { status: 404 });
    if (request.method === 'HEAD') return new Response(null, { headers });
    return new Response(file, { headers });
  });
}

const server = Bun.serve({
  port,
  routes: {
    '/': page,
    '/data/graph.bin': graphResponse,
    '/engine.wasm': engineResponse,
    '/worker-entry.js': function worker(): Response {
      // Purpose: the worker module built once at startup
      if (workerSource === null) return new Response('The WASM worker is unavailable', { status: 503 });
      return new Response(workerSource, { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' } });
    },
  },
  development: process.env.NODE_ENV !== 'production',
});

console.log(`zamda BGP topology on ${server.url} (graph ${GRAPH}, engine ${ENGINE})`);
