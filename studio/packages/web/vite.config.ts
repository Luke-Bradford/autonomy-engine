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
        //
        // BUNDLE BUDGET (the spec pins one to U1; measured on this config, so
        // re-measure with `pnpm --filter @autonomy-studio/web build` when it
        // changes). Baseline at U1 — gzip: `fluent` 22.48 kB · entry 167.43 kB
        // · css 4.27 kB. U1 added ~+5.0 kB gzip total, of which +4.64 kB is one
        // Fluent `Switch` and it landed in `fluent`, NOT the entry (+0.20) —
        // which is what this split is for, and the property to hold as U4-U29
        // pull in more Fluent surface. The entry chunk is over Rollup's 500 kB
        // raw warning already and is tracked separately by #698 (route-level
        // code-splitting). Treat a Fluent-driven jump in the ENTRY chunk as the
        // regression to investigate — it means a barrel import escaped this rule.
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
