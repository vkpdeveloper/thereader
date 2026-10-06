import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { grammarFor, languageLabel } from '../../../lib/codeLanguages';
import { highlightCode } from '../../../lib/highlight';
import { texToMathml } from '../../../lib/tex';
import { renderBlocks } from '../Blocks';
import { everyBlock, rtlArticle } from './fixture';

const render = (blocks: typeof everyBlock.blocks) =>
  renderToStaticMarkup(<div>{renderBlocks(blocks, { sizes: '(min-width: 760px) 680px, 100vw', seenRefs: new Set() })}</div>);

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('article renderer', () => {
  const html = render(everyBlock.blocks);

  test('draws every block type', () => {
    for (const marker of [
      '<h2 id="section-code" class="article-heading">',
      '<h3 id="section-media"',
      'class="article-code"',
      'class="article-figure"',
      'class="article-figure is-gallery"',
      'class="article-video-facade"',
      '<audio class="article-audio"',
      'class="article-audio-facade"',
      'class="article-embed"',
      '<ol start="3">',
      'type="checkbox"',
      'class="article-quote"',
      'class="article-pullquote" aria-hidden="true"',
      '<hr class="article-rule"/>',
      '<table>',
      'class="article-math is-block is-tex"',
      '<dl class="article-definitions">',
      '<details class="article-details">',
      'class="article-callout is-note"',
      'class="article-callout is-plain"',
      'class="article-footnotes"',
    ]) {
      expect(html).toContain(marker);
    }
  });

  test('draws every inline mark, breaks, inline images and math', () => {
    for (const tag of ['<strong>bold', '<em>italic', '<u>underline', '<s>strike', '<code>inline code', '<sub>2', '<sup>2', '<mark>', '<small>', '<kbd>⌘K', '<br/>']) {
      expect(html).toContain(tag);
    }
    expect(html).toContain('class="article-inline-image"');
    expect(html).toContain('class="article-math is-inline is-tex"');
  });

  test('links open in a new tab without referrer; runs sharing a link become one anchor; unsafe links are dropped', () => {
    expect(count(html, 'href="https://developer.mozilla.org/"')).toBe(1);
    expect(html).toContain('href="https://developer.mozilla.org/" target="_blank" rel="noopener noreferrer">a <strong>bold link</strong></a>');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('script link');
  });

  test('images reserve their box and load lazily without a referrer', () => {
    const image = /<img src="https:\/\/picsum\.photos\/id\/1043\/1200\/800"[^>]*>/.exec(html)?.[0] ?? '';
    for (const attr of ['srcSet="https://picsum.photos/id/1043/600/400 600w', 'sizes="(min-width: 760px) 680px, 100vw"', 'width="1200"', 'height="800"', 'loading="lazy"', 'decoding="async"', 'referrerPolicy="no-referrer"', 'alt="A misty forest"']) {
      expect(image.toLowerCase()).toContain(attr.toLowerCase());
    }
    expect(html).toContain('data-zoom="https://picsum.photos/id/1043/1200/800"');
  });

  test('tables keep header rows, spans, alignment and the caption', () => {
    expect(html).toContain('<caption>Header rows, spans and alignment.</caption>');
    expect(html).toContain('<thead><tr><th class="is-short" scope="col">Format</th><th class="is-short" scope="col" style="text-align:right">Size</th><th class="is-short" scope="col" colSpan="2">Notes</th></tr></thead>');
    expect(html).toContain('<th class="is-short" scope="row" rowspan="2">EPUB</th>');
    expect(html).toContain('<td class="is-short" colSpan="2" style="text-align:center">Fixed layout</td>');
    expect(html).toContain('<td>Structured JSON, stored once</td>');
  });

  test('footnote references link to their notes and the first one carries the return anchor', () => {
    expect(count(html, 'id="fnref-n1"')).toBe(1);
    expect(count(html, 'data-fn="n1"')).toBe(2);
    expect(html).toContain('<li id="fn-n1">');
    expect(html).toContain('data-fnback="n1"');
  });

  test('code blocks show their title and language before highlighting', () => {
    expect(html).toContain('store.ts');
    expect(html).toContain('<span class="article-code-lang">TypeScript</span>');
    expect(html).toContain('<span class="article-code-lang">Code</span>');
    expect(html).toContain('<pre tabindex="0"><code>use std::collections::HashMap;');
  });

  test('right-to-left content keeps code left to right', () => {
    const rtl = render(rtlArticle.blocks);
    expect(rtl).toContain('عنوان');
    expect(rtl).toContain('class="article-code"');
  });
});

describe('code languages', () => {
  test('maps engine ids and aliases to highlight.js grammars', () => {
    expect(grammarFor('html')).toBe('xml');
    expect(grammarFor('shell')).toBe('shell');
    expect(grammarFor('bash')).toBe('bash');
    expect(grammarFor('ts')).toBe('typescript');
    expect(grammarFor('toml')).toBe('ini');
    expect(grammarFor('erb')).toBe('erb');
    expect(grammarFor('cobol')).toBeNull();
    expect(languageLabel('cpp')).toBe('C++');
    expect(languageLabel('shell')).toBe('Console');
    expect(languageLabel('zig')).toBe('Zig');
  });

  test('highlights a named language and only accepts confident detection', async () => {
    const python = await highlightCode('def fib(n):\n    return n if n < 2 else fib(n - 1) + fib(n - 2)', 'python');
    expect(python?.html).toContain('<span class="hljs-keyword">def</span>');
    const rust = await highlightCode((everyBlock.blocks.find((b) => b.type === 'code' && b.language === null) as { code: string }).code, null);
    expect(rust?.language).toBe('rust');
    expect(await highlightCode('hello there', null)).toBeNull();
    expect(await highlightCode('plain words', 'plaintext')).toBeNull();
    expect(await highlightCode('x', 'cobol')).toBeNull();
  });

  test('highlights JSX inside JavaScript and CSS inside HTML', async () => {
    const jsx = await highlightCode('function App() {\n  return <main className="app">Hi</main>;\n}', 'jsx');
    expect(jsx?.html).toContain('<span class="hljs-name">main</span>');
    const html = await highlightCode('<style>\n  body { color: red; }\n</style>', 'html');
    expect(html?.html).toContain('hljs-attribute');
  });
});

describe('TeX', () => {
  test('converts TeX-only formulas to MathML and gives up on broken TeX', () => {
    const block = texToMathml(String.raw`$$ \frac{1}{\sqrt{1 - \beta_t}} $$`, true);
    expect(block?.startsWith('<math display="block"')).toBe(true);
    expect(block).toContain('<mfrac>');
    expect(block).toContain('<msqrt>');
    expect(texToMathml(String.raw`\alpha_t`, false)?.startsWith('<math>')).toBe(true);
    expect(texToMathml(String.raw`\frac{1}{2`, true)).toBeNull();
    expect(texToMathml('$$', true)).toBeNull();
  });
});
