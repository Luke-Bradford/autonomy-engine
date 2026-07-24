import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
// The bridge remaps React Flow's `--xy-*` chrome vars onto Fluent tokens; it
// must be keyed on the FluentProvider root class (see fluentTheme.ts).
import './theme/xyThemeBridge.css';
import { AppThemeProvider } from './theme/AppThemeProvider';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element not found');
}

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
