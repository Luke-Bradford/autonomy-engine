import { createHashRouter, RouterProvider } from 'react-router';
import { ROUTES } from './routes';

/**
 * HASH routing, kept from the pre-U2 hand-rolled router: every URL still
 * requests `/index.html`, so the Fastify static route that serves the built SPA
 * in the P7 single-container image needs no history-API fallback. Switching to
 * a browser router would be a server change, and the spec pins `createHashRouter`.
 *
 * Created ONCE at module scope: a data router owns its history subscription and
 * its navigation state, so building a fresh one per render would reset both on
 * every commit.
 */
const hashRouter = createHashRouter(ROUTES);

// A data router subscribes to `popstate`/`pagehide` the moment it is created,
// and `RouterProvider` never disposes it. In production that is exactly right —
// one router for the page's lifetime — but a Vite HMR re-evaluation of this
// module builds a second one while the first stays subscribed, so a dev session
// accumulates routers that all react to the same Back button.
if (import.meta.hot) {
  import.meta.hot.dispose(() => hashRouter.dispose());
}

interface AppProps {
  /**
   * Injectable so tests mount the real `ROUTES` under `createMemoryRouter` at a
   * chosen initial entry, instead of driving `window.location.hash` and racing
   * jsdom's asynchronous `hashchange`.
   */
  router?: typeof hashRouter;
}

export default function App({ router = hashRouter }: AppProps) {
  return <RouterProvider router={router} />;
}
