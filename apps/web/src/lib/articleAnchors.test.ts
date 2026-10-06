import { describe, expect, test } from 'bun:test';
import { inlineText, type Block } from 'truffle';
import { everyBlock } from '../components/article/__tests__/fixture';
import {
  ARTICLE_HIGHLIGHT_SHA,
  articleHighlightBookId,
  articleIdOf,
  describeSpan,
  normalizeSpan,
  parseArticleLocator,
  resolveLocator,
  spanText,
  type ArticleSpan,
  type BlockText,
} from './articleAnchors';

/** A block's text roughly as the page draws it; anchoring only needs it to be consistent. */
function textOf(block: Block): string {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return inlineText(block.content);
    case 'code':
      return block.code;
    case 'list':
      return block.items.map((item) => item.blocks.map(textOf).join('')).join('');
    case 'quote':
    case 'callout':
      return block.blocks.map(textOf).join('');
    case 'figure':
      return block.caption ? inlineText(block.caption) : '';
    default:
      return '';
  }
}

const texts = everyBlock.blocks.map(textOf);
const count = texts.length;
const reader = (list: string[]): BlockText => (i) => list[i] || null;
const info = { articleId: 'a'.repeat(32), href: everyBlock.url };

/** The span of `needle` inside block `block`. */
function spanOf(list: string[], block: number, needle: string, from = 0): ArticleSpan {
  const start = list[block]!.indexOf(needle, from);
  if (start < 0) throw new Error(`"${needle}" is not in block ${block}`);
  return { startBlock: block, start, endBlock: block, end: start + needle.length };
}

const firstParagraph = 0;
const codeHeading = texts.findIndex((t) => t === 'Code');
const firstCode = codeHeading + 1;

describe('article highlight identity', () => {
  test('article highlights carry the article id and the sentinel edition; books never match', () => {
    const bookId = articleHighlightBookId(info.articleId);
    // The API's BOOK_ID_PATTERN.
    expect(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(bookId)).toBe(true);
    expect(articleIdOf({ bookId, sha256: ARTICLE_HIGHLIGHT_SHA })).toBe(info.articleId);
    expect(articleIdOf({ bookId, sha256: 'f'.repeat(64) })).toBeNull();
    expect(articleIdOf({ bookId: 'moby-dick', sha256: ARTICLE_HIGHLIGHT_SHA })).toBeNull();
  });
});

