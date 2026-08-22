import { describe, expect, it } from 'vitest';
import { deepRedactRecord, deepRedactSecrets, redactSecrets } from '../redact.js';

/**
 * A proxy whose `ownKeys` trap claims one more key than `MAX_REDACT_BREADTH`
 * allows. Built once per call and deliberately just over the line, because
 * materialising the keys is the expensive part — see the ceiling's own note on
 * why that cost is the whole difference between this branch and the array one.
 */
function hugeKeyProxy(secret: string): object {
  const keys = Array.from({ length: 1_000_001 }, (_, i) => `k${i}`);
  return new Proxy(
    {},
    {
      ownKeys: () => keys,
      getOwnPropertyDescriptor: () => ({
        value: `Bearer ${secret}`,
        enumerable: true,
        configurable: true,
      }),
      get: () => `Bearer ${secret}`,
    },
  );
}

describe('redactSecrets — string substring scrub', () => {
  it('replaces every occurrence of each non-empty secret with ***', () => {
    expect(redactSecrets('token=abc and again abc', ['abc'])).toBe('token=*** and again ***');
  });

  it('skips null/undefined/empty secrets so a message is never turned wholly into ***', () => {
    expect(redactSecrets('keep me', [null, undefined, ''])).toBe('keep me');
  });
});

