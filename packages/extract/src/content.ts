import { isContentFrame } from './media';
import { textOf, visibleLength, VElement, walk, type VNode } from './tree';

/**
 * Finds the article body. The scoring follows Mozilla Readability's proven
 * model (paragraph scores flowing to ancestors, class weights, link density,
 * sibling joining, conditional cleaning) but runs over the compact tree with
 * statistics computed in one bottom-up pass per attempt, instead of repeated
 * `innerText` and `querySelectorAll` calls. Removals are marks (`skip`), so a
 * retry with relaxed rules does not need to re-parse the page.
 */

const UNLIKELY = /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote|newsletter|subscribe|cookie|consent|signup|outbrain|taboola|recirc|trending|most-popular|mostpopular|promo/;
/** Unlikely-candidate words that prose never overrides. */
const UNLIKELY_HARD = /-ad-|ai2html|breadcrumbs|combx|comment|community|disqus|footer|gdpr|menu|related|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|ad-break|pagination|pager|popup|yom-remote|newsletter|subscribe|cookie|consent|signup|outbrain|taboola|recirc|trending|most-popular|mostpopular|promo/;
const MAYBE = /and|article|body|column|content|main|mathjax|shadow|story|post-text|entry/;
const POSITIVE = /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story|prose|markdown|rich-text|richtext/;
const NEGATIVE = /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget|newsletter|subscribe|taboola|recirc|byline|author-bio|toolbar|breadcrumb|disclaimer|caption-credit/;
const BYLINE = /byline|author|dateline|writtenby|p-author/;
const SHARE = /(?:\b|_)(?:share|sharedaddy|social|sharing)(?:\b|_)/;
const UNLIKELY_ROLES = new Set(['menu', 'menubar', 'complementary', 'navigation', 'alert', 'alertdialog', 'dialog', 'banner', 'contentinfo', 'search', 'tooltip']);
const AD_WORDS = /^(?:ad(?:vertising|vertisement)?|pub(?:licité)?|werb(?:ung)?|广告|Реклама|Anuncio)$/i;
const LOADING_WORDS = /^(?:(?:loading|正在加载|Загрузка|chargement|cargando)(?:…|\.\.\.)?)$/i;

/**
 * Strong signals that an element is the article body (publisher templates,
 * CMSs, doc generators and schema.org). A boost, never a blind choice.
 */
const CONTENT_HINT = /(?:^|\s)(?:entry-content|post-content|article-content|article-body|articlebody|article__body|article__content|article-text|articletext|story-body|storybody|story-content|story__body|post-body|postbody|post__content|post-entry|blog-post-content|blog-content|entry-body|content-body|body-text|bodytext|markdown-body|gh-content|available-content|mw-parser-output|ltx_page_content|theme-doc-markdown|md-content__inner|vp-doc|rich-text|richtext|c-entry-content|td-post-content|single-post-content|article-body-text|news-content|news-body|text-content|main-content-body|post-article|articlecontent|field-name-body|field--name-body|single-content|paywall-content|caas-body|wysiwyg|prose)(?:\s|$)/;

const PHRASING = new Set([
  'abbr', 'audio', 'b', 'bdo', 'bdi', 'br', 'button', 'canvas', 'cite', 'code', 'data', 'datalist', 'dfn', 'em', 'embed', 'i',
  'img', 'input', 'kbd', 'label', 'mark', 'math', 'math-tex', 'meter', 'noscript', 'object', 'output', 'progress', 'q', 'ruby',
  'rb', 'rt', 'rtc', 'rp', 'samp', 'select', 'small', 'span', 'strong', 'sub', 'sup', 'textarea', 'time', 'var', 'wbr', 'u', 's', 'strike',
  'tt', 'font', 'big', 'svg', 'picture', 'nobr', 'acronym',
]);

/** Elements that make a container "not a paragraph". */
const BLOCKS = new Set([
  'blockquote', 'dl', 'div', 'img', 'ol', 'p', 'pre', 'table', 'ul', 'section', 'article', 'figure', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'footer', 'aside', 'nav', 'main', 'hr', 'details', 'video', 'iframe', 'form', 'fieldset', 'address',
  'center', 'picture', 'figcaption', 'li', 'dd', 'dt', 'audio',
]);

const TAGS_TO_SCORE = new Set(['section', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'td', 'pre']);

export interface Flags {
  stripUnlikely: boolean;
  weightClasses: boolean;
  cleanConditionally: boolean;
}

function isWhitespace(node: VNode): boolean {
  return node.kind === 0 ? node.text.trim().length === 0 : node.tag === 'br';
}

export function isPhrasing(node: VNode): boolean {
  if (node.kind === 0) return true;
  if (PHRASING.has(node.tag)) return true;
  if (node.tag === 'a' || node.tag === 'del' || node.tag === 'ins') return node.children.every(isPhrasing);
  return false;
}

/** Post-order: children were visited first, so their `containsBlock` is known. */
function hasBlockChild(el: VElement): boolean {
  for (const child of el.children) {
    if (child.kind === 1 && (BLOCKS.has(child.tag) || child.containsBlock)) return true;
  }
  return false;
}

/** Bottom-up statistics over non-skipped nodes. */
export function measure(el: VElement): void {
  let text = 0;
  let link = 0;
  let commas = 0;
  const isLink = el.tag === 'a';
  for (const child of el.children) {
    if (child.kind === 0) {
      text += child.length;
      commas += child.commas;
    } else if (!child.skip) {
      measure(child);
      text += child.textLen;
      link += child.linkLen;
      commas += child.commas;
    }
  }
  el.textLen = text;
  el.commas = commas;
  if (isLink) {
    const href = el.attrs['href'] ?? '';
    // In-page links (footnotes, anchors) weigh less than links away.
    el.linkLen = href.length > 1 && href.charCodeAt(0) === 35 ? text * 0.3 : text;
  } else {
    el.linkLen = link;
  }
}

