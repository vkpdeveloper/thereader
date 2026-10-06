// Runs Postlight Parser (Mercury) in Node over the eval manifest.
// node run_postlight.mjs <manifest.json> <out.json> [--runs N] [--shard i/k]
// Settings: library defaults with the page HTML passed in (no fetching) and fetchAllPages: false.
// Postlight parses with cheerio internally, so only the total is timed (reported as extraction).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import Parser from '@postlight/parser';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { runs: { type: 'string', default: '5' }, shard: { type: 'string', default: '0/1' } },
});
const [manifest, out] = positionals;
const [shard, shards] = values.shard.split('/').map(Number);
const docs = JSON.parse(readFileSync(manifest, 'utf8')).filter((_, i) => i % shards === shard);
const version = createRequire(import.meta.url)('@postlight/parser/package.json').version;
const results = {};
for (const doc of docs) {
  const html = readFileSync(doc.path, 'utf8');
  const parse = () => Parser.parse(doc.url, { html, fetchAllPages: false });
  try {
    const article = await parse();
    const result = { ok: true, title: article?.title ?? '', html: article?.content ?? '', parseMs: [], extractMs: [] };
    for (let i = 0; i < Number(values.runs); i++) {
      const t0 = performance.now();
      await parse();
      result.extractMs.push(performance.now() - t0);
    }
    results[doc.id] = result;
  } catch (error) {
    results[doc.id] = { ok: false, error: String(error?.stack ?? error).split('\n')[0], parseMs: [], extractMs: [] };
  }
}
writeFileSync(out, JSON.stringify({ version, results }));
