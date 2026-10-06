/**
 * The article document model: what the extractor produces, what the app
 * stores, and what both renderers draw. The Dart implementation
 * (`packages/truffle_dart`) produces byte-identical JSON for the same input;
 * `packages/truffle/fixtures` holds the shared conformance cases.
 *
 * Rules every producer follows:
 * - URLs are absolute (`http:`/`https:`; `data:` only for inline images that
 *   carry real content). `#fragment` links inside the article become `ref`
 *   inlines or plain text; links to other pages stay absolute.
 * - Text outside `code` blocks has whitespace collapsed to single spaces and no
 *   leading or trailing space in a block. `code.code` is verbatim.
 * - Optional fields are omitted, never `undefined` or `null`, unless the type
 *   says `| null`. Empty arrays are omitted where the field is optional.
 */

export const ARTICLE_SCHEMA = 1;

export type Mark = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'sub' | 'sup' | 'highlight' | 'small' | 'kbd';

/** A run of text with formatting. Marks are sorted in the order of `Mark`. */
export interface TextRun {
  type: 'text';
  text: string;
  marks?: Mark[];
  /** Absolute link target. */
  href?: string;
}

export interface LineBreak {
  type: 'break';
}

/** A small image inside a line (emoji, icons, inline formulas rendered as images). */
export interface InlineImage {
  type: 'image';
  src: string;
  alt: string;
  width?: number;
  height?: number;
}

export interface InlineMath {
  type: 'math';
  /** LaTeX source when the page provided it. */
  tex?: string;
  /** Serialized `<math>` element when the page provided MathML. */
  mathml?: string;
  /** Text fallback (what a reader without math support sees). */
  text: string;
}

/** A footnote reference; `id` matches a `footnotes` item. */
export interface FootnoteRef {
  type: 'ref';
  id: string;
  label: string;
}

export type Inline = TextRun | LineBreak | InlineImage | InlineMath | FootnoteRef;

export interface Image {
  /** Best available source (largest reasonable candidate). */
  src: string;
  alt: string;
  width?: number;
  height?: number;
  /** Normalized absolute `srcset`, when the page offered several sizes. */
  srcset?: string;
  /** Link target when the image itself is a link (often the full-size file). */
  href?: string;
}

export interface Heading {
  type: 'heading';
  /** 2..6. The article title is the only level-1 heading and is not a block. */
  level: 2 | 3 | 4 | 5 | 6;
  content: Inline[];
  /** Original element id, for in-article links. */
  anchor?: string;
}

export interface Paragraph {
  type: 'paragraph';
  content: Inline[];
}

export interface ListItem {
  blocks: Block[];
  /** Task-list state. */
  checked?: boolean;
}

export interface List {
  type: 'list';
  ordered: boolean;
  /** First number of an ordered list when not 1. */
  start?: number;
  items: ListItem[];
}

export interface Quote {
  type: 'quote';
  blocks: Block[];
  /** Attribution (`<cite>`, `<footer>` inside the quote). */
  cite?: Inline[];
  /** Pull quote: a decorative repeat of article text. */
  pull?: boolean;
}

export interface Code {
  type: 'code';
  /** Verbatim source: line-number gutters and prompts removed, tabs kept. */
  code: string;
  /** Lowercase canonical language id (see `languages.ts`), or null if unknown. */
  language: string | null;
  /** Where `language` came from: page markup, or the detector. */
  languageSource?: 'markup' | 'detected';
  /** File name or title shown above the block. */
  title?: string;
}

/** One image, or a gallery when `images` has several. */
export interface Figure {
  type: 'figure';
  images: Image[];
  caption?: Inline[];
  credit?: Inline[];
}

export interface Video {
  type: 'video';
  /** youtube, vimeo, dailymotion, twitch, loom, wistia, ted, file, other. */
  provider: string;
  /** Page a reader can open (watch page or file URL). */
  url: string;
  /** Embeddable player URL, when the provider has one. */
  embedUrl?: string;
  poster?: string;
  title?: string;
  caption?: Inline[];
}

export interface Audio {
  type: 'audio';
  provider: string;
  url: string;
  embedUrl?: string;
  title?: string;
  caption?: Inline[];
}

/** A social post or other third-party embed kept as readable content. */
export interface Embed {
  type: 'embed';
  /** twitter, mastodon, bluesky, instagram, threads, reddit, tiktok, facebook, linkedin, codepen, gist, other. */
  provider: string;
  url: string;
  author?: string;
  /** The embed's own text, when the page carried it. */
  blocks?: Block[];
}

export interface TableCell {
  content: Inline[];
  header?: boolean;
  colspan?: number;
  rowspan?: number;
  align?: 'left' | 'center' | 'right';
}

export interface TableRow {
  cells: TableCell[];
}

export interface Table {
  type: 'table';
  caption?: Inline[];
  /** Rows in order; header rows first. */
  rows: TableRow[];
  /** Number of leading rows that form the header. */
  headerRows?: number;
}

export interface Rule {
  type: 'rule';
}

export interface MathBlock {
  type: 'math';
  tex?: string;
  mathml?: string;
  text: string;
}

export interface Definition {
  term: Inline[];
  details: Block[];
}

export interface DefinitionList {
  type: 'definitions';
  items: Definition[];
}

export interface Details {
  type: 'details';
  summary: Inline[];
  blocks: Block[];
}

/** Admonitions: note, tip, info, warning, danger, or null when unstyled. */
export interface Callout {
  type: 'callout';
  variant: 'note' | 'tip' | 'info' | 'warning' | 'danger' | null;
  title?: Inline[];
  blocks: Block[];
}

export interface Footnote {
  id: string;
  label: string;
  blocks: Block[];
}

export interface Footnotes {
  type: 'footnotes';
  items: Footnote[];
}

export type Block =
  | Heading
  | Paragraph
  | List
  | Quote
  | Code
  | Figure
  | Video
  | Audio
  | Embed
  | Table
  | Rule
  | MathBlock
  | DefinitionList
  | Details
  | Callout
  | Footnotes;

export interface Article {
  schema: typeof ARTICLE_SCHEMA;
  /** Canonical URL when the page declares one on the same site, else the fetched URL. */
  url: string;
  title: string;
  /** Standfirst / dek. */
  subtitle: string | null;
  /** Display byline, e.g. "Jane Doe and John Roe". */
  byline: string | null;
  authors: string[];
  siteName: string | null;
  /** ISO 8601. */
  publishedAt: string | null;
  modifiedAt: string | null;
  /** BCP 47 tag, e.g. `en`, `pt-BR`. */
  language: string | null;
  dir: 'ltr' | 'rtl';
  /** One or two sentences: the page description or the opening of the text. */
  excerpt: string | null;
  leadImage: Image | null;
  favicon: string | null;
  wordCount: number;
  /** Rounded up, at least 1. */
  readingMinutes: number;
  blocks: Block[];
}

export interface ExtractOptions {
  /** URL the HTML was fetched from (after redirects). Resolves relative URLs. */
  url: string;
}