describe('deepRedactSecrets — structured value scrub (item 7 / S3)', () => {
  const SECRET = 'sk-super-secret';

  it('scrubs string leaves nested in objects and arrays, leaving the shape intact', () => {
    const value = {
      headers: { auth: `Bearer ${SECRET}`, other: 'safe' },
      list: ['x', SECRET, { deep: SECRET }],
    };
    expect(deepRedactSecrets(value, [SECRET])).toEqual({
      headers: { auth: 'Bearer ***', other: 'safe' },
      list: ['x', '***', { deep: '***' }],
    });
  });

  it('passes non-string leaves through untouched (only a string can carry a secret)', () => {
    const value = { status: 200, ok: true, body: null, nested: [1, false] };
    expect(deepRedactSecrets(value, [SECRET])).toEqual(value);
  });

  it('is a pure no-op when the plaintext list is empty (the common dispatch path)', () => {
    const value = { a: `contains ${SECRET}` };
    expect(deepRedactSecrets(value, [])).toEqual({ a: `contains ${SECRET}` });
  });

  it('redacts a top-level string value directly', () => {
    expect(deepRedactSecrets(SECRET, [SECRET])).toBe('***');
  });

  it('does not mutate the input value (rebuilds the tree)', () => {
    const value = { a: [SECRET] };
    const out = deepRedactSecrets(value, [SECRET]);
    expect(value).toEqual({ a: [SECRET] }); // original untouched
    expect(out).toEqual({ a: ['***'] });
  });

  it('bounds recursion (adversarially deep value cannot stack-overflow) — over-deep subtree becomes the sentinel', () => {
    // Build a value nested well past the ceiling; the walk must terminate and
    // never leak, replacing the over-deep subtree wholesale with '***'.
    let deep: unknown = SECRET;
    for (let i = 0; i < 500; i++) deep = { next: deep };
    const out = deepRedactSecrets(deep, [SECRET]);
    // Walk down what we can and assert it terminates in the sentinel, never the
    // raw secret (and the call itself did not throw).
    let cur: unknown = out;
    let depth = 0;
    while (cur !== null && typeof cur === 'object' && 'next' in cur) {
      cur = (cur as { next: unknown }).next;
      depth++;
    }
    expect(cur).toBe('***');
    expect(depth).toBeLessThan(500);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('round-trips a JSON-sourced __proto__ key as an OWN data property, not a prototype mutation', () => {
    // The choke point walks adversarial external adapter output. A field literally
    // named `__proto__` (a real own property after JSON.parse) must survive as a
    // data property, never silently vanish or poison the prototype.
    const value = JSON.parse('{"__proto__": {"leak": "sk-x"}, "ok": 1}') as Record<string, unknown>;
    const out = deepRedactSecrets(value, ['sk-x']) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(out['__proto__']).toEqual({ leak: '***' });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype); // prototype untouched
    expect(out.ok).toBe(1);
  });
});

describe('deepRedactRecord — typed outputs-map wrapper', () => {
  it('deep-redacts each value and returns a typed record (no cast needed)', () => {
    const secret = 'sk-x';
    const rec: Record<string, unknown> = { a: secret, b: { c: [secret] }, n: 1 };
    expect(deepRedactRecord(rec, [secret])).toEqual({ a: '***', b: { c: ['***'] }, n: 1 });
  });

  it('round-trips a __proto__ key faithfully (own data property, prototype intact)', () => {
    const rec = JSON.parse('{"__proto__": "sk-x"}') as Record<string, unknown>;
    const out = deepRedactRecord(rec, ['sk-x']);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(out['__proto__']).toBe('***');
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe('deepRedactSecrets — values whose JSON form is not their key form (#1223)', () => {
  const SECRET = 'sk-super-secret';

  /**
   * The walker's contract is "scrub string leaves, leave everything else as it
   * was". Rebuilding an object from `Object.entries` keeps that promise only for
   * values whose JSON form IS their own-enumerable-key form. It is not for a
   * value carrying a `toJSON`, and the failure is invisible: a `{}` where a date
   * was reads exactly like an activity that returned an empty object.
   */
  it('preserves a Date as its ISO string rather than flattening it to {}', () => {
    const when = new Date('2026-08-22T09:15:00.000Z');
    expect(deepRedactSecrets({ at: when }, [SECRET])).toEqual({ at: '2026-08-22T09:15:00.000Z' });
  });

  it('preserves a Buffer as its serialised form rather than an index map', () => {
    const out = deepRedactSecrets({ blob: Buffer.from([1, 2, 3]) }, [SECRET]);
    expect(out).toEqual({ blob: { type: 'Buffer', data: [1, 2, 3] } });
  });

  it('agrees with what JSON.stringify would have produced, for the whole tree', () => {
    const value = { at: new Date('2020-01-02T03:04:05.000Z'), blob: Buffer.from([9]), n: 1 };
    expect(deepRedactSecrets(value, [SECRET])).toEqual(JSON.parse(JSON.stringify(value)));
  });

  /**
   * The reason a `toJSON` value is NORMALISED rather than passed through: its
   * serialised form can itself carry a resolved secret, and this walker's whole
   * posture is never-leak. Passing such a value through untouched would be a
   * fail-open trade of one bug for a worse one.
   */
  it('still redacts a secret carried in a toJSON result', () => {
    const carrier = { toJSON: () => `Bearer ${SECRET}` };
    expect(deepRedactSecrets({ auth: carrier }, [SECRET])).toEqual({ auth: 'Bearer ***' });
  });

  it('still redacts a secret nested inside a toJSON result', () => {
    const carrier = { toJSON: () => ({ headers: { auth: SECRET } }) };
    expect(deepRedactSecrets(carrier, [SECRET])).toEqual({ headers: { auth: '***' } });
  });

  it('replaces a throwing toJSON with the sentinel rather than crashing the walk', () => {
    const hostile = {
      toJSON: () => {
        throw new Error(`boom ${SECRET}`);
      },
    };
    expect(deepRedactSecrets({ bad: hostile, ok: 1 }, [SECRET])).toEqual({ bad: '***', ok: 1 });
  });

  /**
   * A chain of `toJSON`s runs to its FIXED POINT, which is the one place the
   * walker deliberately does not reproduce a single `JSON.stringify` (measured:
   * that gives `{"a":{}}`). "Apply once" was tried first and is not reachable —
   * it leaves the result's own `toJSON` alive in the output, which the event
   * log's own serialisation then applies anyway. Diverging by PRESERVING what
   * stringify discards is the safe direction (#473).
   */
  it('walks a toJSON chain to its fixed point rather than discarding the result', () => {
    const value = { a: { toJSON: () => ({ toJSON: () => 1 }) } };
    expect(deepRedactSecrets(value, [SECRET])).toEqual({ a: 1 });
  });

  /**
   * The property the fixed point buys, and the reason it is worth the divergence
   * above: no live `toJSON` survives into the output, so nothing downstream can
   * transform the value a second time.
   */
  it('is idempotent — walking the output again cannot change it', () => {
    const value = {
      at: new Date('2023-03-04T05:06:07.000Z'),
      blob: Buffer.from([7, 8]),
      auth: `Bearer ${SECRET}`,
      // A CHAIN, not a single `toJSON`: a fixture whose `toJSON` returns a plain
      // object is idempotent under the rejected "apply once" design too, so it
      // pins nothing. This one is the shape that separates them.
      chain: { toJSON: () => ({ toJSON: () => 1 }) },
      list: [{ toJSON: () => ({ n: 1 }) }],
    };
    const once = deepRedactSecrets(value, [SECRET]);
    expect(deepRedactSecrets(once, [SECRET])).toEqual(once);
  });

  /**
   * AN ARRAY CAN CARRY ONE TOO, and the walk order decides whether it is seen.
   * `JSON.stringify` applies `toJSON` before it looks at the type at all
   * (measured: `{"a":"from-toJSON"}`, and an Array SUBCLASS with a `toJSON`
   * serialises as `"listy"`), so an `Array.isArray` branch placed first would
   * silently walk the indexed elements and discard the serialised form. That is
   * leak-shaped, not merely lossy: a secret appearing only in the `toJSON`
   * result would never be produced, and so never scrubbed.
   */
  it('consults a toJSON on an ARRAY as well — the isArray branch must not shadow it', () => {
    const listy = Object.assign([SECRET], { toJSON: () => `Bearer ${SECRET}` });
    expect(deepRedactSecrets({ v: listy }, [SECRET])).toEqual({ v: 'Bearer ***' });

    class Listy extends Array<string> {
      toJSON(): string {
        return `sub ${SECRET}`;
      }
    }
    expect(deepRedactSecrets({ v: Listy.from([SECRET]) }, [SECRET])).toEqual({ v: 'sub ***' });
  });

  /**
   * The ACCESS is guarded, not just the call. A hostile proxy throws on every
   * property read, so `Object.entries` in the rebuild below would throw too —
   * the sentinel is what stops adapter output from crashing the walk.
   */
  it('replaces a value whose toJSON access throws with the sentinel', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile getter');
        },
      },
    );
    expect(deepRedactSecrets({ bad: hostile, ok: 1 }, [SECRET])).toEqual({ bad: '***', ok: 1 });
  });

  it('bounds a self-returning toJSON at the depth ceiling instead of looping', () => {
    const looping: { toJSON: () => unknown } = { toJSON: () => looping };
    expect(deepRedactSecrets({ v: looping }, [SECRET])).toEqual({ v: '***' });
  });

  it('hands toJSON the key it is reached by, as JSON.stringify does', () => {
    const value = { inner: { toJSON: (k: string) => k }, list: [{ toJSON: (k: string) => k }] };
    expect(deepRedactSecrets(value, [SECRET])).toEqual(JSON.parse(JSON.stringify(value)));
    expect(deepRedactSecrets(value, [SECRET])).toEqual({ inner: 'inner', list: ['0'] });
  });

  it('hands toJSON the OUTPUTS-MAP key through deepRedactRecord', () => {
    const rec: Record<string, unknown> = { body: { toJSON: (k: string) => k } };
    expect(deepRedactRecord(rec, [SECRET])).toEqual({ body: 'body' });
  });

  /**
   * A class instance is NOT automatically special-cased, and this pins that.
   * `pg`'s `interval` parser returns a `PostgresInterval` — a class instance
   * carrying all of its data as own enumerable properties and no `toJSON`, so
   * its JSON form IS its key form. Rebuilding it by keys is already faithful,
   * and a fix that passed every non-plain object through would leave any secret
   * inside one unscrubbed.
   */
  it('still rebuilds a class instance that has no toJSON, scrubbing inside it', () => {
    class PostgresIntervalish {
      constructor(
        readonly years: number,
        readonly note: string,
      ) {}
    }
    const out = deepRedactSecrets(new PostgresIntervalish(1, `note ${SECRET}`), [SECRET]);
    expect(out).toEqual({ years: 1, note: 'note ***' });
  });

  /**
   * `Object.entries` INVOKES every own enumerable getter, and a getter that
   * throws sends its message — with the plaintext in it — straight out of the
   * walker uncaught. Measured: `Object.entries({get auth(){throw new
   * Error('boom sk-x')}})` throws `boom sk-x`. That is the precise failure this
   * file's header exists to close (an error that embeds a value we passed in,
   * echoed into a durable event), reached through the one door the walker had
   * left open. `Object.keys` does not invoke accessors, so enumeration is safe;
   * it is the per-key READ that needs the guard.
   *
   * Per KEY, not per object: one hostile accessor must not cost the siblings,
   * which are ordinary values that redact fine.
   */
  it('replaces a property whose getter throws with the sentinel, keeping its siblings', () => {
    const hostile = {
      ok: 1,
      safe: `Bearer ${SECRET}`,
      get auth(): string {
        throw new Error(`boom ${SECRET}`);
      },
    };
    const out = deepRedactSecrets({ v: hostile }, [SECRET]);
    expect(out).toEqual({ v: { ok: 1, safe: 'Bearer ***', auth: '***' } });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  /**
   * The same guard, one branch over — the one the object branch's fix left open.
   * `.map` reads every index bare, so an element backed by a throwing getter
   * propagated the exception out of `walk`, and that message is exactly where
   * plaintext lands. Per ELEMENT, not per array: a hostile index must not cost
   * the siblings, which redact fine.
   */
  it('replaces an ARRAY element whose getter throws with the sentinel, keeping its siblings', () => {
    const hostile: unknown[] = [1, `Bearer ${SECRET}`];
    Object.defineProperty(hostile, 2, {
      get(): string {
        throw new Error(`boom ${SECRET}`);
      },
      enumerable: true,
      configurable: true,
    });
    const out = deepRedactSecrets({ v: hostile }, [SECRET]);
    expect(out).toEqual({ v: [1, 'Bearer ***', '***'] });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  /**
   * An array's LENGTH is itself a read, and on a proxy it is a trap that can
   * throw. It is the array's analogue of the object branch's enumeration
   * failure: nothing can be walked and nothing partial is worth keeping, so the
   * whole value takes the sentinel rather than a truncated array that would
   * claim the missing elements never existed.
   */
  it('replaces an array whose LENGTH cannot be read with the sentinel', () => {
    const hostile = new Proxy([] as unknown[], {
      get(target, prop, receiver): unknown {
        if (prop === 'length') throw new Error(`no length ${SECRET}`);
        return Reflect.get(target, prop, receiver);
      },
    });
    const out = deepRedactSecrets({ v: hostile, ok: 1 }, [SECRET]);
    expect(out).toEqual({ v: '***', ok: 1 });
  });

  /**
   * A length that is not a usable count is a lie about how much there is to
   * walk, and each lie fails in its own direction. A NEGATIVE one ends the walk
   * before it starts, which would fabricate an empty array — #473's shape, an
   * absence manufactured from a failure and indistinguishable from an array that
   * really was empty. An INFINITE one goes the other way: `.map` throws
   * `RangeError: Invalid array length` out of the walk. A merely ENORMOUS one is
   * the quiet third case: it is a safe integer, so it passes both of those
   * checks, and an index loop would simply run for hours. All three take the
   * sentinel.
   */
  it.each([
    ['negative', -1],
    ['infinite', Number.POSITIVE_INFINITY],
    ['past the breadth ceiling', Number.MAX_SAFE_INTEGER],
  ])('replaces an array whose length is %s with the sentinel', (_label, length) => {
    const hostile = new Proxy([`Bearer ${SECRET}`] as unknown[], {
      get(target, prop, receiver): unknown {
        if (prop === 'length') return length;
        return Reflect.get(target, prop, receiver);
      },
    });
    const out = deepRedactSecrets({ v: hostile, ok: 1 }, [SECRET]);
    expect(out).toEqual({ v: '***', ok: 1 });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('replaces a value that refuses to be ENUMERATED with the sentinel', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(`no keys ${SECRET}`);
        },
      },
    );
    const out = deepRedactSecrets({ v: hostile, ok: 1 }, [SECRET]);
    expect(out).toEqual({ v: '***', ok: 1 });
  });

  /**
   * The breadth ceiling's object sibling. An `ownKeys` trap can fabricate a key
   * list far larger than anything real, and the walker then pays per key. This
   * is a LESSER hazard than the array-length lie and the difference is measured,
   * not assumed: a fake `length` is one number, so it buys an unbounded walk for
   * free, whereas an `ownKeys` trap must MATERIALISE every key it claims (5M of
   * them cost ~4.5s to build). Linear rather than unbounded — but the walker
   * still does far more work per key than the trap did, so the ceiling applies
   * on both branches or the walker is only half-defended.
   */
  it('replaces an object with more own keys than the breadth ceiling with the sentinel', () => {
    const out = deepRedactSecrets({ v: hugeKeyProxy(SECRET), ok: 1 }, [SECRET]);
    expect(out).toEqual({ v: '***', ok: 1 });
  });

  /**
   * Same ceiling, but `deepRedactRecord` returns a `Record`, so — exactly as for
   * the map that cannot be enumerated at all — there is no value to stand in for
   * the whole thing and inventing an empty one would be #473's shape. It refuses
   * instead, with a message carrying no plaintext.
   */
  it('refuses an outputs map wider than the breadth ceiling, without echoing the secret', () => {
    const rec = hugeKeyProxy(SECRET) as Record<string, unknown>;
    expect(() => deepRedactRecord(rec, [SECRET])).toThrow(/too many keys/);
    try {
      deepRedactRecord(rec, [SECRET]);
    } catch (err) {
      expect(String(err)).not.toContain(SECRET);
    }
  });

  it('guards the same getter hazard inside deepRedactRecord', () => {
    const rec: Record<string, unknown> = {
      get body(): string {
        throw new Error(`boom ${SECRET}`);
      },
      status: 200,
    };
    expect(deepRedactRecord(rec, [SECRET])).toEqual({ body: '***', status: 200 });
  });

  /**
   * The one place the sentinel is not expressible: `deepRedactRecord` returns a
   * `Record`, so an outputs map that cannot be enumerated at all has no value to
   * stand in for it. Inventing an empty map would be #473's shape — an absence
   * manufactured from a failure — so it REFUSES, with a message that carries no
   * plaintext of its own.
   */
  it('refuses an outputs map that cannot be enumerated, without echoing the secret', () => {
    const rec = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(`no keys ${SECRET}`);
        },
      },
    ) as Record<string, unknown>;
    expect(() => deepRedactRecord(rec, [SECRET])).toThrow(/could not be enumerated/);
    try {
      deepRedactRecord(rec, [SECRET]);
    } catch (err) {
      expect(String(err)).not.toContain(SECRET);
    }
  });

  it('preserves a Date reached through deepRedactRecord', () => {
    const rec: Record<string, unknown> = { at: new Date('2021-05-06T07:08:09.000Z') };
    expect(deepRedactRecord(rec, [SECRET])).toEqual({ at: '2021-05-06T07:08:09.000Z' });
  });
});
