/**
 * Dumps the eval corpus for the Dart port's parity checks
 * (`packages/truffle_dart/tool/parity.dart`). For every page it writes, under
 * `test-corpus/parity/`:
 *
 * - `html/<key>.html`: the decoded HTML (UTF-8), exactly what jsdom parsed;
 * - `vdoc/<key>.json`: the `VDocument` jsdom produced (`fromDom`), so the Dart
 *   `extractTree` runs on the very same tree and parser differences drop out;
 * - `ts/<key>.json`: the TypeScript `extractTree` output with `markdown: true` (`null` when no
 *   article), so the comparison covers `article.markdown` too;
 * - `manifest.json`: `{ key, dataset, id, url, bytes, tsMs }` per page, where
 *   `tsMs` is the median `extractTree` time under Bun (fresh tree per run, without Markdown).
 *
 * Pages are parsed with jsdom exactly as `test/conformance.test.ts` does.
 *
 *   bun scripts/parity-dump.ts [--ids id,id] [--runs 3]
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CORPUS_DIR, loadCurated, loadCuratedDocs, loadZyte, type Doc } from '../../../eval/src/corpus';
import { extractTree, fromDom } from '../src/index';
import { vdocJson } from './vdoc-json';

const OUT = resolve(CORPUS_DIR, 'parity');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parse(html: string): Document {
  return new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document;
}

const only = arg('--ids')?.split(',');
const runs = Number(arg('--runs') ?? 3);

const curated = await loadCuratedDocs(await loadCurated());
const { docs: zyte } = await loadZyte();
const docs: Doc[] = [...curated, ...zyte].filter((d) => only === undefined || only.includes(d.id));

for (const dir of ['html', 'vdoc', 'ts']) mkdirSync(resolve(OUT, dir), { recursive: true });
const manifest: { key: string; dataset: string; id: string; url: string; bytes: number; tsMs: number }[] = [];
let done = 0;
for (const doc of docs) {
  const key = `${doc.dataset}-${doc.id}`;
  const dom = parse(doc.html);
  const vdoc = fromDom(dom);
  writeFileSync(resolve(OUT, 'html', key + '.html'), doc.html);
  writeFileSync(resolve(OUT, 'vdoc', key + '.json'), JSON.stringify(vdocJson(vdoc)));
  const article = extractTree(vdoc, { url: doc.url, markdown: true });
  writeFileSync(resolve(OUT, 'ts', key + '.json'), JSON.stringify(article, null, 2) + '\n');
  const times: number[] = [];
  for (let r = 0; r < runs; r++) {
    const fresh = fromDom(dom);
    const t0 = performance.now();
    extractTree(fresh, { url: doc.url });
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  manifest.push({ key, dataset: doc.dataset, id: doc.id, url: doc.url, bytes: doc.bytes, tsMs: times.length > 0 ? times[times.length >> 1]! : 0 });
  if (++done % 25 === 0) console.log(`${done}/${docs.length}`);
}
if (only === undefined) writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`wrote ${docs.length} pages to ${OUT}`);
