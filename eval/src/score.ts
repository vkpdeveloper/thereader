import type { CuratedEntry } from './corpus';
import { accuracyScore, f1Score, precisionScore, recallScore, shingleMatch } from './metric';
import type { Stats } from './page';
import { canonicalLanguage, matchKey } from './text';

export const ENGINES = ['ours', 'readability', 'defuddle', 'trafilatura', 'postlight'] as const;
export type EngineName = (typeof ENGINES)[number];

/** One engine's output for one page, as stored in `test-corpus/eval-out/` (with text). */
export interface DocOutput {
  id: string;
  ok: boolean;
  error?: string;
  title: string;
  text: string;
  stats: Stats;
  blockTypes?: Record<string, number>;
  bytes: number;
  /** Medians over the timed runs; `parseMs` is null when the engine cannot separate parsing. */
  parseMs: number | null;
  extractMs: number | null;
  totalMs: number | null;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export const mean = (values: number[]) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0);

export const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

export interface ZyteDocScore {
  id: string;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  tp: number;
  fp: number;
  fn: number;
  chars: number;
}

export function scoreZyteDoc(id: string, truth: string, output: DocOutput): ZyteDocScore {
  const row = shingleMatch(truth, output.text);
  return {
    id,
    precision: round(precisionScore(row)),
    recall: round(recallScore(row)),
    f1: round(f1Score(row)),
    accuracy: accuracyScore(truth, output.text),
    tp: row[0],
    fp: row[1],
    fn: row[2],
    chars: output.text.length,
  };
}

export const STRUCTURE_CHECKS = ['code', 'languages', 'images', 'headings', 'tables', 'math', 'footnotes', 'embeds'] as const;
export type StructureCheck = (typeof STRUCTURE_CHECKS)[number];

export interface CuratedDocScore {
  id: string;
  tier: number;
  category: string;
  language: string;
  jsOnly: boolean;
  includeRecall: number;
  missing: number[];
  leaks: number[];
  /** Null when the page has no boilerplate text to leak. */
  leakRate: number | null;
  titleExact: boolean;
  titleFuzzy: boolean;
  structure: Partial<Record<StructureCheck, boolean>>;
  structurePass: number | null;
  /** Share of the expected code languages the engine reported. */
  languageRecall: number | null;
  combined: number;
  chars: number;
}

