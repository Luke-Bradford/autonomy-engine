import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
// The bridge remaps React Flow's `--xy-*` chrome vars onto Fluent tokens; it
// must be keyed on the FluentProvider root class (see fluentTheme.ts).
import './theme/xyThemeBridge.css';
import { AppThemeProvider } from './theme/AppThemeProvider';
import { uiStore } from './stores/uiStore';
import { syncColorScheme } from './theme/fluentTheme';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element not found');
}

// Paint the stored preference as early as this bundle can: `index.css` is a
// render-blocking stylesheet whose base `:root` block is DARK, so between first
// paint and React's first commit a `light` user would see a full dark page. The
// provider's layout effect is too late for that first frame (it waits on the
// entry chunk parsing and React mounting), so the mode is mirrored here at
// module scope too — the same call U0 made. Both are idempotent attribute
// writes. This narrows the flash to the CSS-vs-JS window; closing it entirely
// needs an inline bootstrap script in `index.html`, deferred as not worth the
// CSP surface for a local-first app.
syncColorScheme(uiStore.getState().themeMode);

createRoot(container).render(
  <StrictMode>
    {/* Owns the Fluent theme AND the `data-theme` mirror, both driven by
        `uiStore.themeMode`. U0 mounted a fixed dark provider here; U1 makes it
        reactive. */}
    <AppThemeProvider>
      <App />
    </AppThemeProvider>
  </StrictMode>,
);
