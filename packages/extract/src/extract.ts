import { Converter } from './blocks';
import { findContent } from './content';
import { readMetadata, type Metadata } from './metadata';
import { ARTICLE_SCHEMA, type Article, type Block, type ExtractOptions, type Image, type Inline } from './model';
import { blocksText, countWords, inlineText } from './text';
import { collapse, fromDom, textOf, walk, type VDocument, type VElement } from './tree';
import { hostOf, resolveUrl } from './url';

/**
 * Extracts the readable article from a parsed page. Mutates `doc` nowhere:
 * the page is copied into a compact tree first.
 */
export function extract(doc: Document, options: ExtractOptions): Article | null {
  return extractTree(fromDom(doc), options);
}

/** Parses with the platform `DOMParser` (browser) unless `parse` is given, then extracts. */
export function extractHtml(html: string, options: ExtractOptions & { parse?: (html: string) => Document }): Article | null {
  const parse = options.parse ?? ((source: string) => new DOMParser().parseFromString(source, 'text/html'));
  return extract(parse(html), options);
}

/** Platform-independent part of the pipeline (the Dart port mirrors everything from here on). */
export function extractTree(doc: VDocument, options: ExtractOptions): Article | null {
  const pageUrl = options.url;
  const base = doc.baseHref !== null ? resolveUrl(doc.baseHref, pageUrl) ?? pageUrl : pageUrl;
  const meta = readMetadata(doc, pageUrl);
  let title = chooseTitle(meta, doc.body, pageUrl);
  const titleMatched = title !== titleFallback(meta, pageUrl);
  const roots = findContent(doc.body, meta.articleBody);

  let blocks = new Converter(base).convert(roots);
  if (!titleMatched) title = sectionTitle(blocks, title);
  blocks = tidy(blocks, title, meta);

  const bodyText = blocksText(blocks);
  if (meta.articleBody !== null && meta.articleBody.length > 500 && bodyText.length < meta.articleBody.length * 0.3) {
    blocks = paragraphsFrom(meta.articleBody);
  }
  if (blocks.length === 0) return null;
  if (blocksText(blocks).length < 50 && !blocks.some((b) => b.type === 'figure' || b.type === 'video' || b.type === 'code' || b.type === 'embed')) return null;

  addLeadImage(blocks, meta.leadImage);
  blocks = blocks.map(canonical);

  const text = blocksText(blocks);
  const wordCount = countWords(text);
  return {
    schema: ARTICLE_SCHEMA,
    url: meta.url,
    title,
    subtitle: meta.subtitle !== null && meta.subtitle !== title ? meta.subtitle : null,
    byline: meta.authors.length > 0 ? meta.authors.join(', ') : null,
    authors: meta.authors,
    siteName: meta.siteName,
    publishedAt: meta.publishedAt,
    modifiedAt: meta.modifiedAt,
    language: meta.language,
    dir: meta.dir ?? detectDirection(text),
    excerpt: excerptOf(meta.excerpt, blocks),
    leadImage: meta.leadImage,
    favicon: meta.favicon,
    wordCount,
    readingMinutes: Math.max(1, Math.ceil(wordCount / 230)),
    blocks,
  };
}

// ------------------------------------------------------------------ title

const SEPARATORS = /\s+[|\-–—·•»:]{1,2}\s+|\s+\/\s+|\s+::\s+/;