function linkDensity(el: VElement): number {
  return el.textLen === 0 ? 0 : Math.min(1, el.linkLen / el.textLen);
}

function classWeight(el: VElement, flags: Flags): number {
  if (!flags.weightClasses) return 0;
  let weight = 0;
  const cls = el.className.toLowerCase();
  const id = el.id.toLowerCase();
  if (cls.length > 0) {
    if (NEGATIVE.test(cls)) weight -= 25;
    if (POSITIVE.test(cls)) weight += 25;
  }
  if (id.length > 0) {
    if (NEGATIVE.test(id)) weight -= 25;
    if (POSITIVE.test(id)) weight += 25;
  }
  if (CONTENT_HINT.test(cls) || el.attrs['itemprop'] === 'articleBody' || el.attrs['itemprop'] === 'articlebody') weight += 30;
  return weight;
}

function initialize(el: VElement, flags: Flags): void {
  let score = 0;
  switch (el.tag) {
    case 'div':
      score = el.attrs['data-x-as-p'] === undefined ? 5 : 0;
      break;
    case 'pre':
    case 'td':
    case 'blockquote':
      score = 3;
      break;
    case 'address':
    case 'ol':
    case 'ul':
    case 'dl':
    case 'dd':
    case 'dt':
    case 'li':
    case 'form':
      score = -3;
      break;
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
    case 'th':
      score = -5;
      break;
    case 'article':
      score = 8;
      break;
  }
  el.score = score + classWeight(el, flags);
  el.scored = true;
}

/**
 * One-time normalization that Readability performs inside its scoring loop:
 * inline runs inside block containers become synthetic paragraphs, divs with
 * only inline content act as paragraphs, empty wrappers disappear.
 */
export function normalize(body: VElement): void {
  const visit = (el: VElement): void => {
    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i]!;
      if (child.kind === 1) visit(child);
    }
    el.containsBlock = hasBlockChild(el);
    const tag = el.tag;
    if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'main' || tag === 'center' || tag === 'form' || tag === 'body') {
      if (!el.containsBlock) {
        if (tag === 'div') el.attrs['data-x-as-p'] = '';
        return;
      }
      // Wrap phrasing runs between blocks in synthetic paragraphs.
      const out: VNode[] = [];
      let p: VElement | null = null;
      for (const child of el.children) {
        if (isPhrasing(child)) {
          if (p !== null) p.append(child);
          else if (!isWhitespace(child)) {
            p = new VElement('p', { 'data-x-synthetic': '' });
            p.parent = el;
            p.append(child);
            out.push(p);
          } else {
            out.push(child);
          }
        } else {
          if (p !== null) {
            while (p.children.length > 0 && isWhitespace(p.children[p.children.length - 1]!)) {
              const ws = p.children.pop()!;
              ws.parent = el;
              out.push(ws);
            }
          }
          p = null;
          out.push(child);
        }
      }
      el.children = out;
    }
  };
  visit(body);
}

function isEmptyContainer(el: VElement): boolean {
  const tag = el.tag;
  if (tag !== 'div' && tag !== 'section' && tag !== 'header' && tag !== 'h1' && tag !== 'h2' && tag !== 'h3' && tag !== 'h4' && tag !== 'h5' && tag !== 'h6') return false;
  for (const child of el.children) {
    if (child.kind === 0) {
      if (child.text.trim().length > 0) return false;
    } else if (child.tag !== 'br' && child.tag !== 'hr') {
      return false;
    }
  }
  return true;
}

function hasAncestor(el: VElement, tags: Set<string>, limit = 64): boolean {
  let depth = 0;
  for (let p = el.parent; p !== null && depth < limit; p = p.parent, depth++) if (tags.has(p.tag)) return true;
  return false;
}

const TABLE_OR_CODE = new Set(['table', 'code', 'pre']);

/** Pass 1 of an attempt: marks unlikely candidates, bylines and empty wrappers as skipped. */
function markUnlikely(body: VElement, flags: Flags, state: { bylineRemoved: boolean }): void {
  const totalProse = proseLength(body);
  walk(body, (el) => {
    if (el === body) return true;
    // A heading's id is a slug of its own words ("highlighting-with-comments"): judge headings by class.
    const match = HEADINGS.has(el.tag) ? el.className.toLowerCase() : el.matchString;
    if (el.attrs['aria-modal'] === 'true' && el.attrs['role'] === 'dialog') {
      el.skip = true;
      return false;
    }
    if (!state.bylineRemoved && match.length > 1 && isByline(el, match)) {
      state.bylineRemoved = true;
      el.skip = true;
      return false;
    }
    if (flags.stripUnlikely) {
      if (UNLIKELY.test(match) && !MAYBE.test(match) && el.tag !== 'a' && el.tag !== 'body' && el.tag !== 'article' && el.tag !== 'main' && !hasAncestor(el, TABLE_OR_CODE) && !(el.tag === 'table' && isDataTableCached(el))) {
        // "header", "banner", "extra": weak signals that real prose overrides (MDN puts intros in a header).
        // A layout wrapper holding most of the page's prose ("with-sidebar") is never unlikely.
        const prose = proseLength(el);
        // Headings carry no prose of their own; only the hard words drop them ("header-anchor" is not chrome).
        // A header holding the page's h1 and real prose is the article's own header (title, standfirst, intro).
        if ((UNLIKELY_HARD.test(match) || prose < 400 && !HEADINGS.has(el.tag) && !(prose >= 100 && linkDensity(el) < 0.3 && hasH1(el))) && prose <= totalProse * 0.5) {
          el.skip = true;
          return false;
        }
      }
      const role = el.attrs['role'];
      if (role !== undefined && UNLIKELY_ROLES.has(role)) {
        el.skip = true;
        return false;
      }
      if (el.tag === 'nav' || el.tag === 'aside' && !isCallout(el) && !isNoteMarkup(el)) {
        el.skip = true;
        return false;
      }
      // Several articles inside an article are a feed of other posts or comments.
      if (el.tag === 'article' && el.parent !== null && countNestedArticles(el.parent) >= 2 && hasAncestor(el, ARTICLE)) {
        el.skip = true;
        return false;
      }
    }
    if (isEmptyContainer(el)) {
      el.skip = true;
      return false;
    }
    return true;
  });
}

