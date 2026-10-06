// Writes a self-contained dark HTML report to $TMPDIR/extract-eval-report.html
// (and refreshes eval/results/latest.json and eval/RESULTS.md from the stored outputs).
// bun run report
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { type Latest, readOutputs, renderMarkdown, writeResults } from '../src/results';
import { type DocOutput, ENGINES, type EngineName, mean, percentile } from '../src/score';

const COLORS: Record<EngineName, string> = {
  ours: '#38bdf8',
  'ours-md': '#818cf8',
  'ours-dart': '#2dd4bf',
  readability: '#f472b6',
  defuddle: '#a3e635',
  trafilatura: '#fbbf24',
  postlight: '#c084fc',
};

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmt = (v: number, digits = 3) => v.toFixed(digits);
const W = 860;

function svg(height: number, body: string): string {
  return `<svg viewBox="0 0 ${W} ${height}" width="100%" role="img">${body}</svg>`;
}

function legend(engines: EngineName[], y = 14): string {
  return engines
    .map((e, i) => `<rect x="${120 + i * 130}" y="${y - 9}" width="10" height="10" rx="2" fill="${COLORS[e]}"/><text x="${136 + i * 130}" y="${y}" class="label">${e}</text>`)
    .join('');
}

/** Horizontal box plot with every page as a dot. */
function distribution(rows: [EngineName, number[]][], label: string): string {
  const left = 110;
  const right = W - 20;
  const x = (v: number) => left + v * (right - left);
  const rowH = 46;
  let body = '';
  for (let t = 0; t <= 10; t++) {
    const v = t / 10;
    body += `<line x1="${x(v)}" x2="${x(v)}" y1="10" y2="${20 + rows.length * rowH}" class="grid"/><text x="${x(v)}" y="${34 + rows.length * rowH}" class="tick" text-anchor="middle">${v.toFixed(1)}</text>`;
  }
  rows.forEach(([engine, values], i) => {
    const cy = 20 + i * rowH + rowH / 2;
    const sorted = [...values].sort((a, b) => a - b);
    const q = (p: number) => percentile(sorted, p);
    const color = COLORS[engine];
    sorted.forEach((v, j) => {
      body += `<circle cx="${x(v)}" cy="${cy - 12 + ((Math.imul(j + 1, 2654435761) >>> 0) % 24)}" r="2.2" fill="${color}" opacity="0.35"/>`;
    });
    body += `<line x1="${x(q(0.05))}" x2="${x(q(0.95))}" y1="${cy}" y2="${cy}" stroke="${color}" stroke-width="1.5"/>`;
    body += `<rect x="${x(q(0.25))}" y="${cy - 9}" width="${Math.max(1, x(q(0.75)) - x(q(0.25)))}" height="18" fill="${color}" fill-opacity="0.25" stroke="${color}"/>`;
    body += `<line x1="${x(q(0.5))}" x2="${x(q(0.5))}" y1="${cy - 11}" y2="${cy + 11}" stroke="#fff" stroke-width="2"/>`;
    body += `<text x="${left - 10}" y="${cy + 4}" class="label" text-anchor="end">${engine}</text>`;
    body += `<text x="${right}" y="${cy - 14}" class="tick" text-anchor="end">median ${fmt(q(0.5))} · mean ${fmt(mean(values))}</text>`;
  });
  body += `<text x="${(left + right) / 2}" y="${50 + rows.length * rowH}" class="tick" text-anchor="middle">${label}</text>`;
  return svg(60 + rows.length * rowH, body);
}