function words(text: string): Set<string> {
  return new Set(text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Exact after normalization; fuzzy when one title contains the other (e.g. a site suffix) or the word sets mostly agree. */
export function titleMatch(expected: string, actual: string): { exact: boolean; fuzzy: boolean } {
  const a = matchKey(expected);
  const b = matchKey(actual);
  if (!b) return { exact: false, fuzzy: false };
  if (a === b) return { exact: true, fuzzy: true };
  if ((b.includes(a) && a.length >= b.length * 0.4) || (a.includes(b) && b.length >= a.length * 0.6)) return { exact: false, fuzzy: true };
  const x = words(expected);
  const y = words(actual);
  const shared = [...x].filter((w) => y.has(w)).length;
  return { exact: false, fuzzy: shared / Math.max(1, new Set([...x, ...y]).size) >= 0.8 };
}

/** Weights of the curated combined score; components missing for a page are dropped and the rest renormalized. */
export const COMBINED_WEIGHTS = { include: 0.5, exclude: 0.2, title: 0.1, structure: 0.2 };

export function scoreCuratedDoc(entry: CuratedEntry, output: DocOutput): CuratedDocScore {
  const text = matchKey(output.text);
  const missing = entry.mustInclude.flatMap((s, i) => (text.includes(matchKey(s)) ? [] : [i]));
  const leaks = entry.mustExclude.flatMap((s, i) => (text.includes(matchKey(s)) ? [i] : []));
  const { exact, fuzzy } = titleMatch(entry.title, output.title);
  const stats = output.stats;
  const structure: Partial<Record<StructureCheck, boolean>> = {};
  let languageRecall: number | null = null;
  if (entry.minCodeBlocks) structure.code = stats.codeBlocks >= entry.minCodeBlocks;
  if (entry.codeLanguages?.length) {
    const expected = [...new Set(entry.codeLanguages.map(canonicalLanguage).filter((l): l is string => !!l))];
    const found = new Set(stats.codeLanguages.map(canonicalLanguage));
    languageRecall = expected.length ? expected.filter((l) => found.has(l)).length / expected.length : null;
    if (languageRecall !== null) structure.languages = languageRecall === 1;
  }
  if (entry.minImages) structure.images = stats.images >= entry.minImages;
  if (entry.minHeadings) structure.headings = stats.headings >= entry.minHeadings;
  if (entry.minTables) structure.tables = stats.tables >= entry.minTables;
  if (entry.hasMath) structure.math = stats.math > 0;
  if (entry.hasFootnotes) structure.footnotes = stats.footnotes + stats.footnoteRefs > 0;
  if (entry.hasEmbeds) structure.embeds = stats.embeds > 0;
  const checks = Object.values(structure);
  const structurePass = checks.length ? checks.filter(Boolean).length / checks.length : null;
  const includeRecall = (entry.mustInclude.length - missing.length) / entry.mustInclude.length;
  const leakRate = entry.mustExclude.length ? leaks.length / entry.mustExclude.length : null;
  const parts: [number, number][] = [
    [COMBINED_WEIGHTS.include, includeRecall],
    [COMBINED_WEIGHTS.title, fuzzy ? 1 : 0],
  ];
  if (leakRate !== null) parts.push([COMBINED_WEIGHTS.exclude, text ? 1 - leakRate : 0]);
  if (structurePass !== null) parts.push([COMBINED_WEIGHTS.structure, structurePass]);
  const combined = parts.reduce((sum, [w, v]) => sum + w * v, 0) / parts.reduce((sum, [w]) => sum + w, 0);
  return {
    id: entry.id,
    tier: entry.tier,
    category: entry.category,
    language: entry.language,
    jsOnly: !!entry.jsOnly,
    includeRecall: round(includeRecall),
    missing,
    leaks,
    leakRate: leakRate === null ? null : round(leakRate),
    titleExact: exact,
    titleFuzzy: fuzzy,
    structure,
    structurePass: structurePass === null ? null : round(structurePass),
    languageRecall: languageRecall === null ? null : round(languageRecall),
    combined: round(combined),
    chars: output.text.length,
  };
}

export interface CuratedAggregate {
  docs: number;
  includeRecall: number;
  leakRate: number;
  /** Share of pages leaking at least one mustExclude snippet. */
  docsLeaking: number;
  titleExact: number;
  titleFuzzy: number;
  structurePass: number;
  checks: Partial<Record<StructureCheck, { pass: number; total: number }>>;
  languageRecall: number | null;
  combined: number;
}

export function aggregateCurated(scores: CuratedDocScore[]): CuratedAggregate {
  const checks: CuratedAggregate['checks'] = {};
  for (const score of scores) {
    for (const [name, pass] of Object.entries(score.structure) as [StructureCheck, boolean][]) {
      const check = (checks[name] ??= { pass: 0, total: 0 });
      check.total++;
      if (pass) check.pass++;
    }
  }
  const structure = Object.values(checks);
  const languages = scores.flatMap((s) => (s.languageRecall === null ? [] : [s.languageRecall]));
  const leakable = scores.filter((s) => s.leakRate !== null);
  return {
    docs: scores.length,
    includeRecall: round(mean(scores.map((s) => s.includeRecall))),
    leakRate: round(mean(leakable.map((s) => s.leakRate!))),
    docsLeaking: round(mean(leakable.map((s) => (s.leaks.length ? 1 : 0)))),
    titleExact: round(mean(scores.map((s) => (s.titleExact ? 1 : 0)))),
    titleFuzzy: round(mean(scores.map((s) => (s.titleFuzzy ? 1 : 0)))),
    structurePass: round(structure.reduce((sum, c) => sum + c.pass, 0) / Math.max(1, structure.reduce((sum, c) => sum + c.total, 0))),
    checks,
    languageRecall: languages.length ? round(mean(languages)) : null,
    combined: round(mean(scores.map((s) => s.combined))),
  };
}

export interface PerfAggregate {
  docs: number;
  failed: number;
  parse: { median: number; p95: number; mean: number } | null;
  extract: { median: number; p95: number; mean: number };
  total: { median: number; p95: number; mean: number };
  /** Median total ms per HTML size bucket. */
  bySize: Record<string, { docs: number; median: number; p95: number }>;
}

export const SIZE_BUCKETS: [string, number][] = [
  ['<50KB', 50_000],
  ['50-200KB', 200_000],
  ['200-500KB', 500_000],
  ['0.5-1MB', 1_000_000],
  ['>1MB', Infinity],
];

const summary = (values: number[]) => ({ median: round(median(values), 3), p95: round(percentile(values, 0.95), 3), mean: round(mean(values), 3) });

export function aggregatePerf(outputs: DocOutput[]): PerfAggregate | null {
  const timed = outputs.filter((o) => o.ok && o.totalMs !== null);
  if (timed.length === 0) return null;
  const parses = timed.flatMap((o) => (o.parseMs === null ? [] : [o.parseMs]));
  const bySize: PerfAggregate['bySize'] = {};
  let lower = 0;
  for (const [label, upper] of SIZE_BUCKETS) {
    const values = timed.filter((o) => o.bytes >= lower && o.bytes < upper).map((o) => o.totalMs!);
    if (values.length) bySize[label] = { docs: values.length, median: round(median(values), 3), p95: round(percentile(values, 0.95), 3) };
    lower = upper;
  }
  return {
    docs: timed.length,
    failed: outputs.length - timed.length,
    parse: parses.length ? summary(parses) : null,
    extract: summary(timed.map((o) => o.extractMs!)),
    total: summary(timed.map((o) => o.totalMs!)),
    bySize,
  };
}
