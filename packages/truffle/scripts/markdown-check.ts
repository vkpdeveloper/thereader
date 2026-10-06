/**
 * Checks `blocksMarkdown` on every article of the eval corpus: each article's
 * Markdown is parsed back with remark (GFM + math) and compared with its blocks
 * (`test/markdown-oracle.ts`). Reads the articles `scripts/parity-dump.ts`
 * wrote to `test-corpus/parity/ts/`, so run that first.
 *
 *   bun scripts/markdown-check.ts [--dir <articles dir>] [--show 5]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CORPUS_DIR } from '../../../eval/src/corpus';
import { blocksMarkdown, type Article } from '../src/index';
import { compareShapes, expectedShape, parseMarkdown, parsedShape } from '../test/markdown-oracle';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dir = arg('--dir') ?? resolve(CORPUS_DIR, 'parity', 'ts');
const show = Number(arg('--show') ?? 5);
let pages = 0;
let broken = 0;
let marksOnly = 0;
let markEntries = 0;
let shown = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const article = JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as Article | null;
  if (article === null) continue;
  pages++;
  const markdown = blocksMarkdown(article.blocks);
  const mismatches = compareShapes(expectedShape(article.blocks), parsedShape(parseMarkdown(markdown)));
  const structural = mismatches.find((m) => !m.marksOnly);
  if (structural !== undefined) broken++;
  else if (mismatches.length > 0) marksOnly++;
  markEntries += mismatches.filter((m) => m.marksOnly).length;
  for (const m of structural !== undefined ? [structural] : mismatches.slice(0, 1)) {
    if (shown++ >= show) break;
    console.log(`\n${file} (${structural ? 'structure' : 'marks'}) entry ${m.index}\n  expected: ${m.expected?.slice(0, 400)}\n  actual:   ${m.actual?.slice(0, 400)}`);
  }
}
console.log(`\n${pages} articles: ${pages - broken - marksOnly} identical, ${marksOnly} with dropped marks only (${markEntries} blocks), ${broken} with a structural difference`);
if (broken > 0) process.exit(1);
