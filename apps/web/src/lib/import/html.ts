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
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') out.attributes = foreignAttributeOrder(out.attributes);
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
/** In-body start tags `package:html` inserts without reconstructing active formatting elements. */
const noReconstruct = new Set([
  'base', 'basefont', 'bgsound', 'command', 'link', 'meta', 'noframes', 'script', 'style', 'title', 'frameset', 'address',
  'article', 'aside', 'blockquote', 'center', 'details', 'dir', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer',
  'header', 'hgroup', 'menu', 'nav', 'ol', 'p', 'section', 'summary', 'ul', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre',
  'listing', 'form', 'li', 'dd', 'dt', 'plaintext', 'table', 'param', 'source', 'track', 'hr', 'isindex', 'textarea',
  'iframe', 'noembed', 'noscript', 'rp', 'rt', 'caption', 'col', 'colgroup', 'frame', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr',
]);
/** Elements that put a scope marker on the list of active formatting elements. */
const markerElements = new Set(['td', 'th', 'caption', 'applet', 'marquee', 'object']);
const scopeBoundary = new Set(['html', 'table', 'td', 'th', 'caption', 'marquee', 'object', 'applet', 'template', 'svg', 'math']);
const tableContext = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr']);
const tableContent = new Set(['caption', 'colgroup', 'col', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'script', 'style', 'template', 'form']);
/** SVG attribute names HTML5 camel-cases (the tokenizer lower-cases every name). */
const svgAttributes = new Map([
  'attributeName', 'attributeType', 'baseFrequency', 'baseProfile', 'calcMode', 'clipPathUnits', 'contentScriptType',
  'contentStyleType', 'diffuseConstant', 'edgeMode', 'externalResourcesRequired', 'filterRes', 'filterUnits',
  'glyphRef', 'gradientTransform', 'gradientUnits', 'kernelMatrix', 'kernelUnitLength', 'keyPoints', 'keySplines',
  'keyTimes', 'lengthAdjust', 'limitingConeAngle', 'markerHeight', 'markerUnits', 'markerWidth', 'maskContentUnits',
  'maskUnits', 'numOctaves', 'pathLength', 'patternContentUnits', 'patternTransform', 'patternUnits', 'pointsAtX',
  'pointsAtY', 'pointsAtZ', 'preserveAlpha', 'preserveAspectRatio', 'primitiveUnits', 'refX', 'refY', 'repeatCount',
  'repeatDur', 'requiredExtensions', 'requiredFeatures', 'specularConstant', 'specularExponent', 'spreadMethod',
  'startOffset', 'stdDeviation', 'stitchTiles', 'surfaceScale', 'systemLanguage', 'tableValues', 'targetX',
  'targetY', 'textLength', 'viewBox', 'viewTarget', 'xChannelSelector', 'yChannelSelector', 'zoomAndPan',
].map((name) => [name.toLowerCase(), name]));
const namespacedAttributes = new Set([
  'xlink:actuate', 'xlink:arcrole', 'xlink:href', 'xlink:role', 'xlink:show', 'xlink:title', 'xlink:type', 'xml:base',
  'xml:lang', 'xml:space', 'xmlns', 'xmlns:xlink',
]);

/**
 * `package:html` adjusts SVG/MathML start tags by removing and re-adding the
 * renamed attributes, so they end up last: camel-cased SVG names (and MathML
 * `definitionURL`) first, then the xlink/xml/xmlns ones. Browsers keep source
 * order, so foreign elements are reordered to match.
 */
function foreignAttributes(tokenAttributes: Map<string, string>): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const [key, value] of tokenAttributes) {
    attributes.set(svgAttributes.get(key) ?? (key === 'definitionurl' ? 'definitionURL' : key), value);
  }
  return foreignAttributeOrder(attributes);
}

