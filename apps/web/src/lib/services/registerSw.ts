/**
 * Registers `public/sw.js` so the app shell, bundles and fonts load offline.
 * Production builds only: in development the worker would cache Vite's
 * unhashed modules and hide edits.
 */
export function registerServiceWorker(): void {
  const env = (import.meta as ImportMeta & { env?: { PROD?: boolean } }).env;
  if (!env?.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        // Check for a new deployment whenever the tab comes back.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void registration.update().catch(() => undefined);
        });
      })
      .catch((error) => console.warn('Service worker registration failed', error));
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
