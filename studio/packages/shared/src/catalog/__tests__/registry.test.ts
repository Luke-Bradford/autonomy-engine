import { describe, expect, it } from 'vitest';
import { DATASET_CONNECTION_KINDS } from '../dataset-config.js';
import { catalog, getActivity, isStructuralCallActivity } from '../registry.js';
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_CATEGORY_LABELS,
  EXECUTE_PIPELINE_ACTIVITY_TYPE,
} from '../types.js';

describe('activity catalog', () => {
  it('exposes the MVP activity types', () => {
    // `if` (#4 A1) is the first CONTROL activity, `switch` (#4 A2) the second,
    // `fail` (#4 A7) the third, `filter` (#4 A8) the fourth, `wait` (#4 A5+A6) the
    // fifth (and first DURABLE control activity), `webhook` (#4 A13) the sixth (the
    // external-wait durable twin of `wait`) — all engine-evaluated, catalogued so
    // the palette/executor-guard/version know them. `execute_pipeline` (#4 A9)
    // surfaces the pre-existing structural `Node.call` mechanism as a first-class
    // catalog TYPE (its config rides `node.call`, not `node.config`).
    expect([...catalog.keys()].sort()).toEqual([
      'agent_task',
      'copy',
      'execute_pipeline',
      'fail',
      'file_copy',
      'file_delete',
      'file_list',
      'file_move',
      'file_read',
      'file_write',
      'filter',
      'http_request',
      'if',
      'llm_call',
      // #1221 M12 slice 2 — `lookup`, the SOURCE-ONLY data-movement activity.
      'lookup',
      'switch',
      'wait',
      'webhook',
    ]);
  });

  it('getActivity returns an entry for a known type and undefined for an unknown one', () => {
    expect(getActivity('http_request')?.type).toBe('http_request');
    expect(getActivity('nope')).toBeUndefined();
  });

  it('the read-only file activities are the ONLY idempotent ones (fail-safe crash-recovery default)', () => {
    // The reconciler FREEZES a non-idempotent in-flight node and RESUMES an
    // idempotent one. Everything that has a side effect (or unknown safety) must
    // stay `false`, so a write/call that regressed to `idempotent:true` would be
    // silently re-run on resume. `file_read` (#4 A11) + `file_list` (#4 A12) are
    // the sole read-only opt-ins — assert exactly them so a NEW idempotent
    // activity is caught here. (Insertion order: read before list.)
    const idempotent = [...catalog.values()]
      .filter((entry) => entry.idempotent)
      .map((entry) => entry.type);
    // #1221 M12 slice 2 — `lookup` is the THIRD, and it is claimed rather than
    // inherited: it opens a store READ-ONLY, moves nothing and writes nowhere,
    // so the reconciler resuming it after a crash re-reads and is safe. That is
    // `file_read`/`file_list`'s own reasoning, and the entry has no sink half
    // for a later slice to widen without confronting this flag.
    expect(idempotent).toEqual(['file_read', 'file_list', 'lookup']);
    // file_write/copy/move/delete MUST stay non-idempotent — each is a side effect.
    for (const type of ['file_write', 'file_copy', 'file_move', 'file_delete']) {
      expect(getActivity(type)!.idempotent).toBe(false);
    }
  });

  it('http_request needs an http connection and declares its outputs', () => {
    const http = getActivity('http_request')!;
    expect(http.connectionKinds).toEqual(['http']);
    expect(http.outputs.map((o) => o.name).sort()).toEqual(['body', 'headers', 'status']);
  });

  it('http_request declares `secretHeaders` as its secret SINK (item 7 / S4)', () => {
    // The FIRST real activity to open a sink — `validateRefs` accepts a
    // `{$secret}` marker within `secretHeaders` and refuses it anywhere else.
    expect(getActivity('http_request')!.secretSinkFields).toEqual(['secretHeaders']);
  });

  it('http_request is the ONLY activity in the whole catalog with a secret sink (fail-closed elsewhere)', () => {
    // Assert across the full catalog, not a named subset, so a future activity
    // that silently gains a sink is caught here rather than slipping through.
    const withSink = [...catalog.values()]
      .filter((entry) => entry.secretSinkFields !== undefined)
      .map((entry) => entry.type);
    expect(withSink).toEqual(['http_request']);
  });

  it('M5 slice 4c (#1139): `copy` is the ONLY activity that declares a sink', () => {
    // This pin used to read `toEqual([])` and carried M1's deliberate NO-BUMP in
    // `schemas/version.ts`: a doc holding `Node.connectionIds` ran identically on
    // a pre-M1 build precisely because nothing declared `sinkConnectionKinds`.
    // Slice 4c is the event that entry named as voiding it, so the pin flips
    // rather than goes away — the CATALOG_VERSION 23 bump is the discharge, and
    // this list is what makes the NEXT entry to declare a sink notice that it is
    // joining a set with a version story rather than starting one.
    //
    // Asserted across the FULL catalog (the `secretSinkFields` pin's idiom), not
    // a named subset, so an entry cannot gain a sink silently.
    const paired = [...catalog.values()]
      .filter((entry) => entry.sinkConnectionKinds !== undefined)
      .map((entry) => entry.type);
    expect(paired).toEqual(['copy']);
  });

  it('a declared sink allowlist must be non-empty, and pair with a non-empty source one', () => {
    // The `[]` polarity decision, pinned rather than left to be discovered at M5:
    // absence means "not paired", so `[]` cannot ALSO mean it — it would mean
    // "paired, but no sink kind is ever valid", an entry every dispatch refuses.
    // Deliberately NOT the same polarity as `connectionKinds: []` (= needs no
    // connection), which has no absent form to carry that meaning.
    for (const entry of catalog.values()) {
      if (entry.sinkConnectionKinds === undefined) continue;
      expect(entry.sinkConnectionKinds.length).toBeGreaterThan(0);
      // A paired activity resolves a SOURCE from `connectionKinds` too, and the
      // executor's `connectionKinds.length > 0` gate would otherwise route it to
      // NO_EXECUTOR before the pair logic ever ran.
      expect(entry.connectionKinds.length).toBeGreaterThan(0);
    }
  });

  it('M5 slice 4c (#1139): `copy` is the ONLY activity that declares a dataset binding', () => {
    // Flipped from `toEqual([])` by the same event, and carrying M3's NO-BUMP the
    // same way the sink pin above carries M1's. One CATALOG_VERSION bump (23)
    // discharges both, which is what M3's ledger entry predicted: the two fields
    // become load-bearing together.
    //
    // #1221 (M12 slice 2) makes it TWO, and the second is the one this field's
    // optional `sink` was made optional FOR: `lookup` declares a source and no
    // sink at all, so it is also the first entry from which a source-only
    // `Node.datasetIds` can be authored — the shape M12 slice 1 (#1220) made
    // legal but could not yet produce.
    const bound = [...catalog.values()]
      .filter((entry) => entry.datasetKinds !== undefined)
      .map((entry) => entry.type);
    expect(bound).toEqual(['copy', 'lookup']);
  });

  it('`copy` declares a sink of `table` only — a query dataset has nothing to write into', () => {
    // Not a policy choice this entry could have made differently:
    // `connectors/sqlite.ts` reads a `query` dataset and refuses any non-`table`
    // for the WRITE. Pinned here so widening `sink` later has to confront the
    // writer rather than just the allowlist — which M7 slice 3 (#1167) is the
    // first slice to have done: it widened both SOURCE lists and left both SINK
    // lists exactly where they were, because it built a `delimited` reader and
    // no writer. M10 slice 2 (#1190) is the SECOND, and did the same for the
    // same reason — `postgres` joins `connectionKinds` because the reader
    // landed, and `sinkConnectionKinds` did NOT move because there was no
    // postgres writer.
    //
    // M10 slice 3a (#1196) is the first slice to MOVE the sink list, and it did
    // confront the writer rather than the allowlist: `postgres-sink.ts` lands in
    // the same commit. It also confronted what #1190 pinned this against —
    // that widening here expires #1193's two deferrals — by RE-MEASURING both
    // rather than expiring them silently. §7's row 3 turned out to rest on a
    // wrong premise (a BOUND parameter coerces per VALUE, so `'123'` into
    // `int4` succeeds), and the `query` self-copy residual measured as a
    // wasteful no-op rather than a data-loss path. The registry entry carries
    // both measurements. #1193 then closed with ONE item left of the three —
    // the `storeIdentity` hole — which slice 3b shipped by giving the address
    // seam a credential; row 3 is declined on measured grounds, not deferred.
    //
    // `datasetKinds.sink` STILL does not move, and that half of the pin is
    // untouched: there is no `delimited` writer, so a CSV remains something a
    // copy can read and not something it can write.
    // #1215 (M11 slice 2) widened SOURCE only, for `delimited`'s reason
    // unchanged: M11 built a reader and no writer, so there is nothing to copy
    // INTO a workbook with. The sink halves therefore still do not move — which
    // is the half of this pin that has now survived three widenings.
    const copy = catalog.get('copy');
    expect(copy?.datasetKinds).toEqual({
      source: ['table', 'query', 'delimited', 'excel'],
      sink: ['table'],
    });
    expect(copy?.connectionKinds).toEqual(['sqlite', 'fs', 'postgres']);
    expect(copy?.sinkConnectionKinds).toEqual(['sqlite', 'postgres']);
  });

  it('every source dataset kind `copy` accepts can live in a source connection it accepts', () => {
    // The pairing rule #1167's ticket states: widening one list without the
    // other produces an entry every dispatch refuses —
    // `DATASET_CONNECTION_MISMATCH` for a dataset kind whose store is not on the
    // connection list, and an unusable store for the reverse. Asserted as an
    // INTERSECTION over `DATASET_CONNECTION_KINDS` rather than as a literal
    // pair, so the next store to join has to satisfy the rule rather than
    // restate it.
    const copy = catalog.get('copy');
    for (const kind of copy?.datasetKinds?.source ?? []) {
      expect(
        DATASET_CONNECTION_KINDS[kind].some((store) => copy?.connectionKinds.includes(store)),
      ).toBe(true);
    }
    // And the same for the sink halves, which is what would catch a `delimited`
    // sink added before a `delimited` writer exists.
    for (const kind of copy?.datasetKinds?.sink ?? []) {
      expect(
        DATASET_CONNECTION_KINDS[kind].some((store) => copy?.sinkConnectionKinds?.includes(store)),
      ).toBe(true);
    }
  });

  it('a declared datasetKinds list is non-empty, and a sink one implies a sink connection', () => {
    // `[]` cannot mean "not dataset-bound" — absence already does — so it would
    // have to mean "dataset-bound, but no kind is ever valid", an entry every
    // dispatch refuses with DATASET_KIND_INVALID.
    //
    // `sink` is OPTIONAL (M12's `lookup` reads a source only), but a sink DATASET
    // with no sink CONNECTION names a store that does not exist, so declaring one
    // implies the other.
    for (const entry of catalog.values()) {
      if (entry.datasetKinds === undefined) continue;
      expect(entry.datasetKinds.source.length).toBeGreaterThan(0);
      if (entry.datasetKinds.sink === undefined) continue;
      expect(entry.datasetKinds.sink.length).toBeGreaterThan(0);
      expect(entry.sinkConnectionKinds?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('llm_call binds the LLM provider kinds plus agent_cli (CLI/subscription, #2 L14b)', () => {
    expect(getActivity('llm_call')!.connectionKinds).toEqual([
      'anthropic_api',
      'openai_api',
      'ollama',
      'agent_cli',
    ]);
  });

  it('an activity configSchema validates its settings blob', () => {
    const http = getActivity('http_request')!;
    expect(http.configSchema.safeParse({ url: 'https://example.com' }).success).toBe(true);
    // Missing the required `url`.
    expect(http.configSchema.safeParse({ method: 'GET' }).success).toBe(false);
  });

  it('file_read / file_write are execution activities on the `fs` connector (#4 A11)', () => {
    const read = getActivity('file_read')!;
    const write = getActivity('file_write')!;
    for (const entry of [read, write]) {
      expect(entry.kind).toBe('execution');
      expect(entry.category).toBe('general');
      expect(entry.connectionKinds).toEqual(['fs']);
      // `fs` is credential-less — no secret sink on either file activity.
      expect(entry.secretSinkFields).toBeUndefined();
    }
    // A read is side-effect-free (safe to resume); a write is not (fail-safe freeze).
    expect(read.idempotent).toBe(true);
    expect(write.idempotent).toBe(false);
    expect(read.outputs.map((o) => o.name).sort()).toEqual(['content', 'path']);
    expect(write.outputs.map((o) => o.name).sort()).toEqual(['bytesWritten', 'path']);
    // configSchema (palette metadata): `path` required for both, `content` for write.
    expect(read.configSchema.safeParse({ path: 'notes.txt' }).success).toBe(true);
    expect(read.configSchema.safeParse({}).success).toBe(false);
    expect(write.configSchema.safeParse({ path: 'out.txt', content: '' }).success).toBe(true);
    expect(write.configSchema.safeParse({ path: 'out.txt' }).success).toBe(false);
  });

  it('file_copy/move/delete/list are execution activities on the `fs` connector (#4 A12)', () => {
    const copy = getActivity('file_copy')!;
    const move = getActivity('file_move')!;
    const del = getActivity('file_delete')!;
    const list = getActivity('file_list')!;
    for (const entry of [copy, move, del, list]) {
      expect(entry.kind).toBe('execution');
      expect(entry.category).toBe('general');
      expect(entry.connectionKinds).toEqual(['fs']);
      // `fs` is credential-less — no secret sink on any file activity.
      expect(entry.secretSinkFields).toBeUndefined();
    }
    // Only the read-only list is safe to resume; the three mutating ops freeze.
    expect(list.idempotent).toBe(true);
    for (const entry of [copy, move, del]) expect(entry.idempotent).toBe(false);
    // Outputs.
    expect(copy.outputs.map((o) => o.name).sort()).toEqual(['bytesWritten', 'dest', 'source']);
    expect(move.outputs.map((o) => o.name).sort()).toEqual(['dest', 'source']);
    expect(del.outputs.map((o) => o.name)).toEqual(['path']);
    expect(list.outputs.map((o) => o.name).sort()).toEqual(['entries', 'path']);
    // `entries` is a json-typed output (an array of {name,type} objects).
    expect(list.outputs.find((o) => o.name === 'entries')!.type).toBe('json');
    // configSchema (palette metadata): copy/move need source+dest; delete/list a path.
    expect(copy.configSchema.safeParse({ source: 'a.txt', dest: 'b.txt' }).success).toBe(true);
    expect(copy.configSchema.safeParse({ source: 'a.txt' }).success).toBe(false);
    expect(move.configSchema.safeParse({ source: 'a.txt', dest: 'b.txt' }).success).toBe(true);
    expect(del.configSchema.safeParse({ path: 'a.txt' }).success).toBe(true);
    expect(del.configSchema.safeParse({}).success).toBe(false);
    expect(list.configSchema.safeParse({ path: 'sub' }).success).toBe(true);
    expect(list.configSchema.safeParse({ path: '' }).success).toBe(false);
  });
});

// --- F9a: the ActivityDefinition contract (#1 D6) ---------------------------

describe('activity definition contract (#1 D6)', () => {
  it('splits execution (connector-dispatched) from control (engine-evaluated)', () => {
    // Since #4 A1 the catalog has BOTH: `if`/`switch` are the `control` entries
    // (the executor's `CONTROL_NOT_DISPATCHABLE` guard is now reachable),
    // everything else is `execution`. An execution activity binds >=1 connection;
    // a control activity binds NONE (it never touches a connector).
    for (const type of ['if', 'switch', 'fail']) {
      expect(getActivity(type)!.kind).toBe('control');
      expect(getActivity(type)!.connectionKinds).toEqual([]);
      expect(getActivity(type)!.outputs).toEqual([]);
    }
    for (const entry of catalog.values()) {
      if (entry.kind === 'control') continue;
      expect(entry.kind).toBe('execution');
    }
  });

  it('switch is a control activity exposing an on/cases configSchema for the palette (#4 A2)', () => {
    const sw = getActivity('switch')!;
    expect(sw.category).toBe('control');
    expect(
      sw.configSchema.safeParse({ on: '${nodes.c.output.t}', cases: ['a', 'b'] }).success,
    ).toBe(true);
    // Missing the required `on`.
    expect(sw.configSchema.safeParse({ cases: ['a'] }).success).toBe(false);
  });

  it('fail is a control activity exposing a message configSchema for the palette (#4 A7)', () => {
    const fail = getActivity('fail')!;
    expect(fail.category).toBe('control');
    expect(fail.configSchema.safeParse({ message: 'rejected the input' }).success).toBe(true);
    // Missing / empty message is refused by the palette schema.
    expect(fail.configSchema.safeParse({}).success).toBe(false);
    expect(fail.configSchema.safeParse({ message: '' }).success).toBe(false);
  });

  it('execute_pipeline is a control activity typing the Node.call blob for the palette (#4 A9)', () => {
    const ep = getActivity(EXECUTE_PIPELINE_ACTIVITY_TYPE)!;
    expect(ep.kind).toBe('control');
    expect(ep.category).toBe('control');
    // A call node binds NO connection (it spawns a child run, never a connector)
    // and its outputs come from the CHILD projection, never a catalog template —
    // so it seeds no `outputs` (see `lowerNodeOutputs`, which skips call nodes).
    expect(ep.connectionKinds).toEqual([]);
    expect(ep.outputs).toEqual([]);
    expect(ep.idempotent).toBe(false);
    // configSchema mirrors the `CallConfigSchema` (`node.call`) — it types the CALL
    // blob, not `node.config` (the structural-call exception). A valid call parses;
    // a missing `pipelineVersionId` is refused.
    expect(ep.configSchema.safeParse({ pipelineVersionId: 'v1', params: {} }).success).toBe(true);
    expect(ep.configSchema.safeParse({ params: {} }).success).toBe(false);
  });

  it('execute_pipeline is the only structural-call activity (config rides node.call, #4 A9/#425)', () => {
    // The palette/inspector author `node.config`; a structural-call activity's
    // settings live in `node.call`, so the generic palette excludes it (call-node
    // authoring is #425). Asserted across the full catalog so a future entry that
    // silently becomes a structural-call type is caught here.
    const structural = [...catalog.values()]
      .map((e) => e.type)
      .filter((t) => isStructuralCallActivity(t));
    expect(structural).toEqual([EXECUTE_PIPELINE_ACTIVITY_TYPE]);
    expect(isStructuralCallActivity('if')).toBe(false);
    expect(isStructuralCallActivity('http_request')).toBe(false);
  });

  it('categorises the MVP set per spec #4 (agent_task is an AI activity, not its own class)', () => {
    expect(getActivity('http_request')!.category).toBe('general');
    expect(getActivity('llm_call')!.category).toBe('ai');
    // Spec #4 lists `agent_task` under "Execution — AI (Spec #2)" alongside
    // `llm_call` — an external CLI agent is an AI activity, not a third class.
    expect(getActivity('agent_task')!.category).toBe('ai');
  });
});

// U5 — the toolbox renders one GROUP per category, headed by its label. The map
// lives beside `ACTIVITY_CATEGORIES` (not web-side) for the same reason `title`
// does: `ActivityCatalogEntry.title` is already a display string owned by the
// catalog, and `ACTIVITY_CATEGORIES`'s own doc already owns the palette's group
// ORDER — splitting order and label across two packages would let one drift.
describe('ACTIVITY_CATEGORY_LABELS (U5 toolbox group headings)', () => {
  it('labels every category, with no blank or slug-shaped label', () => {
    // The Record type makes a MISSING key a compile error; this pins the
    // remaining runtime risk — a key present but useless.
    for (const category of ACTIVITY_CATEGORIES) {
      const label = ACTIVITY_CATEGORY_LABELS[category];
      expect(label.trim()).not.toBe('');
      // A label equal to its own slug means somebody added a category and left
      // the raw union member as the heading.
      expect(label).not.toBe(category);
    }
  });

  it('has no keys beyond the declared categories', () => {
    // A category REMOVED from the union would otherwise leave a dead label
    // behind; `Record` only constrains the other direction.
    expect(Object.keys(ACTIVITY_CATEGORY_LABELS).sort()).toEqual([...ACTIVITY_CATEGORIES].sort());
  });

  it('every catalogued activity falls in a labelled category', () => {
    for (const entry of catalog.values()) {
      expect(ACTIVITY_CATEGORY_LABELS[entry.category]).toBeTruthy();
    }
  });
});

// A `kind`/`category` SHAPE test is deliberately absent: both are typed fields
// on literal entries, so TS strict already rejects an unknown value at compile
// time and the runtime assertion could never fire. The rule "an EXECUTION
// activity declares >=1 connectionKind" is deliberately NOT pinned either — it
// holds for today's catalog but is NOT a law: `executor.ts` reserves execution +
// no connection as the future built-in-runner slot (and tests it fails cleanly
// as `no_executor`), so asserting it would trip the first ticket to use it.
