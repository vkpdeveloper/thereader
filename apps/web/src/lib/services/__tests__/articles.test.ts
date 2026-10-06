import { describe, expect, test } from 'bun:test';
import type { Article, ExtractOptions } from '@thereader/extract';
import { ArticleStoreImpl, articleKey, decodeHtml, findArticleUrl, normalizeArticleUrl, sniffEncoding } from '../articles';
import { ApiError, type ArticlesSnapshot } from '../contract';
import { MemoryKv } from '../kv';
import { Clock, ORIGIN } from './helpers';

const bytesOf = (...parts: (string | number[])[]): Uint8Array => {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') for (const c of part) out.push(c.charCodeAt(0));
    else out.push(...part);
  }
  return new Uint8Array(out);
};

/** A stand-in Document carrying the decoded HTML, so tests run without a DOM. */
const parse = (html: string) => ({ html }) as unknown as Document;

function fakeArticle(html: string, options: ExtractOptions, overrides: Partial<Article> = {}): Article | null {
  const text = /<p>([\s\S]*?)<\/p>/.exec(html)?.[1];
  if (!text) return null;
  const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? 'Untitled';
  const canonical = /<link rel="canonical" href="([^"]+)">/.exec(html)?.[1];
  return {
    schema: 1,
    url: canonical ?? options.url,
    title,
    subtitle: null,
    byline: 'Ada Writer',
    authors: ['Ada Writer'],
    siteName: null,
    publishedAt: null,
    modifiedAt: null,
    language: 'en',
    dir: 'ltr',
    excerpt: text.slice(0, 40),
    leadImage: { src: 'https://cdn.example.org/lead.jpg', alt: '' },
    favicon: 'https://example.org/favicon.ico',
    wordCount: 900,
    readingMinutes: 4,
    blocks: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    ...overrides,
  };
}

interface Call {
  url: string;
}

function setup(pages: Record<string, () => Response>, options: { extract?: (doc: Document, o: ExtractOptions) => Article | null } = {}) {
  const kv = new MemoryKv();
  const clock = new Clock();
  const calls: Call[] = [];
  const fetch = async (input: string) => {
    calls.push({ url: input });
    const target = new URL(input).searchParams.get('url') ?? '';
    const page = pages[target];
    if (!page) return new Response(JSON.stringify({ error: { code: 'UPSTREAM_STATUS', message: 'The page answered with HTTP 404.' } }), { status: 502 });
    return page();
  };
  const extract = options.extract ?? ((doc: Document, o: ExtractOptions) => fakeArticle((doc as unknown as { html: string }).html, o));
  const store = new ArticleStoreImpl({ kv, currentOrigin: () => ORIGIN, fetch, parse, extract, now: clock.now });
  return { kv, clock, calls, store };
}

const page = (html: string | Uint8Array, headers: Record<string, string> = {}) => () =>
  new Response(typeof html === 'string' ? new TextEncoder().encode(html) : (html as BlobPart), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
  });

const html = (title: string, text: string, extra = '') => `<html><head><title>${title}</title>${extra}</head><body><p>${text}</p></body></html>`;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
}

describe('article URLs', () => {
  test('adds https, drops fragments and tracking, rejects what is not a web address', () => {
    expect(normalizeArticleUrl('example.com/post')).toBe('https://example.com/post');
    expect(normalizeArticleUrl('  https://Example.COM/a?id=2&utm_source=x&fbclid=y#top ')).toBe('https://example.com/a?id=2');
    expect(normalizeArticleUrl('http://blog.example.org/x')).toBe('http://blog.example.org/x');
    expect(normalizeArticleUrl('//news.example.org/y')).toBe('https://news.example.org/y');
    expect(normalizeArticleUrl('<https://example.com/z>')).toBe('https://example.com/z');
    for (const bad of ['', 'hello world', 'ftp://example.com/f', 'localhost:3000', 'mailto:me@example.com', 'https://user:pw@example.com/', 'notaurl']) {
      expect(normalizeArticleUrl(bad)).toBeNull();
    }
  });

  test('finds a link in pasted text', () => {
    expect(findArticleUrl('Read this: https://example.com/a-story. Great!')).toBe('https://example.com/a-story');
    expect(findArticleUrl('https://en.wikipedia.org/wiki/Bird_(disambiguation)')).toBe('https://en.wikipedia.org/wiki/Bird_(disambiguation)');
    expect(findArticleUrl('(see https://example.com/x)')).toBe('https://example.com/x');
    expect(findArticleUrl('www.example.com/post')).toBe('https://www.example.com/post');
    expect(findArticleUrl('just some words')).toBeNull();
    expect(findArticleUrl('version 1.2')).toBeNull();
  });
});

