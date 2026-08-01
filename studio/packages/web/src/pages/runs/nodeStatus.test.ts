import { describe, expect, it } from 'vitest';
import { ContainerRunStatusSchema, NodeRunStatusSchema } from '@autonomy-studio/shared';
import { containerStatusTone, nodeStatusLabel, nodeStatusTone } from './nodeStatus';

describe('status tones', () => {
  it('maps every engine node status — no status is left without a tone', () => {
    for (const status of NodeRunStatusSchema.options) {
      expect(nodeStatusTone(status)).toBeTruthy();
    }
    // The groupings that carry meaning, pinned so a careless edit trips:
    expect(nodeStatusTone('pending')).toBe('neutral');
    expect(nodeStatusTone('dispatched')).toBe('running');
    expect(nodeStatusTone('skipped')).toBe('skipped');
    // All four parked statuses share ONE tone, and it is not `neutral` — a
    // parked node is not an idle one.
    for (const held of [
      'waiting',
      'retry_pending',
      'wait_pending',
      'external_wait_pending',
    ] as const) {
      expect(nodeStatusTone(held)).toBe('holding');
    }
  });

  it('maps every container status, with `active` as the container’s running tone', () => {
    for (const status of ContainerRunStatusSchema.options) {
      expect(containerStatusTone(status)).toBeTruthy();
    }
    expect(containerStatusTone('active')).toBe('running');
  });
});

describe('nodeStatusLabel', () => {
  it('words every engine node status, and never leaks the identifier for one that needs wording', () => {
    for (const status of NodeRunStatusSchema.options) {
      expect(nodeStatusLabel(status)).toBeTruthy();
    }
    // `dispatched` names the ENGINE's act; the operator is asking what the NODE
    // is doing.
    expect(nodeStatusLabel('dispatched')).toBe('running');
    // A snake_case identifier reaching the screen is the failure this map
    // exists to prevent.
    for (const status of NodeRunStatusSchema.options) {
      expect(nodeStatusLabel(status)).not.toContain('_');
    }
  });

  it('gives each of the three parks its OWN word, so a stuck run says what it is stuck on', () => {
    // The heart of U25's "waiting + reason": these were ONE word before, and an
    // operator could not tell "wait for it" from "something external owes us a
    // call" from "go look at the child run".
    const timer = nodeStatusLabel('wait_pending');
    const callback = nodeStatusLabel('external_wait_pending');
    const child = nodeStatusLabel('waiting');
    expect(new Set([timer, callback, child]).size).toBe(3);
    for (const label of [timer, callback, child]) expect(label).toContain('waiting');
    expect(timer).toContain('timer');
    expect(callback).toContain('callback');
    expect(child).toContain('child run');
    // A retry backoff is a hold too, but it is NOT a park and must not read as
    // one — it follows a failure and earns different attention (#483).
    expect(nodeStatusLabel('retry_pending')).toBe('retrying');
  });

  it('words no two statuses the same — a label an operator cannot invert is not a label', () => {
    const labels = NodeRunStatusSchema.options.map((s) => nodeStatusLabel(s));
    expect(new Set(labels).size).toBe(labels.length);
  });
});