function hasH1(el: VElement): boolean {
  let found = false;
  walk(el, (e) => {
    if (found) return false;
    if (e.tag === 'h1') found = true;
    return !found;
  });
  return found;
}

const ARTICLE = new Set(['article']);
const QUOTE_OR_FIGURE = new Set(['blockquote', 'figure']);

function countNestedArticles(parent: VElement): number {
  let n = 0;
  for (const child of parent.children) if (child.kind === 1 && child.tag === 'article') n++;
  return n;
}

/** Text of paragraphs inside `el` that is not link text (uses the attempt's fresh `measure`). */
function proseLength(el: VElement): number {
  let n = 0;
  walk(el, (e) => {
    if (e.skip) return false;
    if (e.tag === 'p') {
      n += e.textLen - e.linkLen;
      return false;
    }
    return true;
  });
  return n;
}

function isByline(el: VElement, match: string): boolean {
  const rel = el.attrs['rel'];
  const itemprop = el.attrs['itemprop'];
  if (!(rel === 'author' || (itemprop !== undefined && itemprop.indexOf('author') >= 0) || BYLINE.test(match))) return false;
  const len = visibleLength(textOf(el));
  return len > 0 && len < 100;
}

/** Footnote and endnote lists (Pandoc, Sphinx, Hugo, GitHub, Wikipedia, Substack). */
export const FOOTNOTE_CONTAINER = /(?:^|[\s_-])(?:footnotes|footnote-list|footnotes-list|endnotes|references|reflist|refs|footnote-definitions|notes-list|fn-list)(?:$|[\s_-])/;

export function isFootnotes(el: VElement): boolean {
  if (el.notesState < 0) el.notesState = isFootnoteList(el) ? 1 : 0;
  return el.notesState === 1;
}

function isFootnoteList(el: VElement): boolean {
  if (el.attrs['role'] === 'doc-endnotes' || el.attrs['data-footnotes'] !== undefined) return true;
  // Every container word has "note", "ref" or "fn" in it: skip the regex for everything else.
  const m = el.matchString;
  if (m.indexOf('note') < 0 && m.indexOf('ref') < 0 && m.indexOf('fn') < 0) return false;
  if (FOOTNOTE_CONTAINER.test(m)) return true;
  // Python-Markdown: <div class="footnote"><hr><ol><li id="fn:1">.
  if (!el.hasClass('footnote')) return false;
  for (const child of el.children) if (child.kind === 1 && child.tag === 'ol') return true;
  return false;
}

/** A footnote list or one of its notes: kept even when marked up as <aside>. */
function isNoteMarkup(el: VElement): boolean {
  return isFootnotes(el) || el.attrs['role'] === 'doc-footnote' || el.attrs['role'] === 'doc-endnote' || /(?:^|\s)footnote(?:\s|$)/.test(el.className);
}

export function isCallout(el: VElement): boolean {
  return /(?:^|[\s_-])(?:note|tip|warning|caution|important|admonition|callout|alert|info|danger|notice|hint|notecard)(?:$|[\s_-])/.test(el.matchString);
}

function ancestors(el: VElement, max: number): VElement[] {
  const out: VElement[] = [];
  for (let p = el.parent; p !== null && out.length < max; p = p.parent) out.push(p);
  return out;
}

interface Attempt {
  roots: VElement[];
  textLength: number;
}