describe('decoding like a browser', () => {
  test('a byte order mark wins over the declared charset', () => {
    const bytes = bytesOf([0xef, 0xbb, 0xbf], '<p>caf', [0xc3, 0xa9], '</p>');
    expect(sniffEncoding(bytes, 'text/html; charset=windows-1252')).toBe('utf-8');
    expect(decodeHtml(bytes, 'text/html; charset=windows-1252')).toBe('<p>café</p>');
    expect(sniffEncoding(bytesOf([0xff, 0xfe], '<'), null)).toBe('utf-16le');
  });

  test('windows-1252 from the Content-Type header', () => {
    const bytes = bytesOf('<p>', [0x93], 'Quoted', [0x94], ' ', [0x96], ' caf', [0xe9], '</p>');
    expect(decodeHtml(bytes, 'text/html; charset=windows-1252')).toBe('<p>\u201cQuoted\u201d \u2013 café</p>');
    expect(decodeHtml(bytes, 'text/html; charset="ISO-8859-1"')).toBe('<p>\u201cQuoted\u201d \u2013 café</p>');
  });

  test('shift_jis from the header and from a meta tag only', () => {
    const japanese = [0x93, 0xfa, 0x96, 0x7b];
    expect(decodeHtml(bytesOf('<p>', japanese, '</p>'), 'text/html; charset=Shift_JIS')).toBe('<p>日本</p>');
    const metaOnly = bytesOf('<html><head><meta charset="shift_jis"><title>t</title></head><p>', japanese, '</p>');
    expect(sniffEncoding(metaOnly, 'text/html')).toBe('shift_jis');
    expect(decodeHtml(metaOnly, null)).toContain('<p>日本</p>');
  });

  test('http-equiv meta, unknown header labels, UTF-16 meta and the UTF-8 default', () => {
    const equiv = bytesOf('<meta http-equiv="Content-Type" content="text/html;charset=windows-1252"><p>', [0xe9], '</p>');
    expect(sniffEncoding(equiv, 'text/html; charset=bogus-label')).toBe('windows-1252');
    expect(decodeHtml(equiv, null)).toContain('<p>é</p>');
    expect(sniffEncoding(bytesOf("<meta charset='utf-16'>"), null)).toBe('utf-8');
    expect(sniffEncoding(bytesOf('<p>plain</p>'), null)).toBe('utf-8');
    const late = bytesOf(' '.repeat(2100), '<meta charset="shift_jis">');
    expect(sniffEncoding(late, null)).toBe('utf-8');
  });
});

