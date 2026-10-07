// The three engines side by side on the same pages and the same machine: the TypeScript
// reference (headless Chromium), the Dart port (AOT) and the Go port (native), each running
// the whole pipeline — HTML to article and Markdown — on every page of the parity dump
// (`bun scripts/parity-dump.ts` in packages/truffle writes test-corpus/parity/).
//
//   bun run bench [--runs 11] [--ids key,key] [--skip go,dart,ts] [--keep go,dart,ts]
//
// Writes eval/results/bench.json (per-page medians) and eval/results/benchmark.md. --skip leaves an
// engine out; --keep reuses its results from the last run (test-corpus/bench/<engine>.json) instead
// of running it again.
// The engines run one after another, one process or renderer each, so they never compete.
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { cpus, loadavg, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BrowserPool } from '../src/browser';
import { CORPUS_DIR, EVAL_DIR, ROOT } from '../src/corpus';
import { median } from '../src/score';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { runs: { type: 'string', default: '11' }, ids: { type: 'string' }, skip: { type: 'string', default: '' }, keep: { type: 'string', default: '' } },
});
const runs = Number(values.runs);
const skip = new Set(values.skip.split(',').filter(Boolean));
const keep = new Set(values.keep.split(',').filter(Boolean));
const PARITY = resolve(CORPUS_DIR, 'parity');
if (!existsSync(resolve(PARITY, 'manifest.json'))) throw new Error('test-corpus/parity/ missing: run `bun scripts/parity-dump.ts` in packages/truffle first');

interface Page {
  key: string;
  url: string;
  bytes: number;
  tsMs: number;
}
interface Row {
  key: string;
  bytes: number;
  parseMs: number;
  treeMs: number;
  extractMs: number;
  markdownMs: number;
  totalMs: number;
  /** Bytes one run allocates (Go, GC paused) or adds to the V8 and DOM heaps (TS); absent for Dart. */
  memoryBytes?: number;
}
interface EngineResult {
  engine: 'ts' | 'dart' | 'go';
  label: string;
  runtime: string;
  memoryNote: string;
  maxRss?: number;
  rows: Row[];
}

const only = values.ids ? new Set(values.ids.split(',')) : undefined;
const pages: Page[] = (await Bun.file(resolve(PARITY, 'manifest.json')).json()).filter((p: Page) => !only || only.has(p.key));
const ids = only ? ['--ids', [...only].join(',')] : [];
const work = resolve(CORPUS_DIR, 'bench');
await mkdir(work, { recursive: true });

async function run(cmd: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited) throw new Error(`${cmd.join(' ')} failed`);
}

const results: EngineResult[] = [];
const environment = {
  os: `${platform()} ${release()}`,
  cpu: `${cpus()[0]?.model ?? 'unknown'} x${cpus().length}`,
  bun: Bun.version,
  'load avg at start': loadavg().map((l) => l.toFixed(1)).join(' '),
};

if (!skip.has('go')) {
  const exe = resolve(work, 'go-bench');
  const out = resolve(work, 'go.json');
  // Built as the CLI is, with its profile (profile-guided optimization).
  if (!keep.has('go')) {
    await run(['go', 'build', '-pgo=cmd/truffle/default.pgo', '-o', exe, './tools/bench'], resolve(ROOT, 'packages/truffle_go'));
    await run([exe, '-runs', String(runs), '-json', out, ...ids.map((a) => a.replace('--', '-'))], ROOT);
  }
  const data = await Bun.file(out).json();
  results.push({
    engine: 'go',
    label: 'Go',
    runtime: `${String(data.version).replace(/^go/, 'Go ')}, native binary (PGO), own HTML5 parser`,
    memoryNote: 'every byte the pipeline allocates for the page, garbage collector paused (Markdown included)',
    maxRss: data.maxRss,
    rows: data.rows.map((r: Row & { allocBytes: number }) => ({ ...r, memoryBytes: r.allocBytes })),
  });
}

if (!skip.has('dart')) {
  const exe = resolve(work, 'dart-bench');
  const out = resolve(work, 'dart.json');
  const dartDir = resolve(ROOT, 'packages/truffle_dart');
  if (!keep.has('dart')) {
    await run(['dart', 'compile', 'exe', 'tool/bench.dart', '-o', exe], dartDir);
    await run([exe, '--runs', String(runs), '--json', out, ...ids], ROOT);
  }
  const data = await Bun.file(out).json();
  results.push({
    engine: 'dart',
    label: 'Dart',
    runtime: `Dart ${data.version} ${data.mode}, package:html`,
    memoryNote: 'not measured per page (the Dart VM exposes no heap counter to programs); the process peak RSS is reported',
    maxRss: data.maxRss,
    rows: data.rows,
  });
}

