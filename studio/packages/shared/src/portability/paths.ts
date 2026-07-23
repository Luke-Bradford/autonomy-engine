/**
 * #3 G3a — the workspace-git file path policy (G1 built-block: "slug util lands
 * in G3 with its first consumer"). A resource serializes to
 * `<kind-dir>/<slug>.json`; **identity is the `resourceId`, the path is
 * cosmetic** (same-id-new-path = a rename, resolved on import G5). Shared
 * (not server-only) so the Author UI can preview a resource's committed path.
 *
 * Two properties are load-bearing and pinned by test:
 * - **Traversal-safe:** the slug maps every non-alphanumeric — including `.`
 *   and `/` — to a dash, so a hostile resource NAME can never climb out of its
 *   kind directory. The write path is additionally containment-asserted, but
 *   the slug is the first line.
 * - **Order-independent bytes:** the `list*` repo fns return rows in no defined
 *   order, so path assignment must not depend on it. Collisions are resolved by
 *   suffixing EVERY member of a colliding slug group with its `resourceId` (a
 *   content-decided rule) — not "first-wins-the-bare-slug", which would flip
 *   with iteration order and churn the committed files (the G1 built-block's
 *   byte-stability contract).
 */

/**
 * The resource kinds in a fixed canonical order — drives `MANAGED_DIRS` and is
 * the ONE list every other kind/dir construct derives from (`ResourceKind`
 * below is derived from it, so the two can never drift). The serializer emits
 * in this same order, though it currently spells its three loops out rather
 * than iterating this list.
 */
export const RESOURCE_KINDS = ['pipeline', 'connection', 'trigger'] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/**
 * The repo directory each kind serializes into — the SSOT for the dir↔kind
 * relationship. `resourceFilePaths` (write side), `kindForDir` (G4 parse side),
 * and the Commit route's `MANAGED_DIRS` all derive from THIS map, so a dir name
 * is never a second magic string that can drift.
 */
export const RESOURCE_KIND_DIRS: Record<ResourceKind, string> = {
  pipeline: 'pipelines',
  connection: 'connections',
  trigger: 'triggers',
};

/** The three studio-managed repo directories, in `RESOURCE_KINDS` order. */
export const MANAGED_DIRS: readonly string[] = RESOURCE_KINDS.map(
  (kind) => RESOURCE_KIND_DIRS[kind],
);

const DIR_TO_KIND: Record<string, ResourceKind> = Object.fromEntries(
  RESOURCE_KINDS.map((kind) => [RESOURCE_KIND_DIRS[kind], kind]),
) as Record<string, ResourceKind>;

/**
 * The resource kind a managed directory holds (the inverse of
 * `RESOURCE_KIND_DIRS`), or `null` when `dir` is not one of the three managed
 * dirs. Used by the G4 workspace parser to decide the kind a committed file is
 * EXPECTED to carry from its path alone.
 */
export function kindForDir(dir: string): ResourceKind | null {
  return DIR_TO_KIND[dir] ?? null;
}

/**
 * The cosmetic slug for a resource name: lowercased, every run of
 * non-alphanumeric characters collapsed to a single `-`, leading/trailing
 * dashes trimmed. Returns `''` for a name with no alphanumerics (the caller
 * substitutes the stable `resourceId`).
 */
export function resourceSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface ResourcePathInput {
  resourceId: string;
  name: string;
}

/**
 * Assigns each resource of one kind its `<dir>/<slug>.json` path, resolving
 * slug collisions deterministically (see the module doc). Returns a
 * `resourceId → path` map. Pure and order-independent: sorting by `resourceId`
 * plus a content-decided collision rule means any input permutation of the
 * same resources yields the identical path set.
 */
export function resourceFilePaths(
  kind: ResourceKind,
  items: readonly ResourcePathInput[],
): Map<string, string> {
  const dir = RESOURCE_KIND_DIRS[kind];
  const sorted = [...items].sort((a, b) =>
    a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0,
  );

  // Base slug per resource; an empty slug (no alphanumerics in the name) falls
  // back to the unique resourceId, which can never collide.
  const baseSlug = new Map<string, string>();
  for (const item of sorted) {
    const slug = resourceSlug(item.name);
    baseSlug.set(item.resourceId, slug === '' ? item.resourceId : slug);
  }

  const slugCounts = new Map<string, number>();
  for (const slug of baseSlug.values()) {
    slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
  }

  const paths = new Map<string, string>();
  for (const item of sorted) {
    const base = baseSlug.get(item.resourceId)!;
    // Collision → suffix EVERY member with its resourceId (order-independent).
    const finalSlug = slugCounts.get(base)! > 1 ? `${base}-${item.resourceId}` : base;
    paths.set(item.resourceId, `${dir}/${finalSlug}.json`);
  }
  return paths;
}
