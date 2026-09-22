import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UPDATED_AT = "2026-09-22T00:00:00.000Z";
const GENERATED_AT = "2026-09-22T00:00:00.000Z";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(scriptDirectory, "../fixtures/generated");
const encoder = new TextEncoder();

interface SourceBook {
  id: string;
  title: string;
  description: string;
  subject: string;
  paragraphs: string[];
}

const books: SourceBook[] = [
  {
    id: "the-quiet-hour",
    title: "The Quiet Hour",
    description: "An original short reading sample about making room for stillness.",
    subject: "Essays",
    paragraphs: [
      "The quiet hour did not announce itself. It arrived after the kettle clicked off and before the street began its evening argument.",
      "Mira left the phone facedown and watched a square of amber light travel across the table. In that small interval, unfinished thoughts stopped asking to be solved.",
      "She opened a notebook. The first line was ordinary, the second was honest, and by the third the room seemed larger than it had been all day.",
    ],
  },
  {
    id: "a-walk-in-the-rain",
    title: "A Walk in the Rain",
    description: "An original short reading sample about a rainy neighborhood walk.",
    subject: "Short Fiction",
    paragraphs: [
      "Rain polished the lane until every window floated twice: once in the wall and once beneath Arun's shoes.",
      "He had gone out for coriander and returned by the longest route, past the tailor closing his blue shutters and the dog asleep under the tea stall awning.",
      "By home, the paper bag was soft at its corners. The coriander was bright, the rooms smelled of wet earth, and the unnecessary walk felt like the day's most useful thing.",
    ],
  },
  {
    id: "notes-on-attention",
    title: "Notes on Attention",
    description: "An original short reading sample on noticing one thing at a time.",
    subject: "Mindfulness",
    paragraphs: [
      "Attention is less like a spotlight than a hand. It can grip, skim, point, or rest.",
      "A page asks for a particular kind of rest: long enough for one sentence to alter the meaning of the next.",
      "When the mind wanders, the practice is simple. Notice where it went, return without ceremony, and begin again with the word already waiting.",
    ],
  },
];

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character]!);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint16(offset, value, true);
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value, true);
}

function zipStore(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let localOffset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const checksum = crc32(file.data);
    const local = new Uint8Array(30 + name.length + file.data.length);
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 4, 20);
    writeU16(local, 6, 0x0800);
    writeU16(local, 8, 0);
    writeU16(local, 10, 0);
    writeU16(local, 12, 0x0021);
    writeU32(local, 14, checksum);
    writeU32(local, 18, file.data.length);
    writeU32(local, 22, file.data.length);
    writeU16(local, 26, name.length);
    writeU16(local, 28, 0);
    local.set(name, 30);
    local.set(file.data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    writeU32(central, 0, 0x02014b50);
    writeU16(central, 4, 20);
    writeU16(central, 6, 20);
    writeU16(central, 8, 0x0800);
    writeU16(central, 10, 0);
    writeU16(central, 12, 0);
    writeU16(central, 14, 0x0021);
    writeU32(central, 16, checksum);
    writeU32(central, 20, file.data.length);
    writeU32(central, 24, file.data.length);
    writeU16(central, 28, name.length);
    writeU16(central, 30, 0);
    writeU16(central, 32, 0);
    writeU16(central, 34, 0);
    writeU16(central, 36, 0);
    writeU32(central, 38, 0);
    writeU32(central, 42, localOffset);
    central.set(name, 46);
    centrals.push(central);
    localOffset += local.length;
  }

  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  writeU32(end, 0, 0x06054b50);
  writeU16(end, 4, 0);
  writeU16(end, 6, 0);
  writeU16(end, 8, files.length);
  writeU16(end, 10, files.length);
  writeU32(end, 12, centralSize);
  writeU32(end, 16, localOffset);
  writeU16(end, 20, 0);

  const result = new Uint8Array(localOffset + centralSize + end.length);
  let offset = 0;
  for (const item of [...locals, ...centrals, end]) {
    result.set(item, offset);
    offset += item.length;
  }
  return result;
}

function makeEpub(book: SourceBook): Uint8Array {
  const identifier = `urn:thereader:${book.id}:1`;
  const title = xmlEscape(book.title);
  const paragraphs = book.paragraphs.map((paragraph) => `<p>${xmlEscape(paragraph)}</p>`).join("\n");
  const files = [
    { name: "mimetype", data: encoder.encode("application/epub+zip") },
    {
      name: "META-INF/container.xml",
      data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    },
    {
      name: "EPUB/package.opf",
      data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="en"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${identifier}</dc:identifier><dc:title>${title}</dc:title><dc:creator>The Reader</dc:creator><dc:language>en</dc:language><dc:subject>${xmlEscape(book.subject)}</dc:subject><meta property="dcterms:modified">2026-09-22T00:00:00Z</meta></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="styles.css" media-type="text/css"/></manifest><spine><itemref idref="chapter"/></spine></package>`),
    },
    {
      name: "EPUB/nav.xhtml",
      data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">${title}</a></li></ol></nav></body></html>`),
    },
    {
      name: "EPUB/chapter.xhtml",
      data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title>${title}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head><body><article><h1>${title}</h1><p class="byline">The Reader</p>${paragraphs}</article></body></html>`),
    },
    {
      name: "EPUB/styles.css",
      data: encoder.encode("body{font-family:serif;line-height:1.6;margin:5%;}article{max-width:40em;margin:auto;}h1{line-height:1.15;}.byline{font-style:italic;margin-bottom:2em;}"),
    },
  ];
  return zipStore(files);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

await mkdir(outputDirectory, { recursive: true });
const manifestBooks = [];
for (const book of books) {
  const epub = makeEpub(book);
  const sha256 = hex(await crypto.subtle.digest("SHA-256", epub.buffer as ArrayBuffer));
  const fileName = `${book.id}-v1.epub`;
  await Bun.write(resolve(outputDirectory, fileName), epub);
  manifestBooks.push({
    id: book.id,
    version: "1",
    title: book.title,
    author: "The Reader",
    description: book.description,
    language: "en",
    subjects: [book.subject],
      coverId: null,
      coverUrl: null,
    downloadUrl: `/v1/books/${book.id}/download`,
    fileSize: epub.length,
    sha256,
    updatedAt: UPDATED_AT,
    objectKey: `books/${book.id}/v1.epub`,
    cover: null,
  });
}

const manifest = { schemaVersion: 1, generatedAt: GENERATED_AT, books: manifestBooks };
await Bun.write(resolve(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Generated ${manifestBooks.length} deterministic EPUB fixtures in ${outputDirectory}`);
