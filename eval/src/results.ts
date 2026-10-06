import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CURATED_PATH, type CuratedEntry, EVAL_DIR, OUTPUT_DIR, ZYTE_DIR, loadCurated, type ZyteTruth } from './corpus';
import { type ZyteMetrics, evaluate } from './metric';
import {
  type CuratedAggregate,
  type CuratedDocScore,
  type DocOutput,
  ENGINES,
  type EngineName,
  type PerfAggregate,
  type ZyteDocScore,
  aggregateCurated,
  aggregatePerf,
  COMBINED_WEIGHTS,
  round,
  scoreCuratedDoc,
  scoreZyteDoc,
  SIZE_BUCKETS,
  STRUCTURE_CHECKS,
} from './score';
import { type MetricCheck, ZYTE_COMMIT, checkMetric } from './zyte';

export const LATEST_PATH = resolve(EVAL_DIR, 'results/latest.json');
export const RESULTS_MD_PATH = resolve(EVAL_DIR, 'RESULTS.md');

export interface EngineInfo {
  version: string;
  runtime: string;
  settings: string;
}

/** `test-corpus/eval-out/<dataset>/<engine>.json`: one engine's raw outputs (with text) for one dataset. */
export interface OutputFile extends EngineInfo {
  engine: EngineName;
  ranAt: string;
  runs: number;
  workers: number;
  environment: Record<string, string>;
  docs: DocOutput[];
}

export function outputPath(dataset: string, engine: string): string {
  return resolve(OUTPUT_DIR, dataset, `${engine}.json`);
}

export async function readOutputs(dataset: string): Promise<Partial<Record<EngineName, OutputFile>>> {
  const files: Partial<Record<EngineName, OutputFile>> = {};
  for (const engine of ENGINES) {
    const path = outputPath(dataset, engine);
    if (existsSync(path)) files[engine] = await Bun.file(path).json();
  }
  return files;
}

export interface Latest {
  generatedAt: string;
  engines: Partial<Record<EngineName, EngineInfo & { ranAt: string; runs: number; workers: number; environment: Record<string, string> }>>;
  zyte?: {
    source: string;
    docs: number;
    metricCheck: MetricCheck[];
    engines: Partial<Record<EngineName, { metrics: ZyteMetrics; failed: number; empty: number; perf: PerfAggregate | null; docs: Omit<ZyteDocScore, 'tp' | 'fp' | 'fn'>[] }>>;
  };
  curated?: {
    entries: number;
    docs: number;
    jsOnly: string[];
    blocked: number;
    weights: typeof COMBINED_WEIGHTS;
    engines: Partial<
      Record<
        EngineName,
        {
          overall: CuratedAggregate;
          jsOnly: CuratedAggregate | null;
          byTier: Record<string, CuratedAggregate>;
          byCategory: Record<string, CuratedAggregate>;
          failed: number;
          empty: number;
          perf: PerfAggregate | null;
          docs: CuratedDocScore[];
        }
      >
    >;
  };
  perf: Partial<Record<EngineName, PerfAggregate>>;
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) (groups[key(item)] ??= []).push(item);
  return groups;
}

