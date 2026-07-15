import { z } from 'zod';
import { OutputSchema, type Node, type OutputType } from '../schemas/pipeline.js';

/**
 * A node's declared output contract, read from `config.outputs`. This is the
 * SINGLE SOURCE OF TRUTH for a node's outputs, shared by:
 *  - the runtime reducer (`reduce.ts` `storeOutputs`/`validateOutputs`) — which
 *    keeps ONLY declared keys and type-checks them at `node.succeeded` time; and
 *  - static validation (`params.ts` `validateRefs`) — which rejects a
 *    `${nodes.X.output.NAME}` ref whose NAME the producer does not declare.
 * Keeping both paths on this one helper stops the two from ever disagreeing
 * about which output names a node produces.
 */
export type DeclaredOutput = { name: string; type: OutputType };

/**
 * A node's declared `outputs` (from `config.outputs`), or `null` when none are
 * declared / the field is malformed. `null` means "no contract": the reducer
 * stores the executor's whole payload and static validation enforces no names.
 */
export function declaredOutputs(node: Node): DeclaredOutput[] | null {
  const parsed = z.array(OutputSchema).safeParse(node.config['outputs']);
  return parsed.success ? parsed.data : null;
}

// `declaredOutputNames` (a names-only `Set` view) was REMOVED at #6 E6: the
// static checker now needs each output's TYPE as well as its name, so it reads
// `declaredOutputs` directly and `ScanScope.outputsById` carries the full
// `{name,type}`. A names-only view would be a second answer to "what does this
// node declare?" — exactly the drift this module's SSOT rule exists to prevent.
