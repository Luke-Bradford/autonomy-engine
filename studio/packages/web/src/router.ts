import { useSyncExternalStore } from 'react';

/**
 * A deliberately tiny hash-based router. Hash routing (`#/connections`) is
 * self-contained: it needs no server-side SPA fallback (every URL still
 * requests `/index.html`), which keeps P5 free of any change to the Fastify
 * static-serving story (that lands in P7 packaging). The locked stack lists
 * no router dependency, and the app's route space is small and flat, so this
 * ~20-line hook is the right amount of machinery — not react-router.
 */
function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, '');
  return hash === '' ? '/' : hash;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

/** The current in-app path (the bit after `#`), reactive to back/forward. */
export function useRoute(): string {
  // Server snapshot is only for SSR, which the SPA never does; '/' is a safe
  // constant so React never warns about a mismatched server render.
  return useSyncExternalStore(subscribe, currentPath, () => '/');
}

/** Imperative navigation; setting the hash fires `hashchange`, re-rendering. */
export function navigate(path: string): void {
  window.location.hash = path;
}
