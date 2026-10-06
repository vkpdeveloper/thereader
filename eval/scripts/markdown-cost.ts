// What `markdown: true` adds to extraction, in Chromium. For every page, `extract`
// runs with and without the option in the same renderer, alternating which goes
// first, `--runs` times each; the per-page medians are compared. Unlike two
// engines in one `bun run eval`, the pair shares warm-up state and machine load,
// so the difference is the export's cost and nothing else.
// bun run markdown-cost [--dataset zyte|curated|all] [--runs 21] [--workers 4] [--ids id,id]
import { cpus, loadavg, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BrowserPool } from '../src/browser';
import { type Dataset, type Doc, EVAL_DIR, loadCurated, loadCuratedDocs, loadZyte } from '../src/corpus';
import { median, percentile } from '../src/score';
import { ensureZyte } from '../src/zyte';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    dataset: { type: 'string', default: 'all' },
    runs: { type: 'string', default: '21' },
    workers: { type: 'string', default: '4' },
    ids: { type: 'string' },
  },
});
const datasets: Dataset[] = values.dataset === 'all' ? ['zyte', 'curated'] : [values.dataset as Dataset];
const runs = Number(values.runs);
const only = values.ids ? new Set(values.ids.split(',')) : undefined;

const docs: Doc[] = [];
if (datasets.includes('zyte')) {
  await ensureZyte();
  docs.push(...(await loadZyte()).docs);
}
if (datasets.includes('curated')) docs.push(...(await loadCuratedDocs(await loadCurated())));
const selected = only ? docs.filter((d) => only.has(d.id)) : docs;
const start = loadavg().map((l) => l.toFixed(1)).join(' ');
console.log(`${selected.length} pages, ${runs} alternating runs each, ${values.workers} workers, load ${start}`);

const pool = await BrowserPool.open(Number(values.workers));
const rows = await pool.map(selected, async (worker, doc) => {
  await pool.call(worker, 'load', [doc.html, doc.url]);
  const { plain, markdown } = await pool.call(worker, 'timeMarkdown', [runs]);
  return { id: `${doc.dataset}/${doc.id}`, plain: median(plain), markdown: median(markdown) };
});
await pool.close();

const ms = (v: number) => v.toFixed(3);
const plain = rows.map((r) => r.plain);
const markdown = rows.map((r) => r.markdown);
const delta = rows.map((r) => r.markdown - r.plain);
const share = rows.map((r) => (r.markdown - r.plain) / r.plain);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const line = (label: string, xs: number[]) => `| ${label} | ${ms(median(xs))} | ${ms(percentile(xs, 0.9))} | ${ms(percentile(xs, 0.95))} | ${ms(mean(xs))} |`;
const largest = [...rows].sort((a, b) => b.markdown - b.plain - (a.markdown - a.plain)).slice(0, 5);
const report = `# Cost of the Markdown export

Generated ${new Date().toISOString()} by \`bun run markdown-cost\` (see [eval/README.md](../README.md)): \`extract(doc, { url })\` and \`extract(doc, { url, markdown: true })\` on each of ${rows.length} pages (${datasets.join(' + ')}) in headless Chromium, in the same renderer, alternating which runs first, ${runs} runs each after one warm-up; a fresh \`DOMParser\` document per run, parsing not timed. Milliseconds, over the per-page medians.

Machine: ${platform()} ${release()}, ${cpus()[0]?.model} x${cpus().length}, load avg at start ${start}, at end ${loadavg().map((l) => l.toFixed(1)).join(' ')}, ${values.workers} workers.

| extract | median | p90 | p95 | mean |
| --- | ---: | ---: | ---: | ---: |
${line('without markdown', plain)}
${line('markdown: true', markdown)}
${line('per-page difference', delta)}

Per-page difference as a share of extraction: median ${(median(share) * 100).toFixed(1)}%, p90 ${(percentile(share, 0.9) * 100).toFixed(1)}%.

Largest per-page differences:

| page | without | with |
| --- | ---: | ---: |
${largest.map((r) => `| ${r.id} | ${ms(r.plain)} | ${ms(r.markdown)} |`).join('\n')}
`;
console.log(report);
if (only === undefined) await Bun.write(resolve(EVAL_DIR, 'results', 'markdown-cost.md'), report);
