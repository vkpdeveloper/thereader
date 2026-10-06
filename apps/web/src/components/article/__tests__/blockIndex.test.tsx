import { expect, test } from 'bun:test';
import type { Block } from '@thereader/extract';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderArticleBlocks } from '../Blocks';
import { everyBlock } from './fixture';

// Reading positions sync as indexes into `article.blocks`; the web reader finds
// blocks by `data-block-index` (routes/article.tsx), never by DOM structure.
const render = (blocks: readonly Block[]) =>
  renderToStaticMarkup(<div>{renderArticleBlocks(blocks, { sizes: '100vw', seenRefs: new Set() })}</div>);

const indexes = (html: string) => [...html.matchAll(/data-block-index="(\d+)"/g)].map((m) => Number(m[1]));

test('every top-level block, and only those, carries its index', () => {
  const html = render(everyBlock.blocks);
  expect(indexes(html)).toEqual(everyBlock.blocks.map((_, i) => i));
});

test('components get a box-less wrapper; elements carry the marker themselves', () => {
  const blocks: Block[] = [
    { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
    { type: 'code', code: 'let x = 1;', language: 'javascript' },
    { type: 'paragraph', content: [] }, // renders nothing
    { type: 'heading', level: 2, content: [{ type: 'text', text: 'Two' }] },
  ];
  const html = render(blocks);
  expect(html.startsWith('<div><p data-block-index="0">One</p><div class="article-block-contents" data-block-index="1"><figure')).toBe(true);
  expect(html).toContain('<h2 class="article-heading" data-block-index="3">');
  expect(indexes(html)).toEqual([0, 1, 3]);
});
