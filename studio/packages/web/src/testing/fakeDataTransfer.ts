/**
 * A `DataTransfer` stand-in for drag-and-drop specs. jsdom implements none.
 *
 * Shared rather than defined per spec file, for the reason `e2e/support/theme.ts`
 * already records this repo paying for once: a helper that existed twice was
 * hardened in only one copy, and the un-hardened one let a defect through. The
 * subtlety below is exactly the kind that gets fixed in one copy.
 *
 * **`protectedMode` is the whole point.** During `dragenter`/`dragover` the HTML
 * drag-data store is in PROTECTED mode: `types` is readable, but `getData()`
 * returns `''`. Only at `drop` is the payload readable. A fake that always hands
 * the data back would let a `dragover` gate written against `getData()` pass
 * every test and then reject every real drag in a browser — so any spec covering
 * the dragover path must construct its fake with `protectedMode: true`.
 */
export interface FakeDataTransferInit {
  /** Initial payload, keyed by MIME type. */
  data?: Record<string, string>;
  /** Emulate the dragenter/dragover protected-data-store mode. */
  protectedMode?: boolean;
}

/**
 * Build a `DataTransfer`-shaped object.
 *
 * Returned as `DataTransfer` so specs pass it straight to `fireEvent.drop(...)`
 * without casting at every call site; it implements only the surface the drag
 * code actually touches (`types`, `getData`, `setData`, `dropEffect`,
 * `effectAllowed`), which is deliberate — a fake that stubbed the whole
 * interface would invite tests to lean on behaviour it does not really model.
 */
export function fakeDataTransfer(init: FakeDataTransferInit = {}): DataTransfer {
  const { data = {}, protectedMode = false } = init;
  const store = new Map(Object.entries(data));
  const dt = {
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
    get types(): string[] {
      return [...store.keys()];
    },
    setData(format: string, value: string): void {
      store.set(format, value);
    },
    getData(format: string): string {
      if (protectedMode) return '';
      return store.get(format) ?? '';
    },
  };
  return dt as unknown as DataTransfer;
}
