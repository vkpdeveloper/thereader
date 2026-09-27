import * as bunTest from 'bun:test';
import {
  blocksFromNodes,
  descriptionToPlainText,
  looksLikeHtml,
  parseDescription,
  safeHref,
  stripHtml,
  type RichNode,
} from './richText';

// Run with `cd apps/web && bun test src/lib/richText`.

const { describe, test } = bunTest;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const expect = bunTest.expect as unknown as (actual: unknown) => any;

/** Tiny DOM stand-in: `h('p', {}, 'text', h('em', {}, 'x'))`. */
type Child = RichNode | string;
const text = (value: string): RichNode => ({ nodeType: 3, nodeName: '#text', nodeValue: value, childNodes: [] });
const comment = (value: string): RichNode => ({ nodeType: 8, nodeName: '#comment', nodeValue: value, childNodes: [] });
function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): RichNode {
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    nodeValue: null,
    childNodes: children.map((c) => (typeof c === 'string' ? text(c) : c)),
    getAttribute: (name) => attrs[name] ?? null,
  };
}
const body = (...children: Child[]) => h('body', {}, ...children);
const walk = (...children: Child[]) => blocksFromNodes(body(...children));

describe('blocksFromNodes', () => {
  test('keeps paragraphs and allowlisted inline marks', () => {
    expect(walk(h('p', {}, 'The ', h('i', {}, 'essential'), ' universe'), h('p', {}, h('b', {}, 'What'), ' is it?'))).toEqual([
      { kind: 'p', children: [{ kind: 'text', text: 'The ' }, { kind: 'mark', tag: 'em', children: [{ kind: 'text', text: 'essential' }] }, { kind: 'text', text: ' universe' }] },
      { kind: 'p', children: [{ kind: 'mark', tag: 'strong', children: [{ kind: 'text', text: 'What' }] }, { kind: 'text', text: ' is it?' }] },
    ]);
  });

  test('drops dangerous elements with their contents and every attribute', () => {
    const blocks = walk(
      h('script', {}, 'alert(1)'),
      h('style', {}, 'p{color:red}'),
      h('p', { onclick: 'x()', style: 'color:red', class: 'c' }, 'Safe', h('img', { src: 'x', onerror: 'y' }), h('iframe', {}, 'frame')),
      h('svg', {}, h('a', { href: 'https://evil.test' }, 'svg link')),
      h('form', {}, h('input', { value: 'v' }), 'form text'),
      comment('<b>hidden</b>'),
    );
    expect(blocks).toEqual([{ kind: 'p', children: [{ kind: 'text', text: 'Safe' }] }]);
    expect(JSON.stringify(blocks)).not.toContain('onclick');
  });

  test('only keeps absolute http(s) and mailto links', () => {
    const blocks = walk(
      h('p', {},
        h('a', { href: 'https://example.com/a?b=1' }, 'web'), ' ',
        h('a', { href: 'mailto:me@example.com' }, 'mail'), ' ',
        h('a', { href: 'javascript:alert(1)' }, 'js'), ' ',
        h('a', { href: ' JaVaScRiPt:alert(1)' }, 'js2'), ' ',
        h('a', { href: 'data:text/html,x' }, 'data'), ' ',
        h('a', { href: '/relative' }, 'rel'), ' ',
        h('a', {}, 'bare'),
      ),
    );
    expect(blocks).toEqual([
      {
        kind: 'p',
        children: [
          { kind: 'link', href: 'https://example.com/a?b=1', children: [{ kind: 'text', text: 'web' }] },
          { kind: 'text', text: ' ' },
          { kind: 'link', href: 'mailto:me@example.com', children: [{ kind: 'text', text: 'mail' }] },
          { kind: 'text', text: ' ' },
          { kind: 'text', text: 'js' }, { kind: 'text', text: ' ' },
          { kind: 'text', text: 'js2' }, { kind: 'text', text: ' ' },
          { kind: 'text', text: 'data' }, { kind: 'text', text: ' ' },
          { kind: 'text', text: 'rel' }, { kind: 'text', text: ' ' },
          { kind: 'text', text: 'bare' },
        ],
      },
    ]);
  });

  test('unwraps nested links, spans, fonts and divs', () => {
    expect(
      walk(h('div', {}, h('font', { color: 'red' }, h('span', {}, h('a', { href: 'https://a.test' }, 'out ', h('a', { href: 'https://b.test' }, 'in')))))),
    ).toEqual([
      {
        kind: 'p',
        children: [{ kind: 'link', href: 'https://a.test/', children: [{ kind: 'text', text: 'out ' }, { kind: 'text', text: 'in' }] }],
      },
    ]);
  });

  test('collapses empty paragraphs and <br> runs into paragraph breaks', () => {
    const blocks = walk(
      h('p', {}, ' '),
      h('p', {}, h('br'), 'One', h('br'), 'line two', h('br'), ' ', h('br'), h('br'), 'Two', h('br')),
      h('p', {}, h('span', {}, '  ')),
    );
    expect(blocks).toEqual([
      { kind: 'p', children: [{ kind: 'text', text: 'One' }, { kind: 'br' }, { kind: 'text', text: 'line two' }] },
      { kind: 'p', children: [{ kind: 'text', text: 'Two' }] },
    ]);
  });

  test('wraps loose inline content and keeps headings, lists and quotes', () => {
    const blocks = walk(
      'Intro ',
      h('strong', {}, 'text'),
      h('h3', {}, 'Praise'),
      h('blockquote', {}, h('p', {}, 'Brilliant.')),
      h('ul', {}, '\n', h('li', {}, 'One'), h('li', {}, h('p', {}, 'Two')), h('li', {})),
      h('ol', {}, h('li', {}, 'First')),
    );
    expect(blocks).toEqual([
      { kind: 'p', children: [{ kind: 'text', text: 'Intro ' }, { kind: 'mark', tag: 'strong', children: [{ kind: 'text', text: 'text' }] }] },
      { kind: 'p', heading: true, children: [{ kind: 'text', text: 'Praise' }] },
      { kind: 'quote', children: [{ kind: 'p', children: [{ kind: 'text', text: 'Brilliant.' }] }] },
      {
        kind: 'list',
        ordered: false,
        items: [[{ kind: 'p', children: [{ kind: 'text', text: 'One' }] }], [{ kind: 'p', children: [{ kind: 'text', text: 'Two' }] }]],
      },
      { kind: 'list', ordered: true, items: [[{ kind: 'p', children: [{ kind: 'text', text: 'First' }] }]] },
    ]);
  });

  test('caps nesting depth by flattening deep subtrees to text', () => {
    let node: RichNode = h('em', {}, 'deep');
    for (let i = 0; i < 200; i++) node = h(i % 2 ? 'span' : 'div', {}, node, h('script', {}, 'x'));
    const blocks = walk(node);
    expect(descriptionToPlainText('<p>x</p>', () => body(node))).toBe('deep');
    expect(JSON.stringify(blocks)).not.toContain('"x"');
  });
});

