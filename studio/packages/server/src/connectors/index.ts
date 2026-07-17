// P3 — connector adapters (the executor's connection execution seam).
export * from './types.js';
export * from './registry.js';
export { httpAdapter } from './http.js';
export { fsAdapter } from './fs.js';
export { anthropicAdapter } from './anthropic.js';
export { openaiAdapter } from './openai.js';
export { ollamaAdapter } from './ollama.js';
export { createAgentAdapter } from './agent.js';
