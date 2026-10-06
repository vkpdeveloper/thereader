// Runs the extraction engines over the datasets, stores raw outputs under
// test-corpus/eval-out/ and re-derives eval/results/latest.json and eval/RESULTS.md.
// bun run eval [--engines ours,readability,defuddle,trafilatura,postlight] [--dataset zyte|curated|all]
//              [--runs 5] [--workers 4] [--ids id,id] [--timeout 60]
import { mkdir, rm } from 'node:fs/promises';
import { cpus, loadavg, platform, release, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BrowserPool, TimeoutError } from '../src/browser';
import { type Dataset, type Doc, EVAL_DIR, OUTPUT_DIR, ROOT, loadCurated, loadCuratedDocs, loadZyte } from '../src/corpus';
import type { BrowserEngine, EngineRun, Stats } from '../src/page';
import { type EngineInfo, type OutputFile, outputPath, writeResults } from '../src/results';
import { type DocOutput, ENGINES, type EngineName, median } from '../src/score';
import { normalizeText } from '../src/text';
import { ensureZyte } from '../src/zyte';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    engines: { type: 'string', default: ENGINES.join(',') },
    dataset: { type: 'string', default: 'all' },
    runs: { type: 'string', default: '5' },
    workers: { type: 'string', default: '4' },
    ids: { type: 'string' },
    timeout: { type: 'string', default: '60' },
  },
});
const engines = values.engines.split(',') as EngineName[];
for (const engine of engines) if (!ENGINES.includes(engine)) throw new Error(`Unknown engine ${engine}; use ${ENGINES.join(',')}`);
const datasets: Dataset[] = values.dataset === 'all' ? ['zyte', 'curated'] : [values.dataset as Dataset];
if (!datasets.every((d) => d === 'zyte' || d === 'curated')) throw new Error('--dataset is zyte, curated or all');
const runs = Number(values.runs);
const workers = Number(values.workers);
const timeoutMs = Number(values.timeout) * 1000;
const only = values.ids ? new Set(values.ids.split(',')) : undefined;
const started = performance.now();

const docs: Doc[] = [];
if (datasets.includes('zyte')) {
  await ensureZyte();
  docs.push(...(await loadZyte()).docs);
}
if (datasets.includes('curated')) docs.push(...(await loadCuratedDocs(await loadCurated())));
const selected = only ? docs.filter((d) => only.has(d.id)) : docs;
if (selected.length === 0) throw new Error('No documents selected');
console.log(`${selected.length} docs (${datasets.join(' + ')}), engines ${engines.join(', ')}, ${runs} timed runs, ${workers} workers`);

const outputs = new Map<string, DocOutput>();
const key = (engine: EngineName, doc: Doc) => `${engine}/${doc.dataset}/${doc.id}`;
const emptyStats: Stats = { codeBlocks: 0, codeLanguages: [], images: 0, headings: 0, tables: 0, lists: 0, math: 0, footnotes: 0, footnoteRefs: 0, embeds: 0 };

function toOutput(doc: Doc, run: EngineRun & { summary?: { title: string; text: string; stats: Stats; blockTypes?: Record<string, number> } }): DocOutput {
  const timed = run.ok && run.extractMs.length > 0;
  const totals = run.extractMs.map((v, i) => v + (run.parseMs[i] ?? 0));
  return {
    id: doc.id,
    ok: run.ok,
    ...(run.error ? { error: run.error } : {}),
    title: run.summary?.title ?? '',
    text: run.summary?.text ?? '',
    stats: run.summary?.stats ?? emptyStats,
    ...(run.summary?.blockTypes ? { blockTypes: run.summary.blockTypes } : {}),
    bytes: doc.bytes,
    parseMs: timed && run.parseMs.length ? median(run.parseMs) : null,
    extractMs: timed ? median(run.extractMs) : null,
    totalMs: timed ? median(totals) : null,
  };
}

