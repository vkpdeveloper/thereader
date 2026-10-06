/**
 * Round-trip oracle for `blocksMarkdown`: the Markdown is parsed back with the
 * remark parser (mdast-util-from-markdown with GFM and math, the reference
 * CommonMark implementation), and the parsed tree is compared with what the
 * blocks say the document holds. Both sides are flattened to the same shape:
 * one entry per block boundary, inline content as runs of text with their
 * marks. Used by `test/markdown.test.ts` and `scripts/markdown-check.ts`.
 */
import type { Nodes, PhrasingContent, Root, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import type { Block, Footnotes, Inline, List } from '../src/model';

export function parseMarkdown(markdown: string): Root {
  return fromMarkdown(markdown, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] });
}

interface Run {
  text: string;
  marks: string;
}

/** Runs with whitespace at the edges of marked text moved out (Markdown cannot mark it), equal neighbours merged. */
function normalizeRuns(input: Run[]): string {
  let runs = input;
  const merged: Run[] = [];
  for (let run of runs) {
    // A bare URL is a link to GFM whether or not the page linked it: compare such links as text.
    if (run.marks.includes('a:')) {
      const marks = run.marks.split(',');
      const kept = marks.filter((m) => !(m.startsWith('a:') && selfLink(run.text, m.slice(2))));
      if (kept.length !== marks.length) run = { text: run.text, marks: kept.join(',') };
    }
    const last = merged[merged.length - 1];
    if (last !== undefined && last.marks === run.marks && !run.marks.startsWith('img') && run.marks !== 'math' && run.marks !== 'ref') last.text += run.text;
    else merged.push({ ...run });
  }
  runs = merged;
  const out: Run[] = [];
  const push = (text: string, marks: string) => {
    if (text.length === 0) return;
    const last = out[out.length - 1];
    if (last !== undefined && last.marks === marks && !marks.startsWith('img') && marks !== 'math' && marks !== 'ref') last.text += text;
    else out.push({ text, marks });
  };
  for (const run of runs) {
    if (run.marks === '' || run.marks.includes('code') || run.marks.startsWith('img') || run.marks === 'math' || run.marks === 'ref') {
      push(run.text, run.marks);
      continue;
    }
    const lead = /^\s*/.exec(run.text)![0];
    const core = run.text.slice(lead.length).trimEnd();
    const trail = run.text.slice(lead.length + core.length);
    push(lead, '');
    push(core, run.marks);
    push(trail, '');
  }
  return out.map((r) => (r.marks === '' ? r.text : `«${r.marks}»${r.text}«/»`)).join('');
}

function selfLink(text: string, url: string): boolean {
  return text === url || 'http://' + text === url || 'mailto:' + text === url;
}

/** Visible text of a shape entry: marks dropped. */
export function plain(entry: string): string {
  return entry.replace(/«[^»]*»/g, '');
}

// ------------------------------------------------------------------ expected (from blocks)

const LABEL = /[^A-Za-z0-9_-]+/g;

