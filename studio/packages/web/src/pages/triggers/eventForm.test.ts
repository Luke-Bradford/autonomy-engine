import { describe, expect, it } from 'vitest';
import type { EventConfig } from '@autonomy-studio/shared';
import { blankEventForm, eventToForm, formToEvent } from './eventForm';

function eventOf(form: ReturnType<typeof blankEventForm>): EventConfig | null {
  const converted = formToEvent(form);
  if (!converted.ok) throw new Error(`expected a conversion, got: ${converted.reason}`);
  return converted.event;
}

describe('formToEvent', () => {
  it('reads a blank name as an ABSENT subscription, not an empty one', () => {
    // `EventConfigSchema.name` is `.min(1)`, so `{name:''}` is REFUSED at the
    // write boundary — a blank field is "not configured", never a present fact.
    expect(eventOf(blankEventForm())).toBeNull();
  });

  it('reads a whitespace-only name as absent too', () => {
    expect(eventOf({ ...blankEventForm(), name: '   ' })).toBeNull();
  });

  it('trims the name it submits', () => {
    expect(eventOf({ ...blankEventForm(), name: '  order.placed  ' })).toEqual({
      name: 'order.placed',
    });
  });
});

describe('eventToForm — an API-authored subscription survives a UI edit', () => {
  // `EventConfigSchema` has a `.catchall(z.unknown())`, so a subscription
  // authored through the API can carry keys this form has no control for. They
  // are held verbatim and written back, because dropping them on an unrelated
  // edit (renaming the trigger) would be silent data loss.
  const stored: EventConfig = {
    name: 'order.placed',
    filter: { region: 'eu' },
    source: 'checkout',
  };

  it('splits the catchall keys out of the editable name', () => {
    expect(eventToForm(stored)).toEqual({
      name: 'order.placed',
      extras: { filter: { region: 'eu' }, source: 'checkout' },
    });
  });

  it('round-trips a subscription it has no controls for, byte for byte', () => {
    expect(eventOf(eventToForm(stored))).toEqual(stored);
  });

  it('keeps the extras when only the name is edited', () => {
    const edited = { ...eventToForm(stored), name: 'order.shipped' };
    expect(eventOf(edited)).toEqual({ ...stored, name: 'order.shipped' });
  });

  it('never lets an extra key shadow the edited name', () => {
    const sneaky = { name: 'edited', extras: { name: 'stale' } };
    expect(eventOf(sneaky)).toEqual({ name: 'edited' });
  });
});

describe('formToEvent — a preserved subscription is authored state', () => {
  it('refuses to clear the name while catchall extras ride on it', () => {
    // Blanking a one-field control must not be a silent delete of config the
    // form never showed. The window builder treats a preserved sub-object the
    // same way; removing a subscription deliberately is a MODE switch.
    const converted = formToEvent({ name: '', extras: { filter: { region: 'eu' } } });
    expect(converted.ok).toBe(false);
    if (!converted.ok) expect(converted.reason).toMatch(/would discard/i);
  });

  it('still reads a blank name as absent when there is nothing to lose', () => {
    expect(formToEvent({ name: '  ', extras: {} })).toEqual({ ok: true, event: null });
  });
});
