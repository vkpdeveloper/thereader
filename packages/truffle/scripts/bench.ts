/**
 * Speed and memory of the working tree's engine against the baseline, measured
 * in one run on the eval corpus (`test-corpus/parity/`), so machine load hits
 * both builds alike. Prints Markdown tables.
 *
 * Time. Per page, each build runs one warm-up and `--runs` timed runs, the two
 * builds interleaved run by run, and the build that goes first alternates by
 * page and by run. A full GC precedes each timed run, so no run pays to collect
 * the other build's garbage (its own scavenges are its cost). Each run times:
 *
 * - `fromDom`: the page document copied into the engine's tree;
 * - `extractTree`: that tree to an `Article` (no Markdown);
 * - `markdown`: `articleMarkdown` of that article;
 * - `extract`: the full `extract(doc, { url, markdown: true })`, timed on its own.
 *
 * The per-page figure is the median of the runs; tables summarize those over
 * pages (median, p95, mean, and the corpus total, which is their sum).
 *
 * - Chromium (the web app's runtime; V8): headless Chromium, both builds
 *   bundled into one cross-origin-isolated page (5 µs timers), native
 *   `DOMParser` documents with a `<base href>` as the eval adds. One renderer.
 * - Bun (JavaScriptCore), secondary: jsdom documents, as the tests and
 *   parity tools parse. `fromDom` over jsdom is mostly jsdom's own cost.
 *
 * Memory (Chromium only), with V8's sampling heap profiler over CDP
 * (`HeapProfiler.startSampling`, every `--interval` bytes on average, 64 by
 * default), attributed to the one call that runs the phase (inputs are built
 * before sampling starts), after a warm-up run, averaged over `--mem-runs` runs:
 *
 * - allocated: bytes allocated by the phase, including everything collected
 *   since (`includeObjectsCollectedByMajorGC/MinorGC`); the garbage it makes;
 * - retained: bytes the phase allocated that are still live after a forced
 *   full GC while its result is held: the tree (`fromDom`) and the final output
 *   (`extract`, the tree and all intermediates gone). The tree is what every
 *   later stage works on and is live through the whole extraction, so tree +
 *   output bounds the long-lived part of peak heap; the transient rest is in
 *   allocated bytes.
 *
 * The profiler samples allocations as a Poisson process and scales each sample
 * to an unbiased estimate, so one page's figure carries a few percent of noise
 * (relative error about sqrt(interval / bytes)); over the corpus (hundreds of
 * MB) it is well under 1%. Both builds are measured the same way in the same renderer.
 *
 *   bun scripts/bench.ts [--runtime chromium|bun|both] [--runs 10] [--mem-runs 2] [--interval 64]
 *                        [--no-memory] [--ids id,id] [--baseline <src>] [--json out.json]
 *   bun scripts/bench.ts --profile [next|base] [--runs 5]   # V8 CPU profile of `extract`, top functions by self time
 */
import { writeFileSync } from 'node:fs';
import type { CDPSession, Page } from '../../../eval/node_modules/playwright';
import { createHarness, PHASES, type EngineName, type Phase, type Timing } from './compare-harness';
import { arg, baselineDir, bundleComparePage, call, flag, loadCorpus, loadEngines, openPages, pageHtml, parseJsdom, type Entry } from './compare';

const runtime = arg('--runtime') ?? 'both';
const runs = Number(arg('--runs') ?? 10);
const memRuns = Number(arg('--mem-runs') ?? 2);
const interval = Number(arg('--interval') ?? 64);
const memory = !flag('--no-memory');
const entries = loadCorpus(arg('--ids')?.split(','));
const ENGINES: EngineName[] = ['base', 'next'];

type PageTiming = { entry: Entry; time: Record<EngineName, Timing> };
type Memory = Record<'fromDom' | 'extractTree' | 'markdown' | 'extract' | 'tree' | 'output', number>;
type PageMemory = { entry: Entry; memory: Record<EngineName, Memory> };

// ------------------------------------------------------------------ stats and tables

