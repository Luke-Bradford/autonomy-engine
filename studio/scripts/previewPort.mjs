/**
 * The preview server's address, as a CONSTANT ONLY.
 *
 * Its own module because `preview.mjs` runs on import — it probes the port and
 * spawns the server as top-level code — so importing the number from there
 * would start a second server every time something merely wanted to know the
 * port. `shot.mjs` does exactly that, which would have meant a spawned server
 * per screenshot, each failing the busy-port check.
 *
 * The same rule the engine's shell scripts state as "every script's executable
 * body is guarded": a module that DOES something on import cannot also be the
 * place a value is read from.
 */
export const PREVIEW_PORT = 8080;
export const PREVIEW_HOST = '127.0.0.1';
export const PREVIEW_URL = `http://${PREVIEW_HOST}:${String(PREVIEW_PORT)}`;
