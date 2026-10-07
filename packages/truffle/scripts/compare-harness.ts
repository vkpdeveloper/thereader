/**
 * Runs two builds of the engine side by side on one page: the pinned baseline
 * and the working tree. Environment-agnostic: `compare-page.ts` runs it inside
 * Chromium on `DOMParser` documents, `verify-golden.ts` and `bench.ts` run it
 * under Bun on jsdom documents. Only plain data crosses its boundary.
 */
import { vdocJson } from './vdoc-json';

/** The part of the engine's API the comparison uses (both builds export it). */
export interface Engine {
  extract(doc: Document, options: { url: string; markdown?: boolean }): unknown;
  extractTree(tree: unknown, options: { url: string; markdown?: boolean }): unknown;
  fromDom(doc: Document): unknown;
  articleText(article: never): string;
  articleMarkdown(article: never): string;
  blocksMarkdown(blocks: never): string;
  blocksText(blocks: never): string;
}

export type EngineName = 'base' | 'next';
export type Phase = 'fromDom' | 'extractTree' | 'markdown' | 'extract';
export const PHASES: Phase[] = ['fromDom', 'extractTree', 'markdown', 'extract'];

export interface Environment {
  base: Engine;
  next: Engine;
  parse(html: string, url: string): Document;
  /** Full garbage collection (V8 `--expose-gc`, `Bun.gc(true)`); absent where unavailable. */
  /**
   * A document for the page. In Chromium a fresh one each call: an engine's first walk over a document creates its
   * DOM wrappers (and whatever else the DOM builds lazily), which is part of what extraction costs in the app.
   */
  gc?: () => void;
}

/** One output both builds produce for the page, as the string compared byte for byte. */
export interface Mismatch {
  check: string;
  base: string;
  next: string;
}

/** Medians per phase, in milliseconds. */
export type Timing = Record<Phase, number>;

/** `JSON.stringify(value, null, 2) + '\n'`: the golden files' serialization. */
export function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted.length % 2 === 1 ? sorted[sorted.length >> 1]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
}

type Article = { blocks: unknown; markdown?: string } | null;

