import type { LlmCallConfig } from './llm-config.js';

/**
 * #2 L8 — the `llm_call` palette RECIPES (presets).
 *
 * The North star (spec #2) is ONE flexible `llm_call` activity whose *config*
 * selects its shape. A recipe is not a new activity or a new mechanism: it is a
 * ready-made, save-valid {@link LlmCallConfig} starter for one of the spec's four
 * common invocation shapes (Generate / Extract / Classify / Judge), so the
 * authoring palette can offer each as one click and the operator edits from a
 * working baseline instead of a blank form.
 *
 * This module is PURE METADATA in `shared` (isomorphic, I/O-free), the same home
 * as the activity catalog. The UI epic (U-series) renders these; nothing here
 * runs, is persisted, or is version-stamped — a recipe's config is COPIED into a
 * new `node.config` at author-time and thereafter is an ordinary config that the
 * normal save gate (`validateDoc` / `validateRefs`) fully validates. So, unlike a
 * new catalog `type`, adding a recipe does NOT bump `CATALOG_VERSION`: no older
 * build can mis-run an authoring convenience it never sees.
 *
 * Recipes are deliberately kept OFF the generic `ActivityCatalogEntry`
 * (`types.ts`) — they are LLM-specific, and loading them onto the intentionally
 * activity-agnostic catalog contract would pollute it. The UI imports both the
 * catalog and this module.
 *
 * Each `config` is a COMPLETE config that parses under the SSOT
 * `llmCallConfigSchema`, NOT a partial: the palette seeds `node.config` wholesale
 * and the recipe test proves "every preset saves". The prompt text, and every
 * structured field / enum value, are ILLUSTRATIVE STARTERS the author replaces.
 *
 * Starter prompts are deliberately PLAIN TEXT — they carry no `${...}` reference
 * to a specific upstream node, so a recipe dropped as the FIRST node and saved
 * UNEDITED still passes `validateRefs` (a `${nodes.previous.output}` starter
 * would 400 against an empty graph). Wiring upstream data via `${nodes.<id>...}`
 * is the author's next step, guided by the description, not a broken default.
 *
 * Recipes carry NO `outputs` array: for a `structured` recipe the addressable
 * `config.outputs` are DERIVED from `outputSchema` at save-time by the lowering
 * pass (`catalog/lower.ts`). Seeding a lowered `outputs` here would be a second
 * source that can desync from the schema — the SSOT is the `outputSchema`.
 */

/**
 * The recipe ids — one per spec invocation shape. This const is the SSOT of the
 * {@link LlmRecipeId} union (the `LLM_RECIPES` array is asserted to match it by
 * the recipe test, so the two can never drift).
 */
export const LLM_RECIPE_IDS = ['generate', 'extract', 'classify', 'judge'] as const;

/** A palette recipe id (one of the four spec shapes). */
export type LlmRecipeId = (typeof LLM_RECIPE_IDS)[number];

/** A palette preset: a display label + a save-valid `llm_call` config starter. */
export interface LlmRecipe {
  /** Stable id; the palette + tests key on it. */
  readonly id: LlmRecipeId;
  /** Palette display label. */
  readonly title: string;
  /** One-line palette description of the shape + typical use. */
  readonly description: string;
  /** A complete, save-valid `llm_call` config the palette copies into a node. */
  readonly config: LlmCallConfig;
}

/**
 * The four presets, in palette order.
 *
 * - **Generate** (`outputMode:'text'`) — free-text output (`text`) for drafting /
 *   content / summarize. The simplest shape.
 * - **Extract** (`outputMode:'structured'`) — pull typed fields out of
 *   unstructured input; the starter schema declares two example string fields
 *   (`title`, `summary`) the author edits into their real contract.
 * - **Classify** (`outputMode:'structured'`) — a single `category` output whose
 *   starter `enum` is a sentiment example. This node just SUCCEEDS with a typed
 *   `category`; the operator wires a downstream `switch` that routes on
 *   `${nodes.<id>.output.category}` (spec T8) — that switch is NOT part of the
 *   recipe (a recipe is a single-node preset, not a multi-node template).
 * - **Judge** (`outputMode:'structured'`) — an eval/gate shape: a numeric `score`
 *   plus a `reason`, both required, for scoring / quality gates.
 */
export const LLM_RECIPES: readonly LlmRecipe[] = [
  {
    id: 'generate',
    title: 'Generate',
    description: 'Free-text generation — drafting, content, or summarize. Outputs `text`.',
    config: {
      outputMode: 'text',
      system: 'You are a helpful assistant. Follow the instruction precisely and concisely.',
      messages: [{ role: 'user', content: 'Write a short summary of the following input.' }],
    },
  },
  {
    id: 'extract',
    title: 'Extract',
    description: 'Pull typed fields out of unstructured text. Edit the schema to your fields.',
    config: {
      outputMode: 'structured',
      system: 'Extract the requested fields from the input. Return only the declared fields.',
      messages: [
        { role: 'user', content: 'Extract the requested fields from the following input.' },
      ],
      outputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short title for the input.' },
          summary: { type: 'string', description: 'A one-sentence summary.' },
        },
        required: ['title', 'summary'],
        additionalProperties: false,
      },
    },
  },
  {
    id: 'classify',
    title: 'Classify',
    description:
      'Assign one category (typed `category` output). Route with a downstream Switch on ' +
      '${nodes.<id>.output.category}. Edit the enum to your labels.',
    config: {
      outputMode: 'structured',
      system:
        'Classify the input into exactly one of the allowed categories. ' +
        'Return only the `category` field.',
      messages: [{ role: 'user', content: 'Classify the following input.' }],
      outputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'The chosen category — edit these labels to your own.',
            enum: ['positive', 'neutral', 'negative'],
          },
        },
        required: ['category'],
        additionalProperties: false,
      },
    },
  },
  {
    id: 'judge',
    title: 'Judge',
    description:
      'Score / evaluate — a numeric `score` plus a `reason`. For evals and quality gates.',
    config: {
      outputMode: 'structured',
      system: 'Evaluate the input against the criteria. Return a numeric score and a brief reason.',
      messages: [{ role: 'user', content: 'Evaluate the following input against the criteria.' }],
      outputSchema: {
        type: 'object',
        properties: {
          score: { type: 'number', description: 'The numeric score.' },
          reason: { type: 'string', description: 'A brief justification for the score.' },
        },
        required: ['score', 'reason'],
        additionalProperties: false,
      },
    },
  },
];

/** Look up a recipe by id; `undefined` when the id is unknown. */
export function getLlmRecipe(id: string): LlmRecipe | undefined {
  return LLM_RECIPES.find((r) => r.id === id);
}
