/* The Reader service worker: keeps the app shell, every bundle (including
 * lazily loaded routes such as the reader and the import pipeline) and the
 * fonts available offline. It never touches the API (/v1/*, /health) or other
 * origins; books and covers live in IndexedDB, managed by the app itself, so
 * a downloaded book opens with no network at all.
 *
 * - Install, and every newly deployed shell: crawl the asset graph from
 *   index.html (script/link tags, Vite's dynamic imports and preload maps,
 *   CSS url()s) and precache it. Hashed assets of older deployments are
 *   pruned once a crawl completes.
 * - /assets/* (hashed Vite bundles) and /fonts/*: cache first.
 * - Navigations: network first, falling back to the cached app shell.
 * Bump VERSION to drop every older cache on activation. */

const VERSION = 'v2';
const SHELL_CACHE = `thereader-shell-${VERSION}`;
const STATIC_CACHE = `thereader-static-${VERSION}`;
const CURRENT = new Set([SHELL_CACHE, STATIC_CACHE]);
const SHELL_URL = '/index.html';
const CRAWL_LIMIT = 400;

self.addEventListener('install', (event) => {
  event.waitUntil(
    fetch(new Request('/', { cache: 'reload' }))
      .then(async (response) => {
        if (!response.ok) return;
        const html = await response.clone().text();
        await (await caches.open(SHELL_CACHE)).put(SHELL_URL, response);
        // Best effort: a failed asset must not keep the worker from installing.
        await precache(html).catch(() => undefined);
      })
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

function isStatic(url) {
  return url.origin === self.location.origin && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/'));
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
 * Walks the asset graph from the shell and caches every file not cached
 * yet. After a complete crawl, hashed bundles no longer referenced (older
 * deployments) are removed.
 */
async function precache(html) {
  const cache = await caches.open(STATIC_CACHE);
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
  if (!complete || queue.length > 0) return;
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/assets/') && !seen.has(path)) await cache.delete(request);
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
  return response;
}

async function networkFirstShell(event) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(event.request);
    // Every SPA route serves index.html; keep the latest copy as the shell.
    if (response.ok && response.type === 'basic' && (response.headers.get('content-type') || '').includes('text/html')) {
      const html = await response.clone().text();
      const previous = await cache.match(SHELL_URL);
      const changed = !previous || (await previous.text()) !== html;
      await cache.put(SHELL_URL, response.clone());
      // A new deployment: precache its bundles while the page loads.
      if (changed) event.waitUntil(precache(html).catch(() => undefined));
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
    event.respondWith(networkFirstShell(event));
    return;
  }
  if (isStatic(url)) event.respondWith(cacheFirst(request));
});
