import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAndUpgradeEnvelope, type ExportEnvelope } from '@autonomy-studio/shared';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { exportPipeline } from '../export.js';
import { importEnvelope } from '../import.js';

/**
 * The shipped example pipelines (`studio/examples/*.pipeline.json`) are the
 * P7-packaging artifacts a self-hoster imports via `POST /api/import`. They are
 * hand-authored export envelopes, NOT produced by `exportPipeline`, so nothing
 * but this suite proves they are importable — and importing exercises the FULL
 * gate (`parseAndUpgradeEnvelope` version/shape → `NewPipelineVersionSchema`
 * strict write schema → the `validateDoc` semantic gate → real persistence), so
 * a green here means every shipped example is genuinely valid and runnable-shaped.
 *
 * The suite reads the directory (rather than pinning filenames) so a new example
 * is covered the moment it is added; the count floor below turns a
 * directory-exists-but-empty "vacuous green" into a loud failure (a mis-resolved
 * path already throws `ENOENT` at `readdirSync`, loud on its own).
 */
const EXAMPLES_DIR = fileURLToPath(new URL('../../../../../examples/', import.meta.url));

/** Every shipped example file, sorted for a stable test order. */
function exampleFiles(): string[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((name) => name.endsWith('.pipeline.json'))
    .sort();
}

function readEnvelope(file: string): {
  raw: string;
  env: Extract<ExportEnvelope, { kind: 'pipeline' }>;
} {
  const raw = readFileSync(`${EXAMPLES_DIR}${file}`, 'utf8');
  const env = parseAndUpgradeEnvelope(raw);
  if (env.kind !== 'pipeline') throw new Error(`example ${file} is not a pipeline envelope`);
  return { raw, env };
}

const OWNER = 'owner-examples';

describe('shipped example pipelines (studio/examples)', () => {
  const files = exampleFiles();
  // Parse each example exactly once — the envelope is immutable across every
  // assertion below, so the aggregate guards and per-file tests all read from
  // these rather than re-reading + re-parsing the same JSON per assertion.
  const examples = files.map((file) => ({ file, ...readEnvelope(file) }));

  it('ships at least the three documented examples (guards a vacuous green)', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  // Aggregate coverage guards: the point of the trio is to exercise the three
  // distinct import paths (a plain doc, a connection-rebind, a container). If a
  // future edit collapsed them into three trivial connection-less flat docs, the
  // #473 (containers) and connection-rebind regression nets would silently stop
  // exercising anything — these assert the fleet keeps that coverage.
  it('at least one example declares a container (keeps the #473 round-trip exercised)', () => {
    const anyContainer = examples.some(({ env }) =>
      env.data.versions.some((v) => (v.containers ?? []).length > 0),
    );
    expect(anyContainer).toBe(true);
  });

  it('at least one example strips a connection ref (keeps the rebind path exercised)', () => {
    const anyStripped = examples.some(({ env }) => env.data.strippedConnectionRefs.length > 0);
    expect(anyStripped).toBe(true);
  });

  for (const { file, raw, env } of examples) {
    describe(file, () => {
      it('is a valid, current pipeline export envelope', () => {
        expect(env.kind).toBe('pipeline');
        expect(env.data.versions.length).toBeGreaterThanOrEqual(1);
      });

      it('imports cleanly (strict write schema + validateDoc gate + persistence)', () => {
        const { db } = freshDb();
        const result = importEnvelope(db, OWNER, raw);

        expect(result.kind).toBe('pipeline');
        if (result.kind !== 'pipeline') throw new Error('unreachable');
        expect(result.pipeline.ownerId).toBe(OWNER);
        expect(result.pipeline.id).not.toBe(env.data.pipeline.id); // ids are re-minted
        expect(result.versions.length).toBe(env.data.versions.length);

        // The rebind attention items must be exactly the source's stripped refs
        // (the array is load-bearing, not the null connectionId — import.ts:78).
        const unresolved = result.attention
          .filter((a) => a.type === 'unresolvedConnectionRef')
          .map((a) => a.nodeId)
          .sort();
        expect(unresolved).toEqual([...env.data.strippedConnectionRefs].sort());
      });

      it('preserves declared containers through import and an export round-trip (#473)', () => {
        const { db } = freshDb();

        const first = importEnvelope(db, OWNER, raw);
        if (first.kind !== 'pipeline') throw new Error('unreachable');
        // Per-version container counts survive the initial import (import maps
        // versions in source order).
        env.data.versions.forEach((sourceVersion, i) => {
          expect(first.versions[i]!.containers.length).toBe(
            (sourceVersion.containers ?? []).length,
          );
        });

        const reExported = exportPipeline(db, first.pipeline.id, OWNER);
        const second = importEnvelope(db, OWNER, reExported);
        expect(second.kind).toBe('pipeline');
        if (second.kind !== 'pipeline') throw new Error('unreachable');
        // ...and survive a full export → re-import cycle (the exact bug #473 was).
        first.versions.forEach((v, i) => {
          expect(second.versions[i]!.containers.length).toBe(v.containers.length);
        });
      });
    });
  }
});
