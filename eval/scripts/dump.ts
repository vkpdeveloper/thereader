// Annotation aid: prints a snapshot's metadata and its text blocks with DOM paths.
// bun run dump <id> [<id> ...] [--full] [--grep text]
import { parseArgs } from 'node:util';
import { BrowserPool } from '../src/browser';
import { loadCurated, loadCuratedDocs } from '../src/corpus';
import { matchKey } from '../src/text';

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { full: { type: 'boolean', default: false }, grep: { type: 'string' } },
});
const entries = (await loadCurated()).filter((e) => positionals.includes(e.id));
if (entries.length === 0) throw new Error(`Pass curated ids; known: ${(await loadCurated()).map((e) => e.id).join(' ')}`);
const docs = await loadCuratedDocs(entries);
const pool = await BrowserPool.open(1);
await pool.map(docs, async (worker, doc) => {
  await pool.call(worker, 'load', [doc.html, doc.url]);
  const meta = await pool.call(worker, 'meta', []);
  const blocks = await pool.call(worker, 'pageBlocks', []);
  console.log(`# ${doc.id} ${doc.url} (${(doc.bytes / 1024).toFixed(0)}KB, ${blocks.length} blocks)`);
  console.log(`title: ${meta.title}\nog:title: ${meta.ogTitle}\nh1: ${meta.h1}\nlang: ${meta.lang}\n`);
  const needle = values.grep ? matchKey(values.grep) : undefined;
  blocks.forEach((block, i) => {
    if (needle && !matchKey(block.text).includes(needle)) return;
    const text = values.full || block.text.length <= 400 ? block.text : `${block.text.slice(0, 400)}… (+${block.text.length - 400} chars)`;
    console.log(`[${i}] <${block.path}> ${text}`);
  });
});
await pool.close();