const browserEngines = engines.filter((e): e is BrowserEngine => e === 'ours' || e === 'readability' || e === 'defuddle');
const external = engines.filter((e) => e === 'trafilatura' || e === 'postlight');
const pool = await BrowserPool.open(workers);
const environment: Record<string, string> = {
  os: `${platform()} ${release()}`,
  cpu: `${cpus()[0]?.model ?? 'unknown'} x${cpus().length}`,
  chromium: pool.version(),
  bun: Bun.version,
  'load avg at start': loadavg().map((l) => l.toFixed(1)).join(' '),
};

if (browserEngines.length) {
  let done = 0;
  await pool.map(selected, async (worker, doc) => {
    await pool.call(worker, 'load', [doc.html, doc.url]);
    for (const engine of browserEngines) {
      let run: EngineRun;
      try {
        run = await pool.call(worker, 'runEngine', [engine, runs], timeoutMs);
      } catch (error) {
        run = { ok: false, error: error instanceof TimeoutError ? error.message : String(error), parseMs: [], extractMs: [] };
        if (error instanceof TimeoutError) await pool.call(worker, 'load', [doc.html, doc.url]);
      }
      if (!run.ok) console.log(`  ${engine} failed on ${doc.dataset}/${doc.id}: ${run.error}`);
      outputs.set(key(engine, doc), toOutput(doc, run));
    }
    if (++done % 50 === 0) console.log(`  chromium ${done}/${selected.length} (${((performance.now() - started) / 1000).toFixed(0)}s)`);
  });
  console.log(`chromium engines done in ${((performance.now() - started) / 1000).toFixed(1)}s`);
}

const versions: Partial<Record<EngineName, string>> = {};
if (external.length) {
  const work = resolve(OUTPUT_DIR, 'work');
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const manifest = await Promise.all(
    selected.map(async (doc, i) => {
      const path = resolve(work, `${i}.html`);
      await Bun.write(path, doc.html);
      return { id: String(i), path, url: doc.url };
    }),
  );
  const manifestPath = resolve(work, 'manifest.json');
  await Bun.write(manifestPath, JSON.stringify(manifest));
  const spawn = async (cmd: string[], cwd: string) => {
    const child = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'pipe' });
    const stderr = await new Response(child.stderr).text();
    if (await child.exited) throw new Error(`${cmd.join(' ')} failed:\n${stderr}`);
  };
  type ExternalResult = { ok: boolean; error?: string; text?: string; title?: string; html?: string; stats?: Stats; parseMs: number[]; extractMs: number[] };
  const collect = async (engine: EngineName, files: string[]) => {
    const results: [Doc, ExternalResult][] = [];
    for (const file of files) {
      const data: { version: string; results: Record<string, ExternalResult> } = await Bun.file(file).json();
      versions[engine] = data.version;
      for (const [id, result] of Object.entries(data.results)) results.push([selected[Number(id)], result]);
    }
    await pool.map(results, async (worker, [doc, result]) => {
      const summary = result.html !== undefined ? await pool.call(worker, 'summarizeHtml', [result.html, result.title ?? '']) : undefined;
      const text = summary?.text ?? normalizeText(result.text ?? '');
      outputs.set(key(engine, doc), toOutput(doc, { ...result, summary: { title: result.title ?? '', text, stats: result.stats ?? summary?.stats ?? emptyStats } }));
    });
  };
  if (external.includes('trafilatura')) {
    const t = performance.now();
    const out = resolve(work, 'trafilatura.json');
    await spawn(['uv', 'run', '--quiet', 'python', 'run_trafilatura.py', manifestPath, out, '--runs', String(runs), '--workers', String(workers)], resolve(EVAL_DIR, 'python'));
    await collect('trafilatura', [out]);
    console.log(`trafilatura done in ${((performance.now() - t) / 1000).toFixed(1)}s`);
  }
  if (external.includes('postlight')) {
    const t = performance.now();
    const files = Array.from({ length: workers }, (_, i) => resolve(work, `postlight-${i}.json`));
    await Promise.all(files.map((out, i) => spawn(['node', '--no-deprecation', 'run_postlight.mjs', manifestPath, out, '--runs', String(runs), '--shard', `${i}/${workers}`], resolve(EVAL_DIR, 'node'))));
    await collect('postlight', files);
    console.log(`postlight done in ${((performance.now() - t) / 1000).toFixed(1)}s`);
  }
}
await pool.close();
environment['load avg at end'] = loadavg().map((l) => l.toFixed(1)).join(' ');

