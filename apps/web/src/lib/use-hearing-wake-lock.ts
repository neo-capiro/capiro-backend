import { useEffect, useState } from 'react';

export type HearingWakeLockState = 'inactive' | 'requesting' | 'active' | 'unavailable';

/** Screen wake locks are best-effort and never keep a server capture alive.
 * Browsers release them when hidden; reacquire when the hearing is visible. */
export function useHearingWakeLock(active: boolean): HearingWakeLockState {
  const [state, setState] = useState<HearingWakeLockState>('inactive');

  useEffect(() => {
    if (!active) {
      setState('inactive');
      return;
    }
    let disposed = false;
    let requesting = false;
    let sentinel: WakeLockSentinel | null = null;

    const acquire = async () => {
      if (disposed || requesting || sentinel || document.visibilityState !== 'visible') return;
      if (!navigator.wakeLock?.request) {
        setState('unavailable');
        return;
      }
      requesting = true;
      setState('requesting');
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (disposed || document.visibilityState !== 'visible') {
          await lock.release();
          return;
        }
        sentinel = lock.released ? null : lock;
        setState(lock.released ? 'unavailable' : 'active');
        lock.addEventListener('release', () => {
          if (sentinel === lock) sentinel = null;
          if (!disposed) setState('unavailable');
        }, { once: true });
      } catch {
        if (!disposed) setState('unavailable');
      } finally {
        requesting = false;
      }
    };
    const onVisible = () => { void acquire(); };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);

  return state;
}