export function expectedShape(blocks: readonly Block[]): string[] {
  const labels = new Map<string, string>();
  const used = new Set<string>();
  const called = new Set<string>();
  const clean = (s: string) => s.replace(LABEL, '-').replace(/^-+|-+$/g, '');
  const scan = (list: readonly Block[]) => {
    for (const block of list) {
      if (block.type === 'footnotes') {
        for (const item of block.items) {
          if (labels.has(item.id)) continue;
          let label = clean(item.label);
          if (label.length === 0 || used.has(label)) label = clean(item.id);
          if (label.length === 0) label = 'note';
          if (used.has(label)) {
            let n = 2;
            while (used.has(`${label}-${n}`)) n++;
            label = `${label}-${n}`;
          }
          used.add(label);
          labels.set(item.id, label);
        }
      } else if (block.type === 'list') for (const item of block.items) scan(item.blocks);
      else if (block.type === 'quote' || block.type === 'details' || block.type === 'callout') scan(block.blocks);
      else if (block.type === 'definitions') for (const item of block.items) scan(item.details);
    }
  };
  scan(blocks);
  const inlineNodes = (content: readonly Inline[] | undefined) => {
    for (const node of content ?? []) if (node.type === 'ref' && labels.has(node.id)) called.add(node.id);
  };
  const scanRefs = (list: readonly Block[]) => {
    for (const b of list) {
      switch (b.type) {
        case 'heading':
        case 'paragraph':
          inlineNodes(b.content);
          break;
        case 'list':
          for (const i of b.items) scanRefs(i.blocks);
          break;
        case 'quote':
          scanRefs(b.blocks);
          inlineNodes(b.cite);
          break;
        case 'figure':
          inlineNodes(b.caption);
          inlineNodes(b.credit);
          break;
        case 'video':
        case 'audio':
          inlineNodes(b.caption);
          break;
        case 'embed':
          scanRefs(b.blocks ?? []);
          break;
        case 'table':
          inlineNodes(b.caption);
          for (const r of b.rows) for (const c of r.cells) inlineNodes(c.content);
          break;
        case 'definitions':
          for (const i of b.items) {
            inlineNodes(i.term);
            scanRefs(i.details);
          }
          break;
        case 'details':
          inlineNodes(b.summary);
          scanRefs(b.blocks);
          break;
        case 'callout':
          inlineNodes(b.title);
          scanRefs(b.blocks);
          break;
        case 'footnotes':
          for (const i of b.items) scanRefs(i.blocks);
          break;
      }
    }
  };
  scanRefs(blocks);

  const runs = (content: readonly Inline[], line = false, extra = '', cell = false): Run[] => {
    const out: Run[] = [];
    for (const node of content) {
      if (node.type === 'text') {
        const marks: string[] = [];
        let code = false;
        for (const m of node.marks ?? []) {
          if (m === 'bold') marks.push('b');
          else if (m === 'italic') marks.push('i');
          else if (m === 'strike') marks.push('s');
          else if (m === 'code' || m === 'kbd') code = true;
        }
        if (extra) marks.push(extra);
        if (node.href !== undefined) marks.push(`a:${node.href}`);
        if (code) marks.push('code');
        out.push({ text: node.text, marks: [...new Set(marks)].sort().join(',') });
      } else if (node.type === 'break') out.push({ text: line ? ' ' : '⏎', marks: line ? extra : '' });
      else if (node.type === 'image') out.push({ text: `${node.src}|${node.alt.replace(/\s+/g, ' ').trim()}`, marks: 'img' });
      else if (node.type === 'math') {
        if (node.tex !== undefined && node.tex.trim().length > 0) {
          let tex = node.tex.replace(/\s+/g, ' ').trim();
          if (cell && tex.includes('|')) tex = tex.replace(/\\\|/g, '\\Vert ').replace(/\|/g, '\\vert ').replace(/ {2,}/g, ' ').trim();
          out.push({ text: tex, marks: 'math' });
        }
        else out.push({ text: node.text, marks: extra });
      } else if (node.type === 'ref') {
        const label = labels.get(node.id);
        if (label !== undefined) out.push({ text: label, marks: 'ref' });
        else out.push({ text: node.label, marks: extra });
      }
    }
    return out;
  };
  const para = (content: readonly Inline[], prefix: Run[] = []): string[] => {
    const text = normalizeRuns([...prefix, ...runs(content)]);
    return text.trim().length === 0 ? [] : [`p ${text}`];
  };
  const strong = (content: readonly Inline[]): string[] => {
    const text = normalizeRuns(runs(content, true, 'b'));
    return text.trim().length === 0 ? [] : [`p ${text}`];
  };
  const imageRun = (src: string, alt: string, href?: string): Run => ({ text: `${src}|${alt.replace(/\s+/g, ' ').trim()}`, marks: href === undefined ? 'img' : `img,a:${href}` });

  const out: string[] = [];
  const list = (block: List): string[] => {
    const start = block.start !== undefined && block.start >= 0 && block.start <= 999_999_999 - block.items.length ? block.start : 1;
    const lines = [`list ${block.ordered ? `ordered ${start}` : 'bullet'}`];
    for (const item of block.items) {
      // GFM ticks only an item that opens with a paragraph; otherwise the box stays text.
      const ticked = item.checked !== undefined && item.blocks[0]?.type === 'paragraph';
      lines.push(`item ${ticked ? item.checked : '-'}`);
      if (item.checked !== undefined && !ticked) lines.push(`p ${item.checked ? '[x]' : '[ ]'}`);
      lines.push(...visitAll(item.blocks));
      lines.push('/item');
    }
    lines.push('/list');
    return lines;
  };
  const visitAll = (list: readonly Block[]): string[] => list.flatMap(visit);
  const visit = (block: Block): string[] => {
    switch (block.type) {
      case 'heading': {
        const text = normalizeRuns(runs(block.content, true));
        return text.length === 0 ? [] : [`h${block.level} ${text}`];
      }
      case 'paragraph':
        return para(block.content);
      case 'list':
        return list(block);
      case 'quote': {
        const inner = visitAll(block.blocks);
        if (block.cite !== undefined) inner.push(...para(block.cite, [{ text: '— ', marks: '' }]));
        return inner.length === 0 ? [] : ['quote', ...inner, '/quote'];
      }
      case 'code': {
        const title = block.title?.replace(/\s+/g, ' ').trim();
        const lang = block.language ?? (title ? 'text' : '');
        const meta = title ? `title="${title}"` : '';
        const value = block.code.endsWith('\n') ? block.code.slice(0, -1) : block.code;
        return [`code ${lang}|${meta}|${JSON.stringify(value)}`];
      }
      case 'figure': {
        const lines = block.images.map((image) => `p ${normalizeRuns([imageRun(image.src, image.alt, image.href)])}`);
        if (block.caption) lines.push(...para(block.caption));
        if (block.credit) lines.push(...para(block.credit));
        return lines;
      }
      case 'video':
      case 'audio': {
        const lines =
          block.type === 'video' && block.poster !== undefined
            ? [`p ${normalizeRuns([imageRun(block.poster, block.title ?? '', block.url)])}`]
            : [`p ${normalizeRuns([{ text: block.title ?? block.url, marks: `a:${block.url}` }])}`];
        if (block.caption) lines.push(...para(block.caption));
        return lines;
      }
      case 'embed': {
        const source: Run[] = [];
        if (block.author !== undefined) source.push({ text: block.author + ', ', marks: '' });
        source.push({ text: block.url, marks: `a:${block.url}` });
        const inner = visitAll(block.blocks ?? []);
        if (inner.length === 0) return [`p ${normalizeRuns(source)}`];
        return ['quote', ...inner, `p ${normalizeRuns([{ text: '— ', marks: '' }, ...source])}`, '/quote'];
      }
      case 'table': {
        const grid: (Run[] | null)[][] = [];
        const align: (string | undefined)[] = [];
        let width = 0;
        for (let r = 0; r < block.rows.length; r++) {
          const row = (grid[r] ??= []);
          let c = 0;
          for (const cell of block.rows[r]!.cells) {
            while (row[c] !== undefined) c++;
            const colspan = Math.min(Math.max(cell.colspan ?? 1, 1), 1000);
            const rowspan = Math.min(Math.max(cell.rowspan ?? 1, 1), block.rows.length - r);
            if (r === 0 && cell.align !== undefined) align[c] = cell.align;
            for (let dr = 0; dr < rowspan; dr++) {
              const target = (grid[r + dr] ??= []);
              for (let dc = 0; dc < colspan; dc++) target[c + dc] = dr === 0 && dc === 0 ? runs(cell.content, true, '', true) : null;
            }
            c += colspan;
          }
          width = Math.max(width, row.length);
        }
        if (width === 0) return [];
        const cells = (row: (Run[] | null)[]) => Array.from({ length: width }, (_, c) => normalizeRuns(row[c] ?? [])).join(' ¦ ');
        const lines = block.caption ? para(block.caption) : [];
        lines.push(`table ${Array.from({ length: width }, (_, c) => align[c] ?? '-').join(',')}`);
        const header = (block.headerRows ?? 0) > 0;
        lines.push(`row ${header ? cells(grid[0]!) : cells([])}`);
        for (let r = header ? 1 : 0; r < grid.length; r++) lines.push(`row ${cells(grid[r]!)}`);
        lines.push('/table');
        return lines;
      }
      case 'rule':
        return ['hr'];
      case 'math': {
        const tex = block.tex?.replace(/^\s*\n|\n\s*$/g, '').trimEnd();
        if (tex !== undefined && tex.trim().length > 0) return [`math ${JSON.stringify(tex)}`];
        return block.text.trim().length > 0 ? [`p ${block.text}`] : [];
      }
      case 'definitions':
        return block.items.flatMap((item) => [...strong(item.term), ...visitAll(item.details)]);
      case 'details':
        return [...strong(block.summary), ...visitAll(block.blocks)];
      case 'callout': {
        const inner = [...(block.title ? strong(block.title) : []), ...visitAll(block.blocks)];
        if (block.variant === null) return inner.length === 0 ? [] : ['quote', ...inner, '/quote'];
        const marker = `[!${({ note: 'NOTE', tip: 'TIP', info: 'NOTE', warning: 'WARNING', danger: 'CAUTION' } as const)[block.variant]}]`;
        // The marker line and a paragraph right after it are one paragraph to a parser without alerts.
        if (inner[0]?.startsWith('p ')) inner[0] = `p ${marker} ${inner[0].slice(2)}`;
        else inner.unshift(`p ${marker}`);
        return ['quote', ...inner, '/quote'];
      }
      case 'footnotes':
        return footnotes(block);
    }
  };
  const footnotes = (block: Footnotes): string[] => {
    const lines: string[] = [];
    for (const item of block.items) {
      const inner = visitAll(item.blocks);
      if (called.has(item.id)) lines.push(`fn ${labels.get(item.id)}`, ...inner, '/fn');
      else if (inner[0]?.startsWith('p ') && item.blocks[0]?.type === 'paragraph') lines.push(`p [${item.label}] ${inner[0].slice(2)}`, ...inner.slice(1));
      else lines.push(`p [${item.label}]`, ...inner);
    }
    return lines;
  };
  // Footnotes are written last at the top level; their place in the list does not change the parse.
  for (const block of blocks) out.push(...visit(block));
  return out;
}