/** Re-derives every score from the stored outputs, so re-annotating the corpus needs no re-run. */
export async function buildResults(): Promise<Latest> {
  const latest: Latest = { generatedAt: new Date().toISOString(), engines: {}, perf: {} };
  const allOutputs: Partial<Record<EngineName, DocOutput[]>> = {};
  const note = (engine: EngineName, file: OutputFile) => {
    const { version, runtime, settings, ranAt, runs, workers, environment } = file;
    const current = latest.engines[engine];
    if (!current || current.ranAt < ranAt) latest.engines[engine] = { version, runtime, settings, ranAt, runs, workers, environment };
    (allOutputs[engine] ??= []).push(...file.docs);
  };

  const zyteOutputs = await readOutputs('zyte');
  if (Object.keys(zyteOutputs).length && existsSync(resolve(ZYTE_DIR, 'ground-truth.json'))) {
    const truth: Record<string, ZyteTruth> = await Bun.file(resolve(ZYTE_DIR, 'ground-truth.json')).json();
    latest.zyte = {
      source: `scrapinghub/article-extraction-benchmark@${ZYTE_COMMIT.slice(0, 7)}`,
      docs: Object.keys(truth).length,
      metricCheck: await checkMetric(truth),
      engines: {},
    };
    for (const [engine, file] of Object.entries(zyteOutputs) as [EngineName, OutputFile][]) {
      note(engine, file);
      const byId = new Map(file.docs.map((d) => [d.id, d]));
      const ids = Object.keys(truth).filter((id) => byId.has(id));
      const scores = ids.map((id) => scoreZyteDoc(id, truth[id].articleBody ?? '', byId.get(id)!));
      latest.zyte.engines[engine] = {
        metrics: evaluate(
          scores.map((s) => [s.tp, s.fp, s.fn]),
          scores.map((s) => s.accuracy),
        ),
        failed: file.docs.filter((d) => !d.ok).length,
        empty: file.docs.filter((d) => d.ok && !d.text).length,
        perf: aggregatePerf(file.docs),
        docs: scores.map(({ tp: _tp, fp: _fp, fn: _fn, ...rest }) => rest),
      };
    }
  }

  const curatedOutputs = await readOutputs('curated');
  if (Object.keys(curatedOutputs).length && existsSync(CURATED_PATH)) {
    const entries = await loadCurated();
    const blocked = existsSync(resolve(EVAL_DIR, 'corpus/blocked.json')) ? (await Bun.file(resolve(EVAL_DIR, 'corpus/blocked.json')).json()).length : 0;
    const byId = new Map(entries.map((e) => [e.id, e]));
    const docIds = new Set(Object.values(curatedOutputs).flatMap((f) => f!.docs.map((d) => d.id)));
    latest.curated = {
      entries: entries.length,
      docs: [...docIds].filter((id) => byId.get(id)?.mustInclude.length).length,
      jsOnly: entries.filter((e) => e.jsOnly && docIds.has(e.id)).map((e) => e.id),
      blocked,
      weights: COMBINED_WEIGHTS,
      engines: {},
    };
    for (const [engine, file] of Object.entries(curatedOutputs) as [EngineName, OutputFile][]) {
      note(engine, file);
      const scores = file.docs.flatMap((d) => {
        const entry = byId.get(d.id);
        return entry && entry.mustInclude.length ? [scoreCuratedDoc(entry as CuratedEntry, d)] : [];
      });
      const real = scores.filter((s) => !s.jsOnly);
      const jsOnly = scores.filter((s) => s.jsOnly);
      const map = (groups: Record<string, CuratedDocScore[]>) =>
        Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, aggregateCurated(v)]));
      latest.curated.engines[engine] = {
        overall: aggregateCurated(real),
        jsOnly: jsOnly.length ? aggregateCurated(jsOnly) : null,
        byTier: map(groupBy(real, (s) => String(s.tier))),
        byCategory: map(groupBy(real, (s) => s.category)),
        failed: file.docs.filter((d) => !d.ok).length,
        empty: file.docs.filter((d) => d.ok && !d.text).length,
        perf: aggregatePerf(file.docs),
        docs: scores,
      };
    }
  }

  for (const [engine, outputs] of Object.entries(allOutputs) as [EngineName, DocOutput[]][]) {
    const perf = aggregatePerf(outputs);
    if (perf) latest.perf[engine] = perf;
  }
  return latest;
}

const pct = (value: number | null | undefined) => (value === null || value === undefined ? '–' : `${(value * 100).toFixed(1)}%`);
const num = (value: number | null | undefined, digits = 3) => (value === null || value === undefined ? '–' : value.toFixed(digits));
const ms = (value: number | null | undefined) => (value === null || value === undefined ? '–' : value < 10 ? value.toFixed(2) : value.toFixed(1));

