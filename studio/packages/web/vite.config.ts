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
        // pull in more Fluent surface. (The entry chunk was over Rollup's 500 kB
        // raw warning at the time; #698 below fixed that.) Treat a Fluent-driven
        // jump in the ENTRY chunk as the regression to investigate — it means a
        // barrel import escaped this rule.
        //
        // #698 measured (route-level code-splitting, bug sweep) — gzip:
        // `fluent` 71.03 kB · `router` 30.64 kB · entry 109.46 kB · index css
        // 2.87 kB · NEW `PipelineCanvasRoute` 60.01 kB + its own css 2.56 kB.
        // The before-figure is from building `origin/main` (e45e5b4) in a
        // throwaway worktree rather than reusing U4's recorded 169.39 — the two
        // differ by 0.06 kB, so quote the one that reproduces against a commit.
        // The entry chunk fell 169.45 -> 109.46 kB gzip (558.91 -> 372.62 kB
        // raw), a 35% cut, and Rollup's >500 kB raw warning is gone. The whole
        // of that came from ONE route: `@xyflow/react` is imported only by the
        // canvas, so until now every visitor downloaded React Flow to look at a
        // list of runs. Vite split the canvas's CSS out on the same boundary
        // without being asked; total CSS is a shade larger (5.43 vs 5.17 kB
        // gzip) but first paint only pays 2.87 kB of it.
        //
        // U11 measured (run-monitor node overlay) — gzip: entry 122.62 kB
        // (from 111.09 on `origin/main`, built in a throwaway worktree) · index
        // css 3.99 kB · `PipelineCanvasRoute` 11.07 kB · NEW shared
        // `containerLayout` chunk (React Flow + the canvas geometry both views
        // use) · NEW `RunGraph` 1.4 kB. Rollup's >500 kB raw warning stays gone.
        //
        // The first cut of U11 imported the run canvas STATICALLY from
        // `RunDetailPage`, which is eagerly routed — that put `@xyflow/react`
        // straight back in the entry (111.09 -> 182.14 kB gzip) and undid #698
        // above without any test noticing. `RunGraph.lazy.ts` is the fix, and
        // the boundary is in the PAGE so the run metadata, node table and event
        // feed paint without waiting on React Flow.
        //
        // The residual +11.53 kB is the ENGINE REDUCER, and it is understood
        // rather than mysterious: eager code already imports the engine barrel
        // (`runSummary.ts` needs `EngineEventSchema`), so `engine/reduce.js` is
        // placed in the ENTRY chunk. On `main` nothing referenced `createEngine`
        // and tree-shaking dropped it; U11's overlay references it from the LAZY
        // chunk, so it survives — in the chunk it was already placed in. The
        // lever, if this is ever worth reclaiming, is a subpath export on
        // `@autonomy-studio/shared` so the reducer is not reached through a
        // barrel the entry already holds. Not worth a package-boundary change
        // for 11 kB today; recorded so the next person does not re-derive it.
        //
        // U7 measured (per-activity node config form) — gzip: entry 122.62 kB
        // UNCHANGED · index css 3.99 kB UNCHANGED · `PipelineCanvasRoute`
        // 11.07 -> 12.38 kB. The whole +1.31 kB lands in the LAZY canvas chunk,
        // which is the property being checked: `configForm.ts` is imported only
        // by `PipelineCanvas`, and it pulls in nothing new — it reads Zod's
        // introspection surface off schemas the canvas chunk already holds, so
        // there is no second copy of `zod` and no new dependency edge.
        //
        // Only the canvas route is lazy. The other pages are ordinary React +
        // Fluent and would each buy back single-digit kB for a Suspense
        // boundary apiece — measure before adding more, rather than lazying
        // every route reflexively.
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
