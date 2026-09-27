/* The Reader service worker: keeps the app shell, every bundle (including
 * lazily loaded routes such as the reader and the import pipeline) and the
 * fonts available offline. It never touches the API (/v1/*, /health) or other
 * origins; books and covers live in IndexedDB, managed by the app itself, so
 * a downloaded book opens with no network at all.
 *
 * - Install, and every newly deployed shell: crawl the asset graph from
 *   index.html (script/link tags, Vite's dynamic imports and preload maps,
 *   CSS url()s) and precache it. Bundles of an older worker version are
 *   carried over, and hashed assets referenced by neither the new nor the
 *   previous shell are pruned once a crawl completes (a page still running
 *   the previous shell can lazy-load its routes offline).
 * - Navigations: the cached app shell immediately. The network copy (the
 *   navigation preload response when available) refreshes it in the
 *   background; a changed shell is precached first, then stored, then open
 *   pages get a `thereader:shell-updated` message and apply it when idle.
 *   With no cached shell yet (first visit), the network.
 * - /assets/* (hashed Vite bundles) and /fonts/*: cache first.
 * - The web manifest and icons: cached copy first, refreshed in the background.
 * Bump VERSION to drop every older cache on activation. */

const VERSION = 'v3';
const SHELL_CACHE = `thereader-shell-${VERSION}`;
const STATIC_CACHE = `thereader-static-${VERSION}`;
const CURRENT = new Set([SHELL_CACHE, STATIC_CACHE]);
const SHELL_URL = '/index.html';
const CRAWL_LIMIT = 400;
const UPDATED_MESSAGE = 'thereader:shell-updated';
/** Unhashed files the browser asks for on every visit (install metadata, icons). */
const ROOT_FILES = [
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const previous = await previousShellHtml();
      await carryOverStatic();
      const response = await fetch(new Request('/', { cache: 'reload' }));
      if (!isHtml(response)) return;
      const html = await response.clone().text();
      const shell = await caches.open(SHELL_CACHE);
      await Promise.all(ROOT_FILES.map((path) => refresh(shell, path).catch(() => undefined)));
      // Best effort: a failed asset must not keep the worker from installing.
      await precache(html, previous).catch(() => undefined);
      await shell.put(SHELL_URL, response);
    })()
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith('thereader-') && !CURRENT.has(key)).map((key) => caches.delete(key)));
      // Starts the network request with the navigation, in parallel with the worker.
      await self.registration.navigationPreload?.enable().catch(() => undefined);
      await self.clients.claim();
    })(),
  );
});

function isApi(url) {
  return url.pathname === '/health' || url.pathname === '/v1' || url.pathname.startsWith('/v1/');
}

function isStatic(url) {
  return url.origin === self.location.origin && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/'));
}

function isHtml(response) {
  return !!response && response.ok && response.type === 'basic' && (response.headers.get('content-type') || '').includes('text/html');
}

/** The shell cached by an older worker version, if any. */
async function previousShellHtml() {
  for (const key of await caches.keys()) {
    if (!key.startsWith('thereader-shell-') || key === SHELL_CACHE) continue;
    const cached = await (await caches.open(key)).match(SHELL_URL);
    if (cached) return cached.text();
  }
  return null;
}

/** Copies bundles cached by an older worker version, so a VERSION bump refetches nothing unchanged. */
async function carryOverStatic() {
  const target = await caches.open(STATIC_CACHE);
  for (const key of await caches.keys()) {
    if (!key.startsWith('thereader-static-') || key === STATIC_CACHE) continue;
    const source = await caches.open(key);
    for (const request of await source.keys()) {
      if (await target.match(request)) continue;
      const response = await source.match(request);
      if (response) await target.put(request, response);
    }
  }
}

