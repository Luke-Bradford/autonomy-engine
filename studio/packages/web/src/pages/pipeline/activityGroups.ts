import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_CATEGORY_LABELS,
  catalog,
  isStructuralCallActivity,
  type ActivityCatalogEntry,
  type ActivityCategory,
} from '@autonomy-studio/shared';

/*
 * The toolbox's pure grouping/filtering rules (U5).
 *
 * NAMED `activityGroups`, not `activityToolbox`, deliberately: this project is
 * developed on a case-INSENSITIVE filesystem, and Vite resolves a bare
 * `./activityToolbox` through `.ts` BEFORE `.tsx`. A pure `activityToolbox.ts`
 * next to the `ActivityToolbox.tsx` component therefore captured the component's
 * own import — every render resolved to this module, and `<ActivityToolbox/>`
 * was `undefined`. Two modules in one directory differing only in the case of
 * their first letter is the hazard; distinct names retire it.
 */

/** One rendered group of the activities toolbox (U5). */
export interface ToolboxGroup {
  category: ActivityCategory;
  /** The group heading, from the shared label SSOT. */
  label: string;
  /** Non-empty by construction — an empty group is omitted, not rendered blank. */
  entries: ActivityCatalogEntry[];
}

/**
 * The toolbox's rendered content for a search query — pure, so the grouping and
 * filtering rules are testable without a DOM.
 *
 * Three rules worth stating, because each is a decision rather than a default:
 *
 * 1. **Group order is `ACTIVITY_CATEGORIES`, not catalog order.** The catalog's
 *    Map order is registry DECLARATION order, which interleaves categories.
 * 2. **Entry order inside a group is alphabetical by title.** Declaration order
 *    tracks nothing a user can see, so a "searchable, categorized" palette that
 *    used it would be unscannable — the reason to search would be the ordering.
 * 3. **A group with no matches is OMITTED.** A heading over nothing is a false
 *    "this category has matches" signal, and dead height in a 180px column.
 *
 * The structural-call activity (`execute_pipeline`) is excluded outright: its
 * settings ride `node.call`, not `node.config`, so the generic config form cannot
 * author it (#4 A9; call-node authoring is #425).
 */
export function toolboxGroups(query: string): ToolboxGroup[] {
  const needle = query.trim().toLowerCase();
  const groups: ToolboxGroup[] = [];

  for (const category of ACTIVITY_CATEGORIES) {
    const entries = [...catalog.values()]
      .filter((e) => e.category === category)
      .filter((e) => !isStructuralCallActivity(e.type))
      // Title AND type: the title is what the toolbox shows, but the type is what
      // the docs, an export envelope and an error message all name, so an author
      // who knows `file_read` should not have to guess it is called "Read File".
      .filter(
        (e) =>
          needle === '' ||
          e.title.toLowerCase().includes(needle) ||
          e.type.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.title.localeCompare(b.title));

    if (entries.length > 0) {
      groups.push({ category, label: ACTIVITY_CATEGORY_LABELS[category], entries });
    }
  }

  return groups;
}