if (!skip.has('ts')) {
  const out = resolve(work, 'ts.json');
  if (!keep.has('ts')) {
    // Timings first, in one renderer; memory afterwards in a fresh one, so the collections the
    // memory readings force never touch the timed runs.
    let pool = await BrowserPool.open(1);
    const version = pool.version();
    const rows: Row[] = [];
    let done = 0;
    for (const page of pages) {
      const html = await Bun.file(resolve(PARITY, 'html', `${page.key}.html`)).text();
      await pool.map([page], async (worker) => {
        await pool.call(worker, 'load', [html, page.url]);
        const r = await pool.call(worker, 'benchPipeline', [runs], 600_000);
        const totals = r.parseMs.map((p, i) => p + r.treeMs[i]! + r.extractMs[i]! + r.markdownMs[i]!);
        rows.push({
          key: page.key,
          bytes: page.bytes,
          parseMs: median(r.parseMs),
          treeMs: median(r.treeMs),
          extractMs: median(r.extractMs),
          markdownMs: median(r.markdownMs),
          totalMs: median(totals),
        });
      });
      if (++done % 50 === 0) console.log(`  ts ${done}/${pages.length}`);
    }
    await pool.close();
    // Memory: the V8 heap and Blink's (the DOM) before and after one run whose results stay
    // alive, a full collection first (DevTools; performance.memory does not move within a task).
    pool = await BrowserPool.open(1);
    done = 0;
    for (const row of rows) {
      const page = pages.find((p) => p.key === row.key)!;
      const html = await Bun.file(resolve(PARITY, 'html', `${page.key}.html`)).text();
      await pool.map([page], async (worker) => {
        await pool.call(worker, 'load', [html, page.url]);
        const cdp = await worker.page.context().newCDPSession(worker.page);
        await cdp.send('HeapProfiler.collectGarbage');
        const before = await cdp.send('Runtime.getHeapUsage');
        await pool.call(worker, 'benchKeep', [true]);
        const after = await cdp.send('Runtime.getHeapUsage');
        await pool.call(worker, 'benchKeep', [false]);
        await cdp.detach();
        row.memoryBytes = Math.max(0, after.usedSize + after.embedderHeapUsedSize - before.usedSize - before.embedderHeapUsedSize);
      });
      if (++done % 100 === 0) console.log(`  ts memory ${done}/${rows.length}`);
    }
    await pool.close();
    await Bun.write(out, JSON.stringify({ version, rows }));
  }
  const data = await Bun.file(out).json();
  results.push({
    engine: 'ts',
    label: 'TypeScript',
    runtime: `Chromium ${data.version} (V8), native DOMParser`,
    memoryNote: 'growth of the V8 and DOM (Blink) heaps across one run whose results stay alive, after a full collection (DevTools Runtime.getHeapUsage); garbage collected during the run is not counted',
    rows: data.rows,
  });
}
(environment as Record<string, string>)['load avg at end'] = loadavg().map((l) => l.toFixed(1)).join(' ');

// ------------------------------------------------------------------ summaries

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const stat = (v: number[]) => ({ median: median(v), p90: percentile(v, 0.9), p95: percentile(v, 0.95), mean: mean(v), max: percentile(v, 1) });
const BUCKETS: [string, number][] = [['<50KB', 50_000], ['50-200KB', 200_000], ['200-500KB', 500_000], ['0.5-1MB', 1_000_000], ['>1MB', Infinity]];
const bucketOf = (bytes: number) => BUCKETS.find(([, limit]) => bytes < limit)![0];

const order: EngineResult['engine'][] = ['ts', 'dart', 'go'];
results.sort((a, b) => order.indexOf(a.engine) - order.indexOf(b.engine));
const summary = results.map((r) => {
  const memory = r.rows.filter((row) => row.memoryBytes !== undefined).map((row) => row.memoryBytes!);
  return {
    engine: r.engine,
    label: r.label,
    runtime: r.runtime,
    memoryNote: r.memoryNote,
    maxRss: r.maxRss,
    pages: r.rows.length,
    parse: stat(r.rows.map((row) => row.parseMs)),
    tree: stat(r.rows.map((row) => row.treeMs)),
    extract: stat(r.rows.map((row) => row.extractMs)),
    markdown: stat(r.rows.map((row) => row.markdownMs)),
    total: stat(r.rows.map((row) => row.totalMs)),
    memoryMB: memory.length ? stat(memory.map((m) => m / (1 << 20))) : null,
    under1ms: r.rows.filter((row) => row.totalMs < 1).length,
    under5MB: memory.length ? memory.filter((m) => m < 5 * (1 << 20)).length : null,
    byBucket: Object.fromEntries(
      BUCKETS.map(([name]) => {
        const v = r.rows.filter((row) => bucketOf(row.bytes) === name).map((row) => row.totalMs);
        return [name, v.length ? { pages: v.length, median: median(v), p95: percentile(v, 0.95) } : null];
      }),
    ),
  };
});

