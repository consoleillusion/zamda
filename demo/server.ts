// Serves the reference dashboard: `bun run demo`, then open http://localhost:3000.
// Bun bundles demo/index.html and the TypeScript it imports. The routes file
// comes from `bun run prep-bgp` (real data) or `bun scripts/fake-routes.ts`.

import page from './index.html';

const ROUTES = process.env.ROUTES ?? 'data/routes.bin';
const port = Number(process.env.PORT ?? 3000);

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
  },
  development: process.env.NODE_ENV !== 'production',
});

console.log(`zamda dashboard on ${server.url} (routes from ${ROUTES}; add ?live=sim for a simulated live feed)`);
