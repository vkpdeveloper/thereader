// Worst pages for one engine, sorted by the score gap to the best other engine,
// with the text it missed and the text it added.
// bun run failures [--engine ours] [--dataset zyte|curated|all] [--limit 20] [--snippets 4]
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ZYTE_DIR, loadCurated, type ZyteTruth } from '../src/corpus';
import { tokenize } from '../src/metric';
import { type OutputFile, buildResults, readOutputs } from '../src/results';
import { type DocOutput, ENGINES, type EngineName } from '../src/score';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    engine: { type: 'string', default: 'ours' },
    dataset: { type: 'string', default: 'all' },
    limit: { type: 'string', default: '20' },
    snippets: { type: 'string', default: '4' },
  },
});
const target = values.engine as EngineName;
if (!ENGINES.includes(target)) throw new Error(`Unknown engine ${target}`);
const limit = Number(values.limit);
const snippets = Number(values.snippets);
const latest = await buildResults();

function shingleSet(text: string): Set<string> {
  const tokens = tokenize(text);
  const set = new Set<string>();
  for (let i = 0; i + 4 <= tokens.length; i++) set.add(tokens.slice(i, i + 4).join(' '));
  return set;
}

/** Lines of `text` (6+ tokens) whose 4-gram shingles are mostly absent from `other`. */
function uncovered(text: string, other: string): string[] {
  const set = shingleSet(other);
  return text.split('\n').filter((line) => {
    const tokens = tokenize(line);
    if (tokens.length < 6) return false;
    let hit = 0;
    for (let i = 0; i + 4 <= tokens.length; i++) if (set.has(tokens.slice(i, i + 4).join(' '))) hit++;
    return hit / (tokens.length - 3) < 0.5;
  });
}

const clip = (line: string) => (line.length > 220 ? `${line.slice(0, 220)}…` : line);
const show = (label: string, lines: string[]) => {
  if (lines.length === 0) return;
  console.log(`  ${label} (${lines.length} lines):`);
  for (const line of lines.slice(0, snippets)) console.log(`    - ${clip(line)}`);
};

interface Row {
  dataset: string;
  id: string;
  score: number;
  best: EngineName;
  bestScore: number;
}

function worst(dataset: 'zyte' | 'curated', scores: Partial<Record<EngineName, Map<string, number>>>): Row[] {
  const mine = scores[target];
  if (!mine) {
    console.log(`no ${dataset} results for ${target}; run bun run eval --engines ${target} --dataset ${dataset}`);
    return [];
  }
  const rows: Row[] = [];
  for (const [id, score] of mine) {
    let best: EngineName = target;
    let bestScore = -1;
    for (const engine of ENGINES) {
      const other = scores[engine]?.get(id);
      if (engine !== target && other !== undefined && other > bestScore) [best, bestScore] = [engine, other];
    }
    if (best !== target) rows.push({ dataset, id, score, best, bestScore });
  }
  return rows.sort((a, b) => b.bestScore - b.score - (a.bestScore - a.score) || a.score - b.score);
}

function summarize(dataset: string, rows: Row[]) {
  const behind = rows.filter((r) => r.bestScore - r.score > 0.05).length;
  const ahead = rows.filter((r) => r.score - r.bestScore > 0.05).length;
  console.log(`\n=== ${dataset}: ${target} trails the best other engine by >0.05 on ${behind}/${rows.length} pages, leads by >0.05 on ${ahead} ===\n`);
}

const textOf = (file: OutputFile | undefined) => new Map((file?.docs ?? []).map((d: DocOutput) => [d.id, d]));

if ((values.dataset === 'all' || values.dataset === 'zyte') && latest.zyte) {
  const truth: Record<string, ZyteTruth> = await Bun.file(resolve(ZYTE_DIR, 'ground-truth.json')).json();
  const outputs = await readOutputs('zyte');
  const scores = Object.fromEntries(Object.entries(latest.zyte.engines).map(([e, r]) => [e, new Map(r.docs.map((d) => [d.id, d.f1]))]));
  const rows = worst('zyte', scores);
  summarize('zyte (F1)', rows);
  const mine = textOf(outputs[target]);
  for (const row of rows.slice(0, limit)) {
    const output = mine.get(row.id)!;
    console.log(`zyte/${row.id}  ${target} F1 ${row.score.toFixed(3)} vs ${row.best} ${row.bestScore.toFixed(3)}  ${truth[row.id].url}`);
    if (!output.ok) console.log(`  error: ${output.error}`);
    show('missing (in ground truth, not in output)', uncovered(truth[row.id].articleBody, output.text));
    show('extra (in output, not in ground truth)', uncovered(output.text, truth[row.id].articleBody));
    console.log('');
  }
}

if ((values.dataset === 'all' || values.dataset === 'curated') && latest.curated) {
  const entries = new Map((await loadCurated()).map((e) => [e.id, e]));
  const outputs = await readOutputs('curated');
  const scores = Object.fromEntries(Object.entries(latest.curated.engines).map(([e, r]) => [e, new Map(r.docs.map((d) => [d.id, d.combined]))]));
  const details = new Map(latest.curated.engines[target]?.docs.map((d) => [d.id, d]) ?? []);
  const rows = worst('curated', scores);
  summarize('curated (combined score)', rows);
  const mine = textOf(outputs[target]);
  for (const row of rows.slice(0, limit)) {
    const entry = entries.get(row.id)!;
    const score = details.get(row.id)!;
    const output = mine.get(row.id)!;
    const best = textOf(outputs[row.best]).get(row.id)!;
    console.log(`curated/${row.id} [tier ${entry.tier}, ${entry.category}${entry.jsOnly ? ', jsOnly' : ''}]  ${target} ${row.score.toFixed(3)} vs ${row.best} ${row.bestScore.toFixed(3)}  ${entry.url}`);
    if (!output.ok) console.log(`  error: ${output.error}`);
    if (!score.titleFuzzy) console.log(`  title: expected "${entry.title}", got "${output.title}"`);
    for (const i of score.missing) console.log(`  missed mustInclude: "${entry.mustInclude[i]}"`);
    for (const i of score.leaks) console.log(`  leaked mustExclude: "${entry.mustExclude[i]}"`);
    const failed = Object.entries(score.structure).filter(([, pass]) => !pass).map(([name]) => name);
    if (failed.length) {
      const s = output.stats;
      const expected = `code>=${entry.minCodeBlocks ?? '-'} ${JSON.stringify(entry.codeLanguages ?? [])} images>=${entry.minImages ?? '-'} headings>=${entry.minHeadings ?? '-'} tables>=${entry.minTables ?? '-'} math=${entry.hasMath ?? '-'} footnotes=${entry.hasFootnotes ?? '-'} embeds=${entry.hasEmbeds ?? '-'}`;
      const got = `code=${s.codeBlocks} ${JSON.stringify(s.codeLanguages)} images=${s.images} headings=${s.headings} tables=${s.tables} math=${s.math} footnotes=${s.footnotes}/${s.footnoteRefs}refs embeds=${s.embeds}`;
      console.log(`  failed structure: ${failed.join(', ')}\n    expected ${expected}\n    got      ${got}`);
    }
    show(`missing vs ${row.best}`, uncovered(best.text, output.text));
    show(`extra vs ${row.best}`, uncovered(output.text, best.text));
    console.log('');
  }
}
