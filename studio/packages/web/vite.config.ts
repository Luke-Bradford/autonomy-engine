import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_PORT = process.env.SERVER_PORT ?? '8080';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split the Fluent UI stack (+ its Griffel CSS-in-JS and Floating UI
        // positioning deps) into its own vendor chunk. The U0 spike measured
        // ~+64 kB gzip landing in ONE un-split chunk from the barrel import;
        // isolating it keeps the app entry chunk lean and lets the browser
        // cache the framework separately from app code.
        manualChunks(id: string): string | undefined {
          if (/[\\/]node_modules[\\/](@fluentui|@griffel|@floating-ui)[\\/]/.test(id)) {
            return 'fluent';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // `ws: true` proxies the WebSocket upgrade for the P6 live-run tail
      // (`/api/runs/:id/events/stream`) as well as the REST calls under `/api`.
      '/api': { target: `http://127.0.0.1:${SERVER_PORT}`, ws: true },
      '/health': `http://127.0.0.1:${SERVER_PORT}`,
    },
  },
});