describe('anchoring', () => {
  test('a passage round-trips through its locator by offsets', () => {
    const span = spanOf(texts, firstParagraph, 'italic, underline');
    const loc = describeSpan(span, reader(texts), count, info);
    expect(loc).toMatchObject({ type: 'article', href: everyBlock.url, block: 0, endBlock: 0, start: span.start, end: span.end });
    expect(loc.text!.highlight).toBe('italic, underline');
    expect(loc.text!.before!.endsWith('bold, ')).toBe(true);
    expect(loc.text!.after!.startsWith(', strike')).toBe(true);

    const parsed = parseArticleLocator(JSON.parse(JSON.stringify(loc)))!;
    expect(resolveLocator(parsed, reader(texts), count)).toEqual(span);
  });

  test('a passage across blocks joins them with a line break and skips blocks without text', () => {
    const start = texts[codeHeading - 1]!.length - 5;
    const span: ArticleSpan = { startBlock: codeHeading - 1, start, endBlock: firstCode, end: 6 };
    const loc = describeSpan(span, reader(texts), count, info);
    expect(loc.text!.highlight).toBe(`${texts[codeHeading - 1]!.slice(start)}\nCode\nexport`);
    expect(resolveLocator(parseArticleLocator({ ...loc })!, reader(texts), count)).toEqual(span);
  });

  test('ends on block edges and on blocks without text move inward', () => {
    const text = reader(texts);
    const figure = everyBlock.blocks.findIndex((b) => b.type === 'figure' && !b.caption);
    const empty = figure >= 0 ? figure : texts.findIndex((t) => t === '');
    expect(empty).toBeGreaterThan(0);
    const after = texts.findIndex((t, i) => i > empty && t);
    // Starting at the very end of a block, or inside one without text, starts at the next text.
    expect(normalizeSpan({ startBlock: 0, start: texts[0]!.length, endBlock: 1, end: 2 }, text, count)).toEqual({ startBlock: 1, start: 0, endBlock: 1, end: 2 });
    expect(normalizeSpan({ startBlock: empty, start: 0, endBlock: after, end: 3 }, text, count)).toEqual({ startBlock: after, start: 0, endBlock: after, end: 3 });
    // Ending at the start of a block ends at the end of the previous text.
    expect(normalizeSpan({ startBlock: 0, start: 2, endBlock: 1, end: 0 }, text, count)).toEqual({ startBlock: 0, start: 2, endBlock: 0, end: texts[0]!.length });
    expect(normalizeSpan({ startBlock: 0, start: 3, endBlock: 0, end: 3 }, text, count)).toBeNull();
  });

  test('text that moved inside its block is found again by the quote', () => {
    const span = spanOf(texts, firstParagraph, 'inline code');
    const loc = describeSpan(span, reader(texts), count, info);
    // An inline image that failed to load shows its alt text on this device.
    const shifted = [...texts];
    shifted[0] = shifted[0]!.replace('This paragraph', 'This [image] paragraph');
    const found = resolveLocator(loc, reader(shifted), count)!;
    expect(found.start).toBe(span.start + ' [image]'.length);
    expect(spanText(found, reader(shifted))).toBe('inline code');
  });

  test('blocks inserted before the passage are searched past', () => {
    const span = spanOf(texts, firstCode, 'encodeURIComponent(url)');
    const loc = describeSpan(span, reader(texts), count, info);
    const resaved = ['A new lede.', 'Another new paragraph.', ...texts];
    const found = resolveLocator(loc, reader(resaved), count + 2)!;
    expect(found).toEqual({ ...span, startBlock: firstCode + 2, endBlock: firstCode + 2 });
  });

  test('of repeated words, the one with matching context wins', () => {
    const rust = texts.findIndex((t) => t.includes('the quick brown fox'));
    const line = texts[rust]!;
    // "the" appears three times in the Rust string; pick the second.
    const second = line.indexOf('the', line.indexOf('the quick') + 1);
    const span: ArticleSpan = { startBlock: rust, start: second, endBlock: rust, end: second + 3 };
    const loc = describeSpan(span, reader(texts), count, info);
    // An edit earlier in the block moves every occurrence; context still picks the right one.
    const edited = [...texts];
    edited[rust] = `// counts words\n${line}`;
    const found = resolveLocator(loc, reader(edited), count)!;
    expect(found.start).toBe(second + '// counts words\n'.length);
  });

  test('a passage that is gone resolves to nothing, and a stripped quote trusts the offsets', () => {
    const span = spanOf(texts, firstParagraph, 'small print');
    const loc = describeSpan(span, reader(texts), count, info);
    const removed = [...texts];
    removed[0] = removed[0]!.replace('small print', 'fine type');
    expect(resolveLocator(loc, reader(removed), count)).toBeNull();

    // The API size cap may drop the context, or the whole `text`.
    const bare = parseArticleLocator({ ...loc, text: undefined })!;
    expect(resolveLocator(bare, reader(texts), count)).toEqual(span);
  });

  test('a passage longer than the cap is cut, and progression orders passages', () => {
    const long = { ...spanOf(texts, firstCode, 'export'), end: texts[firstCode]!.length };
    const cut = describeSpan(long, reader(texts), count, info, 20);
    expect(cut.text!.highlight).toHaveLength(20);
    expect(cut.end - cut.start).toBe(20);

    const early = describeSpan(spanOf(texts, 0, 'bold'), reader(texts), count, info);
    const late = describeSpan(spanOf(texts, firstCode, 'fetch'), reader(texts), count, info);
    expect(early.locations.totalProgression).toBeLessThan(late.locations.totalProgression);
    expect(late.locations.totalProgression).toBeLessThan(1);
  });

  test('malformed locators are rejected', () => {
    const loc = describeSpan(spanOf(texts, 0, 'bold'), reader(texts), count, info) as unknown as Record<string, unknown>;
    expect(parseArticleLocator({ ...loc, type: 'epub' })).toBeNull();
    expect(parseArticleLocator({ ...loc, block: -1 })).toBeNull();
    expect(parseArticleLocator({ ...loc, endBlock: 0, block: 3 })).toBeNull();
    expect(parseArticleLocator({ href: 'OEBPS/ch1.xhtml', locations: { progression: 0.2 } })).toBeNull();
  });
});
