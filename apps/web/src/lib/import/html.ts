/**
 * HTML repair for MOBI-7 text. Mobile uses `package:html` (an HTML5 parser);
 * browsers expose the same algorithm through `DOMParser`, so that is used
 * whenever it exists. Workers and Bun tests have no DOM, so a compact
 * tolerant tree builder covering the HTML5 rules Kindle markup exercises
 * (implied `<p>`/`<li>` ends, void elements, scoped end tags, head/body
 * placement) stands in there. Both produce the same small node shape.
 */

export interface HtmlText {
  kind: 'text';
  text: string;
}

export interface HtmlElement {
  kind: 'element';
  /** Lower-case local name. */
  name: string;
  /** Insertion-ordered like `package:html`'s LinkedHashMap. */
  attributes: Map<string, string>;
  children: HtmlNode[];
}

export type HtmlNode = HtmlText | HtmlElement;

export interface HtmlDocument {
  html: HtmlElement;
  head: HtmlElement;
  body: HtmlElement;
}

export function htmlElement(name: string, attributes = new Map<string, string>()): HtmlElement {
  return { kind: 'element', name, attributes, children: [] };
}

export function parseHtml(source: string): HtmlDocument {
  if (typeof DOMParser !== 'undefined') return fromDom(new DOMParser().parseFromString(source, 'text/html'));
  return parseTolerant(source);
}