function quantile(values: number[], q: number): number {
  const s = values.slice().sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (i - lo);
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const mean = (values: number[]) => (values.length === 0 ? 0 : sum(values) / values.length);
const ms = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
const ratio = (base: number, next: number) => (next === 0 ? '–' : (base / next).toFixed(2) + '×');
const pct = (base: number, next: number) => (base === 0 ? '–' : ((next / base - 1) * 100).toFixed(1) + '%');

function bytes(n: number): string {
  const a = Math.abs(n);
  return a >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : a >= 1e6 ? (n / 1e6).toFixed(2) + ' MB' : a >= 1e3 ? (n / 1e3).toFixed(1) + ' KB' : n.toFixed(0) + ' B';
}

function table(head: string[], rows: string[][]): string {
  const line = (cells: string[]) => '| ' + cells.join(' | ') + ' |';
  return [line(head), line(head.map((_, i) => (i === 0 ? '---' : '---:'))), ...rows.map(line)].join('\n');
}

const BUCKETS: [string, number][] = [['< 50 KB', 50e3], ['50–200 KB', 200e3], ['200 KB–1 MB', 1e6], ['≥ 1 MB', Infinity]];

function bucketOf(size: number): string {
  return BUCKETS.find(([, max]) => size < max)![0];
}

function timeReport(title: string, results: PageTiming[]): string {
  const out = [`### ${title}: time per page (ms; per page the median of ${runs} runs)`, ''];
  out.push(table(['phase', 'median', 'p95', 'mean', 'corpus total', 'speedup (total)', 'per-page speedup (median)'], PHASES.map((p) => {
    const b = results.map((r) => r.time.base[p]);
    const n = results.map((r) => r.time.next[p]);
    const perPage = results.filter((r) => r.time.next[p] > 0).map((r) => r.time.base[p] / r.time.next[p]);
    return [p, `${ms(quantile(b, 0.5))} → ${ms(quantile(n, 0.5))}`, `${ms(quantile(b, 0.95))} → ${ms(quantile(n, 0.95))}`, `${ms(mean(b))} → ${ms(mean(n))}`, `${ms(sum(b))} → ${ms(sum(n))}`, ratio(sum(b), sum(n)), quantile(perPage, 0.5).toFixed(2) + '×'];
  })));
  out.push('', `Full \`extract\` by HTML size:`, '');
  out.push(table(['HTML size', 'pages', 'median', 'total', 'speedup (total)'], BUCKETS.map(([name]) => {
    const rs = results.filter((r) => bucketOf(r.entry.bytes) === name);
    const b = rs.map((r) => r.time.base.extract);
    const n = rs.map((r) => r.time.next.extract);
    return [name, String(rs.length), `${ms(quantile(b, 0.5))} → ${ms(quantile(n, 0.5))}`, `${ms(sum(b))} → ${ms(sum(n))}`, ratio(sum(b), sum(n))];
  }).filter((row) => row[1] !== '0')));
  const slowest = results.slice().sort((a, b) => b.time.base.extract - a.time.base.extract).slice(0, 10);
  out.push('', 'Slowest pages (full `extract`, baseline order):', '');
  out.push(table(['page', 'HTML', 'fromDom', 'extractTree', 'markdown', 'extract', 'speedup'], slowest.map((r) => [
    r.entry.key, bytes(r.entry.bytes),
    ...(['fromDom', 'extractTree', 'markdown', 'extract'] as Phase[]).map((p) => `${ms(r.time.base[p])} → ${ms(r.time.next[p])}`),
    ratio(r.time.base.extract, r.time.next.extract),
  ])));
  return out.join('\n');
}

function memoryReport(results: PageMemory[]): string {
  const out = [`### Chromium: memory per page (V8 sampling heap profiler, ${interval} B interval, mean of ${memRuns} runs)`, ''];
  const rows: [string, keyof Memory][] = [
    ['allocated: fromDom', 'fromDom'], ['allocated: extractTree', 'extractTree'], ['allocated: markdown', 'markdown'], ['allocated: extract (full)', 'extract'],
    ['retained: tree', 'tree'], ['retained: output', 'output'],
  ];
  out.push(table(['metric', 'median', 'p95', 'mean', 'corpus total', 'change (total)'], rows.map(([name, key]) => {
    const b = results.map((r) => r.memory.base[key]);
    const n = results.map((r) => r.memory.next[key]);
    return [name, `${bytes(quantile(b, 0.5))} → ${bytes(quantile(n, 0.5))}`, `${bytes(quantile(b, 0.95))} → ${bytes(quantile(n, 0.95))}`, `${bytes(mean(b))} → ${bytes(mean(n))}`, `${bytes(sum(b))} → ${bytes(sum(n))}`, pct(sum(b), sum(n))];
  })));
  return out.join('\n');
}

// ------------------------------------------------------------------ Chromium

/** Bytes in the sampled profile under the `measuredRun` frame. */
function measuredBytes(node: { callFrame: { functionName: string }; selfSize: number; children: unknown[] }, inside = false): number {
  const here = inside || node.callFrame.functionName === 'measuredRun';
  let total = here ? node.selfSize : 0;
  for (const child of node.children) total += measuredBytes(child as typeof node, here);
  return total;
}

async function sampleHeap(page: Page, cdp: CDPSession, engine: EngineName, phase: Phase, collected: boolean): Promise<number> {
  if (!(await call<boolean>(page, 'prepare', engine, phase))) return 0;
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: interval, includeObjectsCollectedByMajorGC: collected, includeObjectsCollectedByMinorGC: collected } as never);
  await call(page, 'measuredRun', engine, phase);
  if (!collected) await cdp.send('HeapProfiler.collectGarbage');
  const { profile } = await cdp.send('HeapProfiler.stopSampling');
  await call(page, 'release');
  return measuredBytes(profile.head as never);
}

