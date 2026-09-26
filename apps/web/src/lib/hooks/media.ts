import { useSyncExternalStore } from 'react';

/** Live `matchMedia` result. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Wide layouts get the sidebar, side panels and two-column pages. */
export const desktopQuery = '(min-width: 900px)';

export function useIsDesktop(): boolean {
  return useMediaQuery(desktopQuery);
}

export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

/** Devices with a real hover pointer (mouse / trackpad). */
export function useCanHover(): boolean {
  return useMediaQuery('(hover: hover) and (pointer: fine)');
}