function grab(body: VElement, flags: Flags, articleBody: string | null): Attempt {
  resetMarks(body);
  measure(body);
  markUnlikely(body, flags, { bylineRemoved: false });
  measure(body);

  const toScore: VElement[] = [];
  walk(body, (el) => {
    if (el.skip) return false;
    if (TAGS_TO_SCORE.has(el.tag) || el.attrs['data-x-as-p'] !== undefined) toScore.push(el);
    return true;
  });

  const candidates: VElement[] = [];
  for (const el of toScore) {
    if (el.parent === null || el.textLen < 25) continue;
    const ups = ancestors(el, 5);
    if (ups.length === 0) continue;
    const score = 1 + (el.commas + 1) + Math.min(Math.floor(el.textLen / 100), 3);
    for (let level = 0; level < ups.length; level++) {
      const a = ups[level]!;
      if (a.parent === null) break;
      if (!a.scored) {
        initialize(a, flags);
        candidates.push(a);
      }
      a.score += score / (level === 0 ? 1 : level === 1 ? 2 : level * 3);
    }
  }

  const top: VElement[] = [];
  for (const c of candidates) {
    c.score *= 1 - linkDensity(c);
    if (c.tag === 'body' || c.tag === 'html') continue;
    let i = 0;
    while (i < top.length && top[i]!.score >= c.score) i++;
    if (i < 5) {
      top.splice(i, 0, c);
      if (top.length > 5) top.pop();
    }
  }

  let topCandidate: VElement | null = top[0] ?? null;
  // Flat pages (specs, old sites) keep their paragraphs directly in <body>: it wins outright.
  if (body.scored && body.score >= 2 * (topCandidate?.score ?? 0)) topCandidate = body;
  if (articleBody !== null) topCandidate = alignWithStructuredBody(body, topCandidate, articleBody);

  if (topCandidate === null) {
    measure(body);
    return { roots: [body], textLength: body.textLen };
  }
  if (topCandidate.tag === 'body') {
    // The page header of a flat page is chrome.
    for (const child of body.children) if (child.kind === 1 && child.tag === 'header') child.skip = true;
    trimTrailingChrome(body);
    prepare(body, flags);
    if (!flags.cleanConditionally) measure(body);
    return { roots: [body], textLength: body.textLen };
  }

  // Several strong candidates under one ancestor: the ancestor is the article.
  const alternatives: VElement[][] = [];
  for (let i = 1; i < top.length; i++) {
    if (top[i]!.score / topCandidate.score >= 0.75 && !isInside(top[i]!, topCandidate)) alternatives.push(ancestors(top[i]!, 64));
  }
  if (alternatives.length >= 3) {
    for (let p = topCandidate.parent; p !== null && p.tag !== 'body'; p = p.parent) {
      let lists = 0;
      for (const list of alternatives) if (list.indexOf(p) >= 0) lists++;
      if (lists >= 3) {
        topCandidate = p;
        break;
      }
    }
  }
  if (!topCandidate.scored) initialize(topCandidate, flags);

  // Climb while the parent scores higher.
  let lastScore = topCandidate.score;
  const threshold = lastScore / 3;
  for (let p = topCandidate.parent; p !== null && p.tag !== 'body'; p = p.parent) {
    if (!p.scored) continue;
    if (p.score < threshold) break;
    if (p.score > lastScore) {
      topCandidate = p;
      break;
    }
    lastScore = p.score;
  }
  topCandidate = joinSplitBody(topCandidate, candidates);

  // An only child says nothing on its own.
  for (let p = topCandidate.parent; p !== null && p.tag !== 'body' && liveChildren(p) === 1; p = p.parent) topCandidate = p;
  if (!topCandidate.scored) initialize(topCandidate, flags);

  topCandidate = galleryContainer(topCandidate);
  if (!topCandidate.scored) initialize(topCandidate, flags);

  // Join siblings that look like more of the same.
  const roots: VElement[] = [];
  const parent = topCandidate.parent;
  if (parent === null) {
    roots.push(topCandidate);
  } else {
    const siblingThreshold = Math.max(10, topCandidate.score * 0.2);
    for (const sibling of parent.children) {
      if (sibling.kind !== 1 || sibling.skip) continue;
      let append = sibling === topCandidate;
      if (!append) {
        const bonus = sibling.className !== '' && sibling.className === topCandidate.className ? topCandidate.score * 0.2 : 0;
        if (sibling.scored && sibling.score + bonus >= siblingThreshold) {
          append = true;
        } else if (bonus > 0 && sibling.textLen > 50 && linkDensity(sibling) < 0.3) {
          // Same component class as the body (CMS "text block" wrappers): more of the same.
          append = true;
        } else if (sibling.tag === 'p' || sibling.attrs['data-x-as-p'] !== undefined) {
          const density = linkDensity(sibling);
          const len = sibling.textLen;
          if (len > 80 && density < 0.25) append = true;
          else if (len < 80 && len > 0 && density === 0 && /\.( |$)/.test(textOf(sibling))) append = true;
        } else if (isLeadMedia(sibling, topCandidate) || isAdjacentProse(sibling, topCandidate)) {
          append = true;
        }
      }
      if (append) roots.push(sibling);
    }
    fillBetween(parent, roots);
  }

  for (const root of roots) prepare(root, flags);
  let length = 0;
  for (const root of roots) {
    if (!flags.cleanConditionally) measure(root);
    length += root.textLen;
  }
  return { roots, textLength: length };
}

/**
 * A flat page ends with its own chrome (copyright, discussion links) right in
 * <body>: trailing wrappers that are not article structure, and short link lines.
 */
function trimTrailingChrome(body: VElement): void {
  const kids = body.children;
  for (let k = kids.length - 1; k >= 0; k--) {
    const child = kids[k]!;
    if (child.kind === 0 || child.skip || child.tag === 'br' || child.tag === 'hr') continue;
    if (!STRUCTURE.has(child.tag) && child.textLen < 500 && !hasMedia(child)) {
      child.skip = true;
      continue;
    }
    // At most one link line ("Discussion on ...") right before the chrome.
    if (child.tag === 'p' && child.textLen < 100 && linkDensity(child) > 0.3) child.skip = true;
    return;
  }
}

/**
 * Photo galleries: the text is a short standfirst plus the photo captions. A
 * short body next to three or more captioned figures widens to the container
 * they share, when the captions are most of that container's text.
 */
function galleryContainer(top: VElement): VElement {
  if (top.textLen >= 1000) return top;
  let p = top.parent;
  for (let level = 0; level < 3 && p !== null && p.tag !== 'body'; level++, p = p.parent) {
    let figures = 0;
    let captions = 0;
    walk(p, (e) => {
      if (e.skip) return false;
      if (e.tag !== 'figure') return true;
      const caption = firstChild(e, 'figcaption');
      if (caption !== null && caption.textLen > 0 && hasMedia(e)) {
        figures++;
        captions += caption.textLen - caption.linkLen;
      }
      return false;
    });
    if (figures >= 3 && top.textLen + captions >= (p.textLen - p.linkLen) * 0.6) return p;
  }
  return top;
}

function firstChild(el: VElement, tag: string): VElement | null {
  for (const child of el.children) if (child.kind === 1 && !child.skip && child.tag === tag) return child;
  return null;
}

function isInside(node: VElement, ancestor: VElement): boolean {
  for (let p = node.parent; p !== null; p = p.parent) if (p === ancestor) return true;
  return false;
}