/** Grouped vertical bars, values in 0..1. */
function groupedBars(groups: string[], series: [EngineName, (number | null)[]][]): string {
  const left = 40;
  const top = 30;
  const h = 220;
  const groupW = (W - left - 10) / groups.length;
  const barW = Math.min(22, (groupW - 12) / series.length);
  const y = (v: number) => top + h - v * h;
  let body = legend(series.map(([e]) => e));
  for (let t = 0; t <= 5; t++) body += `<line x1="${left}" x2="${W - 10}" y1="${y(t / 5)}" y2="${y(t / 5)}" class="grid"/><text x="${left - 6}" y="${y(t / 5) + 4}" class="tick" text-anchor="end">${(t / 5).toFixed(1)}</text>`;
  groups.forEach((group, g) => {
    const x0 = left + g * groupW + (groupW - barW * series.length) / 2;
    series.forEach(([engine, values], s) => {
      const v = values[g];
      if (v === null || v === undefined) return;
      body += `<rect x="${x0 + s * barW}" y="${y(v)}" width="${barW - 2}" height="${h - (y(v) - top)}" fill="${COLORS[engine]}"><title>${engine} ${group}: ${fmt(v)}</title></rect>`;
    });
    body += `<text x="${left + g * groupW + groupW / 2}" y="${top + h + 16}" class="tick" text-anchor="middle">${escape(group)}</text>`;
  });
  return svg(top + h + 30, body);
}

const logScale = (min: number, max: number, a: number, b: number) => (v: number) => a + ((Math.log10(Math.max(v, min)) - Math.log10(min)) / (Math.log10(max) - Math.log10(min))) * (b - a);

/** Median bar with a p95 whisker per engine, log scale. */
function speedBars(rows: [EngineName, { median: number; p95: number; mean: number }][], label: string): string {
  const left = 110;
  const right = W - 250;
  const max = Math.max(...rows.map(([, r]) => r.p95)) * 1.5;
  const x = logScale(0.01, max, left, right);
  const rowH = 34;
  let body = '';
  for (let t = -2; 10 ** t <= max; t++) body += `<line x1="${x(10 ** t)}" x2="${x(10 ** t)}" y1="6" y2="${10 + rows.length * rowH}" class="grid"/><text x="${x(10 ** t)}" y="${24 + rows.length * rowH}" class="tick" text-anchor="middle">${10 ** t >= 1 ? 10 ** t : (10 ** t).toFixed(-t)} ms</text>`;
  rows.forEach(([engine, r], i) => {
    const cy = 10 + i * rowH + rowH / 2;
    body += `<rect x="${left}" y="${cy - 9}" width="${x(r.median) - left}" height="18" fill="${COLORS[engine]}" fill-opacity="0.8"/>`;
    body += `<line x1="${x(r.median)}" x2="${x(r.p95)}" y1="${cy}" y2="${cy}" stroke="${COLORS[engine]}" stroke-width="2"/><line x1="${x(r.p95)}" x2="${x(r.p95)}" y1="${cy - 7}" y2="${cy + 7}" stroke="${COLORS[engine]}" stroke-width="2"/>`;
    body += `<text x="${left - 10}" y="${cy + 4}" class="label" text-anchor="end">${engine}</text>`;
    body += `<text x="${right + 10}" y="${cy + 4}" class="tick">median ${r.median.toFixed(2)} · p95 ${r.p95.toFixed(1)} · mean ${r.mean.toFixed(1)}</text>`;
  });
  body += `<text x="${(left + right) / 2}" y="${42 + rows.length * rowH}" class="tick" text-anchor="middle">${label}</text>`;
  return svg(50 + rows.length * rowH, body);
}

