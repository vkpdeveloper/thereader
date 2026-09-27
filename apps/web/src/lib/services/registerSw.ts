const UPDATED_MESSAGE = 'thereader:shell-updated';

/**
 * Registers `public/sw.js` so the app shell, bundles and fonts load offline.
 * Production builds only: in development the worker would cache Vite's
 * unhashed modules and hide edits.
 *
 * The worker serves the cached shell and caches a new deployment in the
 * background. That deployment opens on the next launch, or once this page is
 * hidden outside the reader; an open book is never reloaded.
 */
export function registerServiceWorker(): void {
  const env = (import.meta as ImportMeta & { env?: { PROD?: boolean } }).env;
  if (!env?.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const container = navigator.serviceWorker;

  let updateReady = false;
  const applyWhenIdle = () => {
    if (updateReady && document.visibilityState === 'hidden' && !location.pathname.startsWith('/read/')) location.reload();
  };
  // Listen before `load`: messages sent while the page starts must not be missed.
  const updated = () => {
    updateReady = true;
    applyWhenIdle();
  };
  container.addEventListener('message', (event: MessageEvent) => {
    if ((event.data as { type?: unknown } | null)?.type === UPDATED_MESSAGE) updated();
  });
  // A new worker version took over (it cached its deployment's shell while installing).
  const hadController = container.controller !== null;
  container.addEventListener('controllerchange', () => {
    if (hadController) updated();
  });

  const register = () => {
    container
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void registration.update().catch(() => undefined);
          else applyWhenIdle();
        });
      })
      .catch((error) => console.warn('Service worker registration failed', error));
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