/**
 * Bodies split into several containers by ads or "chunks" (Wired, many CMSs):
 * climb to the nearest ancestor (up to three levels) whose text is almost all
 * strong candidates.
 */
function joinSplitBody(top: VElement, candidates: VElement[]): VElement {
  const strong: VElement[] = [];
  for (const c of candidates) {
    if (c !== top && c.textLen >= 200 && c.score >= top.score * 0.3 && !isInside(c, top) && !isInside(top, c)) strong.push(c);
  }
  if (strong.length === 0) return top;
  // Outermost strong candidates only, so nested ones are not counted twice.
  const outer = strong.filter((c) => !strong.some((o) => o !== c && isInside(c, o)));
  let ancestor = top.parent;
  for (let level = 0; level < 3 && ancestor !== null && ancestor.tag !== 'body'; level++, ancestor = ancestor.parent) {
    if (ancestor.textLen === 0 || linkDensity(ancestor) > 0.25) continue;
    let covered = top.textLen;
    let others = 0;
    for (const c of outer) {
      if (isInside(c, ancestor)) {
        covered += c.textLen;
        others++;
      }
    }
    if (others > 0 && covered >= ancestor.textLen * 0.8) return ancestor;
  }
  return top;
}

const STRUCTURE = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'pre', 'table', 'blockquote', 'p', 'hr', 'picture', 'details', 'dl', 'ul', 'ol']);

/**
 * Joined siblings imply the parent is the article: headings, figures, code and
 * prose between them (and a heading right before the first) belong to it too.
 */
function fillBetween(parent: VElement, roots: VElement[]): void {
  if (roots.length < 2) return;
  const kids = parent.children;
  let first = kids.indexOf(roots[0]!);
  const last = kids.indexOf(roots[roots.length - 1]!);
  for (let k = first - 1; k >= 0; k--) {
    const prev = kids[k]!;
    if (prev.kind === 0) {
      if (prev.text.trim().length > 0) break;
      continue;
    }
    if (!prev.skip && /^h[1-6]$/.test(prev.tag)) first = k;
    break;
  }
  const out: VElement[] = [];
  for (let k = first; k <= last; k++) {
    const child = kids[k]!;
    if (child.kind !== 1 || child.skip) continue;
    if (roots.indexOf(child) >= 0) {
      out.push(child);
      continue;
    }
    if (NEGATIVE.test(child.matchString) || BOILERPLATE.test(child.matchString)) continue;
    if (!STRUCTURE.has(child.tag) && !(child.textLen < 400 && hasMedia(child))) continue;
    if ((child.tag === 'ul' || child.tag === 'ol' || child.tag === 'dl') && linkDensity(child) > 0.5) continue;
    out.push(child);
  }
  roots.length = 0;
  roots.push(...out);
}

const MEDIA = new Set(['figure', 'img', 'picture', 'pre', 'table', 'video', 'iframe', 'audio', 'math', 'blockquote']);

/** Wrapper of an image, video, table or code listing (CMS media blocks between text blocks). */
function hasMedia(el: VElement): boolean {
  let found = false;
  walk(el, (e) => {
    if (found || e.skip) return false;
    if (e !== el && MEDIA.has(e.tag)) found = true;
    return !found;
  });
  return found;
}

/** A figure or heading directly before the body (lead image, section title) belongs to it. */
function isLeadMedia(sibling: VElement, top: VElement): boolean {
  const parent = top.parent;
  if (parent === null) return false;
  const i = parent.children.indexOf(sibling);
  const j = parent.children.indexOf(top);
  if (i < 0 || j < 0 || i > j) return false;
  for (let k = i + 1; k < j; k++) {
    const between = parent.children[k]!;
    if (between.kind === 1 && !between.skip) return false;
  }
  if (sibling.tag === 'figure' || sibling.tag === 'picture') return true;
  if (sibling.textLen < 200 && linkDensity(sibling) < 0.3) {
    let images = 0;
    walk(sibling, (e) => {
      if (e.tag === 'img') images++;
      return !e.skip;
    });
    return images === 1 && !NEGATIVE.test(sibling.matchString);
  }
  return false;
}

/** A container of plain paragraphs right next to the body (an intro split from it). */
function isAdjacentProse(sibling: VElement, top: VElement): boolean {
  // The article's own header (with the h1) needs only a standfirst's worth of prose.
  const min = sibling.textLen >= 100 && hasH1(sibling) ? 100 : 200;
  if (sibling.textLen < min || linkDensity(sibling) > 0.25 || NEGATIVE.test(sibling.matchString) || BOILERPLATE.test(sibling.matchString)) return false;
  const parent = top.parent;
  if (parent === null) return false;
  const kids = parent.children;
  const i = kids.indexOf(sibling);
  const j = kids.indexOf(top);
  const step = i < j ? 1 : -1;
  for (let k = i + step; k !== j; k += step) {
    const between = kids[k]!;
    // Only chrome may sit between them (a contents box between the preamble and the text).
    if (between.kind === 1 && !between.skip && !(BOILERPLATE.test(between.matchString) || linkDensity(between) > 0.5)) return false;
  }
  const prose = proseLength(sibling);
  return prose >= sibling.textLen * 0.5 && prose >= min;
}

function liveChildren(el: VElement): number {
  let n = 0;
  for (const child of el.children) if (child.kind === 1 && !child.skip) n++;
  return n;
}

function resetMarks(el: VElement): void {
  el.skip = false;
  el.scored = false;
  el.score = 0;
  for (const child of el.children) if (child.kind === 1) resetMarks(child);
}

// ------------------------------------------------------------- structured body

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

/**
 * When the page publishes its text as schema.org `articleBody`, the element
 * whose text best matches it (high recall, then the smallest such element) is
 * a better root than scoring alone, for pages whose markup misleads scoring.
 */
