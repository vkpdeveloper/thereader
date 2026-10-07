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
  // Inputs prepared outside a measured region, and the outputs kept alive past it.
  let input: unknown = null;
  let kept: unknown = null;

  const engine = (name: EngineName): Engine => (name === 'base' ? env.base : env.next);
  const page = (): Document => (doc ??= env.parse(html, url));

  /** Holds the page in the runtime so later calls do not re-send it; the document is parsed once (no engine mutates it). */
  function load(source: string, pageUrl: string): number {
    html = source;
    url = pageUrl;
    doc = null;
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

  /** One run of each phase; returns milliseconds. A full GC first (when available) so no run pays for the other build's garbage. */
  function timeOnce(e: Engine, t: Timing): void {
    const d = page();
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
    env.gc?.();
    t0 = performance.now();
    kept = e.extract(d, { url, markdown: true });
    t1 = performance.now();
    t.extract = t1 - t0;
    kept = null;
  }

  /**
   * Medians over `runs` timed runs after one warm-up each, the two builds interleaved run by run;
   * `baseFirst` says which goes first on even runs (odd runs swap).
   */
  function time(runs: number, baseFirst: boolean): Record<EngineName, Timing> {
    const samples: Record<EngineName, Record<Phase, number[]>> = {
      base: { fromDom: [], extractTree: [], markdown: [], extract: [] },
      next: { fromDom: [], extractTree: [], markdown: [], extract: [] },
    };
    const t: Timing = { fromDom: 0, extractTree: 0, markdown: 0, extract: 0 };
    for (let r = -1; r < runs; r++) {
      const order: EngineName[] = (r & 1) === 0 === baseFirst ? ['base', 'next'] : ['next', 'base'];
      for (const name of order) {
        timeOnce(engine(name), t);
        if (r >= 0) for (const p of PHASES) samples[name][p].push(t[p]);
      }
    }
    const result = {} as Record<EngineName, Timing>;
    for (const name of ['base', 'next'] as EngineName[]) {
      result[name] = { fromDom: median(samples[name].fromDom), extractTree: median(samples[name].extractTree), markdown: median(samples[name].markdown), extract: median(samples[name].extract) };
    }
    return result;
  }

  /** Builds what `phase` takes (a fresh tree, an article) so that `measuredRun` does only the phase itself. */
  function prepare(name: EngineName, phase: Phase): boolean {
    const e = engine(name);
    kept = null;
    input = phase === 'extractTree' ? e.fromDom(page()) : phase === 'markdown' ? e.extractTree(e.fromDom(page()), { url }) : null;
    return phase !== 'markdown' || input !== null;
  }

  /** The measured region for allocation sampling: exactly one run of `phase`, on what `prepare` built. Its output stays referenced. */
  function measuredRun(name: EngineName, phase: Phase): number {
    const e = engine(name);
    if (phase === 'fromDom') kept = e.fromDom(page());
    else if (phase === 'extractTree') kept = e.extractTree(input, { url });
    else if (phase === 'markdown') kept = e.articleMarkdown(input as never);
    else kept = e.extract(page(), { url, markdown: true });
    input = null;
    return 0;
  }

  /** Drops the output `measuredRun` kept. */
  function release(): void {
    kept = null;
  }

  /** `runs` full extractions with one build, for CPU profiles. */
  function repeat(name: EngineName, runs: number): void {
    const e = engine(name);
    for (let r = 0; r < runs; r++) kept = e.extract(page(), { url, markdown: true });
    kept = null;
  }

  return { load, verify, time, prepare, measuredRun, release, repeat };
}

export type Harness = ReturnType<typeof createHarness>;