/** Log-log scatter of total ms against HTML size. */
function scatter(points: [EngineName, DocOutput[]][]): string {
  const left = 60;
  const right = W - 20;
  const top = 30;
  const bottom = 330;
  const all = points.flatMap(([, docs]) => docs.filter((d) => d.totalMs !== null));
  const x = logScale(2_000, Math.max(...all.map((d) => d.bytes)) * 1.2, left, right);
  const maxMs = Math.max(...all.map((d) => d.totalMs!)) * 1.5;
  const y = logScale(0.05, maxMs, bottom, top);
  let body = legend(points.map(([e]) => e));
  for (const kb of [2, 10, 50, 200, 1000, 5000]) body += `<line x1="${x(kb * 1000)}" x2="${x(kb * 1000)}" y1="${top}" y2="${bottom}" class="grid"/><text x="${x(kb * 1000)}" y="${bottom + 16}" class="tick" text-anchor="middle">${kb >= 1000 ? `${kb / 1000}MB` : `${kb}KB`}</text>`;
  for (let t = -1; 10 ** t <= maxMs; t++) body += `<line x1="${left}" x2="${right}" y1="${y(10 ** t)}" y2="${y(10 ** t)}" class="grid"/><text x="${left - 6}" y="${y(10 ** t) + 4}" class="tick" text-anchor="end">${10 ** t >= 1 ? 10 ** t : 0.1}</text>`;
  for (const [engine, docs] of points) {
    for (const d of docs) if (d.totalMs !== null) body += `<circle cx="${x(d.bytes)}" cy="${y(d.totalMs)}" r="2.4" fill="${COLORS[engine]}" opacity="0.55"><title>${engine} ${escape(d.id)} ${(d.bytes / 1024).toFixed(0)}KB ${d.totalMs.toFixed(2)}ms</title></circle>`;
  }
  body += `<text x="${(left + right) / 2}" y="${bottom + 34}" class="tick" text-anchor="middle">HTML size (log) vs total ms (log)</text>`;
  return svg(bottom + 44, body);
}

function heatmap(latest: Latest): string {
  const curated = latest.curated;
  if (!curated) return '';
  const engines = ENGINES.filter((e) => curated.engines[e]);
  const byEngine = new Map(engines.map((e) => [e, new Map(curated.engines[e]!.docs.map((d) => [d.id, d]))]));
  const first = curated.engines[engines.includes('ours') ? 'ours' : engines[0]]!.docs;
  const rows = [...first].sort((a, b) => a.combined - b.combined);
  const cell = (v: number) => `<td style="background:hsl(${v * 120},55%,${18 + v * 10}%)">${fmt(v, 2)}</td>`;
  return `<table class="heat"><tr><th>page</th><th>tier</th><th>category</th>${engines.map((e) => `<th>${e}</th>`).join('')}</tr>${rows
    .map((r) => `<tr><td>${escape(r.id)}${r.jsOnly ? ' <span class="muted">jsOnly</span>' : ''}</td><td>${r.tier}</td><td>${escape(r.category)}</td>${engines.map((e) => cell(byEngine.get(e)!.get(r.id)?.combined ?? 0)).join('')}</tr>`)
    .join('')}</table>`;
}

function markdownTables(md: string): string {
  const html: string[] = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i].slice(1, -1).split('|').map((c) => c.trim()));
      i--;
      const cells = (row: string[], tag: string) => row.map((c) => `<${tag}>${escape(c).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</${tag}>`).join('');
      html.push(`<table><tr>${cells(rows[0], 'th')}</tr>${rows.slice(2).map((r) => `<tr>${cells(r, 'td')}</tr>`).join('')}</table>`);
    } else if (line.startsWith('### ')) html.push(`<h3>${escape(line.slice(4))}</h3>`);
    else if (line.startsWith('## ')) html.push(`<h2>${escape(line.slice(3))}</h2>`);
    else if (line.startsWith('# ')) continue;
    else if (line.trim()) html.push(`<p>${escape(line).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')}</p>`);
  }
  return html.join('\n');
}

