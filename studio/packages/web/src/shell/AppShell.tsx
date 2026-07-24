import { Outlet } from 'react-router';
import { HubRail } from './HubRail';
import type { UiStore } from '../stores/uiStore';

interface AppShellProps {
  /** Forwarded to the rail's theme toggle; injectable for tests. */
  store?: UiStore;
}

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
export function AppShell({ store }: AppShellProps) {
  return (
    <div className="app-shell">
      <HubRail store={store} />
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
