// Checks every curated annotation against its snapshot: every mustInclude and
// mustExclude snippet must occur in the page text. Exits 1 on any failure.
// bun run validate [--file annotations.json] [--ids id,id]
import { parseArgs } from 'node:util';
import { BrowserPool } from '../src/browser';
import { type CuratedEntry, loadCurated, loadCuratedDocs, loadSnapshotMeta } from '../src/corpus';
import { matchKey } from '../src/text';

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { file: { type: 'string' }, ids: { type: 'string' } } });
const ids = values.ids ? new Set(values.ids.split(',')) : undefined;
const entries: CuratedEntry[] = (values.file ? await Bun.file(values.file).json() : await loadCurated()).filter(
  (e: CuratedEntry) => !ids || ids.has(e.id),
);

const errors: string[] = [];
const warnings: string[] = [];
const cjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;
const seen = new Set<string>();
for (const e of entries) {
  const fail = (message: string) => errors.push(`${e.id}: ${message}`);
  if (seen.has(e.id)) fail('duplicate id');
  seen.add(e.id);
  if (![1, 2, 3, 4, 5].includes(e.tier)) fail(`tier ${e.tier}`);
  for (const field of ['url', 'category', 'language', 'notes', 'title'] as const) if (!e[field]) fail(`missing ${field}`);
  if (e.mustInclude.length < 4 || e.mustInclude.length > 6) fail(`${e.mustInclude.length} mustInclude (want 4-6)`);
  if (e.mustExclude.length > 5) fail(`${e.mustExclude.length} mustExclude (want 3-5)`);
  if (e.mustExclude.length < 3) warnings.push(`${e.id}: only ${e.mustExclude.length} mustExclude (fine only when the page has no more boilerplate text)`);
  for (const snippet of e.mustInclude) {
    const words = snippet.trim().split(/\s+/).length;
    const ok = cjk.test(snippet) ? snippet.length >= 12 && snippet.length <= 80 : words >= 8 && words <= 20;
    if (!ok) warnings.push(`${e.id}: mustInclude length (${words} words) "${snippet}"`);
  }
  for (const snippet of e.mustExclude) if (matchKey(snippet).length < (cjk.test(snippet) ? 6 : 12)) warnings.push(`${e.id}: mustExclude too short to be specific "${snippet}"`);
  for (const snippet of e.mustInclude) if (e.mustExclude.some((x) => matchKey(x).includes(matchKey(snippet)) || matchKey(snippet).includes(matchKey(x)))) fail(`snippet in both lists "${snippet}"`);
  const meta = await loadSnapshotMeta(e.id);
  if (!meta) fail('no snapshot (run bun run snapshot)');
  else if (meta.error || meta.status >= 400) fail(`snapshot failed: ${meta.status} ${meta.error ?? ''}`);
}

const docs = await loadCuratedDocs(entries);
const byId = new Map(entries.map((e) => [e.id, e]));
const pool = await BrowserPool.open(4);
await pool.map(docs, async (worker, doc) => {
  const entry = byId.get(doc.id)!;
  await pool.call(worker, 'load', [doc.html, doc.url]);
  const text = matchKey(await pool.call(worker, 'pageText', []));
  for (const [list, snippets] of [['mustInclude', entry.mustInclude], ['mustExclude', entry.mustExclude]] as const) {
    for (const snippet of snippets) {
      if (text.includes(matchKey(snippet))) continue;
      const message = `${list} not in page text: "${snippet}"`;
      if (entry.jsOnly && list === 'mustInclude') warnings.push(`${doc.id}: (jsOnly) ${message}`);
      else errors.push(`${doc.id}: ${message}`);
    }
  }
});
await pool.close();

for (const warning of warnings) console.log(`warn  ${warning}`);
for (const error of errors) console.log(`FAIL  ${error}`);
console.log(`${entries.length} entries, ${docs.length} snapshots, ${errors.length} errors, ${warnings.length} warnings`);
if (errors.length > 0) process.exit(1);
