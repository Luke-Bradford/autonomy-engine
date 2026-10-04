import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createUiStore, type PreferenceStorage } from '../stores/uiStore';
import { When } from './When';

function memoryStorage(): PreferenceStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const AT = Date.UTC(2026, 9, 4, 12, 5, 7, 123);

describe('When — #1484 principle 4', () => {
  it('shows the instant in the display zone, with the full form and relative time on hover', () => {
    const store = createUiStore(memoryStorage());
    store.getState().setDisplayTimeZone('UTC');
    const { container } = render(<When ms={AT} precision="ms" store={store} />);
    const time = container.querySelector('time')!;
    expect(time.textContent).toBe('2026-10-04 12:05:07.123 UTC');
    expect(time.getAttribute('dateTime')).toBe('2026-10-04T12:05:07.123Z');
    expect(time.getAttribute('title')).toMatch(/^2026-10-04 12:05:07\.123 UTC · .+/);
  });

  it('follows the setting live, without a remount', () => {
    const store = createUiStore(memoryStorage());
    store.getState().setDisplayTimeZone('UTC');
    const { container } = render(<When ms={AT} store={store} />);
    expect(container.textContent).toBe('2026-10-04 12:05:07 UTC');
    act(() => store.getState().setDisplayTimeZone('America/New_York'));
    expect(container.textContent).toBe('2026-10-04 08:05:07 EDT');
  });

  it('renders an em-dash for a time that has not happened', () => {
    const { container } = render(<When ms={null} store={createUiStore(memoryStorage())} />);
    expect(container.textContent).toBe('—');
    expect(container.querySelector('time')).toBeNull();
  });
});
