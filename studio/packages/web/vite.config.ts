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
        //
        // U2 measured — gzip: `fluent` 39.69 kB · `router` 30.59 kB · entry
        // 167.13 kB · css 4.30 kB. Two things worth keeping straight:
        //   - the `fluent` rise (+17.2 kB) is `Tooltip` and its Floating UI
        //     positioning, NOT the eight named icon imports. The built chunk
        //     carries two `viewBox`es in total, so `@fluentui/react-icons`'
        //     barrel does tree-shake and the named-import rule is doing its job;
        //   - the ENTRY is flat on U1 (167.43 -> 167.13) despite U2 adding a
        //     route tree, a shell and a Home page, because react-router left it
        //     for the `router` chunk below. That is the property to hold.
        // Total shipped JS is up ~30 kB gzip, which IS what a router costs.
        //
        // U4 measured — gzip: `fluent` 71.03 kB · `router` 30.63 kB · entry
        // 169.39 kB · css 5.17 kB. The `fluent` jump (+31.3 kB gzip / +108 kB
        // raw) is ONE surface: the row `⋯` uses Fluent's `Menu`, which drags in
        // the menu machinery and more of Floating UI. Priced directly, by
        // building with the `Menu` usage removed (125.79 kB raw / 40.12 gzip)
        // and again with it (234.03 / 71.03) — not inferred.
        //   - it landed in `fluent`, NOT the entry, which is exactly what this
        //     split exists for and the property U1 set out to hold;
        //   - the ENTRY is flat again (167.13 -> 169.39, and that +2.3 kB is
        //     the pane, the store, the route and the tree itself, not Fluent).
        // It is a real cost, and it is why U4 declined a Fluent `Dialog` on top
        // of it for create/rename/duplicate and used an inline name row: the
        // second heavy surface would have been additive, for an interaction a
        // resources tree is better off doing in place anyway.
        manualChunks(id: string): string | undefined {
          if (/[\\/]node_modules[\\/](@fluentui|@griffel|@floating-ui)[\\/]/.test(id)) {
            return 'fluent';
          }
          // react-router is a stable vendor dependency on every route, so it
          // belongs in a separately-cacheable chunk rather than in the entry
          // that every app change invalidates. `cookie-es` is its only dep.
          if (/[\\/]node_modules[\\/](react-router|cookie-es)[\\/]/.test(id)) {
            return 'router';
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