/** Every element of the document in tree order. */
export function allElements(root: HtmlElement): HtmlElement[] {
  const out: HtmlElement[] = [];
  const walk = (element: HtmlElement): void => {
    out.push(element);
    for (const child of element.children) if (child.kind === 'element') walk(child);
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// DOM adapter

function fromDom(document: Document): HtmlDocument {
  const convert = (node: Node): HtmlNode | null => {
    if (node.nodeType === 3 || node.nodeType === 4) return { kind: 'text', text: node.nodeValue ?? '' };
    if (node.nodeType !== 1) return null;
    const element = node as Element;
    const out = htmlElement(element.localName);
    for (const attribute of Array.from(element.attributes)) out.attributes.set(attribute.name, attribute.value);
    // <template> keeps its children in a fragment; package:html does the same.
    const children = element.localName === 'template' ? (element as HTMLTemplateElement).content.childNodes : element.childNodes;
    for (const child of Array.from(children)) {
      const converted = convert(child);
      if (converted !== null) out.children.push(converted);
    }
    return out;
  };
  const html = convert(document.documentElement) as HtmlElement;
  const head = html.children.find((node): node is HtmlElement => node.kind === 'element' && node.name === 'head')
    ?? htmlElement('head');
  const body = html.children.find((node): node is HtmlElement => node.kind === 'element' && node.name === 'body')
    ?? htmlElement('body');
  return { html, head, body };
}

// ---------------------------------------------------------------------------
// Tolerant fallback parser

const voidElements = new Set([
  'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'img', 'input', 'keygen', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
const rawTextElements = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes']);
const rcDataElements = new Set(['title', 'textarea']);
const headElements = new Set(['base', 'basefont', 'bgsound', 'link', 'meta', 'title', 'style', 'script', 'noscript', 'template']);
const headings = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const closesParagraph = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'header', 'hgroup', 'main', 'menu', 'nav', 'ol', 'p', 'section', 'summary', 'ul',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'listing', 'form', 'hr', 'li', 'dd', 'dt', 'plaintext', 'xmp',
]);
const special = new Set([
  'address', 'applet', 'area', 'article', 'aside', 'base', 'basefont', 'bgsound', 'blockquote', 'body', 'br', 'button',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dir', 'div', 'dl', 'dt', 'embed', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr',
  'html', 'iframe', 'img', 'input', 'li', 'link', 'listing', 'main', 'marquee', 'menu', 'meta', 'nav', 'noembed',
  'noframes', 'noscript', 'object', 'ol', 'p', 'param', 'plaintext', 'pre', 'script', 'section', 'select', 'source',
  'style', 'summary', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'title', 'tr', 'track',
  'ul', 'wbr', 'xmp',
]);
const formatting = new Set(['a', 'b', 'big', 'code', 'em', 'font', 'i', 'nobr', 's', 'small', 'strike', 'strong', 'tt', 'u']);
const scopeBoundary = new Set(['html', 'table', 'td', 'th', 'caption', 'marquee', 'object', 'applet', 'template', 'svg', 'math']);
const tableContext = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr']);
const tableContent = new Set(['caption', 'colgroup', 'col', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'script', 'style', 'template', 'form']);
const svgAttributes = new Map([['viewbox', 'viewBox'], ['preserveaspectratio', 'preserveAspectRatio']]);

type Token =
  | { type: 'start'; name: string; attributes: Map<string, string>; selfClosing: boolean }
  | { type: 'end'; name: string }
  | { type: 'text'; text: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let text = '';
  const flushText = (): void => {
    if (text.length > 0) tokens.push({ type: 'text', text: decodeHtmlEntities(text, false) });
    text = '';
  };
  while (pos < source.length) {
    const lt = source.indexOf('<', pos);
    if (lt < 0) {
      text += source.slice(pos);
      break;
    }
    text += source.slice(pos, lt);
    pos = lt;
    const next = source[pos + 1] ?? '';
    if (source.startsWith('<!--', pos)) {
      const end = source.indexOf('-->', pos + 4);
      pos = end < 0 ? source.length : end + 3;
    } else if (next === '!' || next === '?') {
      const end = source.indexOf('>', pos);
      pos = end < 0 ? source.length : end + 1;
    } else if (/[A-Za-z]/.test(next) || (next === '/' && /[A-Za-z]/.test(source[pos + 2] ?? ''))) {
      const closing = next === '/';
      let cursor = pos + (closing ? 2 : 1);
      const nameMatch = /[^\s/>]+/y;
      nameMatch.lastIndex = cursor;
      const name = nameMatch.exec(source)![0].toLowerCase();
      cursor = nameMatch.lastIndex;
      const attributes = new Map<string, string>();
      let selfClosing = false;
      let terminated = false;
      while (cursor < source.length) {
        const char = source[cursor]!;
        if (char === '>') {
          cursor += 1;
          terminated = true;
          break;
        }
        if (/\s/.test(char)) {
          cursor += 1;
          continue;
        }
        if (char === '/') {
          cursor += 1;
          selfClosing = source[cursor] === '>';
          continue;
        }
        const attrName = /[^\s/>][^\s/>=]*/y;
        attrName.lastIndex = cursor;
        const attribute = attrName.exec(source)![0].toLowerCase();
        cursor = attrName.lastIndex;
        while (/\s/.test(source[cursor] ?? '')) cursor += 1;
        let value = '';
        if (source[cursor] === '=') {
          cursor += 1;
          while (/\s/.test(source[cursor] ?? '')) cursor += 1;
          const quote = source[cursor];
          if (quote === '"' || quote === "'") {
            const end = source.indexOf(quote, cursor + 1);
            value = source.slice(cursor + 1, end < 0 ? source.length : end);
            cursor = end < 0 ? source.length : end + 1;
          } else {
            const unquoted = /[^\s>]*/y;
            unquoted.lastIndex = cursor;
            value = unquoted.exec(source)![0];
            cursor = unquoted.lastIndex;
          }
        }
        if (!attributes.has(attribute)) attributes.set(attribute, decodeHtmlEntities(value, true));
      }
      if (!terminated) {
        pos = source.length;
        break;
      }
      pos = cursor;
      flushText();
      if (closing) {
        tokens.push({ type: 'end', name });
      } else {
        tokens.push({ type: 'start', name, attributes, selfClosing });
        if ((rawTextElements.has(name) || rcDataElements.has(name)) && !selfClosing) {
          const closer = new RegExp(`</${name}(?=[\\s/>])`, 'ig');
          closer.lastIndex = pos;
          const found = closer.exec(source);
          const end = found === null ? source.length : found.index;
          const raw = source.slice(pos, end);
          if (raw.length > 0) tokens.push({ type: 'text', text: rcDataElements.has(name) ? decodeHtmlEntities(raw, false) : raw });
          pos = end;
          if (found !== null) {
            const close = source.indexOf('>', end);
            pos = close < 0 ? source.length : close + 1;
            tokens.push({ type: 'end', name });
          }
        }
      }
    } else {
      text += '<';
      pos += 1;
    }
  }
  flushText();
  return tokens;
}

function parseTolerant(source: string): HtmlDocument {
  const html = htmlElement('html');
  const head = htmlElement('head');
  const body = htmlElement('body');
  html.children.push(head, body);
  const merge = (target: HtmlElement, attributes: Map<string, string>): void => {
    for (const [key, value] of attributes) if (!target.attributes.has(key)) target.attributes.set(key, value);
  };
  let inBody = false;
  const headStack: HtmlElement[] = [head];
  const stack: HtmlElement[] = [html, body];
  const current = (): HtmlElement => stack[stack.length - 1]!;
  const appendText = (parent: HtmlElement, text: string): void => {
    const last = parent.children[parent.children.length - 1];
    if (last?.kind === 'text') last.text += text;
    else parent.children.push({ kind: 'text', text });
  };
  const inScope = (name: string, extra: string[] = []): boolean => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const node = stack[i]!.name;
      if (node === name) return true;
      if (scopeBoundary.has(node) || extra.includes(node)) return false;
    }
    return false;
  };
  const popUntil = (names: Set<string> | string): void => {
    while (stack.length > 2) {
      const node = stack.pop()!;
      if (typeof names === 'string' ? node.name === names : names.has(node.name)) return;
    }
  };
  const inForeign = (): boolean => stack.some((node) => node.name === 'svg' || node.name === 'math');
  /**
   * HTML5 foster parenting: content that is not allowed directly inside a
   * table is placed before the table, while still becoming the current node.
   */
  const fosterParent = (): { parent: HtmlElement; before: HtmlElement } | null => {
    if (!tableContext.has(current().name)) return null;
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i]!.name === 'table') return { parent: stack[i - 1]!, before: stack[i]! };
    }
    return null;
  };
  const insert = (node: HtmlNode): void => {
    const foster = fosterParent();
    if (foster === null) {
      if (node.kind === 'text') appendText(current(), node.text);
      else current().children.push(node);
      return;
    }
    const siblings = foster.parent.children;
    const at = siblings.indexOf(foster.before);
    const previous = siblings[at - 1];
    if (node.kind === 'text' && previous?.kind === 'text') previous.text += node.text;
    else siblings.splice(at, 0, node);
  };

  for (const token of tokenize(source)) {
    if (!inBody) {
      if (token.type === 'text' && token.text.trim() === '') {
        if (headStack.length > 1) appendText(headStack[headStack.length - 1]!, token.text);
        continue;
      }
      if (headStack.length > 1) {
        // Inside <title>/<style>/<script> in the head.
        const open = headStack[headStack.length - 1]!;
        if (token.type === 'text') {
          appendText(open, token.text);
          continue;
        }
        if (token.type === 'end' && token.name === open.name) {
          headStack.pop();
          continue;
        }
      }
      if (token.type === 'start' && token.name === 'html') {
        merge(html, token.attributes);
        continue;
      }
      if (token.type === 'start' && token.name === 'head') continue;
      if (token.type === 'end' && (token.name === 'head' || token.name === 'html')) continue;
      if (token.type === 'start' && headElements.has(token.name)) {
        const element = htmlElement(token.name, token.attributes);
        head.children.push(element);
        if (!voidElements.has(token.name) && !token.selfClosing) headStack.push(element);
        continue;
      }
      inBody = true;
      if (token.type === 'start' && token.name === 'body') {
        merge(body, token.attributes);
        continue;
      }
    }

    if (token.type === 'text') {
      if (tableContext.has(current().name) && token.text.trim() === '') appendText(current(), token.text);
      else insert({ kind: 'text', text: token.text });
      continue;
    }
    if (token.type === 'start') {
      const { name } = token;
      if (name === 'html') {
        merge(html, token.attributes);
        continue;
      }
      if (name === 'body') {
        merge(body, token.attributes);
        continue;
      }
      if (name === 'head') continue;
      if (inForeign()) {
        const attributes = new Map<string, string>();
        for (const [key, value] of token.attributes) attributes.set(svgAttributes.get(key) ?? key, value);
        const element = htmlElement(name, attributes);
        current().children.push(element);
        if (!token.selfClosing) stack.push(element);
        continue;
      }
      if (closesParagraph.has(name) && inScope('p', ['button'])) popUntil('p');
      if (name === 'li' && inScope('li', ['ol', 'ul'])) popUntil('li');
      if ((name === 'dd' || name === 'dt') && (inScope('dd') || inScope('dt'))) popUntil(new Set(['dd', 'dt']));
      if (headings.has(name) && headings.has(current().name)) stack.pop();
      if (name === 'a' && stack.some((node) => node.name === 'a')) popUntil('a');
      if (name === 'option' && current().name === 'option') stack.pop();
      if ((name === 'td' || name === 'th') && (inScope('td') || inScope('th'))) popUntil(new Set(['td', 'th']));
      if (name === 'tr' && stack.some((node) => node.name === 'tr')) popUntil('tr');
      // HTML5 wraps rows placed directly in a table in an implied <tbody> (and cells in a <tr>).
      const implied = (child: string): void => {
        const element = htmlElement(child);
        current().children.push(element);
        stack.push(element);
      };
      if ((name === 'tr' || name === 'td' || name === 'th') && current().name === 'table') implied('tbody');
      if ((name === 'td' || name === 'th') && ['tbody', 'thead', 'tfoot'].includes(current().name)) implied('tr');
      const element = htmlElement(name, token.attributes);
      if (tableContent.has(name)) current().children.push(element);
      else insert(element);
      if (!voidElements.has(name)) stack.push(element);
      continue;
    }
    // End tag.
    const { name } = token;
    if (name === 'body' || name === 'html') continue;
    if (name === 'br') {
      insert(htmlElement('br'));
      continue;
    }
    if (name === 'p') {
      if (inScope('p', ['button'])) popUntil('p');
      else insert(htmlElement('p'));
      continue;
    }
    if (headings.has(name)) {
      if ([...headings].some((heading) => inScope(heading))) popUntil(headings);
      continue;
    }
    if (special.has(name)) {
      if (inScope(name, name === 'li' ? ['ol', 'ul'] : [])) popUntil(name);
      continue;
    }
    for (let i = stack.length - 1; i >= 2; i--) {
      const node = stack[i]!;
      if (node.name === name) {
        stack.length = i;
        break;
      }
      if (special.has(node.name) && !formatting.has(name)) break;
    }
  }
  return { html, head, body };
}

