import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { navigate, useRoute } from './router';

afterEach(() => {
  window.location.hash = '';
});

describe('useRoute / navigate', () => {
  it('defaults to "/" when there is no hash', () => {
    window.location.hash = '';
    const { result } = renderHook(() => useRoute());
    expect(result.current).toBe('/');
  });

  it('reflects the current hash path', () => {
    window.location.hash = '#/connections';
    const { result } = renderHook(() => useRoute());
    expect(result.current).toBe('/connections');
  });

  it('re-renders when navigate() changes the hash', async () => {
    window.location.hash = '#/';
    const { result } = renderHook(() => useRoute());
    expect(result.current).toBe('/');
    act(() => {
      navigate('/triggers');
    });
    // jsdom dispatches `hashchange` asynchronously; a real browser is the same
    // (it fires after the current task), so wait for the subscription to fire.
    await waitFor(() => expect(result.current).toBe('/triggers'));
  });
});
