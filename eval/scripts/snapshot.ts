// Fetches every curated URL like the app does and stores the raw bytes under test-corpus/live/.
// bun run snapshot [--refresh] [--only id,id]
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FETCH_HEADERS, LIVE_DIR, decodeHtml, loadCurated, type SnapshotMeta } from '../src/corpus';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { refresh: { type: 'boolean', default: false }, only: { type: 'string' }, concurrency: { type: 'string', default: '8' } },
});
const only = values.only ? new Set(values.only.split(',')) : undefined;
await mkdir(LIVE_DIR, { recursive: true });
const entries = (await loadCurated()).filter((e) => !only || only.has(e.id));
const queue = entries.filter((e) => values.refresh || !existsSync(resolve(LIVE_DIR, `${e.id}.json`)));
console.log(`${entries.length} entries, ${queue.length} to fetch`);

async function snapshot(id: string, url: string): Promise<SnapshotMeta> {
  const fetchedAt = new Date().toISOString();
  try {
    const response = await fetch(url, { headers: FETCH_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    await Bun.write(resolve(LIVE_DIR, `${id}.html`), bytes);
    const contentType = response.headers.get('content-type') ?? '';
    return { id, url, finalUrl: response.url, status: response.status, contentType, fetchedAt, bytes: bytes.length };
  } catch (error) {
    return { id, url, finalUrl: url, status: 0, contentType: '', fetchedAt, bytes: 0, error: String(error) };
  }
}

let failed = 0;
const workers = Array.from({ length: Number(values.concurrency) }, async () => {
  for (let entry = queue.shift(); entry; entry = queue.shift()) {
    const meta = await snapshot(entry.id, entry.url);
    await Bun.write(resolve(LIVE_DIR, `${entry.id}.json`), JSON.stringify(meta, null, 2));
    const ok = !meta.error && meta.status < 400;
    if (!ok) failed++;
    const charset = ok ? decodeHtml(new Uint8Array(await Bun.file(resolve(LIVE_DIR, `${entry.id}.html`)).arrayBuffer()), meta.contentType).charset : '';
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${meta.status} ${entry.id} ${(meta.bytes / 1024).toFixed(0)}KB ${charset} ${meta.error ?? (meta.finalUrl !== entry.url ? `-> ${meta.finalUrl}` : '')}`);
  }
});
await Promise.all(workers);
console.log(`done, ${failed} failed`);