function alignWithStructuredBody(body: VElement, current: VElement | null, articleBody: string): VElement | null {
  const target = words(articleBody);
  if (target.length < 80) return current;
  const set = new Set<string>();
  for (let i = 0; i + 2 < target.length; i++) set.add(target[i] + ' ' + target[i + 1] + ' ' + target[i + 2]);
  if (set.size < 50) return current;

  const recallOf = (el: VElement): [number, number] => {
    const w = words(textOf(el));
    let hit = 0;
    const seen = new Set<string>();
    for (let i = 0; i + 2 < w.length; i++) {
      const s = w[i] + ' ' + w[i + 1] + ' ' + w[i + 2];
      if (set.has(s) && !seen.has(s)) {
        seen.add(s);
        hit++;
      }
    }
    const total = Math.max(1, w.length - 2);
    return [hit / set.size, hit / total];
  };

  if (current !== null) {
    const [recall, precision] = recallOf(current);
    if (recall > 0.8 && precision > 0.6) return current;
  }
  // Smallest element holding most of the structured text. A descendant never
  // recalls more than its ancestor, so failing subtrees are pruned.
  let best: VElement | null = null;
  let bestLen = Infinity;
  const minLen = Math.floor(articleBody.length * 0.6);
  walk(body, (el) => {
    if (el.skip || el.textLen < minLen) return false;
    const [recall, precision] = recallOf(el);
    if (recall <= 0.85) return false;
    if (precision > 0.4 && el.textLen < bestLen) {
      best = el;
      bestLen = el.textLen;
    }
    return true;
  });
  return best ?? current;
}

// ------------------------------------------------------------------ cleaning

function isDataTable(table: VElement): boolean {
  if (table.attrs['role'] === 'presentation' || table.attrs['datatable'] === '0') return false;
  if (table.attrs['summary']) return true;
  let caption = false;
  let headerish = false;
  let nested = false;
  let rows = 0;
  let columns = 0;
  walk(table, (e) => {
    if (e === table) return true;
    if (e.tag === 'table') {
      nested = true;
      return false;
    }
    if (e.tag === 'caption' && e.children.length > 0) caption = true;
    if (e.tag === 'col' || e.tag === 'colgroup' || e.tag === 'tfoot' || e.tag === 'thead' || e.tag === 'th') headerish = true;
    if (e.tag === 'tr') {
      rows++;
      let cols = 0;
      for (const cell of e.children) {
        if (cell.kind === 1 && (cell.tag === 'td' || cell.tag === 'th')) cols += Number(cell.attrs['colspan']) > 0 ? Number(cell.attrs['colspan']) : 1;
      }
      columns = Math.max(columns, cols);
    }
    return true;
  });
  if (caption || headerish) return true;
  if (nested) return false;
  if (rows === 1 || columns === 1) return false;
  if (rows >= 10 || columns > 4) return true;
  return rows * columns > 10;
}

export function isDataTableCached(table: VElement): boolean {
  if (table.tableState < 0) table.tableState = isDataTable(table) ? 1 : 0;
  return table.tableState === 1;
}

/** Boilerplate inside an article: removed regardless of score when small relative to the article. */
const BOILERPLATE = /(?:^|[\s_-])(?:mw-editsection|editsection|edit-section|mw-jump-link|catlinks|printfooter|navbox|vertical-navbox|ambox|hatnote|noprint|share|sharing|social|social-links|sharedaddy|share-buttons|newsletter|subscribe|subscription|signup|sign-up|optin|opt-in|related|related-posts|related-articles|recommended|recommendations|more-stories|read-more|readmore|read-next|also-read|further-reading-promo|promo|promoted|sponsored|advert|advertisement|ad-container|ad-slot|ad-unit|ad-wrapper|adsbygoogle|dfp|gpt-ad|comments|comment-list|commentlist|disqus|breadcrumb|breadcrumbs|pagination|post-tags|entry-tags|tag-list|tags-list|article-tags|toc|table-of-contents|tableofcontents|cookie|consent|gdpr|regwall|inline-cta|cta|author-bio|about-author|author-box|authorbox|post-author-bio|byline|dateline|print|skip-link|toolbar|nav|navigation|navbar|sticky|floating|modal|popup|overlay|outbrain|taboola|jp-relatedposts|wp-block-buttons|follow-us|listen|audio-player|article-audio|podcast-player|rating|reactions|clap|kudos)(?:$|[\s_-])/;

/** Short stand-alone text that is UI, not prose. */
const UI_TEXT = /^(?:text size|caption|image \d+ of \/? ?\d+|\d+ of \d+|photos?|gallery|enlarge( this image)?|view (full )?gallery|advertisement|ad|sponsored|share( this)?( article| story| post)?|tweet|email|print|copy link|copy|copied!?|loading\.*|read more|continue reading|subscribe|sign up|follow|listen( to this article)?|save|bookmark|comments?|reply|related|related articles|you may also like|recommended|more from .*|skip (to )?(main )?content|back to top|top|close|menu|toggle navigation|show more|load more|see more|×)$/i;

