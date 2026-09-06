import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHearingWakeLock } from './use-hearing-wake-lock.js';

class Lock extends EventTarget {
  released = false;
  release = vi.fn(async () => {
    this.released = true;
    this.dispatchEvent(new Event('release'));
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('hearing screen wake lock', () => {
  it('holds one lock, reacquires after returning to the page, and releases on end', async () => {
    const first = new Lock();
    const second = new Lock();
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const hook = renderHook(({ active }) => useHearingWakeLock(active), { initialProps: { active: true } });
    await waitFor(() => expect(hook.result.current).toBe('active'));
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(request).toHaveBeenCalledTimes(1);
    visible.mockReturnValue('hidden');
    await act(async () => { await first.release(); });
    expect(hook.result.current).toBe('unavailable');
    visible.mockReturnValue('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    hook.rerender({ active: false });
    expect(second.release).toHaveBeenCalledOnce();
    expect(hook.result.current).toBe('inactive');
  });

  it('releases a delayed grant after unmount so a finished hearing cannot hold a lock', async () => {
    let resolve!: (lock: Lock) => void;
    const request = vi.fn(() => new Promise<Lock>((done) => { resolve = done; }));
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const hook = renderHook(() => useHearingWakeLock(true));
    hook.unmount();
    const lock = new Lock();
    await act(async () => { resolve(lock); });
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it('reports unsupported or refused locks without failing capture', async () => {
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request: vi.fn().mockRejectedValue(new Error('Battery saver')) },
    });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const hook = renderHook(() => useHearingWakeLock(true));
    await waitFor(() => expect(hook.result.current).toBe('unavailable'));
  });
});