// ---------------------------------------------------------------------------
// Character references

const namedEntities: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', iexcl: '¡', cent: '¢', pound: '£', curren: '¤',
  yen: '¥', brvbar: '¦', sect: '§', uml: '¨', copy: '©', ordf: 'ª', laquo: '«', not: '¬', shy: '­', reg: '®',
  macr: '¯', deg: '°', plusmn: '±', sup2: '²', sup3: '³', acute: '´', micro: 'µ', para: '¶', middot: '·', cedil: '¸',
  sup1: '¹', ordm: 'º', raquo: '»', frac14: '¼', frac12: '½', frac34: '¾', iquest: '¿', Agrave: 'À', Aacute: 'Á',
  Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê',
  Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', ETH: 'Ð', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó',
  Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', times: '×', Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü',
  Yacute: 'Ý', THORN: 'Þ', szlig: 'ß', agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å',
  aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î',
  iuml: 'ï', eth: 'ð', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', divide: '÷',
  oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', thorn: 'þ', yuml: 'ÿ', OElig: 'Œ',
  oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', fnof: 'ƒ', circ: 'ˆ', tilde: '˜', ensp: ' ', emsp: ' ',
  thinsp: ' ', zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏', ndash: '–', mdash: '—', lsquo: '‘',
  rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', dagger: '†', Dagger: '‡', bull: '•', hellip: '…',
  permil: '‰', prime: '′', Prime: '″', lsaquo: '‹', rsaquo: '›', oline: '‾', frasl: '⁄', euro: '€', trade: '™',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔', minus: '−', infin: '∞', ne: '≠', le: '≤', ge: '≥',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', sigma: 'σ', omega: 'ω', Omega: 'Ω', loz: '◊', spades: '♠',
  clubs: '♣', hearts: '♥', diams: '♦',
};
/** Legacy references browsers also decode without the trailing semicolon. */
const legacyEntities = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg']);
const windows1252Controls = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

export function decodeHtmlEntities(text: string, attribute: boolean): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*)(;?)/g, (match, entity: string, semicolon: string, offset: number) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      let code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (code >= 0x80 && code <= 0x9f) code = windows1252Controls[code - 0x80]!;
      if (!Number.isSafeInteger(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    const value = namedEntities[entity];
    if (value === undefined) return match;
    if (semicolon === ';') return value;
    if (!legacyEntities.has(entity)) return match;
    if (attribute && /[=A-Za-z0-9]/.test(text[offset + match.length] ?? '')) return match;
    return value;
  });
}