async function pageMemory(page: Page, cdp: CDPSession, pageIndex: number): Promise<Record<EngineName, Memory>> {
  const memory = {} as Record<EngineName, Memory>;
  const order = pageIndex % 2 === 0 ? ENGINES : ENGINES.slice().reverse();
  for (const engine of order) {
    const m: Memory = { fromDom: 0, extractTree: 0, markdown: 0, extract: 0, tree: 0, output: 0 };
    for (const phase of PHASES) await sampleHeap(page, cdp, engine, phase, true); // warm-up
    for (let r = 0; r < memRuns; r++) {
      for (const phase of PHASES) m[phase] += (await sampleHeap(page, cdp, engine, phase, true)) / memRuns;
      m.tree += (await sampleHeap(page, cdp, engine, 'fromDom', false)) / memRuns;
      m.output += (await sampleHeap(page, cdp, engine, 'extract', false)) / memRuns;
    }
    memory[engine] = m;
  }
  return memory;
}

async function chromiumBench(): Promise<{ time: PageTiming[]; memory: PageMemory[] }> {
  const { browser, pages } = await openPages(1, await bundleComparePage());
  const page = pages[0]!;
  console.error(`Chromium ${browser.version()}: ${entries.length} pages, ${runs} runs`);
  const time: PageTiming[] = [];
  const mem: PageMemory[] = [];
  try {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      await call(page, 'load', pageHtml(entry), entry.url);
      time.push({ entry, time: await call(page, 'time', runs, i % 2 === 0) });
      if ((i + 1) % 50 === 0) console.error(`  time ${i + 1}/${entries.length}`);
    }
    if (memory) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('HeapProfiler.enable');
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        await call(page, 'load', pageHtml(entry), entry.url);
        mem.push({ entry, memory: await pageMemory(page, cdp, i) });
        if ((i + 1) % 50 === 0) console.error(`  memory ${i + 1}/${entries.length}`);
      }
    }
  } finally {
    await browser.close();
  }
  return { time, memory: mem };
}

/** CPU profile of one build's full `extract` over the corpus; prints the top functions by self time. */
async function profile(engine: EngineName): Promise<void> {
  const { browser, pages } = await openPages(1, await bundleComparePage());
  const page = pages[0]!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 50 });
  try {
    await cdp.send('Profiler.start');
    for (const entry of entries) {
      await call(page, 'load', pageHtml(entry), entry.url);
      await page.evaluate(([name, n]) => (globalThis as any).harness.repeat(name, n), [engine, runs] as const);
    }
    const { profile: p } = await cdp.send('Profiler.stop');
    const file = `/tmp/truffle-${engine}.cpuprofile`;
    writeFileSync(file, JSON.stringify(p));
    const self = new Map<string, number>();
    const dt = new Map<number, number>();
    for (let i = 0; i < p.samples!.length; i++) dt.set(p.samples![i]!, (dt.get(p.samples![i]!) ?? 0) + p.timeDeltas![i]! / 1000);
    let total = 0;
    for (const node of p.nodes) {
      const t = dt.get(node.id) ?? 0;
      total += t;
      const f = node.callFrame;
      const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + t);
    }
    console.log(`${engine}: ${ms(total)} ms sampled; profile in ${file}\n`);
    for (const [key, t] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 50)) console.log(`${ms(t).padStart(8)} ms ${((t / total) * 100).toFixed(1).padStart(5)}%  ${key}`);
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------ Bun

async function bunBench(): Promise<PageTiming[]> {
  const engines = await loadEngines();
  let doc: Document | null = null;
  const harness = createHarness({ ...engines, parse: () => doc!, gc: () => Bun.gc(true) });
  console.error(`Bun ${Bun.version}: ${entries.length} pages, ${runs} runs`);
  const out: PageTiming[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const html = pageHtml(entry);
    doc = parseJsdom(html);
    harness.load(html, entry.url);
    out.push({ entry, time: harness.time(runs, i % 2 === 0) });
    doc.defaultView?.close();
    if ((i + 1) % 50 === 0) console.error(`  time ${i + 1}/${entries.length}`);
  }
  return out;
}

// ------------------------------------------------------------------ main

if (flag('--profile')) {
  const which = arg('--profile');
  await profile(which === 'base' ? 'base' : 'next');
  process.exit(0);
}

const report: string[] = [`## Truffle (TS) benchmark: baseline → working tree`, '', `Baseline: \`${baselineDir()}\`. ${entries.length} pages. Arrows read baseline → working tree.`, ''];
const json: Record<string, unknown> = {};
if (runtime === 'chromium' || runtime === 'both') {
  const { time, memory: mem } = await chromiumBench();
  report.push(timeReport('Chromium (V8, DOMParser)', time), '');
  if (mem.length > 0) report.push(memoryReport(mem), '');
  json.chromium = { time, memory: mem };
}
if (runtime === 'bun' || runtime === 'both') {
  const time = await bunBench();
  report.push(timeReport('Bun (JavaScriptCore, jsdom)', time), '');
  json.bun = { time };
}
console.log(report.join('\n'));
const jsonPath = arg('--json');
if (jsonPath !== undefined) writeFileSync(jsonPath, JSON.stringify(json));
