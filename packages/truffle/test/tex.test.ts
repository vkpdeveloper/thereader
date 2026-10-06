import { expect, test } from 'bun:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { extract } from '../src/index';

// The same pages as packages/truffle_dart/test/tex_test.dart.

/** A page that uses TeX (`\(...\)`), with `paragraph` as its second block. */
function page(paragraph: string): string {
  const prose = 'Some long prose sentence here to pass thresholds. '.repeat(15);
  const more = 'More prose here to make the article long enough. '.repeat(10);
  return `<html><head><title>Tex test page</title></head><body><article><h1>Tex test page</h1><p>${prose}</p><p>${paragraph}</p><p>${more}</p></article></body></html>`;
}

function second(paragraph: string): unknown {
  const doc = new JSDOM(page(paragraph), { virtualConsole: new VirtualConsole() }).window.document;
  return extract(doc, { url: 'https://example.com/a' })?.blocks[1];
}

test('a formula after text holding a $ comes out once', () => {
  expect(second('Costs $5, see \\(x\\) here')).toEqual({
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Costs $5, see ' },
      { type: 'math', tex: 'x', text: 'x' },
      { type: 'text', text: ' here' },
    ],
  });
});

// These inputs used to loop forever (a nested call reset the shared pattern's lastIndex), which no
// in-process timeout can stop: extract them in a child process, killed on timeout.
test('TeX input that used to loop forever finishes', () => {
  const pages = [page('one \\(a\\) $ \\(b\\) end'), page('one \\(a\\) $ \\(b\\) and \\ \\(c\\) end')];
  const script = `
    import { JSDOM, VirtualConsole } from 'jsdom';
    import { extract } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).pathname)};
    const blocks = ${JSON.stringify(pages)}.map((html) =>
      extract(new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document, { url: 'https://example.com/a' }).blocks[1]);
    process.stdout.write(JSON.stringify(blocks));
  `;
  const run = Bun.spawnSync({ cmd: [process.execPath, '-e', script], cwd: new URL('..', import.meta.url).pathname, timeout: 10_000 });
  expect(run.exitCode).toBe(0);
  const text = (t: string) => ({ type: 'text', text: t });
  const math = (t: string) => ({ type: 'math', tex: t, text: t });
  expect(JSON.parse(run.stdout.toString())).toEqual([
    { type: 'paragraph', content: [text('one '), math('a'), text(' $ '), math('b'), text(' end')] },
    { type: 'paragraph', content: [text('one '), math('a'), text(' $ '), math('b'), text(' and \\ '), math('c'), text(' end')] },
  ]);
}, 15_000);
