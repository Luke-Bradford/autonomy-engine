// P3 — the activity catalog (pure metadata; the executable adapters live
// server-side). One import surface for both the executor and the authoring UI.
export * from './types.js';
export * from './registry.js';
export * from './lower.js';
export * from './agent-config.js';
export * from './llm-config.js';
export * from './llm-recipes.js';
export * from './llm-structured.js';
export * from './fs-activity-config.js';
export * from './connection-config.js';
export * from './dataset-config.js';

// #996 M5 slice 1 — the `copy` activity's mapping declaration (§6.1). Landing
// ahead of its consumer: slice 3's `copyConfigSchema` embeds it.
export * from './copy-config.js';
