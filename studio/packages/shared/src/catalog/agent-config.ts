import { z } from 'zod';
import { llmOutputSchemaSchema } from './llm-config.js';

/**
 * #2 L11a/L11b — the `agent_task` node config: the SINGLE source of truth for the
 * activity's authored shape, used BOTH as the catalog `configSchema` (save-time /
 * authoring) and as the adapter's runtime input parse (`connectors/agent.ts`).
 * Extracted so the two can never drift (they were two identical inline copies).
 *
 * - `task` — the instruction appended as the final argv element to the connection's
 *   `command`/`args` (the CLI's prompt); the ONE required field.
 * - `cwd` — optional per-node working directory override (else the connection's).
 * - `outputSchema` (#2 L11b) — OPT-IN structured output. Its PRESENCE is the whole
 *   opt-in signal (agent_task has no `outputMode` flag, unlike `llm_call`): when set
 *   to a valid restricted subset (`llmOutputSchemaSchema`), the save-time lowering
 *   pass (`catalog/lower.ts::lowerAgentTaskStructuredOutputs`) DERIVES the node's
 *   `config.outputs` from it, and the adapter extracts + validates a structured
 *   result from the subprocess's sentinel-delimited stdout block. Absent → today's
 *   opaque `{ output, exitCode }` shape. Reuses `llm_call`'s subset SSOT so both
 *   activities share one structured-output type + validator.
 *
 * Non-strict by design (Zod strips unknown keys): a real `node.config` also carries
 * `outputs` (the lowered contract) and other generic fields, and the runtime
 * `safeParse(ctx.input)` must tolerate them — it reads only these three.
 */
export const agentTaskConfigSchema = z.object({
  task: z.string().min(1),
  cwd: z.string().optional(),
  outputSchema: llmOutputSchemaSchema.optional(),
});

export type AgentTaskConfig = z.infer<typeof agentTaskConfigSchema>;