const latest = await writeResults();
const charts: string[] = [];
if (latest.zyte) {
  const engines = ENGINES.filter((e) => latest.zyte!.engines[e]);
  charts.push(
    '<h2>Zyte benchmark: per-page F1</h2>',
    distribution(engines.map((e) => [e, latest.zyte!.engines[e]!.docs.map((d) => d.f1)]), 'per-page shingle F1'),
    '<h2>Zyte benchmark: aggregate metrics</h2>',
    groupedBars(['F1', 'precision', 'recall', 'accuracy'], engines.map((e) => {
      const m = latest.zyte!.engines[e]!.metrics;
      return [e, [m.f1, m.precision, m.recall, m.accuracy]];
    })),
  );
}
if (latest.curated) {
  const c = latest.curated;
  const engines = ENGINES.filter((e) => c.engines[e]);
  const tiers = [...new Set(engines.flatMap((e) => Object.keys(c.engines[e]!.byTier)))].sort();
  const categories = [...new Set(engines.flatMap((e) => Object.keys(c.engines[e]!.byCategory)))].sort();
  charts.push(
    '<h2>Curated corpus: per-page combined score</h2>',
    distribution(engines.map((e) => [e, c.engines[e]!.docs.filter((d) => !d.jsOnly).map((d) => d.combined)]), 'per-page combined score'),
    '<h2>Curated corpus: score components</h2>',
    groupedBars(['include recall', '1 − leak rate', 'title fuzzy', 'structure', 'combined'], engines.map((e) => {
      const o = c.engines[e]!.overall;
      return [e, [o.includeRecall, 1 - o.leakRate, o.titleFuzzy, o.structurePass, o.combined]];
    })),
    '<h2>Curated corpus: combined score by tier</h2>',
    groupedBars(tiers.map((t) => `tier ${t}`), engines.map((e) => [e, tiers.map((t) => c.engines[e]!.byTier[t]?.combined ?? null)])),
    '<h2>Curated corpus: combined score by category</h2>',
    groupedBars(categories, engines.map((e) => [e, categories.map((k) => c.engines[e]!.byCategory[k]?.combined ?? null)])),
  );
}
const perfEngines = ENGINES.filter((e) => latest.perf[e]);
if (perfEngines.length) {
  const outputs = await Promise.all([readOutputs('zyte'), readOutputs('curated')]);
  charts.push(
    '<h2>Speed: total ms per page (parse + extract)</h2>',
    speedBars(perfEngines.map((e) => [e, latest.perf[e]!.total]), 'bar = median, whisker = p95 (log scale)'),
    '<h2>Speed: extraction only</h2>',
    speedBars(perfEngines.map((e) => [e, latest.perf[e]!.extract]), 'bar = median, whisker = p95 (log scale)'),
    '<h2>Speed vs page size</h2>',
    scatter(perfEngines.map((e) => [e, outputs.flatMap((o) => o[e]?.docs ?? [])])),
  );
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Article extraction eval</title><style>
:root{color-scheme:dark}body{margin:0;background:#0b0d10;color:#d7dce2;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:900px;margin:0 auto;padding:32px 20px 80px}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:36px 0 10px;color:#fff}h3{font-size:14px;margin:22px 0 8px;color:#aab}
p{color:#9aa4b0}table{border-collapse:collapse;margin:8px 0 16px;font-size:12px;width:100%}th,td{padding:4px 8px;border-bottom:1px solid #1d232b;text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}th{color:#8b95a1;font-weight:600}
code{background:#151a20;padding:1px 4px;border-radius:3px}.label{fill:#d7dce2;font-size:12px}.tick{fill:#7b8591;font-size:11px}.grid{stroke:#1a2027}.muted{color:#6b7480;font-size:11px}
.heat td{text-align:center;color:#e8ecf0}.heat td:first-child,.heat td:nth-child(3){text-align:left}details{margin-top:28px}summary{cursor:pointer;color:#fff;font-weight:600}
</style></head><body><main><h1>Article extraction eval</h1><p>Generated ${escape(latest.generatedAt)} from the stored outputs. Local file, not uploaded anywhere.</p>
${charts.join('\n')}
<details open><summary>Tables</summary>${markdownTables(renderMarkdown(latest))}</details>
${latest.curated ? `<details><summary>Curated pages × engines (combined score, sorted by ours)</summary>${heatmap(latest)}</details>` : ''}
</main></body></html>`;
const path = resolve(process.env.TMPDIR ?? tmpdir(), 'extract-eval-report.html');
await Bun.write(path, html);
console.log(`wrote ${path}`);
