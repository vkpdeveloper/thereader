import { useEffect } from 'react';

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

/** Holds a Screen Wake Lock while `enabled` and the page is visible. */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    const wakeLock = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock;
    if (!enabled || !wakeLock) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let disposed = false;
    const acquire = async () => {
      if (disposed || sentinel || document.visibilityState !== 'visible') return;
      try {
        const s = await wakeLock.request('screen');
        if (disposed) {
          void s.release();
          return;
        }
        sentinel = s;
        s.addEventListener('release', () => {
          if (sentinel === s) sentinel = null;
        });
      } catch {
        // Denied (battery saver, unsupported frame): reading continues without it.
      }
    };
    const onVisibility = () => void acquire();
    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release().catch(() => undefined);
      sentinel = null;
    };
  }, [enabled]);
}
