import { nanoid } from 'nanoid';

/**
 * Generates a collision-resistant, URL-safe id, tagged with an entity prefix
 * purely for human readability when browsing the DB or logs (e.g.
 * `newId('conn')` → `conn_V1StGXR8_Z5jdHi6B-myT`). The prefix carries no
 * semantic meaning and callers must never parse it back out.
 */
export function newId(prefix: string): string {
  return `${prefix}_${nanoid()}`;
}
