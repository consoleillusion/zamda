// Serves the browser benchmark: `bun run bench:browser`, then open http://localhost:3001
// (or set PORT). Uses data/routes.bin, or ROUTES=path.

import page from './index.html';

const ROUTES = process.env.ROUTES ?? 'data/routes.bin';
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3001),
  routes: {
    '/': page,
    '/data/routes.bin': () => new Response(Bun.file(ROUTES)),
  },
});
console.log(`zamda browser benchmark on ${server.url} (routes from ${ROUTES})`);
