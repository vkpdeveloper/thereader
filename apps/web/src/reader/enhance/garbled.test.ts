import * as bunTest from 'bun:test';
import { strFromU8, unzipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import { existsSync, readFileSync } from 'node:fs';
import { TextIndex } from '../epub/text';
import { decodeGarbledLine, isGarbledMath, type GarbledPiece } from './garbled';
import TABLE from './garbled-table.json';
import { enhanceContent, hydrateMath } from './index';
import { texToMathml } from './tex';

// Run with `cd apps/web && bun test src/reader/enhance`. Snippets imitate the
// garble of PDF conversions; they are not taken from any book.

const { describe, test } = bunTest;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const expect = bunTest.expect as unknown as (actual: unknown) => any;

const window = new JSDOM('').window;
const g = globalThis as Record<string, unknown>;
for (const name of ['Node', 'NodeFilter', 'DOMParser']) g[name] ??= (window as unknown as Record<string, unknown>)[name];

/** Pieces from a string where ‹…› marks italic text. */
function pieces(line: string): GarbledPiece[] {
  return line.split(/(‹[^›]*›)/).filter(Boolean).map((p) => (p.startsWith('‹') ? { text: p.slice(1, -1), italic: true } : { text: p, italic: false }));
}

/** The line with each formula replaced by ⟦its plain reading⟧. */
function read(line: string): string {
  const ps = pieces(line);
  const text = ps.map((p) => p.text).join('');
  let out = '';
  let at = 0;
  for (const run of decodeGarbledLine(ps)) {
    out += `${text.slice(at, run.start)}⟦${run.plain}⟧`;
    at = run.end;
  }
  return out + text.slice(at);
}

const tex = (line: string) => decodeGarbledLine(pieces(line)).map((r) => r.tex);

const FIXTURE: { cases: [string, string][] } = JSON.parse(readFileSync(new URL('../../../fixtures/garbled-lines.json', import.meta.url), 'utf8'));

describe('garbled formulas', () => {
  // Shared with the Dart decoder's tests (apps/mobile/test/garbled_math_test.dart).
  for (const [line, expected] of FIXTURE.cases) {
    test(line, () => expect(read(line)).toBe(expected));
  }

  test('TeX for ℂ, F^{m,n} and a dropped minus in T^{-1}', () => {
    expect(tex('for all x; y 2 C.')).toEqual(['x , y \\in \\mathbf{C}']);
    expect(tex('in Fm;n')).toEqual(['\\mathbf{F}^{m,n}']);
    expect(tex('so S 1 D S')).toEqual(['S^{-1} = S']);
  });

  test('hostile lines are linear and never throw', () => {
    for (const unit of ['W ', 'k ', 'f', 'h ', '.', '2 ', 'C ', 'ˇ', 'D D ', 'kx', ': ']) {
      const line = unit.repeat(Math.ceil(3990 / unit.length)).slice(0, 3990);
      const start = performance.now();
      decodeGarbledLine([{ text: line, italic: false }]);
      expect(performance.now() - start).toBeLessThan(500);
    }
    expect(decodeGarbledLine([{ text: 'x D y '.repeat(2000), italic: false }])).toEqual([]);
  });

  test('every TeX symbol in the table renders', () => {
    for (const [, texSource] of [...Object.values(TABLE.symbols), ...Object.values(TABLE.letterOps)]) {
      expect(texToMathml(`a ${texSource} b`, false)).not.toBeNull();
    }
  });
});

const GENERATOR = '<meta name="generator" content="pdftohtml 0.36"/>';

function xhtml(body: string, head = GENERATOR): Document {
  const source = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title>${head}</head><body>${body}</body></html>`;
  return new window.DOMParser().parseFromString(source, 'application/xhtml+xml') as unknown as Document;
}

function bodyOf(doc: Document): HTMLElement {
  return doc.getElementsByTagNameNS('*', 'body')[0] as HTMLElement;
}

const GARBLED = [
  '<p>Suppose x; y 2 R and x C y D 1.</p>',
  '<p>Then S D fx 2 R W x > 0g is not empty.</p>',
  '<p>hx; <i>y</i> i D 0 for all <i>y </i> 2 V.</p>',
  '<p>x C y D y C x</p>',
  '<p>Vitamin C is good for you, and Plan D is not; mix 2 cups.</p>',
  '<p>Ask René and Jørgen.</p>',
  '<p>for all ˛; ˇ 2 C we have ˛ C Ď ˇ C ˛.</p>',
  '<p>kxk2 D hx; xi and u1; : : : ; um 2 U.</p>',
].join('\n');

describe('garbled chapters', () => {
  test('gated on PDF conversions with the garble signature', () => {
    expect(isGarbledMath(xhtml(GARBLED), bodyOf(xhtml(GARBLED)))).toBe(true);
    // Not a PDF conversion.
    const epub = xhtml(GARBLED, '');
    expect(isGarbledMath(epub, bodyOf(epub))).toBe(false);
    // A PDF conversion whose math kept its Unicode.
    const unicode = xhtml(Array(6).fill('<p>Suppose x, y ∈ ℝ and x + y = 1 and ⟨x, y⟩ = 0 with x ≤ y.</p>').join('\n'));
    expect(isGarbledMath(unicode, bodyOf(unicode))).toBe(false);
    // A converted novel.
    const prose = xhtml(Array(20).fill('<p>Vitamin C and Plan D, 2 cups, René and Jørgen walked to the river.</p>').join('\n'));
    expect(isGarbledMath(prose, bodyOf(prose))).toBe(false);
  });

  test('formulas render after their hidden originals; book text is unchanged', async () => {
    const doc = xhtml(GARBLED);
    const body = bodyOf(doc);
    const before = new TextIndex(body).text;
    const raw = body.textContent;
    await enhanceContent(doc, body, { tex: texToMathml, highlight: null });
    hydrateMath(body, texToMathml);
    expect(new TextIndex(body).text).toBe(before);
    expect(body.textContent).toBe(raw);
    const hosts = Array.from(body.querySelectorAll('.tr-math'));
    expect(hosts.map((h) => h.getAttribute('aria-label'))).toEqual([
      'x,y∈R', 'x+y=1', 'S={x∈R:x>0}', '⟨x,y⟩=0', 'y∈V', 'x+y=y+x', 'α,β∈C', 'α+β=β+α', '‖x‖²=⟨x,x⟩', 'u₁,…,uₘ∈U',
    ]);
    for (const h of hosts) {
      expect(h.previousElementSibling!.getAttribute('class')).toBe('tr-hidden tr-math-source');
      expect(texToMathml(h.getAttribute('data-tr-tex')!, h.hasAttribute('data-tr-display'))).not.toBeNull();
    }
    // A line that is one formula is a display.
    expect(body.querySelectorAll('.tr-math-display').length).toBe(1);
    // Prose lines are untouched.
    const ps = Array.from(body.getElementsByTagNameNS('*', 'p'));
    expect(ps[4].querySelector('.tr-math')).toBeNull();
    expect(ps[5].querySelector('.tr-math')).toBeNull();
  });

  test('a prose book converted from PDF is byte-identical', async () => {
    const body = Array(20).fill('<p>Vitamin C and Plan D, 2 cups; René and Jørgen walked to the river C D.</p>').join('\n');
    const doc = xhtml(body);
    await enhanceContent(doc, bodyOf(doc), { tex: texToMathml, highlight: null });
    expect(bodyOf(doc).querySelector('.tr-math')).toBeNull();
  });
});

// The real book this rule was written for; skipped when the private copy is absent.
const BOOK = process.env.GARBLED_EPUB ?? '/tmp/ladr/books/ladr3e-v2.epub';
describe('real garbled book', () => {
  if (!existsSync(BOOK)) return;
  test('every chapter keeps its text and every formula renders', async () => {
    const zip = unzipSync(new Uint8Array(readFileSync(BOOK)));
    let formulas = 0;
    for (const name of Object.keys(zip).filter((k) => /\.x?html?$/.test(k))) {
      const doc = new window.DOMParser().parseFromString(strFromU8(zip[name]), 'application/xhtml+xml') as unknown as Document;
      const body = bodyOf(doc);
      if (!body) continue;
      const before = new TextIndex(body).text;
      await enhanceContent(doc, body, { tex: texToMathml, highlight: null });
      expect(new TextIndex(body).text).toBe(before);
      for (const h of Array.from(body.querySelectorAll('.tr-math'))) {
        formulas++;
        expect(texToMathml(h.getAttribute('data-tr-tex')!, h.hasAttribute('data-tr-display'))).not.toBeNull();
      }
    }
    expect(formulas).toBeGreaterThan(5000);
  }, 120_000);
});
