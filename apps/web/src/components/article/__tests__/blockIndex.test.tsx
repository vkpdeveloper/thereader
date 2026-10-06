import { expect, test } from 'bun:test';
import type { Block } from 'truffle';
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

test("a video's still saved as a figure before it draws nothing; the video takes its caption", () => {
  const still = 'https://example.org/media/clip.png';
  const blocks: Block[] = [
    { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
    { type: 'figure', images: [{ src: still, alt: 'The sidebar loading', width: 1320, height: 900 }], caption: [{ type: 'text', text: 'FIG A', marks: ['bold'] }] },
    { type: 'video', provider: 'file', url: 'https://example.org/media/clip.mp4', poster: still },
    { type: 'figure', images: [{ src: 'https://example.org/media/chart.png', alt: 'Chart' }], caption: [{ type: 'text', text: 'FIG B' }] },
  ];
  const html = render(blocks);
  // The block count is unchanged: the still keeps index 1 but has no element, as an empty paragraph.
  expect(indexes(html)).toEqual([0, 2, 3]);
  expect(html).toContain('<div class="article-block-contents" data-block-index="2"><figure class="article-media">');
  expect(html).toContain('<figcaption><strong>FIG A</strong></figcaption>');
  expect(html.split(still).length - 1).toBe(1); // the facade's poster only
  expect(html).toContain('<figure class="article-figure" data-block-index="3">');
});
