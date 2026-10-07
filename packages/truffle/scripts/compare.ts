/**
 * Node side of the baseline-vs-working-tree comparison shared by
 * `verify-golden.ts` and `bench.ts`: the corpus, the baseline engine, the
 * Chromium page with both builds, and the first difference between outputs.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from '../../../eval/node_modules/playwright';
import type { Engine } from './compare-harness';

export const ROOT = resolve(import.meta.dir, '../../..');
export const SRC = resolve(import.meta.dir, '../src');
/** `test-corpus/parity/`: `manifest.json` and `html/<key>.html` (see `parity-dump.ts`). */
export const PARITY_DIR = resolve(ROOT, 'test-corpus/parity');
/** The untouched engine the working tree is compared with: a checkout of the commit before the optimizations. */
export const DEFAULT_BASELINE = resolve(ROOT, '../truffle-perf-baseline/packages/truffle/src');

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function flag(name: string): boolean {
  return process.argv.includes(name);
}

export interface Entry {
  key: string;
  dataset: string;
  id: string;
  url: string;
  bytes: number;
}

/** Corpus pages in manifest order, optionally only the given ids or keys. */
export function loadCorpus(only?: string[]): Entry[] {
  const manifest = JSON.parse(readFileSync(resolve(PARITY_DIR, 'manifest.json'), 'utf8')) as Entry[];
  return only === undefined ? manifest : manifest.filter((e) => only.includes(e.id) || only.includes(e.key));
}

export function pageHtml(entry: Entry): string {
  return readFileSync(resolve(PARITY_DIR, 'html', entry.key + '.html'), 'utf8');
}

/** As `parity-dump.ts` and the conformance tests parse. */
export function parseJsdom(html: string): Document {
  return new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document;
}

export function baselineDir(): string {
  return resolve(arg('--baseline') ?? DEFAULT_BASELINE);
}

export async function loadEngines(): Promise<{ base: Engine; next: Engine }> {
  const base = (await import(resolve(baselineDir(), 'index.ts'))) as Engine;
  const next = (await import(resolve(SRC, 'index.ts'))) as Engine;
  if (base === next) throw new Error('the baseline is the working tree');
  return { base, next };
}

/**
 * `compare-page.ts` with both builds in one browser script, or with only one (`only`; then `base` and `next` are
 * the same module).
 */
export async function bundleComparePage(only?: 'base' | 'next'): Promise<string> {
  const base = resolve(baselineDir(), 'index.ts');
  const next = resolve(SRC, 'index.ts');
  const engines: Record<string, string> = { 'truffle-baseline': only === 'next' ? next : base, 'truffle-next': only === 'base' ? base : next };
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, 'compare-page.ts')],
    target: 'browser',
    format: 'iife',
    plugins: [{ name: 'engines', setup: (b) => b.onResolve({ filter: /^truffle-(?:baseline|next)$/ }, (a) => ({ path: engines[a.path]! })) }],
  });
  if (!build.success) throw new AggregateError(build.logs, 'compare page bundle failed');
  return build.outputs[0]!.text();
}

/** Headless Chromium with `gc()` exposed. */
export function launchChromium(): Promise<Browser> {
  return chromium.launch({ args: ['--js-flags=--expose-gc'] });
}

/** A cross-origin-isolated page (5 µs timers, as in the eval) running `script`, in a context, so a renderer, of its own. */
export async function openPage(browser: Browser, index: number, script: string): Promise<Page> {
  const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
  const context = await browser.newContext();
  const origin = `http://w${index}.localhost`;
  await context.route(`${origin}/**`, (route) =>
    route.request().url().endsWith('/page.js')
      ? route.fulfill({ contentType: 'text/javascript', headers, body: script })
      : route.fulfill({ contentType: 'text/html', headers, body: '<!doctype html><meta charset="utf-8"><title>compare</title><script src="/page.js"></script>' }),
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(`[w${index}] ${error.message}`));
  await page.goto(`${origin}/`);
  return page;
}

/** `count` pages in one browser, each running `script` (or its own entry of it). */
export async function openPages(count: number, script: string | string[]): Promise<{ browser: Browser; pages: Page[] }> {
  const browser = await launchChromium();
  const pages = await Promise.all(Array.from({ length: count }, (_, i) => openPage(browser, i, typeof script === 'string' ? script : script[i]!)));
  return { browser, pages };
}

/** Calls `harness[fn](...args)` in the page. */
export function call<T>(page: Page, fn: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([name, list]) => (globalThis as any).harness[name](...list), [fn, args] as const) as Promise<T>;
}

/** Runs `task` over `items` with every worker pulling from one queue; results keep input order. */
export async function pool<W, T, R>(workers: W[], items: T[], task: (worker: W, item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(workers.map(async (w) => {
    for (let i = next++; i < items.length; i = next++) results[i] = await task(w, items[i]!, i);
  }));
  return results;
}

/** Where two serialized outputs first differ: a JSON path when both parse, else the character offset with context. */
export function firstDifference(a: string, b: string): string {
  try {
    const path = jsonDifference(JSON.parse(a), JSON.parse(b), '$');
    if (path !== null) return path;
  } catch {
    /* not JSON */
  }
  return 'text ' + stringDifference(a, b);
}

function stringDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const context = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 40));
  return `offset ${i}: ${context(a)} vs ${context(b)}`;
}

function jsonDifference(a: unknown, b: unknown, path: string): string | null {
  if (a === b) return null;
  if (typeof a === 'string' && typeof b === 'string') return `${path} at ${stringDifference(a, b)}`;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return `${path}: ${JSON.stringify(a)?.slice(0, 200)} vs ${JSON.stringify(b)?.slice(0, 200)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.join(',') !== kb.join(',')) return `${path}: keys [${ka.join(', ')}] vs [${kb.join(', ')}]`;
  for (const k of ka) {
    const d = jsonDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`);
    if (d !== null) return d;
  }
  return null;
}
