import { BLOCKS, closest, create, hasClass, inProtected, nameOf, textNodes, UI_ATTR } from './dom';
import TABLE from './garbled-table.json';
import { makeHost } from './math';
import { isPdfConversion } from './pdf';

/**
 * Decoder for math that a PDF-to-HTML converter extracted from TeX fonts
 * without Unicode maps (pdftohtml, usually through calibre). Each glyph came
 * out as its raw font code read as text: the operator font gives `D` for =,
 * `C` for + and `2` for ∈, Greek italics come out as spacing accents (`˛` for
 * α) that NFC then fused onto the next letter (`Ď` is "β ="), and glyphs at
 * control-code positions (minus, λ, ≤ …) were dropped, leaving a wider gap.
 * Scripts are flattened inline (`R3`, `u1`, `T 1`).
 *
 * The letters are destroyed, so this is a reading, not a conversion: each
 * line is split into prose and math by a small grammar (operands alternate
 * with operators, which decides whether `C` is + or ℂ), and each math run
 * becomes TeX. Gated by the caller on strong signals; everything here is
 * linear in the text and never throws.
 */

type Kind = 'var' | 'rel' | 'bin' | 'post';

/** Spacing accents a combining mark came from, for the marks NFC fused onto a following letter. */
const MARKS: Record<string, string> = TABLE.marks;
const SYMBOLS = TABLE.symbols as unknown as Record<string, [Kind, string, string]>;
const LETTER_OPS = TABLE.letterOps as unknown as Record<string, [Kind, string, string]>;
const FIELDS = new Set(TABLE.fields);
const CALLIGRAPHIC = new Set(TABLE.calligraphic);
const FUNCTIONS = new Set(TABLE.functions);
const WORDS = new Set(TABLE.words.split(' '));
/** Short common words that are also a letter with an index (`an` is a_n in "a1; : : : ; an"). */
const INDEXABLE = new Set(TABLE.commonOverride.split(' '));

/** One piece of a line's text, in order; italic pieces come from `<i>`/`<em>`. */
export interface GarbledPiece {
  text: string;
  italic: boolean;
}

/** A decoded formula: `[start, end)` into the concatenated piece texts. */
export interface GarbledRun {
  start: number;
  end: number;
  tex: string;
  /** Linear Unicode reading of the formula (accessibility and tests). */
  plain: string;
}

/** Longest line decoded; PDF lines are short, a longer "line" is not one. */
const MAX_LINE = 4000;
/** How far ahead an opening `f`, `h`, `k` or `j` looks for its partner. */
const PAIR_WINDOW = 48;

// ---------------------------------------------------------------- lexing

interface Atom {
  /** The (expanded) character, or a whole function name. */
  s: string;
  at: number;
  end: number;
  /** Whitespace before the atom, adjusted for italic boundaries; 0 when glued to the previous atom. */
  gap: number;
  italic: boolean;
  word: number;
  /** A prose word an accent was fused onto ("ąnd"): shown as text inside the formula. */
  text?: string;
}

type WordClass = 'prose' | 'math' | 'weak' | 'func' | 'unknown';

interface Word {
  atoms: Atom[];
  text: string;
  cls: WordClass;
  /** Contains something only a garbled formula has. */
  strong: boolean;
}

const DECOMPOSED = new Map<string, [string, string]>();
for (const base of 'ACDEGIKLNORSTUWZaceginorsuwz') {
  for (const mark of Object.keys(MARKS)) {
    const composed = (base + mark).normalize('NFC');
    if (composed.length === 1) DECOMPOSED.set(composed, [MARKS[mark], base]);
  }
}

const MARKS_SPACING = new Set(Object.values(MARKS));
const isLetter = (c: string) => /^[A-Za-z]$/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

/** Splits a line into words of atoms, expanding fused accents where the result reads right. */
function lex(pieces: GarbledPiece[]): Word[] {
  const chars: { c: string; at: number; italic: boolean }[] = [];
  const edges = new Set<number>();
  let offset = 0;
  let wasItalic = false;
  for (const p of pieces) {
    if (p.italic !== wasItalic) edges.add(chars.length);
    wasItalic = p.italic;
    for (let i = 0; i < p.text.length; i++) chars.push({ c: p.text[i], at: offset + i, italic: p.italic });
    offset += p.text.length;
  }
  if (wasItalic) edges.add(chars.length);
  const words: Word[] = [];
  let i = 0;
  while (i < chars.length) {
    // Whitespace before the word; converters add one space at a font change.
    let gap = 0;
    let edge = edges.has(i);
    while (i < chars.length && /\s/.test(chars[i].c)) {
      gap++;
      i++;
      if (edges.has(i)) edge = true;
    }
    if (i >= chars.length) break;
    if (edge && gap > 0) gap--;
    const start = i;
    while (i < chars.length && !/\s/.test(chars[i].c)) i++;
    words.push(makeWord(chars.slice(start, i), words.length === 0 ? 1 : gap, words.length));
  }
  return words;
}

function makeWord(chars: { c: string; at: number; italic: boolean }[], gap: number, index: number): Word {
  const raw = chars.map((c) => c.c).join('');
  // Fused accents: "Ď" is β followed by "=", "ąnd" is α followed by "and".
  const expanded: { c: string; at: number; italic: boolean }[] = [];
  for (let k = 0; k < chars.length; k++) {
    const split = DECOMPOSED.get(chars[k].c);
    if (split && fusedAccent(raw, k, split[1])) {
      expanded.push({ ...chars[k], c: split[0] }, { ...chars[k], c: split[1] });
    } else expanded.push(chars[k]);
  }
  const text = expanded.map((c) => c.c).join('');
  if (expanded.length > chars.length && MARKS_SPACING.has(text[0]) && /^[A-Za-z]{2,}[.,;:]?$/.test(text.slice(1)) && WORDS.has(text.slice(1).replace(/[.,;:]$/, '').toLowerCase())) {
    // "ąnd": α, then the word "and" the accent was fused onto.
    const first = chars[0];
    const last = chars[chars.length - 1];
    return {
      atoms: [
        { s: text[0], at: first.at, end: first.at + 1, gap, italic: first.italic, word: index },
        { s: 'text', text: text.slice(1), at: first.at, end: last.at + 1, gap: 0, italic: first.italic, word: index },
      ],
      text,
      cls: 'math',
      strong: true,
    };
  }
  const atoms: Atom[] = [];
  for (let k = 0; k < expanded.length; k++) {
    const ch = expanded[k];
    atoms.push({ s: ch.c, at: ch.at, end: ch.at + 1, gap: k === 0 ? gap : 0, italic: ch.italic, word: index });
  }
  const { cls, strong } = classify(text);
  return { atoms: mergeAtoms(atoms, cls), text, cls, strong };
}

