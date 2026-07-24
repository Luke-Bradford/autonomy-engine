import { Outlet } from 'react-router';
import { HubRail } from './HubRail';

/**
 * The shell layout route: a fixed 48px hub rail beside the workspace, with the
 * active hub's page rendered into the `<Outlet/>`.
 *
 * The workspace keeps the `content` class deliberately. `index.css` hangs three
 * behaviours off it — page padding, a 900px reading cap for forms and lists,
 * and `:has(.canvas-page)` which REMOVES that cap so the authoring canvas is
 * full-bleed. Renaming it here would silently re-cap the canvas at 900px, which
 * no unit test can see (jsdom computes no layout).
 *
 * The secondary pane and command bar of the spec's shell diagram are U3; this
 * is the rail + workspace half of it.
 */
export function AppShell() {
  return (
    <div className="app-shell">
      {/* No `store` seam here: the rail takes one for its own unit tests, and
          the composed tree deliberately runs on the `uiStore` singleton — which
          is what `App.test.tsx` asserts the theme provider shares. */}
      <HubRail />
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