describe('parseDescription', () => {
  test('plain text splits on blank lines and keeps single newlines as breaks', () => {
    expect(parseDescription('First para\nsame para.\n\n\n  Second   para.  \r\n \r\nThird')).toEqual([
      { kind: 'p', children: [{ kind: 'text', text: 'First para' }, { kind: 'br' }, { kind: 'text', text: 'same para.' }] },
      { kind: 'p', children: [{ kind: 'text', text: 'Second para.' }] },
      { kind: 'p', children: [{ kind: 'text', text: 'Third' }] },
    ]);
    expect(parseDescription('   ')).toEqual([]);
  });

  test('plain text with angle brackets is not treated as HTML', () => {
    expect(looksLikeHtml('x < y and y > z')).toBe(false);
    expect(looksLikeHtml('<p>x</p>')).toBe(true);
    expect(looksLikeHtml('Tom &amp; Jerry')).toBe(true);
    expect(descriptionToPlainText('x < y and y > z')).toBe('x < y and y > z');
  });

  test('uses the injected parser for HTML', () => {
    let seen = '';
    const blocks = parseDescription('<p>A</p>', (html) => {
      seen = html;
      return body(h('p', {}, 'A'));
    });
    expect(seen).toBe('<p>A</p>');
    expect(blocks).toEqual([{ kind: 'p', children: [{ kind: 'text', text: 'A' }] }]);
  });

  test('falls back to tag stripping without a DOM parser', () => {
    const html =
      '<p>The essential universe&hellip;</p><script>alert("x")</script><p>What is the <em>nature</em> of&nbsp;reality?<br>Line&#33;</p><!-- c --><ul><li>One</li><li>Two &amp; three</li></ul>';
    expect(stripHtml(html)).toBe('The essential universe…\n\nWhat is the nature of reality?\nLine!\n\nOne\n\nTwo & three');
    expect(descriptionToPlainText(html, () => null)).toBe(
      'The essential universe…\n\nWhat is the nature of reality?\nLine!\n\nOne\n\nTwo & three',
    );
    // Under bun there is no DOMParser, so the default path exercises the same fallback.
    if (typeof DOMParser === 'undefined') expect(descriptionToPlainText(html)).toBe(descriptionToPlainText(html, () => null));
  });
});

describe('descriptionToPlainText', () => {
  test('flattens blocks without leaking markup', () => {
    const tree = body(
      h('p', {}, 'Hello ', h('a', { href: 'https://x.test' }, 'world'), h('br'), 'again'),
      h('blockquote', {}, 'Quote'),
      h('ul', {}, h('li', {}, 'a'), h('li', {}, 'b')),
    );
    expect(descriptionToPlainText('<p>ignored</p>', () => tree)).toBe('Hello world\nagain\n\nQuote\n\n• a\n• b');
  });
});

describe('safeHref', () => {
  test('normalises allowed schemes and rejects the rest', () => {
    expect(safeHref('  https://example.com  ')).toBe('https://example.com/');
    expect(safeHref('http://example.com/x')).toBe('http://example.com/x');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('vbscript:x')).toBeNull();
    expect(safeHref('#top')).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
});