/** Whether a precomposed letter at `k` of `word` is a fused accent and not a real accented letter. */
function fusedAccent(word: string, k: number, base: string): boolean {
  const before = word.slice(0, k);
  const after = word.slice(k + 1);
  if (/[A-Za-z]$/.test(before) && !/[˛ˇˆ˚]$/.test(before)) {
    // Inside a run of letters: only an operator glued into a formula ("˛Ď").
    return 'DCW'.includes(base) && !/^[a-z]/.test(after);
  }
  if ('DCW'.includes(base)) return !/^[a-z]/.test(after);
  // At a word start: the base begins a common word ("ąnd", "îs") or is a lone variable ("û").
  const rest = (base + after).replace(/[.,;:]+$/, '');
  return WORDS.has(rest.toLowerCase()) || /^[A-Za-z]$/.test(rest);
}

/** Groups function names and `:::` into single atoms. */
function mergeAtoms(atoms: Atom[], cls: WordClass): Atom[] {
  if (cls === 'prose') return atoms;
  const out: Atom[] = [];
  for (let k = 0; k < atoms.length; k++) {
    const a = atoms[k];
    if (isLetter(a.s) && (k === 0 || !isLetter(atoms[k - 1].s) || /^[hjk]$/.test(atoms[k - 1].s))) {
      let run = '';
      for (let m = k; m < atoms.length && isLetter(atoms[m].s) && run.length < 8; m++) run += atoms[m].s;
      let name = '';
      for (let len = Math.min(run.length, 5); len >= 2; len--) {
        const cand = run.slice(0, len);
        if (FUNCTIONS.has(cand) && (run.length - len <= 2 || !/^[a-z]/.test(run.slice(len)))) {
          name = cand;
          break;
        }
      }
      if (name) {
        out.push({ ...a, s: name, end: atoms[k + name.length - 1].end });
        k += name.length - 1;
        continue;
      }
    }
    if (a.s === ':' && atoms[k + 1]?.s === ':' && atoms[k + 2]?.s === ':') {
      out.push({ ...a, s: ':::', end: atoms[k + 2].end });
      k += 2;
      continue;
    }
    out.push(a);
  }
  return out;
}