// ------------------------------------------------------------------ actual (from the parsed Markdown)

export function parsedShape(root: Root): string[] {
  const runs = (nodes: PhrasingContent[], marks: string[], out: Run[]) => {
    for (const node of nodes) {
      const key = (extra: string[]) => [...new Set([...marks, ...extra])].sort().join(',');
      switch (node.type) {
        case 'text':
          out.push({ text: node.value.replace(/\n/g, ' '), marks: key([]) });
          break;
        case 'strong':
          runs(node.children, [...marks, 'b'], out);
          break;
        case 'emphasis':
          runs(node.children, [...marks, 'i'], out);
          break;
        case 'delete':
          runs(node.children, [...marks, 's'], out);
          break;
        case 'link':
          runs(node.children, [...marks, `a:${node.url}`], out);
          break;
        case 'inlineCode':
          out.push({ text: node.value, marks: key(['code']) });
          break;
        case 'break':
          out.push({ text: '⏎', marks: '' });
          break;
        case 'image':
          out.push({ text: `${node.url}|${node.alt ?? ''}`, marks: ['img', ...marks.filter((m) => m.startsWith('a:'))].join(',') });
          break;
        case 'inlineMath':
          out.push({ text: node.value, marks: 'math' });
          break;
        case 'footnoteReference':
          out.push({ text: node.label ?? node.identifier, marks: 'ref' });
          break;
        default:
          out.push({ text: `⟦${node.type}⟧`, marks: '' });
      }
    }
    return out;
  };
  const text = (nodes: PhrasingContent[]) => normalizeRuns(runs(nodes, [], []));
  const visit = (node: RootContent | Nodes): string[] => {
    switch (node.type) {
      case 'heading':
        return [`h${node.depth} ${text(node.children)}`];
      case 'paragraph':
        return [`p ${text(node.children)}`];
      case 'list':
        return [`list ${node.ordered ? `ordered ${node.start ?? 1}` : 'bullet'}`, ...node.children.flatMap(visit), '/list'];
      case 'listItem':
        return [`item ${node.checked ?? '-'}`, ...node.children.flatMap(visit), '/item'];
      case 'blockquote':
        return ['quote', ...node.children.flatMap(visit), '/quote'];
      case 'code':
        return [`code ${node.lang ?? ''}|${node.meta ?? ''}|${JSON.stringify(node.value)}`];
      case 'table': {
        const lines = [`table ${(node.align ?? []).map((a) => a ?? '-').join(',')}`];
        for (const row of node.children) lines.push(`row ${row.children.map((cell) => text(cell.children)).join(' ¦ ')}`);
        lines.push('/table');
        return lines;
      }
      case 'thematicBreak':
        return ['hr'];
      case 'math':
        return [`math ${JSON.stringify(node.value)}`];
      case 'footnoteDefinition':
        return [`fn ${node.label ?? node.identifier}`, ...node.children.flatMap(visit), '/fn'];
      default:
        return [`⟦${node.type}⟧`];
    }
  };
  return root.children.flatMap(visit);
}

export interface Mismatch {
  index: number;
  expected: string | undefined;
  actual: string | undefined;
  /** Same words, different marks (emphasis the serializer had to drop). */
  marksOnly: boolean;
}

/** Entries that differ, after moving footnote definitions to the end on both sides (the serializer writes them last). */
export function compareShapes(expected: string[], actual: string[]): Mismatch[] {
  const sortNotes = (shape: string[]) => {
    const body: string[] = [];
    const notes: string[] = [];
    let depth = 0;
    for (const entry of shape) {
      if (entry.startsWith('fn ')) depth++;
      (depth > 0 ? notes : body).push(entry);
      if (entry === '/fn') depth--;
    }
    return [...body, ...notes];
  };
  const a = sortNotes(expected);
  const b = sortNotes(actual);
  const out: Mismatch[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const marksOnly = a[i] !== undefined && b[i] !== undefined && plain(a[i]!) === plain(b[i]!);
    out.push({ index: i, expected: a[i], actual: b[i], marksOnly });
    if (!marksOnly) break; // later entries are shifted; the first structural difference is the useful one
  }
  return out;
}
