import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { z } from 'zod';

import { adminManualPlugin } from './vite-plugin-admin-manual';

const EnvSchema = z.object({
  // The Cast API server the web UI proxies to.
  CAST_PORT: z.coerce.number().int().default(5050),
  // The port the web UI itself listens on — what the user actually opens.
  PORT: z.coerce.number().int().default(5051),
});

const env = EnvSchema.parse(process.env);

const proxy = {
  '/api': {
    target: `http://127.0.0.1:${env.CAST_PORT}`,
    // `ws: true` covers the admin events WebSocket at `/api/admin/events`
    // (Task 86 Phase 3.1). Without this, Vite hands the upgrade request
    // to the SPA fallback and the WS never connects — the agent's replies
    // never reach the worker, even though cast emits them server-side.
    ws: true,
  },
  '/agents': `http://127.0.0.1:${env.CAST_PORT}`,
  '/web': {
    target: `http://127.0.0.1:${env.CAST_PORT}`,
    ws: true,
  },
};

export default defineConfig({
  plugins: [preact(), tailwindcss(), adminManualPlugin()],
  build: {
    outDir: 'dist',
  },
  worker: {
    // ES modules are required for `import` inside the SharedWorker bundle
    // (the persistence worker pulls Zod, the IDB store, etc.). Default
    // 'iife' breaks on bare module imports.
    format: 'es',
  },
  server: {
    port: env.PORT,
    // Fail loud if the port is taken rather than silently moving to the next
    // one — otherwise the browser opens the configured port and hits a stale
    // orphan instead of this server.
    strictPort: true,
    proxy,
  },
  preview: {
    port: env.PORT,
    strictPort: true,
    proxy,
  },
});