export function createHarness(env: Environment) {
  let html = '';
  let url = '';
  let doc: Document | null = null;
  // Inputs prepared outside a measured region (a fresh document, a tree, an article), and the outputs kept alive past it.
  let fresh: Document | null = null;
  let input: unknown = null;
  let kept: unknown = null;

  const engine = (name: EngineName): Engine => (name === 'base' ? env.base : env.next);
  const page = (): Document => (doc ??= env.parse(html, url));

  /** Holds the page in the runtime so later calls do not re-send it; the document is parsed once (no engine mutates it). */
  function load(source: string, pageUrl: string): number {
    html = source;
    url = pageUrl;
    doc = null;
    fresh = null;
    input = null;
    kept = null;
    return html.length;
  }

  /** Every output of both builds on the page; the ones that differ. Each build runs on its own fresh document and trees. */
  function verify(): Mismatch[] {
    const out: Mismatch[] = [];
    const check = (name: string, base: string, next: string) => {
      if (base !== next) out.push({ check: name, base, next });
    };
    const run = (e: Engine) => {
      const d = env.parse(html, url);
      const tree = vdocJson(e.fromDom(d) as never);
      const md = e.extractTree(e.fromDom(d), { url, markdown: true }) as Article;
      const plainTree = e.extractTree(e.fromDom(d), { url }) as Article;
      const plain = e.extract(d, { url }) as Article;
      const full = e.extract(d, { url, markdown: true }) as Article;
      return { tree, md, plainTree, plain, full };
    };
    const b = run(env.base);
    const n = run(env.next);
    check('fromDom', JSON.stringify(b.tree), JSON.stringify(n.tree));
    check('extractTree markdown', serialize(b.md), serialize(n.md));
    check('extractTree', serialize(b.plainTree), serialize(n.plainTree));
    check('extract', serialize(b.plain), serialize(n.plain));
    check('extract markdown', serialize(b.full), serialize(n.full));
    if (n.plain !== null && 'markdown' in n.plain) out.push({ check: 'extract: no markdown key', base: '', next: 'markdown' });
    if (b.plain !== null && n.plain !== null) {
      const ba = b.plain as never;
      const na = n.plain as never;
      const blocks = (a: Article) => a!.blocks as never;
      check('articleText', env.base.articleText(ba), env.next.articleText(na));
      check('blocksText', env.base.blocksText(blocks(b.plain)), env.next.blocksText(blocks(n.plain)));
      check('blocksMarkdown', env.base.blocksMarkdown(blocks(b.plain)), env.next.blocksMarkdown(blocks(n.plain)));
      check('articleMarkdown', env.base.articleMarkdown(ba), env.next.articleMarkdown(na));
      check('articleMarkdown = markdown', b.full!.markdown!, env.next.articleMarkdown(na));
      // The text and Markdown functions on one and the same (stored) article.
      check('articleText (same article)', env.base.articleText(ba), env.next.articleText(ba));
      check('blocksMarkdown (same article)', env.base.blocksMarkdown(blocks(b.plain)), env.next.blocksMarkdown(blocks(b.plain)));
    }
    return out;
  }

  /**
   * One run of each phase, in milliseconds, each chain on a document of its own (`parse`, not timed). A full GC (when
   * available) precedes the chain and the full run.
   */
  function timeOnce(e: Engine, t: Timing): void {
    let d = env.parse(html, url);
    env.gc?.();
    let t0 = performance.now();
    const tree = e.fromDom(d);
    let t1 = performance.now();
    t.fromDom = t1 - t0;
    t0 = performance.now();
    const article = e.extractTree(tree, { url }) as Article;
    t1 = performance.now();
    t.extractTree = t1 - t0;
    t0 = performance.now();
    if (article !== null) e.articleMarkdown(article as never);
    t1 = performance.now();
    t.markdown = t1 - t0;
    d = env.parse(html, url);
    env.gc?.();
    t0 = performance.now();
    kept = e.extract(d, { url, markdown: true });
    t1 = performance.now();
    t.extract = t1 - t0;
    kept = null;
  }

  /**
   * Medians per phase over `runs` timed runs after one warm-up, with one build. The builds are timed in separate
   * runtimes (renderers, workers): two copies of the engine in one isolate slow each other down (shared caches),
   * by a third in `extractTree` on large pages.
   */
  function time(name: EngineName, runs: number): Timing {
    const samples: Record<Phase, number[]> = { fromDom: [], extractTree: [], markdown: [], extract: [] };
    const t: Timing = { fromDom: 0, extractTree: 0, markdown: 0, extract: 0 };
    for (let r = -1; r < runs; r++) {
      timeOnce(engine(name), t);
      if (r >= 0) for (const p of PHASES) samples[p].push(t[p]);
    }
    return { fromDom: median(samples.fromDom), extractTree: median(samples.extractTree), markdown: median(samples.markdown), extract: median(samples.extract) };
  }

  /** Builds what `phase` takes (a fresh document, a tree, an article) so that `measuredRun` does only the phase itself. */
  function prepare(name: EngineName, phase: Phase): boolean {
    const e = engine(name);
    kept = null;
    fresh = phase === 'fromDom' || phase === 'extract' ? env.parse(html, url) : null;
    input = phase === 'extractTree' ? e.fromDom(env.parse(html, url)) : phase === 'markdown' ? e.extractTree(e.fromDom(env.parse(html, url)), { url }) : null;
    return phase !== 'markdown' || input !== null;
  }

  /**
   * The measured region for allocation sampling: exactly one run of `phase`, on what `prepare` built. Its output stays
   * referenced; its input does not (the document goes too, with the wrappers the run created on it).
   */
  function measuredRun(name: EngineName, phase: Phase): number {
    const e = engine(name);
    if (phase === 'fromDom') kept = e.fromDom(fresh!);
    else if (phase === 'extractTree') kept = e.extractTree(input, { url });
    else if (phase === 'markdown') kept = e.articleMarkdown(input as never);
    else kept = e.extract(fresh!, { url, markdown: true });
    fresh = null;
    input = null;
    return 0;
  }

  /** Drops the output `measuredRun` kept. */
  function release(): void {
    kept = null;
  }

  /** `runs` full extractions with one build, each on a fresh document, for CPU profiles. */
  function repeat(name: EngineName, runs: number): void {
    const e = engine(name);
    for (let r = 0; r < runs; r++) kept = e.extract(env.parse(html, url), { url, markdown: true });
    kept = null;
  }

  return { load, verify, time, prepare, measuredRun, release, repeat, page };
}

export type Harness = ReturnType<typeof createHarness>;