// Per-page speedups of the Go port.
const byKey = (engine: string) => new Map((results.find((r) => r.engine === engine)?.rows ?? []).map((row) => [row.key, row]));
const goRows = byKey('go');
const speedups: Record<string, { median: number; p90: number; p10: number }> = {};
for (const other of ['ts', 'dart']) {
  const rows = byKey(other);
  const ratios = [...goRows.values()].flatMap((g) => (rows.has(g.key) && g.totalMs > 0 ? [rows.get(g.key)!.totalMs / g.totalMs] : []));
  if (ratios.length) speedups[other] = { median: median(ratios), p90: percentile(ratios, 0.9), p10: percentile(ratios, 0.1) };
}

const generatedAt = new Date().toISOString();
await Bun.write(resolve(EVAL_DIR, 'results/bench.json'), JSON.stringify({ generatedAt, runs, environment, summary, speedups, engines: results }, null, 1) + '\n');

const f = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toFixed(3));
const lines: string[] = [];
lines.push('# TypeScript, Dart and Go: the whole pipeline', '');
lines.push(
  `Generated ${generatedAt} by \`bun run bench\` (see [eval/README.md](../README.md)): every page of the parity dump (${pages.length} pages, Zyte + curated), HTML to article and Markdown, ${runs} timed runs per page after one warm-up, medians per page; summaries are over pages. Milliseconds unless noted.`,
  '',
  `Machine: ${environment.os}, ${environment.cpu}, load avg at start ${environment['load avg at start']}, at end ${(environment as Record<string, string>)['load avg at end']}. Engines run one after another, single-threaded.`,
  '',
);
lines.push('| engine | runtime |', '| --- | --- |');
for (const s of summary) lines.push(`| ${s.label} | ${s.runtime} |`);
lines.push('', '## Whole pipeline (parse + tree + extract + Markdown)', '');
lines.push('| engine | median | p90 | p95 | mean | max | pages under 1 ms |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const s of summary) lines.push(`| ${s.label} | ${f(s.total.median)} | ${f(s.total.p90)} | ${f(s.total.p95)} | ${f(s.total.mean)} | ${f(s.total.max)} | ${s.under1ms}/${s.pages} |`);
lines.push('', '## Phases (median / p95)', '');
lines.push('| engine | parse | tree | extract | Markdown |', '| --- | ---: | ---: | ---: | ---: |');
for (const s of summary) lines.push(`| ${s.label} | ${f(s.parse.median)} / ${f(s.parse.p95)} | ${f(s.tree.median)} / ${f(s.tree.p95)} | ${f(s.extract.median)} / ${f(s.extract.p95)} | ${f(s.markdown.median)} / ${f(s.markdown.p95)} |`);
lines.push('', 'Parse: TypeScript uses Chromium\'s native parser, Dart package:html, Go its own HTML5 parser. Tree: `fromDom` / `fromDocument` / `FromTree`, the compact copy the engine runs on.');
lines.push('', '## Memory per page', '');
lines.push('| engine | median MB | p90 | p95 | max | pages under 5 MB | process peak RSS | what is measured |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
for (const s of summary) {
  const m = s.memoryMB;
  const rss = s.maxRss ? `${(s.maxRss / (1 << 20)).toFixed(1)} MB` : '–';
  lines.push(m ? `| ${s.label} | ${m.median.toFixed(2)} | ${m.p90.toFixed(2)} | ${m.p95.toFixed(2)} | ${m.max.toFixed(1)} | ${s.under5MB}/${s.pages} | ${rss} | ${s.memoryNote} |` : `| ${s.label} | – | – | – | – | – | ${rss} | ${s.memoryNote} |`);
}
lines.push('', '## Whole pipeline by HTML size (median / p95)', '');
lines.push(`| engine | ${BUCKETS.map(([name]) => `${name} (${summary[0]?.byBucket[name]?.pages ?? 0})`).join(' | ')} |`, `| --- |${' ---: |'.repeat(BUCKETS.length)}`);
for (const s of summary) lines.push(`| ${s.label} | ${BUCKETS.map(([name]) => (s.byBucket[name] ? `${f(s.byBucket[name]!.median)} / ${f(s.byBucket[name]!.p95)}` : '–')).join(' | ')} |`);
if (Object.keys(speedups).length) {
  lines.push('', '## Go speedup per page (other engine total / Go total)', '');
  lines.push('| vs | median | p10 | p90 |', '| --- | ---: | ---: | ---: |');
  for (const [engine, s] of Object.entries(speedups)) lines.push(`| ${engine === 'ts' ? 'TypeScript' : 'Dart'} | ${s.median.toFixed(1)}x | ${s.p10.toFixed(1)}x | ${s.p90.toFixed(1)}x |`);
}
await Bun.write(resolve(EVAL_DIR, 'results/benchmark.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