function table(header: string[], rows: (string | number)[][]): string {
  return [`| ${header.join(' | ')} |`, `| ${header.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

function present<T>(record: Partial<Record<EngineName, T>> | undefined): [EngineName, T][] {
  return ENGINES.flatMap((e) => (record?.[e] ? [[e, record[e]!] as [EngineName, T]] : []));
}

export function renderMarkdown(latest: Latest): string {
  const out: string[] = [
    '# Article extraction eval results',
    '',
    `Generated ${latest.generatedAt} by \`bun run eval\` (see [eval/README.md](README.md)). Scores are re-derived from the stored outputs on every run.`,
    '',
    '## Engines',
    '',
    table(
      ['engine', 'version', 'runtime', 'settings', 'ran at'],
      present(latest.engines).map(([e, info]) => [e, info.version, info.runtime, info.settings, info.ranAt.slice(0, 16).replace('T', ' ')]),
    ),
  ];
  const env = Object.values(latest.engines)[0]?.environment;
  if (env) out.push('', `Machine: ${Object.entries(env).map(([k, v]) => `${k} ${v}`).join(', ')}.`);

  if (latest.zyte) {
    const z = latest.zyte;
    out.push(
      '',
      `## Zyte article-extraction-benchmark (${z.docs} pages, ${z.source})`,
      '',
      'Official metric: 4-token shingle precision/recall per page, averaged; F1 from the averages; accuracy = exact token match. ± is the bootstrap std (1000 resamples), CI the 95% percentile interval of F1.',
      '',
      table(
        ['engine', 'F1', 'F1 95% CI', 'precision', 'recall', 'accuracy', 'failed', 'empty', 'median ms'],
        present(z.engines).map(([e, r]) => [
          e,
          `**${num(r.metrics.f1)}** ± ${num(r.metrics.f1_std)}`,
          `${num(r.metrics.f1_ci[0])}–${num(r.metrics.f1_ci[1])}`,
          `${num(r.metrics.precision)} ± ${num(r.metrics.precision_std)}`,
          `${num(r.metrics.recall)} ± ${num(r.metrics.recall_std)}`,
          `${num(r.metrics.accuracy)} ± ${num(r.metrics.accuracy_std)}`,
          r.failed,
          r.empty,
          ms(r.perf?.total.median),
        ]),
      ),
      '',
      '### Metric sanity check',
      '',
      "Our TypeScript port of `evaluate.py` re-scoring the benchmark's own committed outputs, against its README table:",
      '',
      table(
        ['output file', 'version', 'published F1 / P / R / acc', 'ours F1 / P / R / acc', 'max abs diff'],
        z.metricCheck.map((c) => [
          `output/${c.name}.json`,
          c.version,
          `${c.published.f1.toFixed(3)} / ${c.published.precision.toFixed(3)} / ${c.published.recall.toFixed(3)} / ${c.published.accuracy.toFixed(3)}`,
          `${num(c.computed.f1)} / ${num(c.computed.precision)} / ${num(c.computed.recall)} / ${num(c.computed.accuracy)}`,
          c.maxAbsDiff.toFixed(3),
        ]),
      ),
    );
  }

  if (latest.curated) {
    const c = latest.curated;
    const engines = present(c.engines);
    out.push(
      '',
      `## Curated live corpus (${c.docs} annotated pages with snapshots, of ${c.entries} entries; ${c.jsOnly.length} jsOnly scored separately; ${c.blocked} URLs blocked at fetch time, see corpus/blocked.json)`,
      '',
      `Combined score per page = weighted mean of mustInclude recall (${c.weights.include}), 1 − mustExclude leak rate (${c.weights.exclude}; 0 for empty output; dropped for the few pages with no boilerplate text), fuzzy title match (${c.weights.title}) and structure checks passed (${c.weights.structure}; dropped when a page has no structure expectations).`,
      '',
      table(
        ['engine', 'pages', 'include recall', 'leak rate', 'pages leaking', 'title exact', 'title fuzzy', 'structure', 'code langs', 'combined', 'empty', 'failed'],
        engines.map(([e, r]) => [
          e,
          r.overall.docs,
          pct(r.overall.includeRecall),
          pct(r.overall.leakRate),
          pct(r.overall.docsLeaking),
          pct(r.overall.titleExact),
          pct(r.overall.titleFuzzy),
          pct(r.overall.structurePass),
          pct(r.overall.languageRecall),
          `**${num(r.overall.combined)}**`,
          r.empty,
          r.failed,
        ]),
      ),
      '',
      '### Structure checks (pages passing / pages with the expectation)',
      '',
      table(
        ['engine', ...STRUCTURE_CHECKS],
        engines.map(([e, r]) => [e, ...STRUCTURE_CHECKS.map((k) => (r.overall.checks[k] ? `${r.overall.checks[k]!.pass}/${r.overall.checks[k]!.total}` : '–'))]),
      ),
    );
    const tiers = [...new Set(engines.flatMap(([, r]) => Object.keys(r.byTier)))].sort();
    out.push(
      '',
      '### Combined score by tier',
      '',
      table(
        ['engine', ...tiers.map((t) => `tier ${t} (${engines[0][1].byTier[t]?.docs ?? 0})`)],
        engines.map(([e, r]) => [e, ...tiers.map((t) => num(r.byTier[t]?.combined))]),
      ),
    );
    const categories = [...new Set(engines.flatMap(([, r]) => Object.keys(r.byCategory)))].sort();
    out.push(
      '',
      '### Combined score by category',
      '',
      table(
        ['engine', ...categories.map((k) => `${k} (${engines[0][1].byCategory[k]?.docs ?? 0})`)],
        engines.map(([e, r]) => [e, ...categories.map((k) => num(r.byCategory[k]?.combined))]),
      ),
    );
    if (c.jsOnly.length) out.push('', `jsOnly pages (article not in the raw HTML): ${c.jsOnly.join(', ')}.`);
  }

  const perf = present(latest.perf);
  if (perf.length) {
    out.push(
      '',
      '## Performance (all scored pages, per-page median of the timed runs)',
      '',
      'JS engines run in headless Chromium on a fresh `DOMParser` document per run; ours-dart (the Dart port, AOT-compiled, one process) parses with package:html, timed separately from extraction; Trafilatura in CPython (lxml parse timed separately); Postlight in Node (cheerio parse is internal, so only the total is timed). Cross-runtime numbers are indicative; the three Chromium engines are directly comparable.',
      '',
      table(
        ['engine', 'pages', 'parse median', 'extract median', 'extract p95', 'extract mean', 'total median', 'total p95', 'total mean'],
        perf.map(([e, p]) => [e, p.docs, ms(p.parse?.median), ms(p.extract.median), ms(p.extract.p95), ms(p.extract.mean), ms(p.total.median), ms(p.total.p95), ms(p.total.mean)]),
      ),
      '',
      '### Total ms by HTML size (median / p95)',
      '',
      table(
        ['engine', ...SIZE_BUCKETS.map(([label]) => `${label} (${perf[0][1].bySize[label]?.docs ?? 0})`)],
        perf.map(([e, p]) => [e, ...SIZE_BUCKETS.map(([label]) => (p.bySize[label] ? `${ms(p.bySize[label].median)} / ${ms(p.bySize[label].p95)}` : '–'))]),
      ),
    );
  }
  return `${out.join('\n')}\n`;
}

/** Rounds every float in the summary so the committed JSON stays small and diffable. */
export function compact(value: unknown): unknown {
  if (typeof value === 'number') return Number.isInteger(value) ? value : round(value, 4);
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compact(v)]));
  return value;
}

export async function writeResults(): Promise<Latest> {
  const latest = await buildResults();
  await Bun.write(LATEST_PATH, `${JSON.stringify(compact(latest), null, 1)}\n`);
  await Bun.write(RESULTS_MD_PATH, renderMarkdown(latest));
  return latest;
}