/** Statistics from the attempt's `measure(body)` are still valid here. */
function prepare(root: VElement, flags: Flags): void {
  const rootLen = Math.max(1, root.textLen);

  walk(root, (el) => {
    if (el === root) return true;
    if (el.skip) return false;
    const tag = el.tag;
    if (tag === 'pre' || tag === 'code' || tag === 'math' || tag === 'math-tex' || tag === 'table' && isDataTableCached(el)) return false;
    if (tag === 'footer' && !hasAncestor(el, QUOTE_OR_FIGURE) || tag === 'aside' && !isCallout(el) && !isNoteMarkup(el) || tag === 'nav' || tag === 'd-appendix' || tag === 'd-title' || tag === 'd-byline' || tag === 'form' && el.textLen < 200) {
      el.skip = true;
      return false;
    }
    if (tag === 'iframe' && !isContentFrame(el)) {
      el.skip = true;
      return false;
    }
    // A heading's id is a slug of its own words ("nav_relaxing-in-...") and says nothing about it.
    const match = HEADINGS.has(tag) ? el.className.toLowerCase() : el.matchString;
    if (match.length > 1 && el.textLen < Math.max(500, rootLen * 0.3)) {
      if (SHARE.test(match) && el.textLen < 500 || BOILERPLATE.test(match) && !MAYBE_CONTENT.test(match)) {
        el.skip = true;
        return false;
      }
    }
    if (tag === 'article' && el.textLen < rootLen * 0.4 && el.textLen < 1500 && hasLinkedHeading(el)) {
      el.skip = true;
      return false;
    }
    if ((tag === 'ul' || tag === 'ol') && isTableOfContents(el)) {
      el.skip = true;
      const heading = previousElement(el);
      if (heading !== null && HEADINGS.has(heading.tag) && heading.textLen < 40) heading.skip = true;
      return false;
    }
    if ((tag === 'h1' || tag === 'h2') && classWeight(el, flags) < 0) {
      el.skip = true;
      return false;
    }
    // A heading stays or goes whole: its links ("toc-backref", permalinks) are its words.
    if (HEADINGS.has(tag)) return false;
    if (el.textLen < 40 && el.textLen > 0 && (tag === 'p' || tag === 'div' || tag === 'span' || tag === 'a' || tag === 'li') && UI_TEXT.test(textOf(el))) {
      el.skip = true;
      return false;
    }
    return true;
  });

  if (flags.cleanConditionally) {
    cleanConditionally(root, flags);
  }
}

/** A list of three or more items that is almost all links to sections of this page. */
function isTableOfContents(list: VElement): boolean {
  if (list.textLen === 0 || list.linkLen < list.textLen * 0.2) return false;
  let items = 0;
  let inPage = 0;
  walk(list, (e) => {
    if (e.skip) return false;
    if (e.tag === 'li') items++;
    if (e.tag === 'a' && (e.attrs['href'] ?? '').charCodeAt(0) === 35) {
      inPage += e.textLen;
      return false;
    }
    return true;
  });
  return items >= 3 && inPage >= list.textLen * 0.8;
}

function previousElement(el: VElement): VElement | null {
  const parent = el.parent;
  if (parent === null) return null;
  for (let i = parent.children.indexOf(el) - 1; i >= 0; i--) {
    const prev = parent.children[i]!;
    if (prev.kind === 1) return prev.skip ? null : prev;
    if (prev.text.trim().length > 0) return null;
  }
  return null;
}

/** Teaser cards: a nested article whose heading links elsewhere. */
function hasLinkedHeading(el: VElement): boolean {
  let found = false;
  walk(el, (e) => {
    if (found) return false;
    if (e.tag === 'h1' || e.tag === 'h2' || e.tag === 'h3' || e.tag === 'h4') {
      walk(e, (x) => {
        if (x.tag === 'a' && x.attrs['href'] !== undefined && x.attrs['href'].charCodeAt(0) !== 35) found = true;
        return !found;
      });
      return false;
    }
    return true;
  });
  return found;
}

const MAYBE_CONTENT = /(?:^|[\s_-])(?:article-body|articlebody|entry-content|post-content|story-body|main-content|article-content|post-body)(?:$|[\s_-])/;

const CONDITIONAL = new Set(['form', 'fieldset', 'table', 'ul', 'ol', 'div', 'section', 'aside', 'header', 'dl']);

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const LISTS = new Set(['ul', 'ol']);
const CODE_LIKE = new Set(['pre', 'code']);
const EMBEDS = new Set(['object', 'embed', 'iframe']);
const TEXTISH = new Set(['span', 'li', 'td', 'blockquote', 'dl', 'div', 'img', 'ol', 'p', 'pre', 'table', 'ul']);

/** Subtree counts for conditional cleaning, excluding removed descendants. */
class Counts {
  text = 0;
  link = 0;
  commas = 0;
  p = 0;
  img = 0;
  li = 0;
  input = 0;
  /** pre, math, a data table or a player: content that is never cleaned away. */
  protected = 0;
  embeds = 0;
  headingText = 0;
  listText = 0;
  textishText = 0;
  /** Figures holding an image, and the text and link text inside them (captions, credits). */
  figures = 0;
  figureText = 0;
  figureLink = 0;
}

function cleanConditionally(root: VElement, flags: Flags): void {
  const visit = (el: VElement, inProtected: boolean): Counts => {
    const c = new Counts();
    const tag = el.tag;
    const isDataTable = tag === 'table' && isDataTableCached(el);
    // Footnote lists are link-heavy by nature; they are never clutter.
    const notes = isFootnotes(el);
    const protectedHere = inProtected || CODE_LIKE.has(tag) || isDataTable || notes;
    for (const child of el.children) {
      if (child.kind === 0) {
        c.text += child.length;
        c.commas += child.commas;
        continue;
      }
      if (child.skip) continue;
      const k = visit(child, protectedHere);
      if (child.skip) continue;
      const ct = child.tag;
      c.text += k.text;
      c.link += ct === 'a' ? (((child.attrs['href'] ?? '').charCodeAt(0) === 35) ? k.text * 0.3 : k.text) : k.link;
      c.commas += k.commas;
      c.p += k.p + (ct === 'p' ? 1 : 0);
      c.img += k.img + (ct === 'img' ? 1 : 0);
      c.li += k.li + (ct === 'li' ? 1 : 0);
      c.input += k.input + (ct === 'input' && (child.attrs['type'] ?? '').toLowerCase() !== 'checkbox' ? 1 : 0);
      c.protected += k.protected + (ct === 'pre' || ct === 'math' || ct === 'math-tex' || ct === 'table' && isDataTableCached(child) || ct === 'video' || ct === 'audio' || ct === 'iframe' && isContentFrame(child) ? 1 : 0);
      c.embeds += k.embeds + (EMBEDS.has(ct) && !(ct === 'iframe' && isContentFrame(child)) ? 1 : 0);
      c.headingText += HEADINGS.has(ct) ? k.text : k.headingText;
      c.listText += LISTS.has(ct) ? k.text : k.listText;
      c.textishText += TEXTISH.has(ct) ? k.text : k.textishText;
      if (ct === 'figure' && k.img > 0) {
        c.figures++;
        c.figureText += k.text;
        c.figureLink += k.link;
      } else {
        c.figures += k.figures;
        c.figureText += k.figureText;
        c.figureLink += k.figureLink;
      }
    }
    el.textLen = c.text;
    el.linkLen = c.link;
    el.commas = c.commas;
    if (el !== root && CONDITIONAL.has(tag) && !inProtected && !notes && shouldRemove(el, c, flags)) el.skip = true;
    return c;
  };
  visit(root, false);
}