describe('ArticleStore', () => {
  test('fetches through the relay, extracts, stores once and reports phases', async () => {
    const { store, kv, calls } = setup({
      'https://example.com/story': page(html('A Story', 'Once upon a time there was a long paragraph.'), { 'X-Final-Url': 'https://example.com/story' }),
    });
    await store.load();
    const phases: string[] = [];
    store.subscribe(() => {
      const a = (store.getSnapshot() as ArticlesSnapshot).adding;
      if (a && phases[phases.length - 1] !== a.phase) phases.push(a.phase);
    });
    const summary = await store.add('example.com/story');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${ORIGIN}/v1/article-source?url=${encodeURIComponent('https://example.com/story')}`);
    expect(phases).toEqual(['fetching', 'extracting', 'saving']);
    expect(store.getSnapshot().adding).toBeNull();
    expect(summary.title).toBe('A Story');
    expect(summary.siteName).toBe('example.com');
    expect(summary.readingMinutes).toBe(4);
    expect(summary.image).toBe('https://cdn.example.org/lead.jpg');
    expect(summary.progress).toBeNull();
    expect(store.getSnapshot().items.map((s) => s.id)).toEqual([summary.id]);
    const record = await kv.get<{ article: Article }>(articleKey(summary.id));
    expect(record?.article.blocks).toHaveLength(1);
    expect((await store.get(summary.id))?.title).toBe('A Story');
    const index = await kv.get<{ items: unknown[] }>('articles.v1');
    expect(index?.items).toHaveLength(1);
  });

  test('decodes the relayed bytes with the right charset before extracting', async () => {
    const body = bytesOf('<html><head><meta charset="windows-1252"><title>Caf', [0xe9], '</title></head><p>', [0x93], 'Hi', [0x94], '</p></html>');
    const { store } = setup({ 'https://example.com/legacy': page(body, { 'Content-Type': 'text/html' }) });
    await store.load();
    const summary = await store.add('https://example.com/legacy');
    expect(summary.title).toBe('Café');
    const article = await store.get(summary.id);
    expect(article?.blocks[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: '\u201cHi\u201d' }] });
  });

  test('re-adding returns the saved entry: same URL, www or slash variants, redirects and canonical URLs', async () => {
    const { store, calls } = setup({
      'https://example.com/a': page(html('A', 'First article body text.')),
      'https://short.example/xyz': page(html('A again', 'First article body text.'), { 'X-Final-Url': 'https://example.com/a' }),
      'https://example.com/a-amp': page(html('A amp', 'First article body.', '<link rel="canonical" href="https://www.example.com/a/">')),
    });
    await store.load();
    const first = await store.add('https://example.com/a');
    expect((await store.add('http://www.example.com/a/')).id).toBe(first.id);
    expect(calls).toHaveLength(1);
    expect((await store.add('short.example/xyz')).id).toBe(first.id);
    expect(calls).toHaveLength(2);
    expect((await store.add('https://short.example/xyz')).id).toBe(first.id);
    expect(calls).toHaveLength(2);
    expect((await store.add('https://example.com/a-amp')).id).toBe(first.id);
    expect(store.getSnapshot().items).toHaveLength(1);
  });

  test('maps failures to friendly errors and saves nothing', async () => {
    const relayError = (status: number, code: string, message: string) => () =>
      new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'Content-Type': 'application/json' } });
    const { store, calls, kv } = setup(
      {
        'https://example.com/pdf': relayError(415, 'UNSUPPORTED_MEDIA_TYPE', 'The link is not a web page.'),
        'https://example.com/private': relayError(502, 'UPSTREAM_STATUS', 'The page answered with HTTP 403.'),
        'https://example.com/slow': relayError(504, 'UPSTREAM_TIMEOUT', 'The page took too long to respond.'),
        'https://example.com/huge': relayError(413, 'TOO_LARGE', 'The page is larger than 8 MB.'),
        'https://example.com/empty': page('<html><body><div>No paragraphs</div></body></html>'),
      },
    );
    await store.load();
    const cases: [string, string, RegExp][] = [
      ['not a link', 'INVALID_URL', /web address/],
      ['example.com/pdf', 'NOT_HTML', /isn't a web page/],
      ['example.com/private', 'BLOCKED', /example\.com blocked the request \(HTTP 403\)/],
      ['example.com/slow', 'TIMEOUT', /example\.com took too long/],
      ['example.com/huge', 'TOO_LARGE', /too large/],
      ['example.com/missing', 'NOT_FOUND', /wasn't found on example\.com/],
      ['example.com/empty', 'NO_ARTICLE', /Couldn't find an article/],
    ];
    for (const [input, code, message] of cases) {
      const error = (await rejection(store.add(input))) as ApiError;
      expect(error instanceof ApiError).toBe(true);
      expect(error.code).toBe(code);
      expect(error.message).toMatch(message);
    }
    expect(calls).toHaveLength(cases.length - 1);
    expect(store.getSnapshot().items).toHaveLength(0);
    expect(store.getSnapshot().adding).toBeNull();
    expect((await kv.keys()).filter((k) => k.startsWith('article:'))).toEqual([]);
  });

  test('a network failure and an old server without the relay', async () => {
    const kv = new MemoryKv();
    const down = new ArticleStoreImpl({
      kv,
      currentOrigin: () => ORIGIN,
      parse,
      extract: () => null,
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const error = (await rejection(down.add('example.com/a'))) as ApiError;
    expect(error.code).toBe('NETWORK');
    expect(error.isNetwork).toBe(true);
    const old = new ArticleStoreImpl({
      kv,
      currentOrigin: () => ORIGIN,
      parse,
      extract: () => null,
      fetch: async () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }), { status: 404 }),
    });
    expect(((await rejection(old.add('example.com/a'))) as ApiError).code).toBe('UNSUPPORTED');
  });

  test('cancelling stops before anything is saved', async () => {
    const { store, kv } = setup({ 'https://example.com/a': page(html('A', 'Body text of the article.')) });
    await store.load();
    const controller = new AbortController();
    controller.abort();
    const error = (await rejection(store.add('example.com/a', { signal: controller.signal }))) as DOMException;
    expect(error.name).toBe('AbortError');
    expect(store.getSnapshot().items).toHaveLength(0);
    expect(await kv.get('articles.v1')).toBeNull();
  });

  test('progress, opening and removal persist; a new session loads the index without the documents', async () => {
    const { store, kv, clock } = setup({
      'https://example.com/a': page(html('A', 'Body text of article A.')),
      'https://example.com/b': page(html('B', 'Body text of article B.')),
    });
    await store.load();
    const a = await store.add('example.com/a');
    clock.advance(1000);
    const b = await store.add('example.com/b');
    expect(store.getSnapshot().items.map((s) => s.title)).toEqual(['B', 'A']);
    await store.saveProgress(a.id, 0.4321987);
    await store.saveProgress(a.id, 1.7);
    await store.markOpened(a.id);
    await store.flush();

    const again = new ArticleStoreImpl({ kv, currentOrigin: () => ORIGIN, parse, extract: () => null });
    await again.load();
    const loaded = again.summary(a.id);
    expect(loaded?.progress).toBe(1);
    expect(loaded?.lastOpenedAt).toBe(new Date(clock.ms).toISOString());
    expect((await again.get(b.id))?.title).toBe('B');

    await again.remove(b.id);
    expect(again.getSnapshot().items.map((s) => s.id)).toEqual([a.id]);
    expect(await kv.get(articleKey(b.id))).toBeNull();
    expect(await again.get(b.id)).toBeNull();
  });
});
