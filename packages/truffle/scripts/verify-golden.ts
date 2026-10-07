/**
 * Checks that the working tree's engine produces byte-identical output to the
 * baseline on every page of the eval corpus (`test-corpus/parity/`, see
 * `parity-dump.ts`). Exits 1 on any difference, printing the first differing
 * path per page.
 *
 * Under Bun, each page is parsed with jsdom exactly as `parity-dump.ts` does, and:
 *
 * - `extractTree(fromDom(doc), { url, markdown: true })`, serialized as
 *   `JSON.stringify(article, null, 2) + '\n'`, must equal the golden file
 *   `<golden>/<key>.json` byte for byte (the baseline's output; `null` when no article);
 * - `extract` and `extractTree` without `markdown` must equal the golden article without its `markdown` key;
 * - the baseline engine (imported from `--baseline`) and the working tree, each on its own fresh tree, must agree
 *   on the `fromDom` tree, all of the above, `articleText`, `blocksText`, `blocksMarkdown` and `articleMarkdown`
 *   (also both builds' text and Markdown functions on one and the same article).
 *
 * With `--browser`, the same baseline-vs-working-tree comparison runs in headless Chromium on native `DOMParser`
 * documents (both builds bundled into one page), which covers `fromDom` over a real DOM.
 *
 *   bun scripts/verify-golden.ts [--browser] [--baseline <baseline packages/truffle/src>] [--golden <dir>]
 *                                [--ids id,id] [--workers 4]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, serialize, type Mismatch } from './compare-harness';
import { arg, baselineDir, bundleComparePage, call, firstDifference, flag, loadCorpus, loadEngines, openPages, pageHtml, parseJsdom, PARITY_DIR, pool, type Entry } from './compare';

const browser = flag('--browser');
const goldenDir = resolve(arg('--golden') ?? resolve(PARITY_DIR, 'ts'));
const entries = loadCorpus(arg('--ids')?.split(','));
const workers = Number(arg('--workers') ?? 4);

const failures: { key: string; check: string; where: string }[] = [];
let checked = 0;

function report(entry: Entry, mismatches: Mismatch[]): void {
  checked++;
  for (const m of mismatches) failures.push({ key: entry.key, check: m.check, where: firstDifference(m.base, m.next) });
  if (mismatches.length > 0) console.log(`DIFF ${entry.key}: ${mismatches[0]!.check} at ${firstDifference(mismatches[0]!.base, mismatches[0]!.next)}`);
  if (checked % 50 === 0) console.log(`${checked}/${entries.length}`);
}

console.log(`baseline: ${baselineDir()}`);
if (browser) {
  const script = await bundleComparePage();
  const { browser: chromium, pages } = await openPages(workers, script);
  console.log(`Chromium ${chromium.version()}, DOMParser documents, ${workers} workers`);
  try {
    await pool(pages, entries, async (page, entry) => {
      await call(page, 'load', pageHtml(entry), entry.url);
      report(entry, await call<Mismatch[]>(page, 'verify'));
    });
  } finally {
    await chromium.close();
  }
} else {
  console.log(`Bun ${Bun.version}, jsdom documents; golden: ${goldenDir}`);
  const engines = await loadEngines();
  // One parse per page: no engine mutates the document, so every run may read the same one.
  let doc: Document | null = null;
  const harness = createHarness({ ...engines, parse: () => doc! });
  for (const entry of entries) {
    const html = pageHtml(entry);
    const golden = readFileSync(resolve(goldenDir, entry.key + '.json'), 'utf8');
    doc = parseJsdom(html);
    const mismatches: Mismatch[] = [];
    const against = (check: string, expected: string, actual: string) => {
      if (expected !== actual) mismatches.push({ check, base: expected, next: actual });
    };
    // Against the golden files.
    const article = engines.next.extractTree(engines.next.fromDom(doc), { url: entry.url, markdown: true });
    against('golden: extractTree markdown', golden, serialize(article));
    const expected = JSON.parse(golden) as Record<string, unknown> | null;
    if (expected !== null) delete expected['markdown'];
    against('golden: extractTree', serialize(expected), serialize(engines.next.extractTree(engines.next.fromDom(doc), { url: entry.url })));
    against('golden: extract', serialize(expected), serialize(engines.next.extract(doc, { url: entry.url })));
    // Against the baseline engine.
    harness.load(html, entry.url);
    mismatches.push(...harness.verify());
    report(entry, mismatches);
    doc.defaultView?.close();
  }
}

const pages = new Set(failures.map((f) => f.key));
console.log(`\n${checked - pages.size}/${checked} pages identical (${browser ? 'Chromium' : 'Bun + jsdom'})`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 40)) console.log(`  ${f.key}: ${f.check}: ${f.where}`);
  process.exit(1);
}
if (checked !== entries.length) {
  console.log(`only ${checked} of ${entries.length} pages were checked`);
  process.exit(1);
}
