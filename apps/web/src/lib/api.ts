import type { Book } from './types';

export function resolveUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  return b ? `${b}${path}` : path;
}

export async function health(base: string): Promise<{ ok: boolean; service: string }> {
  const res = await fetch(resolveUrl(base, '/health'));
  const data = (await res.json()) as { status?: string; service?: string };
  return { ok: res.ok && data.status === 'ok', service: data.service ?? 'unknown' };
}

export async function listBooks(
  base: string,
  { q, cursor, limit = 24 }: { q?: string; cursor?: string; limit?: number },
): Promise<{ items: Book[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  const res = await fetch(`${resolveUrl(base, '/v1/books')}?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { items: Book[]; nextCursor: string | null };
  return data;
}

export async function getBook(base: string, id: string): Promise<Book> {
  const res = await fetch(resolveUrl(base, `/v1/books/${encodeURIComponent(id)}`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { book: Book };
  return data.book;
}

export async function downloadEpub(
  base: string,
  book: Book,
  onProgress?: (pct: number) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(resolveUrl(base, book.downloadUrl));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || book.fileSize;
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onProgress?.(received / total);
  }

  const all = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return all.buffer;
}
