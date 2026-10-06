import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ZYTE_DIR } from './corpus';
import { ZYTE_PUBLISHED, accuracyScore, evaluate, shingleMatch, type ZyteMetrics } from './metric';

/** scrapinghub/article-extraction-benchmark, pinned. */
export const ZYTE_COMMIT = '4a3bc979f76c0df73cb95fe272e2fc1b96f9f010';

/** Downloads the benchmark's pages, ground truth and the two reference outputs used for the metric check. */
export async function ensureZyte(): Promise<void> {
  if (existsSync(resolve(ZYTE_DIR, 'ground-truth.json'))) return;
  await mkdir(ZYTE_DIR, { recursive: true });
  const url = `https://codeload.github.com/scrapinghub/article-extraction-benchmark/tar.gz/${ZYTE_COMMIT}`;
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Zyte download failed: ${response.status}`);
  const prefix = `article-extraction-benchmark-${ZYTE_COMMIT}`;
  const tar = Bun.spawn(
    ['tar', '-xzf', '-', '--strip-components=1', '-C', ZYTE_DIR, `${prefix}/html`, `${prefix}/ground-truth.json`, ...Object.keys(ZYTE_PUBLISHED).map((name) => `${prefix}/output/${name}.json`)],
    { stdin: new Uint8Array(await response.arrayBuffer()), stderr: 'pipe' },
  );
  if (await tar.exited) throw new Error(await new Response(tar.stderr).text());
}

export interface MetricCheck {
  name: string;
  version: string;
  published: { f1: number; precision: number; recall: number; accuracy: number };
  computed: ZyteMetrics;
  maxAbsDiff: number;
}

/**
 * Re-scores the benchmark's own committed outputs with our port of the metric
 * and compares against the README table: the port is right when every number
 * matches to the published 3 decimals.
 */
export async function checkMetric(truth: Record<string, { articleBody: string }>): Promise<MetricCheck[]> {
  const checks: MetricCheck[] = [];
  for (const [name, published] of Object.entries(ZYTE_PUBLISHED)) {
    const file = resolve(ZYTE_DIR, 'output', `${name}.json`);
    if (!existsSync(file)) continue;
    const data = await Bun.file(file).json();
    const output: Record<string, { articleBody?: string | null }> = data.output ?? data;
    const ids = Object.keys(truth);
    const rows = ids.map((id) => shingleMatch(truth[id].articleBody ?? '', output[id]?.articleBody ?? ''));
    const accuracies = ids.map((id) => accuracyScore(truth[id].articleBody ?? '', output[id]?.articleBody ?? ''));
    const computed = evaluate(rows, accuracies);
    const keys = ['f1', 'precision', 'recall', 'accuracy'] as const;
    const maxAbsDiff = Math.max(...keys.map((k) => Math.abs(Number(computed[k].toFixed(3)) - published[k])));
    checks.push({ name, version: data.version ?? published.version, published: { f1: published.f1, precision: published.precision, recall: published.recall, accuracy: published.accuracy }, computed, maxAbsDiff });
  }
  return checks;
}
