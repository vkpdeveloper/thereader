/* The Reader service worker: keeps the app shell, bundles and fonts available
 * offline. It never touches the API (/v1/*, /health) or other origins; books
 * and covers live in IndexedDB, managed by the app itself.
 *
 * - /assets/* (hashed Vite bundles) and /fonts/*: cache first.
 * - Navigations: network first, falling back to the cached app shell.
 * Bump VERSION to drop every older cache on activation. */

const VERSION = 'v1';
const SHELL_CACHE = `thereader-shell-${VERSION}`;
const STATIC_CACHE = `thereader-static-${VERSION}`;
const CURRENT = new Set([SHELL_CACHE, STATIC_CACHE]);
const SHELL_URL = '/index.html';

self.addEventListener('install', (event) => {
  // Precache only the shell; bundles are cached as the app requests them.
  event.waitUntil(
    fetch(new Request('/', { cache: 'reload' }))
      .then((response) => (response.ok ? caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_URL, response)) : undefined))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('thereader-') && !CURRENT.has(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isApi(url) {
  return url.pathname === '/health' || url.pathname === '/v1' || url.pathname.startsWith('/v1/');
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
  return response;
}

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    // Every SPA route serves index.html; keep the latest copy as the shell.
    if (response.ok && response.type === 'basic' && (response.headers.get('content-type') || '').includes('text/html')) {
      await cache.put(SHELL_URL, response.clone());
    }
    return response;
  } catch (error) {
    const cached = (await cache.match(SHELL_URL)) || (await cache.match('/'));
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isApi(url)) return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/')) {
    event.respondWith(cacheFirst(request));
  }
});
