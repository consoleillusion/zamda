// The globe demo is one static page with one Svelte island. zamda and the BGP data package are read from
// source through the `zamda-source` export condition, so no library build is needed while developing.
import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';

export default defineConfig({
  integrations: [svelte()],
  devToolbar: { enabled: false },
  server: { port: 4321 },
  vite: {
    resolve: { conditions: ['zamda-source', 'module', 'browser', 'development|production'] },
    worker: { format: 'es' },
    server: { fs: { allow: ['../..'] } },
    // deck.gl's luma.gl ships modern syntax already; no transpiling needed.
    build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
    optimizeDeps: { exclude: ['zamda'] },
  },
});
