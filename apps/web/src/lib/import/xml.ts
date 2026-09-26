/**
 * Small well-formedness-checking XML reader for EPUB package metadata. It
 * runs identically in browsers, workers and Bun tests (no DOMParser), and
 * mirrors what the mobile inspector relies on from `package:xml`: element
 * local names, attributes, text/CDATA and matching end tags. DTDs are
 * rejected; unknown entity references are kept literally like `package:xml`.
 */

export interface XmlAttribute {
  name: string;
  local: string;
  value: string;
}

export interface XmlElement {
  kind: 'element';
  name: string;
  local: string;
  attributes: XmlAttribute[];
  children: XmlNode[];
}

export interface XmlText {
  kind: 'text';
  value: string;
  cdata: boolean;
}

export type XmlNode = XmlElement | XmlText;

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

const namePattern = /[A-Za-z_:À-￿][A-Za-z0-9_:.\-·À-￿]*/y;
const spacePattern = /[ \t\r\n]*/y;

export function decodeXmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[entity]!;
  });
}

function localOf(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

export function parseXml(source: string): XmlElement {
  let pos = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = (message: string): never => {
    throw new XmlError(`${message} at offset ${pos}.`);
  };
  const skipSpace = (): void => {
    spacePattern.lastIndex = pos;
    spacePattern.exec(source);
    pos = spacePattern.lastIndex;
  };
  const readName = (): string => {
    namePattern.lastIndex = pos;
    const match = namePattern.exec(source);
    if (match === null) fail('Expected a name');
    pos = namePattern.lastIndex;
    return match![0];
  };
  const skipUntil = (terminator: string, what: string): string => {
    const end = source.indexOf(terminator, pos);
    if (end < 0) fail(`Unterminated ${what}`);
    const text = source.slice(pos, end);
    pos = end + terminator.length;
    return text;
  };
  /** Skips comments/PIs/whitespace outside the root element. */
  const skipMisc = (): void => {
    for (;;) {
      skipSpace();
      if (source.startsWith('<?', pos)) {
        pos += 2;
        skipUntil('?>', 'processing instruction');
      } else if (source.startsWith('<!--', pos)) {
        pos += 4;
        skipUntil('-->', 'comment');
      } else if (source.startsWith('<!DOCTYPE', pos)) {
        fail('Document type declarations are not supported');
      } else {
        return;
      }
    }
  };

  const parseElement = (): XmlElement => {
    pos += 1; // '<'
    const name = readName();
    const element: XmlElement = { kind: 'element', name, local: localOf(name), attributes: [], children: [] };
    for (;;) {
      const before = pos;
      skipSpace();
      if (source.startsWith('/>', pos)) {
        pos += 2;
        return element;
      }
      if (source[pos] === '>') {
        pos += 1;
        break;
      }
      if (pos === before) fail('Expected whitespace');
      const attribute = readName();
      skipSpace();
      if (source[pos] !== '=') fail('Expected =');
      pos += 1;
      skipSpace();
      const quote = source[pos];
      if (quote !== '"' && quote !== "'") fail('Expected a quoted attribute value');
      pos += 1;
      const raw = skipUntil(quote!, 'attribute value');
      if (raw.includes('<')) fail('Unexpected < in attribute value');
      element.attributes.push({ name: attribute, local: localOf(attribute), value: decodeXmlEntities(raw) });
    }
    // Content.
    for (;;) {
      if (pos >= source.length) fail(`Missing </${name}>`);
      if (source.startsWith('</', pos)) {
        pos += 2;
        const closing = readName();
        if (closing !== name) fail(`Expected </${name}> but found </${closing}>`);
        skipSpace();
        if (source[pos] !== '>') fail('Expected >');
        pos += 1;
        return element;
      }
      if (source.startsWith('<!--', pos)) {
        pos += 4;
        skipUntil('-->', 'comment');
      } else if (source.startsWith('<![CDATA[', pos)) {
        pos += 9;
        element.children.push({ kind: 'text', value: skipUntil(']]>', 'CDATA section'), cdata: true });
      } else if (source.startsWith('<?', pos)) {
        pos += 2;
        skipUntil('?>', 'processing instruction');
      } else if (source.startsWith('<!', pos)) {
        fail('Unexpected declaration');
      } else if (source[pos] === '<') {
        element.children.push(parseElement());
      } else {
        const end = source.indexOf('<', pos);
        const raw = source.slice(pos, end < 0 ? source.length : end);
        pos += raw.length;
        element.children.push({ kind: 'text', value: decodeXmlEntities(raw), cdata: false });
      }
    }
  };

  skipMisc();
  if (source[pos] !== '<') fail('Expected the root element');
  const root = parseElement();
  skipMisc();
  if (pos < source.length) fail('Unexpected content after the root element');
  return root;
}

/** Every element below (and including) `root`, in document order. */
export function descendants(root: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (element: XmlElement): void => {
    out.push(element);
    for (const child of element.children) if (child.kind === 'element') walk(child);
  };
  walk(root);
  return out;
}

/** Every text/CDATA node below `root`, in document order. */
export function textNodes(root: XmlElement): XmlText[] {
  const out: XmlText[] = [];
  const walk = (element: XmlElement): void => {
    for (const child of element.children) {
      if (child.kind === 'text') out.push(child);
      else walk(child);
    }
  };
  walk(root);
  return out;
}

export function childElements(element: XmlElement): XmlElement[] {
  return element.children.filter((child): child is XmlElement => child.kind === 'element');
}

/** `package:xml` `innerText`: all descendant text concatenated. */
export function innerText(element: XmlElement): string {
  return textNodes(element).map((node) => node.value).join('');
}

/** Attribute by qualified name, like `XmlElement.getAttribute`. */
export function getAttribute(element: XmlElement, name: string): string | null {
  return element.attributes.find((attribute) => attribute.name === name)?.value ?? null;
}
