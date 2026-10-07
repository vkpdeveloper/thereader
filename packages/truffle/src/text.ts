import type { Article, Block, Inline } from './model';

/** Plain text of inline content. Breaks become newlines. */
export function inlineText(content: readonly Inline[]): string {
  let out = '';
  for (const node of content) {
    switch (node.type) {
      case 'text':
        out += node.text;
        break;
      case 'break':
        out += '\n';
        break;
      case 'image':
        break;
      case 'math':
        out += node.text;
        break;
      case 'ref':
        out += node.label;
        break;
    }
  }
  return out;
}

function blockText(block: Block, out: string[], captions = false): void {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
      out.push(inlineText(block.content));
      break;
    case 'list':
      for (const item of block.items) for (const child of item.blocks) blockText(child, out);
      break;
    case 'quote':
      for (const child of block.blocks) blockText(child, out);
      if (block.cite) out.push(inlineText(block.cite));
      break;
    case 'code':
      out.push(block.code);
      break;
    case 'figure':
      // Captions belong to their media, not the running text (schema.org articleBody semantics),
      // except in photo galleries, where they are the text.
      if (captions && block.caption) out.push(inlineText(block.caption));
      break;
    case 'video':
    case 'audio':
      break;
    case 'embed':
      for (const child of block.blocks ?? []) blockText(child, out);
      break;
    case 'table':
      if (block.caption) out.push(inlineText(block.caption));
      for (const row of block.rows) out.push(row.cells.map((cell) => inlineText(cell.content)).join('\t'));
      break;
    case 'rule':
      break;
    case 'math':
      out.push(block.text);
      break;
    case 'definitions':
      for (const item of block.items) {
        out.push(inlineText(item.term));
        for (const child of item.details) blockText(child, out);
      }
      break;
    case 'details':
      out.push(inlineText(block.summary));
      for (const child of block.blocks) blockText(child, out);
      break;
    case 'callout':
      if (block.title) out.push(inlineText(block.title));
      for (const child of block.blocks) blockText(child, out);
      break;
    case 'footnotes':
      for (const item of block.items) for (const child of item.blocks) blockText(child, out);
      break;
  }
}

/** Body text of an article (title excluded), one block per paragraph. */
export function blocksText(blocks: readonly Block[]): string {
  const out: string[] = [];
  const captions = isGallery(blocks);
  for (const block of blocks) blockText(block, out, captions);
  return out.filter((part) => part.length > 0).join('\n\n');
}

/** Three or more captioned figures whose captions outweigh the rest of the text. */
function isGallery(blocks: readonly Block[]): boolean {
  let figures = 0;
  let captionLength = 0;
  for (const block of blocks) {
    if (block.type === 'figure' && block.caption !== undefined) {
      figures++;
      captionLength += inlineText(block.caption).length;
    }
  }
  if (figures < 3) return false;
  let restLength = 0;
  const rest: string[] = [];
  for (const block of blocks) {
    blockText(block, rest);
    for (const part of rest) restLength += part.length;
    if (restLength >= captionLength) return false;
    rest.length = 0;
  }
  return true;
}

export function articleText(article: Article): string {
  return blocksText(article.blocks);
}

/** Kana, CJK ideographs and Hangul: `[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]`. */
function isCjk(c: number): boolean {
  return (c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xac00 && c <= 0xd7af);
}

/** What regex `\s` and `trim` count as whitespace. */
function isSpace(c: number): boolean {
  if (c <= 0x20) return c === 0x20 || (c >= 0x09 && c <= 0x0d);
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/**
 * Words for reading time: whitespace-separated tokens, CJK characters counted at two per word. One pass, nothing
 * allocated: a token is a run of characters that are neither whitespace nor CJK (each CJK character splits tokens).
 */
export function countWords(text: string): number {
  let words = 0;
  let cjk = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // Printable ASCII, most of any text, is neither whitespace nor CJK.
    if (c > 0x20 && c < 0x7f) {
      if (!inWord) {
        words++;
        inWord = true;
      }
    } else if (isCjk(c)) {
      cjk++;
      inWord = false;
    } else if (isSpace(c)) {
      inWord = false;
    } else if (!inWord) {
      words++;
      inWord = true;
    }
  }
  return words + Math.ceil(cjk / 2);
}