async function oursVersion(): Promise<string> {
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: ROOT }).stdout.toString().trim();
  const dirty = git('status', '--porcelain', '--', 'packages/extract').length > 0;
  return `${git('rev-parse', '--short', 'HEAD')}${dirty ? '+dirty' : ''}`;
}

async function packageVersion(name: string): Promise<string> {
  return (await Bun.file(resolve(EVAL_DIR, 'node_modules', name, 'package.json')).json()).version;
}

const info: Record<EngineName, () => Promise<EngineInfo>> = {
  ours: async () => ({ version: await oursVersion(), runtime: 'Chromium DOMParser', settings: 'extract(doc, { url }); text = articleText(article)' }),
  readability: async () => ({ version: await packageVersion('@mozilla/readability'), runtime: 'Chromium DOMParser', settings: 'new Readability(doc).parse() defaults; text from content HTML' }),
  defuddle: async () => ({ version: await packageVersion('defuddle'), runtime: 'Chromium DOMParser', settings: 'new Defuddle(doc, { url }).parse(), core bundle defaults; text from content HTML' }),
  trafilatura: async () => ({ version: versions.trafilatura ?? '?', runtime: 'CPython 3.12 + lxml', settings: 'extract(tree, url, include_comments=False), txt output; stats from xml output' }),
  postlight: async () => ({ version: versions.postlight ?? (await packageVersion('@postlight/parser')), runtime: `Node ${Bun.spawnSync(['node', '--version']).stdout.toString().trim()}`, settings: 'Parser.parse(url, { html, fetchAllPages: false }); text from content HTML' }),
};

if (only) {
  for (const doc of selected) {
    for (const engine of engines) {
      const o = outputs.get(key(engine, doc));
      console.log(`${doc.dataset}/${doc.id} ${engine.padEnd(11)} ${o?.ok ? 'ok ' : 'ERR'} ${String(o?.text.length ?? 0).padStart(7)} chars  ${o?.totalMs?.toFixed(2) ?? '–'} ms  ${o?.error ?? ''}`);
    }
  }
  console.log('--ids run: outputs not saved');
} else {
  for (const dataset of datasets) {
    for (const engine of engines) {
      const file: OutputFile = {
        engine,
        ...(await info[engine]()),
        ranAt: new Date().toISOString(),
        runs,
        workers,
        environment,
        docs: selected.filter((d) => d.dataset === dataset).map((d) => outputs.get(key(engine, d))!),
      };
      await mkdir(resolve(OUTPUT_DIR, dataset), { recursive: true });
      await Bun.write(outputPath(dataset, engine), JSON.stringify(file));
    }
  }
  const latest = await writeResults();
  for (const [engine, r] of Object.entries(latest.zyte?.engines ?? {})) {
    console.log(`zyte    ${engine.padEnd(11)} F1 ${r.metrics.f1.toFixed(3)}  P ${r.metrics.precision.toFixed(3)}  R ${r.metrics.recall.toFixed(3)}  acc ${r.metrics.accuracy.toFixed(3)}`);
  }
  for (const [engine, r] of Object.entries(latest.curated?.engines ?? {})) {
    console.log(`curated ${engine.padEnd(11)} combined ${r.overall.combined.toFixed(3)}  include ${r.overall.includeRecall.toFixed(3)}  leak ${r.overall.leakRate.toFixed(3)}  pages ${r.overall.docs}`);
  }
  console.log(`wrote eval/results/latest.json and eval/RESULTS.md; raw outputs in ${OUTPUT_DIR} (report: bun run report -> ${tmpdir()})`);
}
console.log(`total ${((performance.now() - started) / 1000).toFixed(1)}s`);