/** Same-origin asset URLs referenced by the HTML, JS or CSS file at `base`. */
function referencesIn(text, base) {
  const found = new Set();
  const add = (ref) => {
    try {
      const url = new URL(ref, base);
      if (isStatic(url)) found.add(url.pathname);
    } catch {
      /* not a URL */
    }
  };
  const path = new URL(base).pathname;
  if (/\.css$/.test(path)) {
    for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) add(m[1]);
    return found;
  }
  if (!/\.m?js$/.test(path)) {
    // The shell: <script src>, <link href>.
    for (const m of text.matchAll(/(?:src|href)=["']([^"']+)["']/g)) add(m[1]);
    return found;
  }
  // Bundles: absolute "/assets/x" or "/fonts/x" strings, Vite's
  // import("./x-HASH.js") relative to /assets/, and the preload map's
  // "assets/x-HASH.js" relative to the site root.
  for (const m of text.matchAll(/["'`](\/(?:assets|fonts)\/[\w.-]+\.[a-z0-9]+)["'`]/g)) add(m[1]);
  for (const m of text.matchAll(/["'`]\.\/([\w.-]+\.(?:js|mjs|css|wasm))["'`]/g)) add(new URL(m[1], new URL('/assets/', base)).href);
  for (const m of text.matchAll(/["'`](assets\/[\w.-]+\.[a-z0-9]+)["'`]/g)) add(`/${m[1]}`);
  return found;
}

/**
 * Walks the asset graph from a shell, caching every file not cached yet.
 * Returns the paths reached, or null if a file could not be fetched.
 */
async function crawl(cache, html) {
  const origin = self.location.origin;
  const seen = new Set();
  let queue = [...referencesIn(html, `${origin}/index.html`)];
  let complete = true;
  while (queue.length > 0 && seen.size < CRAWL_LIMIT) {
    const batch = queue.filter((path) => !seen.has(path));
    queue = [];
    for (const path of batch) seen.add(path);
    await Promise.all(
      batch.map(async (path) => {
        try {
          let response = await cache.match(path);
          if (!response) {
            response = await fetch(path);
            if (!response.ok || response.type !== 'basic') {
              complete = false;
              return;
            }
            await cache.put(path, response.clone());
          }
          if (/\.(?:js|mjs|css)$/.test(path)) {
            for (const ref of referencesIn(await response.text(), `${origin}${path}`)) if (!seen.has(ref)) queue.push(ref);
          }
        } catch {
          complete = false;
        }
      }),
    );
  }
  return complete && queue.length === 0 ? seen : null;
}

/**
 * Precaches `html`'s asset graph; true once every file is cached. After a
 * complete crawl, hashed bundles that neither it nor the `previous` shell
 * references are removed.
 */
async function precache(html, previous) {
  const cache = await caches.open(STATIC_CACHE);
  const keep = await crawl(cache, html);
  if (!keep) return false;
  if (previous && previous !== html) {
    const older = await crawl(cache, previous);
    if (!older) return true;
    for (const path of older) keep.add(path);
  }
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/assets/') && !keep.has(path)) await cache.delete(request);
  }
  return true;
}

async function refresh(cache, request) {
  const response = await fetch(request, { cache: 'no-cache' });
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
  return response;
}

/** The cached copy immediately; the network copy for next time. */
async function staleWhileRevalidate(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(event.request);
  const fresh = refresh(cache, event.request);
  if (cached) {
    event.waitUntil(fresh.catch(() => undefined));
    return cached;
  }
  return fresh;
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
  return response;
}

/**
 * Stores a newer shell once all its bundles are cached (so it always opens
 * offline), then tells open pages. `previousText` is the cached shell's HTML.
 */
async function adoptShell(response, previousText) {
  if (!isHtml(response)) return;
  const html = await response.clone().text();
  const previous = await previousText;
  if (previous === html) return;
  if (!(await precache(html, previous).catch(() => false)) && previous !== null) return;
  const cache = await caches.open(SHELL_CACHE);
  await cache.put(SHELL_URL, response);
  if (previous === null) return;
  for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: UPDATED_MESSAGE });
}

async function networkShell(event) {
  const preloaded = await event.preloadResponse?.catch(() => undefined);
  return preloaded || fetch(event.request);
}

async function appShell(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = (await cache.match(SHELL_URL)) || (await cache.match('/'));
  if (cached) {
    // Every SPA route serves index.html; refresh it without making the launch wait.
    const previousText = cached.clone().text();
    event.waitUntil(
      networkShell(event)
        .then((response) => adoptShell(response, previousText))
        .catch(() => undefined),
    );
    return cached;
  }
  const response = await networkShell(event);
  event.waitUntil(adoptShell(response.clone(), null).catch(() => undefined));
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isApi(url)) return;
  if (request.mode === 'navigate') {
    event.respondWith(appShell(event));
    return;
  }
  if (isStatic(url)) event.respondWith(cacheFirst(request));
  else if (ROOT_FILES.includes(url.pathname)) event.respondWith(staleWhileRevalidate(event));
});
