// Serves the WASM spike benchmark: `bun run spike:browser`, then open http://localhost:3002
// (or set PORT). Needs `bun run spike:build` first. Uses data/routes.bin, or ROUTES=path.

import page from './index.html';

const ROUTES = process.env.ROUTES ?? 'data/routes.bin';
const WASM = process.env.WASM ?? 'spike/target/wasm32-unknown-unknown/release/zamda_spike.wasm';
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3002),
  routes: {
    '/': page,
    '/data/routes.bin': () => new Response(Bun.file(ROUTES)),
    '/spike.wasm': () => new Response(Bun.file(WASM), { headers: { 'content-type': 'application/wasm' } }),
  },
});
console.log(`zamda WASM spike benchmark on ${server.url} (routes from ${ROUTES}, module from ${WASM})`);
