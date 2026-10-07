/**
 * The comparison harness inside Chromium: both builds bundled into one page
 * script (`truffle-baseline` and `truffle-next` are resolved by the bundler,
 * see `compare.ts`), documents from the native `DOMParser`.
 */
import * as base from 'truffle-baseline';
import * as next from 'truffle-next';
import { createHarness, type Engine } from './compare-harness';

/** A fresh document each call, as the eval parses: a `<base href>` with the page URL when the page has none. */
function parse(html: string, url: string): Document {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!doc.querySelector('base[href]')) {
    const el = doc.createElement('base');
    el.href = url;
    doc.head.prepend(el);
  }
  return doc;
}

const g = globalThis as unknown as { gc?: (options?: { type: 'minor' | 'major' }) => void; harness: unknown; engines: unknown };

// Both builds, for ad-hoc probes from the console or `page.evaluate`.
g.engines = { base, next };

g.harness = createHarness({
  base: base as unknown as Engine,
  next: next as unknown as Engine,
  parse,
  // The young generation only: every run starts with it empty. A full collection costs tens of milliseconds with the
  // documents a page has parsed; the old generation is collected when V8 decides, so each build pays for its own garbage.
  gc: g.gc === undefined ? undefined : () => g.gc!({ type: 'minor' }),
});
