import { ARTICLE_SCHEMA, type Article, type ExtractOptions, type Paragraph } from './model';
import { articleText, countWords } from './text';

/**
 * PLACEHOLDER: the real engine replaces this file. Keeps the public API
 * (`extract`, `extractHtml`) stable so consumers can integrate now.
 * Mutates `doc`.
 */
export function extract(doc: Document, options: ExtractOptions): Article | null {
  const blocks: Paragraph[] = [];
  for (const p of Array.from(doc.querySelectorAll('p'))) {
    const text = (p.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > 40) blocks.push({ type: 'paragraph', content: [{ type: 'text', text }] });
  }
  if (blocks.length === 0) return null;
  const article: Article = {
    schema: ARTICLE_SCHEMA,
    url: options.url,
    title: (doc.title || '').trim() || new URL(options.url).hostname,
    subtitle: null,
    byline: null,
    authors: [],
    siteName: null,
    publishedAt: null,
    modifiedAt: null,
    language: doc.documentElement.getAttribute('lang'),
    dir: 'ltr',
    excerpt: null,
    leadImage: null,
    favicon: null,
    wordCount: 0,
    readingMinutes: 1,
    blocks,
  };
  article.wordCount = countWords(articleText(article));
  article.readingMinutes = Math.max(1, Math.ceil(article.wordCount / 230));
  return article;
}

/** Parses with the platform `DOMParser` (browser) unless `parse` is given, then extracts. */
export function extractHtml(
  html: string,
  options: ExtractOptions & { parse?: (html: string) => Document },
): Article | null {
  const parse = options.parse ?? ((source: string) => new DOMParser().parseFromString(source, 'text/html'));
  return extract(parse(html), options);
}