function foreignAttributeOrder(attributes: Map<string, string>): Map<string, string> {
  const plain: Array<[string, string]> = [];
  const cased: Array<[string, string]> = [];
  const namespaced: Array<[string, string]> = [];
  for (const entry of attributes) {
    if (namespacedAttributes.has(entry[0])) namespaced.push(entry);
    else if (/[A-Z]/.test(entry[0])) cased.push(entry);
    else plain.push(entry);
  }
  return new Map([...plain, ...cased, ...namespaced]);
}

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
        // HTML ignores the self-closing flag here: `<script/>` still swallows text up to `</script>`.
        if (rawTextElements.has(name) || rcDataElements.has(name)) {
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
  /** HTML5 list of active formatting elements; `null` is a scope marker. */
  const active: Array<HtmlElement | null> = [];
  const parents = new WeakMap<HtmlElement, HtmlElement>();
  const append = (parent: HtmlElement, element: HtmlElement): void => {
    parent.children.push(element);
    parents.set(element, parent);
  };
  const detach = (element: HtmlElement): void => {
    const parent = parents.get(element);
    if (parent === undefined) return;
    parent.children.splice(parent.children.lastIndexOf(element), 1);
    parents.delete(element);
  };
  const remove = <T>(list: T[], item: T): void => {
    const at = list.indexOf(item);
    if (at >= 0) list.splice(at, 1);
  };
  const popUntil = (names: Set<string> | string): void => {
    while (stack.length > 2) {
      const node = stack.pop()!;
      // Closing a cell (or applet/marquee/object) clears formatting back to its marker.
      if (markerElements.has(node.name)) while (active.length > 0 && active.pop() !== null);
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
  const fosterInsert = (foster: { parent: HtmlElement; before: HtmlElement }, node: HtmlNode): void => {
    const siblings = foster.parent.children;
    const at = siblings.indexOf(foster.before);
    const previous = siblings[at - 1];
    if (node.kind === 'text' && previous?.kind === 'text') {
      previous.text += node.text;
    } else {
      siblings.splice(at, 0, node);
      if (node.kind === 'element') parents.set(node, foster.parent);
    }
  };
  const insert = (node: HtmlNode): void => {
    const foster = fosterParent();
    if (foster !== null) fosterInsert(foster, node);
    else if (node.kind === 'text') appendText(current(), node.text);
    else append(current(), node);
  };
  const clone = (element: HtmlElement): HtmlElement => htmlElement(element.name, new Map(element.attributes));
  /** The last formatting element named `name` after the last marker. */
  const activeFormatting = (name: string): HtmlElement | null => {
    for (let i = active.length - 1; i >= 0; i--) {
      const entry = active[i]!;
      if (entry === null) return null;
      if (entry.name === name) return entry;
    }
    return null;
  };
  /** Reopens formatting elements that were implicitly closed (e.g. a self-closed `<a id="x"/>` inside a `</p>`). */
  const reconstruct = (): void => {
    if (active.length === 0) return;
    let i = active.length - 1;
    const last = active[i]!;
    if (last === null || stack.includes(last)) return;
    while (i > 0) {
      const entry = active[i - 1]!;
      if (entry === null || stack.includes(entry)) break;
      i--;
    }
    for (; i < active.length; i++) {
      const element = clone(active[i]!);
      insert(element);
      stack.push(element);
      active[i] = element;
    }
  };
  /** Pushes a formatting element; like `package:html`, a fourth identical entry drops the earliest. */
  const addFormatting = (element: HtmlElement): void => {
    const matching: HtmlElement[] = [];
    for (let i = active.length - 1, scanned = 0; i >= 0; i--) {
      const entry = active[i]!;
      if (entry === null || scanned++ >= 256) break;
      if (entry.name === element.name && entry.attributes.size === element.attributes.size
        && [...entry.attributes].every(([key, value]) => element.attributes.get(key) === value)) matching.push(entry);
    }
    if (matching.length === 3) remove(active, matching[2]!);
    active.push(element);
  };
  /** `package:html`'s adoption agency (the html5lib variant: at most three inner steps). */
  const adoptionAgency = (name: string): void => {
    for (let outer = 0; outer < 8; outer++) {
      const element = activeFormatting(name);
      if (element === null || (stack.includes(element) && !inScope(name))) return;
      if (!stack.includes(element)) {
        remove(active, element);
        return;
      }
      const elementIndex = stack.indexOf(element);
      const furthestBlock = stack.slice(elementIndex).find((node) => special.has(node.name));
      if (furthestBlock === undefined) {
        while (stack.pop() !== element);
        remove(active, element);
        return;
      }
      const commonAncestor = stack[elementIndex - 1]!;
      let bookmark = active.indexOf(element);
      let lastNode = furthestBlock;
      let index = stack.indexOf(furthestBlock);
      for (let inner = 0; inner < 3; inner++) {
        index -= 1;
        let node = stack[index]!;
        if (!active.includes(node)) {
          remove(stack, node);
          continue;
        }
        if (node === element) break;
        if (lastNode === furthestBlock) bookmark = active.indexOf(node) + 1;
        const copy = clone(node);
        active[active.indexOf(node)] = copy;
        stack[stack.indexOf(node)] = copy;
        node = copy;
        detach(lastNode);
        append(node, lastNode);
        lastNode = node;
      }
      detach(lastNode);
      if (tableContext.has(commonAncestor.name)) {
        let table = stack.length - 1;
        while (table > 0 && stack[table]!.name !== 'table') table--;
        fosterInsert({ parent: stack[table - 1]!, before: stack[table]! }, lastNode);
      } else {
        append(commonAncestor, lastNode);
      }
      const copy = clone(element);
      copy.children = furthestBlock.children;
      for (const child of copy.children) if (child.kind === 'element') parents.set(child, copy);
      furthestBlock.children = [];
      append(furthestBlock, copy);
      remove(active, element);
      active.splice(Math.min(bookmark, active.length), 0, copy);
      remove(stack, element);
      stack.splice(stack.indexOf(furthestBlock) + 1, 0, copy);
    }
  };

  // HTML5 "before head", "in head" and "after head": leading whitespace is
  // dropped before <head>, kept inside it, and kept on <html> after </head>.
  let headMode: 'before' | 'in' | 'after' = 'before';
  // A newline right after <pre>, <listing> or <textarea> is not content.
  let dropNewline = false;
  // HTML5 input preprocessing turns CR LF and lone CR into LF.
  for (const token of tokenize(source.replace(/\r\n?/g, '\n'))) {
    let text = token.type === 'text' ? token.text : '';
    if (dropNewline) {
      dropNewline = false;
      if (text.startsWith('\n')) {
        text = text.slice(1);
        if (text === '') continue;
      }
    }
    if (!inBody) {
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
      if (token.type === 'text') {
        const leading = /^[\t\n\f\r ]*/.exec(text)![0];
        if (leading.length > 0 && headMode === 'in') appendText(head, leading);
        // <body> is created up front, so text "on <html>" goes between head and body.
        if (leading.length > 0 && headMode === 'after') html.children.splice(html.children.length - 1, 0, { kind: 'text', text: leading });
        text = text.slice(leading.length);
        if (text === '') continue;
      }
      if (token.type === 'start' && token.name === 'html') {
        merge(html, token.attributes);
        continue;
      }
      if (token.type === 'start' && token.name === 'head') {
        if (headMode === 'before') headMode = 'in';
        continue;
      }
      if (token.type === 'end' && token.name === 'head') {
        headMode = 'after';
        continue;
      }
      if (token.type === 'end' && token.name === 'html') continue;
      if (token.type === 'start' && headElements.has(token.name)) {
        if (headMode === 'before') headMode = 'in';
        const element = htmlElement(token.name, token.attributes);
        head.children.push(element);
        const rawText = rawTextElements.has(token.name) || rcDataElements.has(token.name);
        if (!voidElements.has(token.name) && (rawText || !token.selfClosing)) headStack.push(element);
        continue;
      }
      inBody = true;
      if (token.type === 'start' && token.name === 'body') {
        merge(body, token.attributes);
        continue;
      }
    }

    if (token.type === 'text') {
      if (tableContext.has(current().name) && text.trim() === '') {
        appendText(current(), text);
      } else {
        reconstruct();
        insert({ kind: 'text', text });
      }
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
        const element = htmlElement(name, foreignAttributes(token.attributes));
        append(current(), element);
        if (!token.selfClosing) stack.push(element);
        continue;
      }
      if (closesParagraph.has(name) && inScope('p', ['button'])) popUntil('p');
      if (name === 'li' && inScope('li', ['ol', 'ul'])) popUntil('li');
      if ((name === 'dd' || name === 'dt') && (inScope('dd') || inScope('dt'))) popUntil(new Set(['dd', 'dt']));
      if (headings.has(name) && headings.has(current().name)) stack.pop();
      const openA = name === 'a' ? activeFormatting('a') : null;
      if (openA !== null) {
        adoptionAgency('a');
        remove(stack, openA);
        remove(active, openA);
      }
      if (name === 'nobr' && inScope('nobr')) {
        reconstruct();
        adoptionAgency('nobr');
      }
      if (name === 'option' && current().name === 'option') stack.pop();
      if ((name === 'td' || name === 'th') && (inScope('td') || inScope('th'))) popUntil(new Set(['td', 'th']));
      if (name === 'tr' && stack.some((node) => node.name === 'tr')) popUntil('tr');
      // HTML5 wraps rows placed directly in a table in an implied <tbody> (and cells in a <tr>).
      const implied = (child: string): void => {
        const element = htmlElement(child);
        append(current(), element);
        stack.push(element);
      };
      if ((name === 'tr' || name === 'td' || name === 'th') && current().name === 'table') implied('tbody');
      if ((name === 'td' || name === 'th') && ['tbody', 'thead', 'tfoot'].includes(current().name)) implied('tr');
      if (!noReconstruct.has(name)) reconstruct();
      const foreignRoot = name === 'svg' || name === 'math';
      const element = htmlElement(name, foreignRoot ? foreignAttributes(token.attributes) : token.attributes);
      if (tableContent.has(name)) append(current(), element);
      else insert(element);
      if (!voidElements.has(name) && !(foreignRoot && token.selfClosing)) stack.push(element);
      if (formatting.has(name)) addFormatting(element);
      if (markerElements.has(name)) active.push(null);
      if (name === 'pre' || name === 'listing' || name === 'textarea') dropNewline = true;
      continue;
    }
    // End tag.
    const { name } = token;
    if (name === 'body' || name === 'html') continue;
    if (name === 'br') {
      reconstruct();
      insert(htmlElement('br'));
      continue;
    }
    if (formatting.has(name)) {
      adoptionAgency(name);
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
      if (special.has(node.name)) break;
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
