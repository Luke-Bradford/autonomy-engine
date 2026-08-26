import { describe, expect, it } from 'vitest';
import type { ConnectionPublic } from '@autonomy-studio/shared';
import {
  deleteConfirmTriggerClause,
  kindChangeDisablesTriggers,
  triggerDisableAdvisory,
  type TriggerCheck,
} from './dependentTriggers';

const stored = (over: Partial<ConnectionPublic> = {}): ConnectionPublic =>
  ({
    id: 'conn_1',
    resourceId: 'res_1',
    ownerId: null,
    name: 'Local',
    kind: 'ollama',
    config: {},
    parameters: [],
    secretStatus: 'not_required',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as ConnectionPublic;

const known = (names: string[], dynamicNames: string[] = []): TriggerCheck => ({
  state: 'known',
  names,
  dynamicNames,
});

describe('kindChangeDisablesTriggers', () => {
  it('is TRUE for the one transition the reverse gate fires on: ready → needs_secret', () => {
    expect(kindChangeDisablesTriggers(stored(), 'anthropic_api', '')).toBe(true);
  });

  it('is FALSE when the same edit SUPPLIES the secret — the connection stays ready', () => {
    expect(kindChangeDisablesTriggers(stored(), 'anthropic_api', 'sk-abc')).toBe(false);
    // Whitespace is not a secret.
    expect(kindChangeDisablesTriggers(stored(), 'anthropic_api', '   ')).toBe(true);
  });

  it('is FALSE when the stored connection is ALREADY unready — no transition, nothing left to disable', () => {
    const already = stored({ kind: 'anthropic_api', secretStatus: 'needs_secret' });
    expect(kindChangeDisablesTriggers(already, 'openai_api', '')).toBe(false);
    const off = stored({ enabled: false });
    expect(kindChangeDisablesTriggers(off, 'anthropic_api', '')).toBe(false);
  });

  it('is FALSE for the REPAIR direction and for a credential-less target', () => {
    const ready = stored({ kind: 'anthropic_api', secretStatus: 'ready' });
    // A secret-requiring kind whose ref is already present stays `ready`.
    expect(kindChangeDisablesTriggers(ready, 'openai_api', '')).toBe(false);
    expect(kindChangeDisablesTriggers(stored(), 'fs', '')).toBe(false);
  });
});

describe('triggerDisableAdvisory', () => {
  it('never claims "none" from a read that did not complete', () => {
    expect(triggerDisableAdvisory({ state: 'loading' })).toContain('Still checking');
    const failed = triggerDisableAdvisory({ state: 'unavailable', detail: 'offline' });
    expect(failed).toContain('offline');
    expect(failed).toMatch(/may/i);
  });

  it('names the triggers it would switch off, and agrees in number', () => {
    expect(triggerDisableAdvisory(known(['nightly']))).toContain('1 enabled trigger');
    expect(triggerDisableAdvisory(known(['nightly']))).toContain('nightly');
    expect(triggerDisableAdvisory(known(['a', 'b']))).toContain('2 enabled triggers');
  });

  it('says the disable is NOT undone by supplying the secret afterwards', () => {
    // `regateTriggersForConnection` is ENABLED-ONLY and never re-enables, so a
    // repair leaves every one of them off until re-enabled by hand. That is why
    // the sentence names them rather than counting them.
    expect(triggerDisableAdvisory(known(['nightly']))).toMatch(/re-enable/i);
  });

  it('is SILENT only on an earned empty — a dynamic reference is never silence', () => {
    expect(triggerDisableAdvisory(known([]))).toBeNull();
    const dyn = triggerDisableAdvisory(known([], ['maybe-nightly']));
    expect(dyn).not.toBeNull();
    expect(dyn).toContain('maybe-nightly');
  });

  it('reports BOTH buckets when a known disable and a dynamic reference coexist', () => {
    const said = triggerDisableAdvisory(known(['nightly'], ['maybe']));
    expect(said).toContain('nightly');
    expect(said).toContain('maybe');
  });
});

describe('deleteConfirmTriggerClause', () => {
  it('is empty ONLY on an earned empty', () => {
    expect(deleteConfirmTriggerClause(known([]))).toBe('');
    expect(deleteConfirmTriggerClause(known([], ['maybe']))).not.toBe('');
    expect(deleteConfirmTriggerClause({ state: 'loading' })).not.toBe('');
    expect(deleteConfirmTriggerClause({ state: 'unavailable', detail: 'x' })).toContain('x');
  });

  it('names the triggers the delete switches off', () => {
    const said = deleteConfirmTriggerClause(known(['nightly', 'hourly']));
    expect(said).toContain('2 enabled triggers');
    expect(said).toContain('nightly, hourly');
  });
});
