// Serves the browser benchmark: `bun run bench:browser`, then open http://localhost:3001
// (or set PORT). Uses data/routes.bin, or ROUTES=path.

import page from './index.html';

const ROUTES = process.env.ROUTES ?? 'data/routes.bin';
const ENGINE = process.env.ENGINE ?? 'dist/zamda-engine.wasm';
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3001),
  routes: {
    '/': page,
    '/data/routes.bin': () => new Response(Bun.file(ROUTES)),
    '/engine.wasm': () => (Bun.file(ENGINE).size > 0 ? new Response(Bun.file(ENGINE), { headers: { 'content-type': 'application/wasm' } }) : new Response('no engine module', { status: 404 })),
  },
});
console.log(`zamda browser benchmark on ${server.url} (routes from ${ROUTES}, engine from ${ENGINE})`);