const GARBLE = /[˛ˇˆ¿¤¨˚\\ıŠŒ…]/;
const OPERATOR_WORD = /^[DCW2![<>]$/;

/** Prose, math, or undecided, from the word alone (context settles the rest). */
function classify(text: string): { cls: WordClass; strong: boolean } {
  const core = text.replace(/^[(“"]+/, '').replace(/[.,;:?!)”"’]+$/, '');
  if (/^[<>]$/.test(text)) return { cls: 'weak', strong: false };
  if (/^[RCF][nm\d](;[nm\d])?[.,;:]?$/.test(text)) return { cls: 'math', strong: true };
  if (!core || core === '/') return { cls: /^[.\/;]+$/.test(text) ? 'math' : 'weak', strong: /\//.test(text) };
  if (GARBLE.test(text) || /^'[\w;:./]*$/.test(text)) return { cls: 'math', strong: true };
  if (/^[A-Za-z]+$/.test(core)) {
    const lower = core.toLowerCase();
    if (core.length === 1) return { cls: 'weak', strong: false };
    if (FUNCTIONS.has(core)) return { cls: 'func', strong: false };
    if (/^[jkh](det|dim|trace|Re|Im)$/.test(core)) return { cls: 'math', strong: true };
    if (/^[kj][A-Za-z]{1,2}[kj]$/.test(core) || /^[RCF][nm]$/.test(core)) return { cls: 'math', strong: true };
    if (WORDS.has(lower) && !(core.length > 1 && /^[A-Z][A-Z]$/.test(core))) return { cls: 'prose', strong: false };
    // "ui": an operand and the closing ⟨ ⟩ bracket.
    if (/^[A-Za-z][jkmn]?i$/.test(core)) return { cls: 'math', strong: false };
    // Letters with indices run together: "anen" is a_n e_n, "enien" e_n⟩e_n, "kukk" ‖u‖‖.
    if (/^([a-z][jkmn])+$/.test(core) || /^[a-z][jkmn]i[a-z][jkmn]$/.test(core) || /^k[a-z]kk?$/.test(core)) return { cls: 'math', strong: true };
    if (core.length >= 4) return { cls: 'prose', strong: false };
    if (/^(f[a-z0-9]$|h[A-Za-z]|[kj][A-Z])/.test(core) || /[a-zA-Z]g$/.test(core) || /^[A-Z][A-Z]$/.test(core)) return { cls: 'math', strong: false };
    return { cls: 'unknown', strong: false };
  }
  // Letters with digits, dots and slashes: "u1;", "R3", ".a", "f0g", "nC1", "kuk2".
  if (/^\.[A-Za-z0-9.]/.test(text) || /[A-Za-z0-9]\/[.,;:]*$/.test(text) || /^[\w;.]*\/\.?[\w;.]*$/.test(text) && !/[A-Za-z]{4}/.test(text)) return { cls: 'math', strong: true };
  if (/^([A-Za-z]|[a-z]{2,5})\.[A-Za-z0-9]{1,3}[.,;:]?$/.test(text) && !/^[a-z]\.[a-z]\.?$/.test(text) && (text[1] === '.' || FUNCTIONS.has(text.slice(0, text.indexOf('.'))))) return { cls: 'math', strong: true };
  if (/^\?[\/.;,]/.test(text) || /^[\w.]*=[A-Za-z0-9.]+[.,;:]?$/.test(text)) return { cls: 'math', strong: true };
  if (/^[A-Za-z]{1,3}\d{1,2}$/.test(core) || /^f\S*g$/.test(core) || /^[kj]\S+[kj]\d?$/.test(core)) return { cls: 'math', strong: true };
  if (/^\d+$/.test(core)) return { cls: 'weak', strong: false };
  if (/^[\w;=]+$/.test(core) && /\d/.test(core) && /[A-Za-z;=]/.test(core)) return { cls: 'math', strong: true };
  if (/^[\w;=.:/]+$/.test(core)) return { cls: 'unknown', strong: false };
  return { cls: 'prose', strong: false };
}

// ---------------------------------------------------------------- runs

/** Words of the math runs in a line: consecutive non-prose words with a garbled signal. */
function findRuns(words: Word[]): [number, number][] {
  // Undecided words lean towards a math neighbour.
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (w.cls !== 'unknown') continue;
    const near = (j: number) => j >= 0 && j < words.length && (words[j].cls === 'math' || words[j].strong || OPERATOR_WORD.test(words[j].text));
    w.cls = near(k - 1) || near(k + 1) ? 'weak' : 'prose';
  }
  // Common words that are also a letter with an index, inside a list ("a1; : : : ; an").
  for (let k = 1; k < words.length; k++) {
    const w = words[k];
    const prev = words[k - 1];
    if (w.cls === 'prose' && INDEXABLE.has(w.text.replace(/[.,;:]+$/, '')) && (/;$/.test(prev.text) && prev.cls !== 'prose' || /^[CD]$/.test(prev.text))) {
      w.cls = 'weak';
    }
  }
  const runs: [number, number][] = [];
  let k = 0;
  while (k < words.length) {
    if (words[k].cls === 'prose') {
      k++;
      continue;
    }
    let end = k;
    // A text colon ends a formula ("D 0: 2 2" is a fraction's leftovers); the operator font's colon is W.
    while (end < words.length && words[end].cls !== 'prose') {
      end++;
      if (/[^:]:$/.test(words[end - 1].text)) break;
    }
    let a = k;
    let b = end - 1;
    // Articles and the pronoun at the edges belong to the prose.
    const article = (w: Word) => /^(a|A|I)$/.test(w.text);
    const operatorAt = (j: number) => j >= a && j <= b && (OPERATOR_WORD.test(words[j].text) || /^[¤¨˚\\[!]$/.test(words[j].text));
    while (a <= b && article(words[a]) && !operatorAt(a + 1) && !(a < b && words[a + 1].atoms[0].gap >= 2)) a++;
    while (b >= a && (article(words[b]) || words[b].cls === 'func') && !operatorAt(b - 1)) b--;
    if (a <= b && hasSignal(words, a, b)) runs.push([a, b]);
    k = end;
  }
  return runs;
}

/** A garbled glyph, a garbled-only word, or an operator letter between two operands. */
function hasSignal(words: Word[], a: number, b: number): boolean {
  let angle = false;
  let comma = false;
  for (let j = a; j <= b; j++) {
    if (words[j].strong) return true;
    // An inner product: "h" … ";" … "i".
    if (/^h/.test(words[j].text) && words[j].cls !== 'prose') angle = true;
    if (angle && /;$/.test(words[j].text)) comma = true;
    if (comma && /i$/.test(words[j].text)) return true;
    // A display's continuation line: "D h T v; v i".
    if (j === a && /^[DC]$/.test(words[j].text) && b - a >= 2) return true;
    // ‖v‖ or |z| spelled out: "k v k".
    if (j + 2 <= b && /^[kj]$/.test(words[j].text) && words[j + 2].text.startsWith(words[j].text) && words[j + 1].text.length === 1) return true;
    if (!OPERATOR_WORD.test(words[j].text)) continue;
    if (j > a && j < b && (words[j].text !== '2' || operandish(words[j - 1]) && operandish(words[j + 1]))) return true;
    // Beside a dropped glyph's gap: "C 0 D  and".
    if ((j > a && operandish(words[j - 1]) || j < b && operandish(words[j + 1])) && (words[j].atoms[0].gap >= 2 || (words[j + 1]?.atoms[0].gap ?? 0) >= 2)) return true;
  }
  return false;
}

function operandish(w: Word): boolean {
  return w.cls !== 'prose' && !OPERATOR_WORD.test(w.text) && /[A-Za-z0-9˛ˇˆ'¿.]/.test(w.text[0] ?? '');
}

// ---------------------------------------------------------------- formulas

interface Part {
  tex: string;
  plain: string;
  /** operand, operator, opener, closer */
  role: 'x' | 'op' | 'open' | 'close' | 'fn';
  sub?: boolean;
  sup?: boolean;
}

/** What a dropped binary glyph most likely was, and a dropped operand. */
export const DROPPED_BINARY: [string, string] = ['-', '−'];
export const DROPPED_OPERAND: [string, string] = ['\\lambda', 'λ'];
/** An ordinary ⋯, so the operators beside it keep their binary spacing in MathML. */
const CDOTS = '\\mathord{\\cdots}';

const INDEX_LETTER = /^[jkmn]$/;

class Builder {
  parts: Part[] = [];
  stack: string[] = [];

  push(tex: string, plain: string, role: Part['role']): void {
    this.parts.push({ tex, plain, role });
  }

  last(): Part | undefined {
    return this.parts[this.parts.length - 1];
  }

  /** Attaches a script to the last part. */
  script(kind: 'sub' | 'sup', tex: string, plain: string): void {
    const base = this.last();
    if (!base) {
      this.push(tex, plain, 'x');
      return;
    }
    if (base[kind]) {
      base.tex = `{${base.tex}}`;
      base.sub = base.sup = false;
    }
    base.tex += `${kind === 'sub' ? '_' : '^'}{${tex}}`;
    base.plain += plain.length === 1 ? (kind === 'sub' ? subscript(plain) : superscript(plain)) : `${kind === 'sub' ? '_' : '^'}(${plain})`;
    base[kind] = true;
  }
}

const SUP: Record<string, string> = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', n: 'ⁿ', m: 'ᵐ', k: 'ᵏ', j: 'ʲ', '−': '⁻', '+': '⁺', T: 'ᵀ', '′': '′', '⊥': '⊥' };
const SUB: Record<string, string> = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', n: 'ₙ', m: 'ₘ', k: 'ₖ', j: 'ⱼ', '+': '₊' };
const superscript = (s: string) => [...s].map((c) => SUP[c] ?? c).join('');
const subscript = (s: string) => [...s].map((c) => SUB[c] ?? c).join('');

/** TeX and plain text for an operand letter. */
function letter(a: Atom, field: boolean): [string, string] {
  if (field && FIELDS.has(a.s)) return [`\\mathbf{${a.s}}`, a.s];
  if (a.italic && CALLIGRAPHIC.has(a.s)) return [`\\mathcal{${a.s}}`, a.s];
  return [a.s, a.s];
}

/**
 * The formula for atoms `[from, to)`; null when it does not read as one.
 * A single left-to-right pass: `expect` is true where an operand belongs,
 * which decides between the readings of `C`, `D`, `W`, `2`, `.` and `;`.
 */
function formula(atoms: Atom[], lastOfLine: boolean, droppedAfter: boolean): { tex: string; plain: string } | null {
  const b = new Builder();
  let expect = true;
  const n = atoms.length;
  const at = (k: number) => atoms[k];
  const glued = (k: number) => k < n && atoms[k].gap === 0;

  const startsOperand = (k: number): boolean => {
    const a = atoms[k];
    if (!a) return false;
    if (a.s === '.' || a.s === 'Œ' || isDigit(a.s) || FUNCTIONS.has(a.s) || a.s === ':::') return true;
    if (SYMBOLS[a.s]) return SYMBOLS[a.s][0] === 'var';
    if (a.s === 'D' || a.s === 'W') {
      // A letter unless it stands between operands (not recursive: hostile input repeats them).
      const next = atoms[k + 1];
      if (!next || next.gap === 0) return true;
      return !(isLetter(next.s) || isDigit(next.s) || next.s === '.' || next.s === 'f' || SYMBOLS[next.s]?.[0] === 'var');
    }
    return isLetter(a.s);
  };

  /** `C`, `D` or `W` standing between two operands (or before `⋯`). */
  const opLetter = (k: number): boolean => {
    const a = atoms[k];
    if (!a || !LETTER_OPS[a.s] || a.gap === 0 || k + 1 >= n || atoms[k + 1].gap === 0) return false;
    return startsOperand(k + 1) || atoms[k + 1].s === 'h' || (atoms[k + 1].gap >= 3 && atoms[k + 1].s === a.s);
  };

  /** A later atom `s` within the window, before the run ends or `stop` appears. */
  const ahead = (k: number, s: string, needComma = false): number => {
    let comma = !needComma;
    for (let m = k + 1; m < n && m <= k + PAIR_WINDOW; m++) {
      if (atoms[m].s === ';') comma = true;
      if (atoms[m].s === s && m > k + 1 && comma) {
        const prev = atoms[m - 1].s;
        if (isLetter(prev) || isDigit(prev) || prev === '/' || SYMBOLS[prev]?.[0] === 'var' || prev === 'g' || prev === 'k' || prev === 'j') return m;
      }
    }
    return -1;
  };

  let jump = 0;
  for (let k = 0; k < n; k = Math.max(k + 1, jump)) {
    jump = 0;
    const a = at(k);
    const s = a.s;

    if (s === 'text') {
      // The prose word an accent was fused onto ends this formula.
      const space = k < n - 1 ? ' ' : '';
      b.push(`\\text{ ${a.text}${space}}`, ` ${a.text}${space}`, 'op');
      expect = true;
      continue;
    }

    // A dropped glyph left a wider gap.
    if (a.gap >= 2 && k > 0) {
      const same = atoms[k - 1].s === s && (LETTER_OPS[s] || SYMBOLS[s]?.[0] === 'bin' || SYMBOLS[s]?.[0] === 'rel');
      if (same) {
        b.push(CDOTS, '⋯', 'x');
        expect = false;
      } else if (!expect && (startsOperand(k) || s === 'h' || s === 'k' || s === 'j' || s === 'f') && !(s === '2' && k + 1 < n && atoms[k + 1].gap > 0 && startsOperand(k + 1))) {
        const prev = b.last()?.tex ?? '';
        if (a.gap >= 4) b.push(CDOTS, '⋯', 'x');
        else if (/^\d+$/.test(prev) && (isDigit(s) || s === '.') || prev === ')' && isDigit(s)) b.push('\\cdot', '·', 'op');
        else b.push(DROPPED_BINARY[0], DROPPED_BINARY[1], 'op');
        expect = true;
      } else if (expect && b.last()?.role === 'op' && s !== 'text') {
        // ";  2 C": an operand was dropped.
        b.push(DROPPED_OPERAND[0], DROPPED_OPERAND[1], 'x');
        expect = false;
      }
    }
    if (k === 0 && (s === ';' || a.gap >= 2 && (LETTER_OPS[s] || s === '2' || SYMBOLS[s] && SYMBOLS[s][0] !== 'var') && k + 1 < n)) {
      // The run opens on an operator: its left operand was dropped ("for all  2 C").
      b.push(DROPPED_OPERAND[0], DROPPED_OPERAND[1], 'x');
      expect = false;
    }

    // Operators spelled with letters, by position.
    if (LETTER_OPS[s] && !(glued(k + 1) && isLetter(atoms[k + 1].s) && expect)) {
      const [, tex, plain] = LETTER_OPS[s];
      if (!expect) {
        if (s === 'C' && a.gap === 0 && k === n - 1 && b.last()?.role === 'close') {
          // (AB)C: a matrix C after a product.
          b.push('C', 'C', 'x');
          continue;
        }
        if (s === 'C' && a.gap === 0 && b.last()?.role === 'x' && /^[A-Z]$/.test(atoms[k - 1].s) && !(glued(k + 1) && startsOperand(k + 1))) {
          // T_C, the complexification.
          b.script('sub', '\\mathbf{C}', 'C');
          continue;
        }
        b.push(tex, plain, 'op');
        expect = true;
        continue;
      }
      if (s === 'C' && !glued(k + 1) && k + 1 < n && startsOperand(k + 1) && !(k === 0 && n === 1)) {
        // "C 0 D" opening a line: + with its left operand dropped, or ℂ before more math.
        if (k === 0 || b.last()?.role === 'op' || b.last()?.role === 'open') {
          if (k > 0) {
            b.push('\\mathbf{C}', 'C', 'x');
            expect = false;
            continue;
          }
          b.push(DROPPED_OPERAND[0], DROPPED_OPERAND[1], 'x');
          b.push(tex, plain, 'op');
          continue;
        }
      }
      if (s === 'D' && n > 1 && !glued(k + 1) && !opLetter(k + 1)) {
        // A continuation line of a display ("D 8 C 10i"), or = after a dropped operand.
        if (k > 0) b.push(DROPPED_OPERAND[0], DROPPED_OPERAND[1], 'x');
        b.push(tex, plain, 'op');
        expect = true;
        continue;
      }
      if (s === 'C' && k > 0 && !glued(k + 1) && startsOperand(k + 1) && /^[+\-(]$|^\\cdot$/.test(b.last()?.tex ?? '')) {
        b.push(DROPPED_OPERAND[0], DROPPED_OPERAND[1], 'x');
        b.push(tex, plain, 'op');
        expect = true;
        continue;
      }
      if (s === 'C') {
        b.push('\\mathbf{C}', 'C', 'x');
        expect = false;
        fieldScripts(k);
        continue;
      }
      // D or W as a letter.
    }

    if (isLetter(s) && s.length === 1) {
      if (s === 'f' && glued(k + 1) && (ahead(k, 'g') > 0 || atoms[k + 1].s === '.' && ahead(k, 'W') > 0)) {
        if (!expect) b.push('', '', 'op');
        b.push('\\{', '{', 'open');
        b.stack.push('{');
        expect = true;
        continue;
      }
      if (s === 'g' && !expect && b.stack[b.stack.length - 1] === '{') {
        b.stack.pop();
        b.push('\\}', '}', 'close');
        expect = false;
        closeScripts(k);
        continue;
      }
      if (s === 'h' && (k + 1 < n) && ahead(k, 'i', true) > 0) {
        b.push('\\langle', '⟨', 'open');
        b.stack.push('<');
        expect = true;
        continue;
      }
      if (s === 'i' && !expect && b.stack[b.stack.length - 1] === '<') {
        b.stack.pop();
        b.push('\\rangle', '⟩', 'close');
        expect = false;
        closeScripts(k);
        continue;
      }
      if (s === 'i' && !expect && a.gap === 0 && !b.stack.length && (k + 1 >= n || atoms[k + 1].gap > 0) && b.parts.some((p) => p.tex === ',') && (b.last()?.sub || isDigit(atoms[k - 1].s))) {
        // "ej ; eki D 0": the ⟨ was on the previous line.
        b.push('\\rangle', '⟩', 'close');
        expect = false;
        continue;
      }
      if (!expect && a.gap === 1 && /^[A-Z]$/.test(atoms[k - 1]?.s ?? '') && INDEX_LETTER.test(s) && !(glued(k + 1) && isLetter(atoms[k + 1].s) && atoms[k + 1].s !== 'C')) {
        // T k: a power of an operator.
        superscriptGroup(k);
        continue;
      }
      if ((s === 'k' || s === 'j') && !expect && b.stack[b.stack.length - 1] === s) {
        b.stack.pop();
        b.push(s === 'k' ? '\\|' : '|', s === 'k' ? '‖' : '|', 'close');
        expect = false;
        closeScripts(k);
        continue;
      }
      if ((s === 'k' || s === 'j') && (a.gap > 0 || expect || b.last()?.role === 'close' || atoms[k + 1]?.gap > 0) && k + 1 < n && !isDigit(atoms[k + 1].s) && (s === 'k' || glued(k + 1)) && (startsOperand(k + 1) || atoms[k + 1].s === 'h') && ahead(k, s) > 0) {
        if (!expect && b.last()?.role !== 'close') b.push('', '', 'op');
        b.push(s === 'k' ? '\\|' : '|', s === 'k' ? '‖' : '|', 'open');
        b.stack.push(s);
        expect = true;
        continue;
      }
      if (s === 'j' && !expect && a.gap > 0 && glued(k + 1) && /^[A-Z]$/.test(atoms[k + 1].s)) {
        // T jU: the restriction T|_U.
        b.push('|', '|', 'close');
        b.script('sub', atoms[k + 1].s, atoms[k + 1].s);
        jump = k + 2;
        expect = false;
        continue;
      }
      if (s === 'N' && glued(k + 1) && (a.gap > 0 || k === 0) && !INDEX_LETTER.test(atoms[k + 1].s) && (isLetter(atoms[k + 1].s) || SYMBOLS[atoms[k + 1].s]?.[0] === 'var')) {
        if (atoms[k + 1].s === 'h') {
          b.push(`\\bar{${DROPPED_OPERAND[0]}}`, `${DROPPED_OPERAND[1]}̄`, 'x');
          expect = false;
          continue;
        }
        const next = atoms[k + 1];
        const [tex, plain] = SYMBOLS[next.s] ? [SYMBOLS[next.s][1], SYMBOLS[next.s][2]] : letter(next, false);
        b.push(`\\overline{${tex}}`, `${plain}̄`, 'x');
        expect = false;
        jump = k + 2;
        continue;
      }
      if (s === 'X' && expect && k + 1 < n && atoms[k + 1].gap > 0 && startsOperand(k + 1) && (k === 0 || b.last()?.role === 'op')) {
        b.push('\\sum', '∑', 'op');
        continue;
      }
      if (!expect && a.gap === 0) {
        // Glued to an operand: an index, or a product.
        const prev = atoms[k - 1].s;
        if ((INDEX_LETTER.test(s) || s === 'i' && atoms[k + 1]?.s === ';' && glued(k + 1) && glued(k + 2)) && (isLetter(prev) || SYMBOLS[prev]?.[0] === 'var') && !INDEX_LETTER.test(prev)) {
          subscriptGroup(k);
          continue;
        }
      }
      const field = FIELDS.has(s) && !(glued(k + 1) && isLetter(atoms[k + 1].s) && !/^[jkmnSgi]$/.test(atoms[k + 1].s) && !FIELDS.has(atoms[k + 1].s)) && !(k > 0 && a.gap === 0 && isLetter(atoms[k - 1].s));
      const [tex, plain] = letter(a, field);
      b.push(tex, plain, 'x');
      expect = false;
      if (field) fieldScripts(k);
      else closeScripts(k, true);
      continue;
    }

    if (FUNCTIONS.has(s)) {
      b.push(`\\operatorname{${s}}`, s, 'fn');
      expect = true;
      continue;
    }

    if (isDigit(s)) {
      if (s === '2' && !expect && a.gap > 0 && k + 1 < n && (startsOperand(k + 1) || atoms[k + 1].s === 'f' || atoms[k + 1].s === 'h') && atoms[k + 1].gap > 0 && !opLetter(k + 1)) {
        b.push('\\in', '∈', 'op');
        expect = true;
        continue;
      }
      let num = s;
      let m = k + 1;
      while (m < n && atoms[m].gap === 0 && isDigit(atoms[m].s)) num += atoms[m++].s;
      if (!expect && a.gap === 0) {
        // u1, A1;k: an index.
        const prev = atoms[k - 1].s;
        if (/^[23]$/.test(num) && /^[nm]$/.test(prev) && b.last()?.tex === prev) {
          // n2: dimensions are squared, not indexed.
          b.script('sup', num, num);
          jump = m;
          continue;
        }
        if (/^0{1,3}$/.test(num) && /^[fgpq]$/.test(prev) && b.last()?.tex === prev) {
          // p0: the derivative p′ (the prime glyph is the symbol font's 0).
          b.script('sup', '\\prime'.repeat(num.length), '′'.repeat(num.length));
          jump = m;
          continue;
        }
        if (prev === '/' || prev === 'k' && b.last()?.role === 'close' || prev === 'j' && b.last()?.role === 'close' || prev === 'g') {
          b.script('sup', num, num);
          jump = m;
          continue;
        }
        subscriptGroup(k);
        continue;
      }
      if (!expect && a.gap === 1 && !(m < n && atoms[m].gap > 0 && startsOperand(m) && !opLetter(m))) {
        // T 1, V 0, i 2: a raised script whose minus or prime was dropped.
        const prev = atoms[k - 1];
        if (num === '0' && /^[A-Zfgpq]$/.test(prev.s)) b.script('sup', '\\prime', '′');
        else if (num === '1' && /^[A-Z]$/.test(prev.s)) b.script('sup', '-1', '−1');
        else b.script('sup', num, num);
        jump = m;
        expect = false;
        continue;
      }
      if (!expect && b.last()?.role === 'x') b.push('', '', 'op');
      b.push(num, num, 'x');
      expect = false;
      jump = m;
      continue;
    }

    if (SYMBOLS[s]) {
      const [kind, tex, plain] = SYMBOLS[s];
      if (kind === 'var') {
        b.push(tex, plain, 'x');
        expect = false;
        closeScripts(k, true);
      } else if (kind === 'post') {
        b.push(tex, plain, 'close');
        expect = false;
      } else if (s === '…' && expect) {
        // Opening a line or after an operator, the ellipsis is the ⋯ of a long sum; between operands it is ∉.
        b.push(CDOTS, '⋯', 'x');
        expect = false;
      } else {
        if (expect && k > 0 && b.last()?.role === 'op') b.push(DROPPED_OPERAND[0], DROPPED_OPERAND[1], 'x');
        b.push(tex, plain, 'op');
        expect = true;
      }
      continue;
    }

    switch (s) {
      case '.':
        if (k + 1 < n && atoms[k + 1].gap <= 1) {
          b.push('(', '(', 'open');
          b.stack.push('(');
          expect = true;
          continue;
        }
        if (k === n - 1) continue;
        return null;
      case '/':
        if (expect && b.last()?.role === 'op') b.push(DROPPED_OPERAND[0], DROPPED_OPERAND[1], 'x');
        if (b.stack[b.stack.length - 1] === '(') b.stack.pop();
        b.push(')', ')', 'close');
        expect = false;
        closeScripts(k);
        continue;
      case ';':
        b.push(',', ',', 'op');
        expect = true;
        continue;
      case ',':
        b.push(',', ',', 'op');
        expect = true;
        continue;
      case ':::':
        b.push('\\ldots', '…', 'x');
        expect = false;
        continue;
      case ':':
        if (atoms[k + 1]?.s === ':' && atoms[k + 2]?.s === ':' && atoms[k + 1].gap <= 1 && atoms[k + 2].gap <= 1) {
          b.push('\\ldots', '…', 'x');
          expect = false;
          jump = k + 3;
          continue;
        }
        if (k === n - 1) continue;
        b.push(':', ':', 'op');
        expect = true;
        continue;
      case 'Œ': {
        b.push('[', '[', 'open');
        b.stack.push('[');
        expect = true;
        continue;
      }
      case '?':
        if (!expect && !lastOfLine) {
          b.script('sup', '\\perp', '⊥');
          continue;
        }
        if (k === n - 1) continue;
        return null;
      default:
        return null;
    }
  }
  // A relation ending the line continues on the next one.
  if (expect && droppedAfter && b.last()?.role === 'op' && b.last()!.tex !== ',' && b.last()!.tex !== '\\sum') b.push(DROPPED_OPERAND[0], DROPPED_OPERAND[1], 'x');
  // Œ0; 1: the closing bracket was dropped.
  if (b.stack.includes('[')) closeInterval(b);
  const tex = b.parts.map((p) => p.tex).filter(Boolean).join(' ');
  const plain = b.parts.map((p) => p.plain).join('');
  return tex ? { tex, plain } : null;

  // ---- helpers sharing the loop's state

  /** Scripts glued after ℝ, ℂ, 𝔽: R3, Rn, Fm;n, RŒ0;1, FS. */
  function fieldScripts(k: number): void {
    let m = k + 1;
    let tex = '';
    let plain = '';
    while (m < n && atoms[m].gap === 0) {
      const c = atoms[m].s;
      if (isDigit(c) || INDEX_LETTER.test(c) || c === 'S' || FIELDS.has(c)) {
        tex += FIELDS.has(c) ? `\\mathbf{${c}}` : c;
        plain += c;
      } else if (c === ';' && m + 1 < n && atoms[m + 1].gap === 0 && /^[\dA-Za-z]$/.test(atoms[m + 1].s)) {
        tex += ',';
        plain += ',';
      } else break;
      m++;
    }
    if (tex) {
      b.script('sup', tex, plain);
      skip(m);
    }
  }

  /** u1, A1;k, vnC1: the index after an operand, through glued commas and plus signs. */
  function subscriptGroup(k: number): void {
    let m = k;
    let tex = '';
    let plain = '';
    while (m < n && (m === k || atoms[m].gap === 0)) {
      const c = atoms[m].s;
      if ((c === 'k' || c === 'j') && m > k && b.stack[b.stack.length - 1] === c) break;
      if (isDigit(c) || INDEX_LETTER.test(c) || (c === 'i' && m === k)) {
        // "am1": a_{m−1}, its minus dropped.
        if (c === '1' && INDEX_LETTER.test(atoms[m - 1]?.s ?? '') && m > k && atoms[m + 1]?.s !== 'C') {
          tex += '-';
          plain += '−';
        }
        tex += c;
        plain += c;
      } else if ((c === ';' || c === 'C') && m + 1 < n && atoms[m + 1].gap === 0 && /^[\dijkmn]$/.test(atoms[m + 1].s) && tex) {
        tex += c === ';' ? ',' : '+';
        plain += c === ';' ? ',' : '+';
      } else break;
      m++;
    }
    b.script('sub', tex, plain);
    jump = m;
  }

  /** T k, T kC1: a power. */
  function superscriptGroup(k: number): void {
    let m = k;
    let tex = '';
    let plain = '';
    while (m < n && (m === k || atoms[m].gap === 0)) {
      const c = atoms[m].s;
      if (isDigit(c) || INDEX_LETTER.test(c)) {
        if (c === '1' && m > k && INDEX_LETTER.test(atoms[m - 1].s) && atoms[m + 1]?.s !== 'C') {
          tex += '-';
          plain += '−';
        }
        tex += c;
        plain += c;
      } else if (c === 'C' && m + 1 < n && atoms[m + 1].gap === 0 && /^[\djkmn]$/.test(atoms[m + 1].s)) {
        tex += '+';
        plain += '+';
      } else break;
      m++;
    }
    b.script('sup', tex, plain);
    jump = m;
  }

  /** A power glued after a closing delimiter: (…)2, ‖v‖2. */
  function closeScripts(k: number, letterBase = false): void {
    if (letterBase) return;
    let m = k + 1;
    let tex = '';
    const delimiter = b.last()?.tex === '\\|' || b.last()?.tex === '|';
    while (m < n && atoms[m].gap === 0 && (isDigit(atoms[m].s) || INDEX_LETTER.test(atoms[m].s) && !delimiter && !b.stack.includes(atoms[m].s))) tex += atoms[m++].s;
    if (/^0+$/.test(tex) && b.last()?.tex === ')') {
      // P(R)0: the dual space, primed.
      b.script('sup', '\\prime'.repeat(tex.length), '′'.repeat(tex.length));
      skip(m);
    } else if (tex) {
      // ⟨u, v⟩1 is an inner product's name; (…)2 and ‖v‖2 are powers.
      b.script(b.last()?.tex === '\\rangle' ? 'sub' : 'sup', tex, tex);
      skip(m);
    }
  }

  function skip(m: number): void {
    jump = m;
  }
}

function closeInterval(b: Builder): void {
  const open = b.parts.findIndex((p) => p.tex === '[');
  let commas = 0;
  for (let k = open + 1; k < b.parts.length; k++) {
    if (b.parts[k].tex === ',') commas++;
    if (commas === 1 && b.parts[k].role === 'x' && b.parts[k + 1]?.role !== 'x') {
      b.parts.splice(k + 1, 0, { tex: ']', plain: ']', role: 'close' });
      return;
    }
  }
}

// ---------------------------------------------------------------- entry

/**
 * Math runs in one PDF line. Pieces are the line's text nodes in order.
 * Never throws; a run that does not read as a formula is left out.
 */
export function decodeGarbledLine(pieces: GarbledPiece[]): GarbledRun[] {
  try {
    const length = pieces.reduce((sum, p) => sum + p.text.length, 0);
    if (length === 0 || length > MAX_LINE) return [];
    const words = lex(pieces);
    const out: GarbledRun[] = [];
    for (const [a, b] of findRuns(words)) {
      const atoms = words.slice(a, b + 1).flatMap((w) => w.atoms);
      // Sentence punctuation after the formula stays text.
      let last = atoms.length;
      while (last > 0 && /^[.,;:?)]$/.test(atoms[last - 1].s) && !(atoms[last - 1].s === '?' && last >= 2 && atoms[last - 1].gap > 0 && b < words.length - 1)) last--;
      if (last === 0) continue;
      const body = atoms.slice(0, last);
      // Pieces of big delimiters on lines of their own.
      if (words.length === 1 && body.length === 1 && /^[ˆ˝˛ˇ]$/.test(body[0].s) && /^\s*\S\s*$/.test(words[0].text)) continue;
      // An operator ending the run had its operand dropped only if a wider gap follows ("λ + 0 = λ and").
      const decoded = formula(body, b === words.length - 1, last === atoms.length && (words[b + 1]?.atoms[0]?.gap ?? 0) >= 2);
      if (!decoded) continue;
      out.push({ start: body[0].at, end: body[body.length - 1].end, ...decoded });
    }
    return out;
  } catch {
    return [];
  }
}


// ---------------------------------------------------------------- the DOM rule

/** Blocks decoded per chapter, and formulas made; a chapter past either is hostile or not this kind of book. */
const MAX_BLOCKS = 40000;
const MAX_RUNS = 40000;
/** Text sampled for the gate. */
const MAX_SAMPLE = 400_000;

/** Operator-font `D` (=) between single-letter operands, `2` (∈) before a set letter, Greek turned accents, `f…g` sets. */
const SIGNATURES = [
  /(?:^|\s)[A-Za-z0-9/] D [A-Za-z0-9.]/g,
  /(?:^|\s)[A-Za-z0-9/] C [A-Za-z0-9.]/g,
  / 2 [RCFUVW](?:[\s;,.:]|$)/g,
  /[˛ˇ]/g,
  /(?:^|\s)f[0-9a-z.]\S{0,40}g(?:[\s;,.:]|$)/g,
  /(?:^|\s)h[a-z]; /g,
];
/** Characters of real (Unicode) math: a book that has them was converted with its fonts' maps. */
const REAL_MATH = /[=+∈∉≤≥≠∑∫∂√∞⊆⊂∪∩→αβγλ]/g;

function count(text: string, re: RegExp): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text)) n++;
  return n;
}

/**
 * Whether a chapter is a PDF conversion whose math came out as the garble
 * this module reads: a PDF conversion with many signature patterns and few
 * real math symbols. Prose books and conversions with real Unicode math fail.
 */
export function isGarbledMath(doc: Document, root: Element): boolean {
  if (!isPdfConversion(doc, root)) return false;
  const text = (root.textContent ?? '').slice(0, MAX_SAMPLE);
  if (text.length < 200) return false;
  let garbled = 0;
  for (const re of SIGNATURES) garbled += count(text, re);
  const real = count(text, REAL_MATH);
  return garbled >= 8 && garbled >= 3 * real && garbled * 2000 >= text.length;
}

const LINE_BLOCKS = new Set(['p', 'li', 'dd', 'dt', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'blockquote', 'figcaption']);
const ITALIC = new Set(['i', 'em', 'var', 'cite', 'dfn']);

/**
 * Decodes the garbled formulas of a chapter (gated by `isGarbledMath`): each
 * one becomes a formula host after its original text, which is wrapped
 * hidden in place, so the book's text and highlight offsets are unchanged.
 */
export function prepareGarbled(doc: Document, root: Element): number {
  if (!isGarbledMath(doc, root)) return 0;
  let blocks = 0;
  let made = 0;
  for (const block of Array.from(root.getElementsByTagNameNS('*', '*'))) {
    if (!LINE_BLOCKS.has(nameOf(block)) || hasClass(block, 'tr-pdf-hidden') || inProtected(block)) continue;
    if (Array.from(block.children).some((c) => BLOCKS.has(nameOf(c)))) continue;
    if (++blocks > MAX_BLOCKS || made > MAX_RUNS) break;
    try {
      made += decodeBlock(doc, block);
    } catch {
      // A line that fails keeps its original text.
    }
  }
  return made;
}

interface Piece {
  node: Text;
  start: number;
}

function decodeBlock(doc: Document, block: Element): number {
  const nodes: Piece[] = [];
  const pieces: GarbledPiece[] = [];
  let offset = 0;
  for (const node of textNodes(block)) {
    if (closest(node.parentElement ?? block, (e) => e === block || e.hasAttribute(UI_ATTR) || hasClass(e, 'tr-math-source')) !== block) continue;
    let italic = false;
    for (let e = node.parentElement; e && e !== block; e = e.parentElement) if (ITALIC.has(nameOf(e))) italic = true;
    nodes.push({ node, start: offset });
    pieces.push({ text: node.data, italic });
    offset += node.data.length;
  }
  if (!offset || offset > MAX_LINE) return 0;
  const runs = decodeGarbledLine(pieces);
  if (!runs.length) return 0;
  const whole = pieces.map((p) => p.text).join('');
  const joined = !!closest(block, (e) => hasClass(e, 'tr-pdf-para'), 4);
  let made = 0;
  // Last first, so earlier offsets stay valid while text nodes are split.
  for (let r = runs.length - 1; r >= 0; r--) {
    const run = runs[r];
    let end = run.end;
    let tex = run.tex;
    const before = whole.slice(0, run.start);
    const after = whole.slice(run.end);
    // A line that is one formula is a display, its closing punctuation inside it.
    const display = runs.length === 1 && !joined && !before.trim() && /^[\s.,;:]*$/.test(after) && run.end - run.start >= 6;
    if (display) {
      const punct = after.trim();
      if (punct) {
        end = run.end + after.indexOf(punct) + punct.length;
        tex += `\\text{${punct}}`;
      }
    } else {
      // Punctuation right after a formula goes with it, so a line never starts with it.
      const punct = /^[.,;:]+(?=\s|$)/.exec(after)?.[0];
      if (punct && (r === runs.length - 1 || runs[r + 1].start > run.end + punct.length)) {
        end = run.end + punct.length;
        tex += `\\text{${punct}}`;
      }
    }
    if (wrapRange(doc, block, nodes, run.start, end, tex, display, run.plain)) made++;
  }
  return made;
}

/** Wraps `[start, end)` of the block's text in a hidden source span and inserts the formula host after it. */
function wrapRange(doc: Document, block: Element, nodes: Piece[], start: number, end: number, tex: string, display: boolean, label: string): boolean {
  const locate = (at: number, isEnd: boolean): { node: Text; offset: number } | null => {
    for (const p of nodes) {
      const len = p.node.data.length;
      if (isEnd ? at > p.start && at <= p.start + len : at >= p.start && at < p.start + len) return { node: p.node, offset: at - p.start };
    }
    return null;
  };
  const from = locate(start, false);
  const to = locate(end, true);
  if (!from || !to) return false;
  const top = (n: Node): Node | null => {
    let cur: Node | null = n;
    while (cur && cur.parentNode !== block) cur = cur.parentNode;
    return cur;
  };
  const first = top(from.node);
  const last = top(to.node);
  if (!first || !last) return false;
  // A formula may cover inline elements only whole: what is outside it in one of them must be blank.
  if (first !== from.node && (from.node !== firstText(first) || from.node.data.slice(0, from.offset).trim() || textBefore(first, from.node).trim())) return false;
  if (last !== to.node && (to.node !== lastText(last) || to.node.data.slice(to.offset).trim() || textAfter(last, to.node).trim())) return false;
  // Split the end first: the start's offsets refer to the unsplit node when both are the same.
  let endNode: Node = last;
  if (last === to.node && to.offset < to.node.data.length) to.node.splitText(to.offset);
  let startNode: Node = first;
  if (first === from.node && from.offset > 0) {
    startNode = from.node.splitText(from.offset);
    if (endNode === from.node) endNode = startNode;
  }
  const wrap = create(doc, 'span', 'tr-hidden tr-math-source');
  block.insertBefore(wrap, startNode);
  for (let n: Node | null = startNode; n; ) {
    const next: Node | null = n === endNode ? null : n.nextSibling;
    wrap.append(n);
    n = next;
  }
  block.insertBefore(makeHost(doc, tex, display, label), wrap.nextSibling);
  return true;
}

function firstText(el: Node): Text | null {
  return textNodes(el)[0] ?? null;
}

function lastText(el: Node): Text | null {
  const all = textNodes(el);
  return all[all.length - 1] ?? null;
}

function textBefore(el: Node, node: Text): string {
  let out = '';
  for (const t of textNodes(el)) {
    if (t === node) break;
    out += t.data;
  }
  return out;
}

function textAfter(el: Node, node: Text): string {
  let out = '';
  let seen = false;
  for (const t of textNodes(el)) {
    if (seen) out += t.data;
    if (t === node) seen = true;
  }
  return out;
}