function comparable(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Removes the site name a <title> carries at either end ("Story | Site", "Site - Story"). */
export function cleanTitle(raw: string, siteName: string | null, host: string): string {
  const title = collapse(raw);
  const parts = title.split(SEPARATORS);
  if (parts.length < 2) return title;
  const site = siteName === null ? '' : comparable(siteName);
  const hostWords = comparable(host.replace(/\.[a-z]+$/, ''));
  const isSite = (part: string) => {
    const c = comparable(part);
    return c.length > 0 && (c === site || c === hostWords || c.replace(/ /g, '') === hostWords.replace(/ /g, '') || (site.length > 0 && site.indexOf(c) >= 0 && c.length > 3) || (site.length > 0 && c.indexOf(site) >= 0 && c.length < site.length + 12));
  };
  let start = 0;
  let end = parts.length;
  if (isSite(parts[end - 1]!)) end--;
  if (end - start > 1 && isSite(parts[0]!)) start++;
  if (start === 0 && end === parts.length) return title;
  // Rebuild from the original string so inner separators survive.
  const first = parts[start]!;
  const last = parts[end - 1]!;
  const from = title.indexOf(first);
  const to = title.lastIndexOf(last) + last.length;
  const cleaned = from >= 0 && to > from ? title.slice(from, to).trim() : title;
  return cleaned.length >= 3 ? cleaned : title;
}

const PERMALINK_TEXT = /^[#¶§🔗]$/u;

/** Heading text without permalink anchors (`¶`, `#`). */
function headingText(el: VElement): string {
  let out = '';
  const visit = (node: VElement): void => {
    for (const child of node.children) {
      if (child.kind === 0) out += child.text;
      else if (!(child.tag === 'a' && PERMALINK_TEXT.test(collapse(textOf(child))))) visit(child);
    }
  };
  visit(el);
  return collapse(out).replace(/\s*[#¶§]$/, '');
}

function countH1(body: VElement): number {
  let n = 0;
  walk(body, (el) => {
    if (el.tag === 'h1') {
      n++;
      return false;
    }
    return true;
  });
  return n;
}

/** What `chooseTitle` falls back to when no heading on the page matches the declared title. */
function titleFallback(meta: Metadata, pageUrl: string): string {
  const host = hostOf(pageUrl);
  for (const t of meta.rawTitles) {
    const cleaned = cleanTitle(t, meta.siteName, host);
    if (cleaned.length > 0) return cleaned;
  }
  return '';
}

/**
 * A <title> that only names the site or document ("HTML Standard") over a
 * page that opens with its own top-level heading sharing a word with it
 * ("13.2 Parsing HTML documents"): that heading is this page's title.
 */
function sectionTitle(blocks: Block[], title: string): string {
  const first = blocks[0];
  if (first === undefined || first.type !== 'heading') return title;
  for (const b of blocks) if (b.type === 'heading' && b.level < first.level) return title;
  const words = comparable(title).split(' ');
  if (words.length > 3) return title;
  const heading = collapse(inlineText(first.content));
  const hw = comparable(heading).split(' ');
  return words.some((w) => w.length > 2 && hw.indexOf(w) >= 0) ? heading : title;
}

function chooseTitle(meta: Metadata, body: VElement, pageUrl: string): string {
  const host = hostOf(pageUrl);
  const cleaned = meta.rawTitles.map((t) => cleanTitle(t, meta.siteName, host)).filter((t) => t.length > 0);
  const headings: string[] = [];
  const h1s: string[] = [];
  walk(body, (el) => {
    if (headings.length >= 8) return false;
    if (el.tag === 'h1' || el.tag === 'h2') {
      const t = headingText(el);
      if (t.length > 0 && t.length <= 300 && (t.length >= 3 || el.tag === 'h1')) {
        headings.push(t);
        if (el.tag === 'h1') h1s.push(t);
      }
      return false;
    }
    return true;
  });
  // The visible heading that matches the page's declared title is the title as written.
  for (const candidate of cleaned) {
    const c = comparable(candidate);
    if (c.length === 0) continue;
    for (const h of headings) {
      const hc = comparable(h);
      if (hc === c) return h;
    }
  }
  // Headings that are the site part of "Story - Site" (a docs menu-bar h1) never stand for the story.
  const siteParts = new Set<string>();
  for (const raw of meta.rawTitles) {
    const segments = collapse(raw).split(SEPARATORS).map(comparable);
    if (segments.length < 2) continue;
    siteParts.add(segments[segments.length - 1]!);
    siteParts.add(segments[0]!);
  }
  for (const candidate of cleaned) {
    const c = comparable(candidate);
    if (c.length < 10) continue;
    for (const h of headings) {
      const hc = comparable(h);
      if (siteParts.has(hc) && hc !== c) continue;
      if (hc.length >= 10 && (c.indexOf(hc) >= 0 && hc.length > c.length * 0.6 || hc.indexOf(c) >= 0 && c.length > hc.length * 0.6)) return h;
    }
  }
  // A heading equal to one segment of "Story - Section - Site".
  for (const raw of meta.rawTitles) {
    const segments = collapse(raw).split(SEPARATORS).map(comparable);
    if (segments.length < 2) continue;
    // The last segment is the site in "Story - Site" titles; never match it.
    for (let i = 0; i < segments.length - 1; i++) {
      if (segments[i]!.length === 0) continue;
      // Short (often CJK) titles only match the page's h1.
      for (const h of segments[i]!.length < 3 ? h1s : headings) if (comparable(h) === segments[i]) return h;
    }
  }
  // Rewritten headlines ("Trump says..." vs "Donald Trump says a..."): the visible
  // heading that shares most of its words with the declared title.
  let best: string | null = null;
  let bestOverlap = 0.6;
  for (const candidate of cleaned) {
    const words = new Set(comparable(candidate).split(' '));
    if (words.size < 3) continue;
    for (const h of headings) {
      const hw = comparable(h).split(' ');
      if (hw.length < 3) continue;
      let shared = 0;
      for (const w of hw) if (words.has(w)) shared++;
      const overlap = shared / Math.max(hw.length, words.size);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = h;
      }
    }
  }
  if (best !== null) return best;
  // An SEO <title> that shares nothing with the page: its one h1 is the headline as published.
  if (h1s.length === 1 && cleaned.length > 0) {
    const hc = comparable(h1s[0]!);
    const site = meta.siteName !== null ? comparable(meta.siteName) : '';
    if (!siteParts.has(hc) && hc !== site && (hc.indexOf(' ') > 0 || hc.length >= 8) && countH1(body) === 1) return h1s[0]!;
  }
  if (cleaned.length > 0) return cleaned[0]!;
  if (headings.length > 0) return headings[0]!;
  return host;
}

// ------------------------------------------------------------------ tidy

function blockPlain(block: Block): string {
  return block.type === 'heading' || block.type === 'paragraph' ? inlineText(block.content) : '';
}

const DATE_LINE = /^(?:(?:published|updated|posted|last updated|modified)\s*:?\s*)?(?:on\s+)?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(?:\d{1,2}\s+[a-z]{3,9}\.?,?\s+\d{4}|[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4})(?:,?\s+(?:at\s+)?\d{1,2}[:.]\d{2}(?:\s*[ap]\.?m\.?)?(?:\s+[a-z]{2,4})?)?$/i;

const DATE_WORDS = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|updated|published|posted|last|modified|on|at|am|pm|a\.m|p\.m|[a-z]?[ecmp][sd]t|gmt|utc|bst|cet|cest|ist|aest|jst|hours?|minutes?|days?|ago|original|of)\b/g;

/** A line made only of dates, times and words like "Updated". */
function isDateLine(lower: string): boolean {
  if (lower.length > 100 || !/\d/.test(lower)) return false;
  return lower.replace(DATE_WORDS, '').replace(/[\d\s.,:;|/·•@\-–—()]+/g, '').length < 3;
}

function tidy(input: Block[], title: string, meta: Metadata): Block[] {
  let blocks = input.filter((b) => !(b.type === 'paragraph' && (b.content.length === 0 || /^[\d\s.,/#|·•]{1,6}$/.test(inlineText(b.content)))));
  // A line of underscores, dashes or asterisks is a section break.
  blocks = blocks.map((b) => (b.type === 'paragraph' && /^[\s_*~=\-–—•·]{3,}$/.test(inlineText(b.content)) ? { type: 'rule' } : b));

  // The title (and a repeated subtitle) are drawn by the renderer, not the body.
  const t = comparable(title);
  for (let i = 0; i < Math.min(blocks.length, 4); i++) {
    const b = blocks[i]!;
    if (b.type !== 'heading' && b.type !== 'paragraph') continue;
    const c = comparable(blockPlain(b));
    if (c.length > 0 && (c === t || b.type === 'heading' && t.length > 10 && (c.indexOf(t) >= 0 || t.indexOf(c) >= 0 && c.length > t.length * 0.75))) {
      blocks.splice(i, 1);
      break;
    }
  }
  // Title set as an image (old sites): a lone inline image whose alt text is the title.
  for (let i = 0; i < Math.min(blocks.length, 3); i++) {
    const b = blocks[i]!;
    if (b.type === 'paragraph' && b.content.length === 1 && b.content[0]!.type === 'image' && comparable(b.content[0]!.alt) === t && t.length > 0) {
      blocks.splice(i, 1);
      break;
    }
  }
  // The subtitle, or a heading that repeats the page description (a dek set as <h2>), is header too.
  const sub = meta.subtitle !== null ? comparable(meta.subtitle) : '';
  const description = meta.excerpt !== null ? comparable(meta.excerpt) : '';
  for (let i = 0; i < Math.min(blocks.length, 3); i++) {
    const b = blocks[i]!;
    if (b.type !== 'paragraph' && b.type !== 'heading') continue;
    const c = comparable(blockPlain(b));
    if (c.length > 0 && (c === sub || b.type === 'heading' && c === description)) {
      blocks.splice(i, 1);
      break;
    }
  }

  // Bylines and bare dates at the top repeat the header.
  const authors = meta.authors.map((a) => a.toLowerCase());
  for (let i = 0; i < Math.min(blocks.length, 5); i++) {
    const b = blocks[i]!;
    if (b.type !== 'paragraph') continue;
    const text = collapse(blockPlain(b));
    if (text.length === 0 || text.length > 120) continue;
    const lower = text.toLowerCase();
    const isByline = /^by\s+\S/i.test(text) && text.length < 100 || authors.length > 0 && authors.some((a) => lower === a || lower === 'by ' + a);
    if (isByline || DATE_LINE.test(text) || isDateLine(lower)) {
      blocks.splice(i, 1);
      i--;
    }
  }

  // Author bios ("Jane Doe is a reporter covering...") describe the writer, not the story.
  blocks = dropBios(blocks, authors);

  // "Read more:" promos and link-only lines are navigation, not text.
  blocks = blocks.filter((b) => !(b.type === 'paragraph' && isPromo(b.content)));
  // Calls to action opening the story (a "buy the PDF" box).
  for (let i = 0; i < Math.min(blocks.length, 3); i++) {
    if (isCallToAction(blocks[i]!)) {
      blocks.splice(i, 1);
      i--;
    }
  }
  // Contact lines, calls to action, link lists and promo headings trailing the story (before its notes).
  const notes: Block[] = [];
  while (blocks.length > 1 && blocks[blocks.length - 1]!.type === 'footnotes') notes.unshift(blocks.pop()!);
  while (blocks.length > 1) {
    const last = blocks[blocks.length - 1]!;
    const prev = blocks[blocks.length - 2]!;
    const lastText = last.type === 'paragraph' ? collapse(inlineText(last.content)) : '';
    if (last.type === 'paragraph' && (isContactLine(lastText) || isDateLine(lastText.toLowerCase()) || /^(?:last updated|updated|published|posted)(?: on)?:?$/i.test(lastText))) blocks.pop();
    else if (last.type === 'paragraph' && lastText.length < 100 && linkShare(last.content) >= 0.5 && !/[.!?]["'”’)]?$/.test(lastText)) blocks.pop();
    else if (isCallToAction(last)) blocks.pop();
    // The short benefits list under a sign-up pitch ("You get articles that match your needs").
    else if (last.type === 'list' && last.items.length <= 6 && isCallToAction(prev) && blocksText(last.items.flatMap((item) => item.blocks)).length < 400) blocks.pop();
    else if (last.type === 'list' && last.items.every((item) => item.blocks.length === 1 && item.blocks[0]!.type === 'paragraph' && linkShare((item.blocks[0] as { content: Inline[] }).content) > 0.8)) blocks.pop();
    else if (last.type === 'heading') blocks.pop();
    else break;
  }
  blocks.push(...notes);

  // Heading levels start at 2 under the title, keeping their relative depth.
  let min = 7;
  for (const b of blocks) if (b.type === 'heading' && b.level < min) min = b.level;
  if (min < 7 && min !== 2) {
    for (const b of blocks) if (b.type === 'heading') b.level = Math.max(2, Math.min(6, b.level - min + 2)) as 2 | 3 | 4 | 5 | 6;
  }

  // No empty structure, no rules at the edges or back to back, notes merged.
  const out: Block[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (b.type === 'rule' && (prev === undefined || prev.type === 'rule' || prev.type === 'heading')) continue;
    if (b.type === 'footnotes' && prev !== undefined && prev.type === 'footnotes') {
      prev.items.push(...b.items);
      continue;
    }
    if (b.type === 'heading' && prev !== undefined && prev.type === 'heading' && prev.level === b.level && inlineText(prev.content) === inlineText(b.content)) continue;
    // The same paragraph or picture twice in a row is a rendering artifact (responsive copies, dek repeated).
    if (b.type === 'paragraph' && prev !== undefined && prev.type === 'paragraph' && inlineText(b.content).length > 20 && inlineText(prev.content) === inlineText(b.content)) continue;
    if (b.type === 'figure' && prev !== undefined && prev.type === 'figure' && prev.images.length === b.images.length && prev.images.every((image, k) => image.src === b.images[k]!.src)) continue;
    out.push(b);
  }
  while (out.length > 0 && (out[out.length - 1]!.type === 'rule' || out[out.length - 1]!.type === 'heading')) out.pop();
  blocks = out;
  return blocks;
}

const BIO_ROLE = /\b(?:reporter|writer|editor|journalist|correspondent|columnist|contributor|author|producer|critic|fellow|researcher|consultant|engineer|developer|designer|professor|director|founder|photographer|analyst|scientist|lecturer|host|freelancer?|economist|historian|novelist|blogger|speaker|principal)\b/i;
const BIO_NAME = /^(\p{Lu}[\p{L}'’.-]*(?:\s+\p{Lu}[\p{L}'’.-]*){0,3})\s+(?:is|was|has been)\s+(?:a|an|the)\s/u;

/**
 * Bios: a short paragraph naming one of the authors (or orphaned from its
 * name, "is a senior reporter...") with a job title, plus bios right next to one.
 */
function dropBios(blocks: Block[], authors: string[]): Block[] {
  const bio = blocks.map((b) => {
    if (b.type !== 'paragraph') return 0;
    const text = collapse(inlineText(b.content));
    if (text.length > 700 || !BIO_ROLE.test(text.slice(0, 160))) return 0;
    if (/^(?:is|was)\s+(?:a|an|the)\s/.test(text)) return 2;
    const m = BIO_NAME.exec(text);
    if (m === null) return 0;
    return authors.indexOf(m[1]!.toLowerCase()) >= 0 ? 2 : 1;
  });
  if (bio.indexOf(2) < 0) return blocks;
  // Unnamed bios count only next to a certain one (co-author boxes), across name lines and photos.
  const near = (i: number, step: number): boolean => {
    for (let j = i + step; j >= 0 && j < blocks.length; j += step) {
      if (bio[j] === 2) return true;
      const b = blocks[j]!;
      if (!(b.type === 'figure' || b.type === 'paragraph' && inlineText(b.content).length < 60)) return false;
    }
    return false;
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < bio.length; i++) if (bio[i] === 1 && (near(i, -1) || near(i, 1))) bio[i] = 2;
  }
  return blocks.filter((_, i) => bio[i] !== 2);
}

function linkShare(content: Inline[]): number {
  let all = 0;
  let linked = 0;
  for (const n of content) {
    if (n.type !== 'text') continue;
    const len = n.text.trim().length;
    all += len;
    if (n.href !== undefined) linked += len;
  }
  return all === 0 ? 0 : linked / all;
}

const PROMO = /^(?:see more|read more|read also|also read|related|more|don'?t miss|watch|watch now|recommended|must read|trending|click here|related articles?|related stories|related coverage|more on this|more from|listen|subscribe|sign up|follow us|read next|up next|next)\s*[:|>»\-–—]/i;

function isPromo(content: Inline[]): boolean {
  const text = collapse(inlineText(content));
  if (text.length === 0) return false;
  const share = linkShare(content);
  if (PROMO.test(text) && (share > 0.4 || text.length < 120)) return true;
  if (/^(?:don'?t miss|read more|related|see also|recommended|more stories|more great .* stories|trending|most popular|you may also like|advertisement|share this( article)?)$/i.test(text)) return true;
  // A short line that is entirely a link to another page, or a stack of them.
  if (share >= 0.9 && (text.length < 160 || content.some((n) => n.type === 'break'))) return true;
  return false;
}

/** Sign-up, subscribe, app, membership and affiliate pitches, in the languages publishers use most. */
const CALL_TO_ACTION = /\b(?:sign(?:ing)? up (?:for|to|here|now|today)|subscribe (?:to|for|now|here|today)|our (?:free |daily |weekly )?newsletter|email list|mailing list|register (?:as|for|now|today)|create (?:a |an )?(?:free )?account|download (?:the|our)|get (?:the|our) (?:\w+ )?app|follow (?:us|topics|authors|the authors)|support (?:us|our)|patreon page|on patreon|donate (?:to|now|today|here)|become a (?:member|patron|subscriber|supporter)|buy it here|we may earn (?:a )?(?:small )?commission|affiliate (?:links?|commission)|purchase through links)\b|suscr[ií]b(?:e|ete|irte)|descarga la|boletín|abonnez-vous|inscrivez-vous|téléchargez|abonnieren sie|jetzt herunterladen|assine|inscreva-se/i;

/** A short pitch to sign up, subscribe, download, follow or support (a paragraph, a list of them, or a box). */
function isCallToAction(b: Block): boolean {
  let text: string;
  if (b.type === 'paragraph') text = inlineText(b.content);
  else if (b.type === 'callout' || b.type === 'list') text = blocksText([b]);
  else return false;
  text = collapse(text);
  // Quoted speech that mentions subscriptions is reporting, not a pitch.
  return text.length > 0 && text.length < 300 && !/^["“„«'‘]/.test(text) && CALL_TO_ACTION.test(text);
}

function isContactLine(text: string): boolean {
  if (text.length > 120) return false;
  return /^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(text) || /^(?:https?:\/\/)?(?:www\.)?(?:twitter|x|facebook|instagram|linkedin|threads|bsky)\.(?:com|app|net)\/\S+$/i.test(text) || /^@\w{2,30}$/.test(text) || /^(?:follow|contact|email|reach)\b.{0,80}(?:@|twitter|on x\b)/i.test(text);
}

function paragraphsFrom(text: string): Block[] {
  let parts = text.split(/\n\s*\n|\r?\n/).map((p) => collapse(p)).filter((p) => p.length > 0);
  if (parts.length === 1 && parts[0]!.length > 1500) {
    const sentences = parts[0]!.match(/[^.!?。！？]+[.!?。！？]+["'”’)]*\s*|[^.!?。！？]+$/g) ?? [parts[0]!];
    parts = [];
    let current = '';
    for (const s of sentences) {
      current += s;
      if (current.length > 600) {
        parts.push(current.trim());
        current = '';
      }
    }
    if (current.trim().length > 0) parts.push(current.trim());
  }
  return parts.map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] }) as Block);
}

/** Field order of each block type in model.ts; JSON output follows it whatever order fields were set in. */
const KEY_ORDER: Record<string, string[]> = {
  heading: ['type', 'level', 'content', 'anchor'],
  paragraph: ['type', 'content'],
  list: ['type', 'ordered', 'start', 'items'],
  quote: ['type', 'blocks', 'cite', 'pull'],
  code: ['type', 'code', 'language', 'languageSource', 'title'],
  figure: ['type', 'images', 'caption', 'credit'],
  video: ['type', 'provider', 'url', 'embedUrl', 'poster', 'title', 'caption'],
  audio: ['type', 'provider', 'url', 'embedUrl', 'title', 'caption'],
  embed: ['type', 'provider', 'url', 'author', 'blocks'],
  table: ['type', 'caption', 'rows', 'headerRows'],
  rule: ['type'],
  math: ['type', 'tex', 'mathml', 'text'],
  definitions: ['type', 'items'],
  details: ['type', 'summary', 'blocks'],
  callout: ['type', 'variant', 'title', 'blocks'],
  footnotes: ['type', 'items'],
};

function inOrder(obj: object, keys: string[]): boolean {
  let at = -1;
  for (const key of Object.keys(obj)) {
    const i = keys.indexOf(key);
    if (i < at) return false;
    at = i;
  }
  return true;
}

/** `block` (and blocks nested in it) with keys in model order. */
function canonical(block: Block): Block {
  switch (block.type) {
    case 'list':
      for (const item of block.items) item.blocks = item.blocks.map(canonical);
      break;
    case 'quote':
    case 'details':
    case 'callout':
      block.blocks = block.blocks.map(canonical);
      break;
    case 'embed':
      if (block.blocks !== undefined) block.blocks = block.blocks.map(canonical);
      break;
    case 'definitions':
      for (const item of block.items) item.details = item.details.map(canonical);
      break;
    case 'footnotes':
      for (const item of block.items) item.blocks = item.blocks.map(canonical);
      break;
  }
  const keys = KEY_ORDER[block.type]!;
  if (inOrder(block, keys)) return block;
  const source = block as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out as unknown as Block;
}

function imageKey(src: string): string {
  const m = /\/([^/?#]+?)(?:[-_]\d+x\d+|[-_](?:large|medium|small|thumb|scaled|\d{2,4}w?))?\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])/i.exec(src);
  return (m === null ? src : m[1]!).toLowerCase();
}

/** Shows the page's lead image above the text when the body itself opens without one. */
function addLeadImage(blocks: Block[], lead: Image | null): void {
  if (lead === null) return;
  if (/(?:logo|default|placeholder|share|social|og-image|opengraph|fallback|favicon|icon|avatar|banner-default)[\w.-]*\.(?:jpe?g|png|webp|gif|svg)/i.test(lead.src) || /\.svg(?:$|\?)/i.test(lead.src)) return;
  if (lead.width !== undefined && lead.width < 400) return;
  const key = imageKey(lead.src);
  for (const b of blocks) {
    if (b.type === 'figure' && b.images.some((i) => i.src === lead.src || imageKey(i.src) === key)) return;
  }
  for (let i = 0; i < Math.min(blocks.length, 3); i++) {
    const b = blocks[i]!;
    if (b.type === 'figure' || b.type === 'video') return;
  }
  const image: Image = { src: lead.src, alt: lead.alt };
  if (lead.width !== undefined && lead.height !== undefined) {
    image.width = lead.width;
    image.height = lead.height;
  }
  blocks.unshift({ type: 'figure', images: [image] });
}

// ------------------------------------------------------------------ details

function excerptOf(description: string | null, blocks: Block[]): string | null {
  if (description !== null && description.length >= 20) return description.length > 400 ? description.slice(0, 397).replace(/\s+\S*$/, '') + '…' : description;
  for (const b of blocks) {
    if (b.type !== 'paragraph') continue;
    const text = collapse((b.content as Inline[]).map((n) => (n.type === 'text' ? n.text : n.type === 'math' ? n.text : n.type === 'break' ? ' ' : '')).join(''));
    if (text.length < 40) continue;
    return text.length > 300 ? text.slice(0, 297).replace(/\s+\S*$/, '') + '…' : text;
  }
  return description;
}

function detectDirection(text: string): 'ltr' | 'rtl' {
  const sample = text.length > 3000 ? text.slice(0, 3000) : text;
  let rtl = 0;
  let ltr = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if ((c >= 0x0590 && c <= 0x08ff) || (c >= 0xfb1d && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff)) rtl++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f) || (c >= 0x370 && c <= 0x52f) || (c >= 0x3040 && c <= 0x9fff)) ltr++;
  }
  return rtl > ltr ? 'rtl' : 'ltr';
}
