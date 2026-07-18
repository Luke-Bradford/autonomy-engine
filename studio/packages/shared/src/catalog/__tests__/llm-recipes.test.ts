import { describe, expect, it } from 'vitest';
import { validateRefs } from '../../engine/params.js';
import { llmCallConfigSchema, llmOutputSchemaSchema, lowerOutputSchema } from '../llm-config.js';
import { getLlmRecipe, LLM_RECIPE_IDS, LLM_RECIPES } from '../llm-recipes.js';
import { LLM_CALL_ACTIVITY_TYPE } from '../types.js';

describe('LLM_RECIPES', () => {
  it('exposes exactly the four spec shapes, ids unique and matching LLM_RECIPE_IDS', () => {
    const ids = LLM_RECIPES.map((r) => r.id);
    // Drift guard: the recipe array and the id const are one set, same order.
    expect(ids).toEqual([...LLM_RECIPE_IDS]);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...LLM_RECIPE_IDS].sort()).toEqual(['classify', 'extract', 'generate', 'judge']);
  });

  it('every recipe carries a non-empty title + description', () => {
    for (const r of LLM_RECIPES) {
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
    }
  });

  it('every recipe config is save-valid under the SSOT llmCallConfigSchema', () => {
    for (const r of LLM_RECIPES) {
      const res = llmCallConfigSchema.safeParse(r.config);
      expect(res.success, `${r.id}: ${res.success ? '' : JSON.stringify(res.error.issues)}`).toBe(
        true,
      );
    }
  });

  it('no recipe pre-seeds a lowered `outputs` array (outputs derive from outputSchema at save-time)', () => {
    for (const r of LLM_RECIPES) {
      expect((r.config as Record<string, unknown>).outputs).toBeUndefined();
    }
  });

  it('a recipe dropped as the ONLY node saves unedited — no upstream `${}` ref to resolve', () => {
    // The whole point of plain-text starters: a recipe placed as the first node,
    // with no producers above it, must still pass `validateRefs`. A
    // `${nodes.previous.output}` starter would 400 here against an empty graph.
    for (const r of LLM_RECIPES) {
      const errors = validateRefs({
        params: [],
        nodes: [
          {
            id: 'n1',
            type: LLM_CALL_ACTIVITY_TYPE,
            config: r.config as Record<string, unknown>,
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
        containers: [],
      });
      expect(errors, `${r.id}: ${errors.join('; ')}`).toEqual([]);
    }
  });
});

describe('getLlmRecipe', () => {
  it('returns each recipe by id', () => {
    for (const id of LLM_RECIPE_IDS) {
      expect(getLlmRecipe(id)?.id).toBe(id);
    }
  });

  it('returns undefined for an unknown id', () => {
    expect(getLlmRecipe('nope')).toBeUndefined();
  });
});

describe('recipe shapes', () => {
  const byId = (id: string) => {
    const r = getLlmRecipe(id);
    if (!r) throw new Error(`missing recipe ${id}`);
    return r;
  };

  it('generate is text-mode with no outputSchema', () => {
    const r = byId('generate');
    expect(r.config.outputMode).toBe('text');
    expect(r.config.outputSchema).toBeUndefined();
  });

  it('extract is structured; its outputSchema parses and lowers to typed fields', () => {
    const r = byId('extract');
    expect(r.config.outputMode).toBe('structured');
    expect(r.config.outputSchema).toBeDefined();
    const schema = llmOutputSchemaSchema.parse(r.config.outputSchema);
    const outs = lowerOutputSchema(schema);
    expect(outs.length).toBeGreaterThan(0);
    // Lowered fields are all string-typed in the starter (title/summary).
    for (const o of outs) expect(o.type).toBe('string');
  });

  it('classify lowers to a string `category` output (the T8 switch routes on it)', () => {
    const r = byId('classify');
    expect(r.config.outputMode).toBe('structured');
    const schema = llmOutputSchemaSchema.parse(r.config.outputSchema);
    // The category property carries a non-empty starter enum.
    expect((schema.properties.category?.enum ?? []).length).toBeGreaterThan(0);
    const outs = lowerOutputSchema(schema);
    const category = outs.find((o) => o.name === 'category');
    expect(category?.type).toBe('string');
  });

  it('judge lowers to a numeric `score` and a string `reason`', () => {
    const r = byId('judge');
    expect(r.config.outputMode).toBe('structured');
    const schema = llmOutputSchemaSchema.parse(r.config.outputSchema);
    const outs = lowerOutputSchema(schema);
    expect(outs.find((o) => o.name === 'score')?.type).toBe('number');
    expect(outs.find((o) => o.name === 'reason')?.type).toBe('string');
  });
});
