import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FluentProvider } from '@fluentui/react-components';
import App from './App';
import './index.css';
// The bridge remaps React Flow's `--xy-*` chrome vars onto Fluent tokens; it
// must be keyed on the FluentProvider root class (see fluentTheme.ts).
import './theme/xyThemeBridge.css';
import {
  DEFAULT_THEME_MODE,
  FLUENT_ROOT_CLASS,
  THEMES,
  syncColorScheme,
} from './theme/fluentTheme';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element not found');
}

// Keep native controls + the pre-Fluent index.css variables aligned with the
// Fluent theme. U0 is dark-only (the toggle is U1).
syncColorScheme(DEFAULT_THEME_MODE);

createRoot(container).render(
  <StrictMode>
    <FluentProvider theme={THEMES[DEFAULT_THEME_MODE]} className={FLUENT_ROOT_CLASS}>
      <App />
    </FluentProvider>
  </StrictMode>,
);