function shouldRemove(el: VElement, c: Counts, flags: Flags): boolean {
  const tag = el.tag;
  if (tag === 'table' && isDataTableCached(el)) return false;
  if (c.protected > 0) return false;
  // A wrapper around captioned figures (credit links and all) is media, not clutter.
  if (c.figures > 0 && c.text - c.figureText < 25 && c.figureLink <= c.figureText * 0.5 && c.input === 0) return false;

  let isList = tag === 'ul' || tag === 'ol';
  if (!isList && c.text > 0) isList = c.listText / c.text > 0.9;

  const weight = classWeight(el, flags);
  if (weight < 0) return true;
  // A boxed "Recommended stories" / "Read more": a heading over a list of links elsewhere, and nothing else.
  if (tag !== 'ul' && tag !== 'ol' && c.headingText > 0 && c.li >= 2 && c.text - c.listText <= c.headingText + 30 && c.link >= (c.text - c.headingText) * 0.7) return true;
  if (c.commas >= 10) return false;
  // Heading wrappers (`div.mw-heading` with an edit link) are structure, not clutter.
  if (c.headingText > 0 && c.text - c.link <= c.headingText * 1.2) return false;

  if (c.text < 40) {
    const text = textOf(el);
    if (AD_WORDS.test(text) || LOADING_WORDS.test(text)) return true;
  }

  const p = c.p;
  const img = c.img;
  const li = c.li - 100;
  const headingDensity = c.text === 0 ? 0 : c.headingText / c.text;
  const contentLength = c.text;
  const density = c.text === 0 ? 0 : Math.min(1, c.link / c.text);
  const textDensity = c.text === 0 ? 0 : c.textishText / c.text;
  const inFigure = hasAncestor(el, FIGURE);

  let remove = false;
  if (!inFigure && img > 1 && p / img < 0.5) remove = true;
  if (!isList && li > p) remove = true;
  if (c.input > Math.floor(p / 3)) remove = true;
  if (!isList && !inFigure && headingDensity < 0.9 && contentLength < 25 && (img === 0 || img > 2) && density > 0) remove = true;
  // Link-rich sections (encyclopedias, docs): a heading over whole sentences tolerates more links.
  if (!isList && weight < 25 && density > 0.2 && !(density <= 0.3 && c.p > 0 && c.headingText > 0 && c.text - c.headingText >= 150 && sentences(textOf(el)) >= 2)) remove = true;
  if (weight >= 25 && density > 0.5) remove = true;
  // A list of short link-only items outside the prose ("Recent posts", archives, tag clouds) is navigation.
  if (isList && tag !== 'ul' && tag !== 'ol' && c.li >= 3 && density > 0.6 && contentLength / c.li < 120 && headingDensity < 0.5) remove = true;
  if ((c.embeds === 1 && contentLength < 75) || c.embeds > 1) remove = true;
  if (img === 0 && textDensity === 0 && contentLength === 0) remove = true;

  // Lists of images (galleries) stay.
  if (isList && remove) {
    for (const child of el.children) if (child.kind === 1 && !child.skip && child.children.filter((k) => k.kind === 1).length > 1) return remove;
    if (c.li === img) return false;
  }
  return remove;
}

const FIGURE = new Set(['figure']);

/** Sentence ends (any script) in `text`. */
function sentences(text: string): number {
  const m = text.match(/[.!?。！？](?:["'”’)\]]|\[\d+\])*(?:\s|$)/g);
  return m === null ? 0 : m.length;
}

/**
 * Runs the attempts and returns the article's root elements in document
 * order. Mirrors Readability's retry: when the result is short, retry with
 * fewer heuristics and keep the longest result.
 */
export function findContent(body: VElement, articleBody: string | null, charThreshold = 500): VElement[] {
  normalize(body);
  const attempts: Attempt[] = [];
  const flagSets: Flags[] = [
    { stripUnlikely: true, weightClasses: true, cleanConditionally: true },
    { stripUnlikely: false, weightClasses: true, cleanConditionally: true },
    { stripUnlikely: false, weightClasses: false, cleanConditionally: true },
    { stripUnlikely: false, weightClasses: false, cleanConditionally: false },
  ];
  for (const flags of flagSets) {
    const attempt = grab(body, flags, articleBody);
    if (attempt.textLength >= charThreshold) return attempt.roots;
    attempts.push(attempt);
  }
  let best = attempts[0]!;
  for (const a of attempts) if (a.textLength > best.textLength) best = a;
  // Re-run the winning attempt so the marks on the tree match it.
  const index = attempts.indexOf(best);
  return grab(body, flagSets[index]!, articleBody).roots;
}
