import { unzlibSync } from 'fflate';
import { ByteBuilder, latin1Decode, utf8Decode, view } from './bytes';

/**
 * TypeScript port of `package:kindle_unpack` 0.2.0, the Dart library the
 * mobile MOBI converter builds on (itself a port of KindleUnpack). Only the
 * pieces `mobi_converter.dart` touches are included; names follow the Dart
 * source so the two can be compared side by side.
 */

/** Any structural failure inside the Kindle container (Dart `KindleUnpackException`). */
export class KindleError extends Error {
  constructor(message: string, readonly kind: 'pdb' | 'header' | 'palmdoc' | 'huffcdic' | 'format' | 'drm' = 'header') {
    super(message);
    this.name = 'KindleError';
  }
}

/** Dart `HeaderException`. */
function headerError(message: string): KindleError {
  return new KindleError(message, 'header');
}

export const UNSET = 0xffffffff;

// ---------------------------------------------------------------------------
// PDB

export interface PdbRecord {
  offset: number;
  data: Uint8Array;
}

export interface PdbFile {
  name: string;
  type: string;
  creator: string;
  records: PdbRecord[];
}

const pdbHeaderSize = 78;

export function parsePdb(bytes: Uint8Array): PdbFile {
  if (bytes.length < pdbHeaderSize) {
    throw new KindleError(`file too short: ${bytes.length} bytes < ${pdbHeaderSize} header bytes`, 'pdb');
  }
  const data = view(bytes);
  let nameEnd = 32;
  for (let i = 0; i < 32; i++) {
    if (bytes[i] === 0) {
      nameEnd = i;
      break;
    }
  }
  const recordCount = data.getUint16(76);
  const recordListEnd = pdbHeaderSize + recordCount * 8;
  if (bytes.length < recordListEnd) {
    throw new KindleError(`truncated record list: need ${recordListEnd} bytes for ${recordCount} entries`, 'pdb');
  }
  const offsets: number[] = [];
  for (let i = 0; i < recordCount; i++) offsets.push(data.getUint32(pdbHeaderSize + i * 8));
  for (let i = 0; i < recordCount; i++) {
    const offset = offsets[i]!;
    if (offset < recordListEnd) throw new KindleError(`record ${i} offset ${offset} lies inside header/record-list area`, 'pdb');
    if (offset > bytes.length) throw new KindleError(`record ${i} offset ${offset} past end of file`, 'pdb');
    if (i > 0 && offset < offsets[i - 1]!) throw new KindleError(`record offsets not monotonically increasing at index ${i}`, 'pdb');
  }
  const records = offsets.map((start, i) => ({
    offset: start,
    data: bytes.subarray(start, i + 1 < recordCount ? offsets[i + 1]! : bytes.length),
  }));
  return {
    name: latin1Decode(bytes.subarray(0, nameEnd)),
    type: latin1Decode(bytes.subarray(60, 64)),
    creator: latin1Decode(bytes.subarray(64, 68)),
    records,
  };
}

// ---------------------------------------------------------------------------
// PalmDOC / MOBI / EXTH headers

export const enum Compression {
  none = 1,
  palmDoc = 2,
  huffCdic = 17480,
}

export interface PalmDocHeader {
  compression: Compression;
  textLength: number;
  textRecordCount: number;
  encryption: number;
}

export function parsePalmDoc(record0: Uint8Array): PalmDocHeader {
  if (record0.length < 16) throw headerError(`record 0 too short for PalmDOC header: ${record0.length} < 16`);
  const data = view(record0);
  const compression = data.getUint16(0);
  if (compression !== 1 && compression !== 2 && compression !== 17480) {
    throw headerError(`unknown PalmDOC compression code: ${compression}`);
  }
  const encryption = data.getUint16(12);
  if (encryption > 2) throw headerError(`unknown encryption code: ${encryption}`);
  return { compression, textLength: data.getUint32(4), textRecordCount: data.getUint16(8), encryption };
}

export interface MobiHeader {
  headerLength: number;
  textEncoding: number;
  uniqueId: number;
  fileVersion: number;
  fullNameOffset: number;
  fullNameLength: number;
  firstImageIndex: number;
  huffmanRecordOffset: number;
  huffmanRecordCount: number;
  exthFlags: number;
  drmOffset: number | null;
  drmCount: number | null;
  fdstRecord: number | null;
  fragmentIndex: number | null;
  skeletonIndex: number | null;
  extraDataFlags: number;
}

export function hasExth(mobi: MobiHeader): boolean {
  return (mobi.exthFlags & 0x40) !== 0;
}

export function hasDrm(mobi: MobiHeader): boolean {
  const { drmOffset: offset, drmCount: count } = mobi;
  if (offset === null || count === null || offset === UNSET || count === UNSET) return false;
  return count > 0;
}

export function parseMobiHeader(record0: Uint8Array): MobiHeader {
  const sigOffset = 16;
  if (record0.length < sigOffset + 8) throw headerError(`record 0 too short for MOBI signature + length: ${record0.length}`);
  const data = view(record0);
  const signature = latin1Decode(record0.subarray(sigOffset, sigOffset + 4));
  if (signature !== 'MOBI') throw headerError(`expected "MOBI" signature, got "${signature}"`);
  const headerLength = data.getUint32(sigOffset + 4);
  if (headerLength < 24) throw headerError(`MOBI header length too small: ${headerLength} (need >= 24)`);
  if (sigOffset + headerLength > record0.length) throw headerError(`MOBI header (length ${headerLength}) extends past record 0`);
  const u32 = (rel: number): number | null => (rel + 4 > headerLength ? null : data.getUint32(sigOffset + rel));
  const u16 = (rel: number): number | null => (rel + 2 > headerLength ? null : data.getUint16(sigOffset + rel));
  return {
    headerLength,
    textEncoding: u32(12) ?? 0,
    uniqueId: u32(16) ?? 0,
    fileVersion: u32(20) ?? 0,
    fullNameOffset: u32(68) ?? 0,
    fullNameLength: u32(72) ?? 0,
    firstImageIndex: u32(92) ?? UNSET,
    huffmanRecordOffset: u32(96) ?? 0,
    huffmanRecordCount: u32(100) ?? 0,
    exthFlags: u32(112) ?? 0,
    drmOffset: u32(152),
    drmCount: u32(156),
    fdstRecord: u32(176),
    fragmentIndex: u32(232),
    skeletonIndex: u32(236),
    extraDataFlags: u16(226) ?? 0,
  };
}

function decodeText(bytes: Uint8Array, encoding: number): string {
  return encoding === 65001 ? utf8Decode(bytes) : latin1Decode(bytes);
}

export function mobiFullName(mobi: MobiHeader, record0: Uint8Array): string {
  if (mobi.fullNameLength === 0) return '';
  const end = mobi.fullNameOffset + mobi.fullNameLength;
  if (end > record0.length) throw headerError(`full name extends past record 0 (${record0.length})`);
  return decodeText(record0.subarray(mobi.fullNameOffset, end), mobi.textEncoding);
}

export interface ExthHeader {
  byType: Map<number, Uint8Array[]>;
  textEncoding: number;
}

export function parseExth(record0: Uint8Array, offset: number, textEncoding: number): ExthHeader {
  if (offset < 0 || offset + 12 > record0.length) throw headerError(`EXTH header offset ${offset} out of range`);
  const data = view(record0);
  const signature = latin1Decode(record0.subarray(offset, offset + 4));
  if (signature !== 'EXTH') throw headerError(`expected "EXTH" signature, got "${signature}"`);
  const headerLength = data.getUint32(offset + 4);
  const recordCount = data.getUint32(offset + 8);
  if (headerLength < 12) throw headerError(`EXTH header length too small: ${headerLength} (need >= 12)`);
  if (offset + headerLength > record0.length) throw headerError(`EXTH header (length ${headerLength}) extends past record 0`);
  const byType = new Map<number, Uint8Array[]>();
  let cursor = offset + 12;
  const headerEnd = offset + headerLength;
  for (let i = 0; i < recordCount; i++) {
    if (cursor + 8 > headerEnd) throw headerError(`EXTH record ${i} header runs past EXTH end`);
    const type = data.getUint32(cursor);
    const length = data.getUint32(cursor + 4);
    if (length < 8) throw headerError(`EXTH record ${i} length too small: ${length} (need >= 8)`);
    if (cursor + length > headerEnd) throw headerError(`EXTH record ${i} (length ${length}) runs past EXTH end`);
    const list = byType.get(type) ?? [];
    list.push(record0.subarray(cursor + 8, cursor + length));
    byType.set(type, list);
    cursor += length;
  }
  return { byType, textEncoding };
}

export const exth = {
  string(header: ExthHeader, type: number): string | null {
    const value = header.byType.get(type)?.[0];
    return value === undefined ? null : decodeText(value, header.textEncoding);
  },
  strings(header: ExthHeader, type: number): string[] {
    return (header.byType.get(type) ?? []).map((value) => decodeText(value, header.textEncoding));
  },
  uint32(header: ExthHeader, type: number): number | null {
    const value = header.byType.get(type)?.[0];
    if (value === undefined || value.length !== 4) return null;
    return view(value).getUint32(0);
  },
  title: (header: ExthHeader) => exth.string(header, 503),
  authors: (header: ExthHeader) => exth.strings(header, 100),
  publisher: (header: ExthHeader) => exth.string(header, 101),
  description: (header: ExthHeader) => exth.string(header, 103),
  asin: (header: ExthHeader) => exth.string(header, 113) ?? exth.string(header, 504),
  language: (header: ExthHeader) => exth.string(header, 524),
  coverOffset: (header: ExthHeader) => exth.uint32(header, 201),
  thumbnailOffset: (header: ExthHeader) => exth.uint32(header, 202),
  kf8BoundaryRecord: (header: ExthHeader) => exth.uint32(header, 121),
};

// ---------------------------------------------------------------------------
// Sections (Mobi-7 / KF8 / combo)

export type KindleFormat = 'mobi7Only' | 'kf8Only' | 'combo';

export interface KindleSection {
  recordOffset: number;
  recordCount: number;
  palmDoc: PalmDocHeader;
  mobi: MobiHeader;
  exth: ExthHeader | null;
}

function parseSection(pdb: PdbFile, recordOffset: number, recordCount: number): KindleSection {
  const record0 = pdb.records[recordOffset]!.data;
  const palmDoc = parsePalmDoc(record0);
  const mobi = parseMobiHeader(record0);
  const header = hasExth(mobi) ? parseExth(record0, 16 + mobi.headerLength, mobi.textEncoding) : null;
  return { recordOffset, recordCount, palmDoc, mobi, exth: header };
}

export function inspectKindle(pdb: PdbFile): { format: KindleFormat; mobi7: KindleSection | null; kf8: KindleSection | null } {
  if (pdb.records.length === 0) throw headerError('PDB has no records to inspect');
  const first = parseSection(pdb, 0, pdb.records.length);
  if (first.mobi.fileVersion >= 8) return { format: 'kf8Only', mobi7: null, kf8: first };
  const boundary = first.exth === null ? null : exth.kf8BoundaryRecord(first.exth);
  if (
    boundary !== null &&
    boundary !== UNSET &&
    boundary > 0 &&
    boundary < pdb.records.length &&
    looksLikeBoundarySentinel(pdb.records[boundary - 1]!.data)
  ) {
    return {
      format: 'combo',
      mobi7: { ...first, recordCount: boundary },
      kf8: parseSection(pdb, boundary, pdb.records.length - boundary),
    };
  }
  return { format: 'mobi7Only', mobi7: first, kf8: null };
}

function looksLikeBoundarySentinel(record: Uint8Array): boolean {
  return record.length >= 8 && latin1Decode(record.subarray(0, 8)) === 'BOUNDARY';
}

// ---------------------------------------------------------------------------
// Text decompression

export function sizeOfTrailingDataEntries(record: Uint8Array, flags: number): number {
  const sizeOfOne = (end: number): number => {
    let bitpos = 0;
    let result = 0;
    let pos = end;
    while (pos > 0) {
      const v = record[pos - 1]!;
      result |= (v & 0x7f) << bitpos;
      bitpos += 7;
      pos -= 1;
      if ((v & 0x80) !== 0 || bitpos >= 28) break;
    }
    return result;
  };
  let num = 0;
  let testFlags = flags >> 1;
  while (testFlags !== 0) {
    if ((testFlags & 1) !== 0) num += sizeOfOne(record.length - num);
    testFlags >>= 1;
  }
  if ((flags & 1) !== 0) {
    if (record.length - num - 1 < 0) throw headerError('multibyte-overlap indicator points before record start');
    num += (record[record.length - num - 1]! & 0x3) + 1;
  }
  return num;
}

export function stripTrailingDataEntries(record: Uint8Array, flags: number): Uint8Array {
  if (flags === 0) return record;
  const size = sizeOfTrailingDataEntries(record, flags);
  if (size < 0 || size > record.length) throw headerError(`trailing-data size ${size} out of range`);
  return record.subarray(0, record.length - size);
}

export function decompressPalmDoc(input: Uint8Array): Uint8Array {
  let out = new Uint8Array(Math.max(16, input.length * 2));
  let length = 0;
  const ensure = (extra: number): void => {
    if (length + extra <= out.length) return;
    const next = new Uint8Array(Math.max(out.length * 2, length + extra));
    next.set(out.subarray(0, length));
    out = next;
  };
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i++]!;
    if (c === 0 || (c >= 0x09 && c <= 0x7f)) {
      ensure(1);
      out[length++] = c;
    } else if (c >= 0x01 && c <= 0x08) {
      if (i + c > n) throw new KindleError(`literal run of ${c} bytes at offset ${i - 1} runs past input`, 'palmdoc');
      ensure(c);
      for (let j = 0; j < c; j++) out[length++] = input[i + j]!;
      i += c;
    } else if (c >= 0x80 && c <= 0xbf) {
      if (i >= n) throw new KindleError(`back-reference at offset ${i - 1} truncated`, 'palmdoc');
      const combined = ((c << 8) | input[i++]!) & 0x3fff;
      const distance = combined >> 3;
      const count = (combined & 0x07) + 3;
      if (distance === 0) throw new KindleError(`back-reference at offset ${i - 2} has distance 0`, 'palmdoc');
      const source = length - distance;
      if (source < 0) throw new KindleError(`back-reference at offset ${i - 2} reads before start of output`, 'palmdoc');
      ensure(count);
      for (let j = 0; j < count; j++) out[length++] = out[source + j]!;
    } else {
      ensure(2);
      out[length++] = 0x20;
      out[length++] = c ^ 0x80;
    }
  }
  return out.slice(0, length);
}

interface HuffTable {
  cacheLength: Uint8Array;
  cacheTerminal: Uint8Array;
  cacheMax: Uint32Array;
  minCode: number[];
  maxCodeByLen: number[];
}

interface CdicEntry {
  bytes: Uint8Array;
  precoded: boolean;
}

/** `(value << shift) & 0xFFFFFFFF` with Dart's 64-bit ints, exact in doubles. */
function shiftLeft32(value: number, shift: number): number {
  return (value % 2 ** (32 - shift)) * 2 ** shift;
}

/** `((value << shift) - 1) & 0xFFFFFFFF` with Dart's 64-bit ints. */
function shiftLeftMinusOne(value: number, shift: number): number {
  const shifted = shiftLeft32(value, shift);
  return shifted === 0 ? 0xffffffff : shifted - 1;
}

function parseHuff(record: Uint8Array): HuffTable {
  if (record.length < 24) throw new KindleError(`HUFF record too short: ${record.length}`, 'huffcdic');
  const data = view(record);
  const signature = latin1Decode(record.subarray(0, 4));
  if (signature !== 'HUFF') throw new KindleError(`expected "HUFF" signature, got "${signature}"`, 'huffcdic');
  if (data.getUint32(4) !== 0x18) throw new KindleError('unsupported HUFF header length', 'huffcdic');
  const off1 = data.getUint32(8);
  const off2 = data.getUint32(12);
  if (off1 + 256 * 4 > record.length) throw new KindleError('HUFF cache table extends past record end', 'huffcdic');
  if (off2 + 64 * 4 > record.length) throw new KindleError('HUFF mincode/maxcode table extends past record end', 'huffcdic');
  const cacheLength = new Uint8Array(256);
  const cacheTerminal = new Uint8Array(256);
  const cacheMax = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = data.getUint32(off1 + i * 4);
    const codeLen = v & 0x1f;
    const terminal = (v & 0x80) !== 0;
    const maxCodeRaw = v >>> 8;
    if (codeLen === 0) throw new KindleError(`HUFF cache entry ${i} has codeLen 0`, 'huffcdic');
    if (codeLen <= 8 && !terminal) throw new KindleError(`HUFF cache entry ${i} is non-terminal`, 'huffcdic');
    cacheLength[i] = codeLen;
    cacheTerminal[i] = terminal ? 1 : 0;
    cacheMax[i] = shiftLeftMinusOne(maxCodeRaw + 1, 32 - codeLen);
  }
  const minCode = new Array<number>(33).fill(0);
  const maxCodeByLen = new Array<number>(33).fill(0);
  maxCodeByLen[0] = 0xffffffff;
  for (let i = 1; i <= 32; i++) {
    const mincodeRaw = data.getUint32(off2 + (i - 1) * 8);
    const maxcodeRaw = data.getUint32(off2 + (i - 1) * 8 + 4);
    minCode[i] = shiftLeft32(mincodeRaw, 32 - i);
    maxCodeByLen[i] = shiftLeftMinusOne(maxcodeRaw + 1, 32 - i);
  }
  return { cacheLength, cacheTerminal, cacheMax, minCode, maxCodeByLen };
}

function parseCdic(records: Uint8Array[]): CdicEntry[] {
  if (records.length === 0) throw new KindleError('CDIC table needs at least one record', 'huffcdic');
  let totalPhrases = 0;
  let bits = 0;
  const entries: CdicEntry[] = [];
  for (let ri = 0; ri < records.length; ri++) {
    const record = records[ri]!;
    if (record.length < 16) throw new KindleError(`CDIC record ${ri} too short`, 'huffcdic');
    const data = view(record);
    const signature = latin1Decode(record.subarray(0, 4));
    if (signature !== 'CDIC') throw new KindleError(`CDIC record ${ri}: expected "CDIC" signature`, 'huffcdic');
    if (data.getUint32(4) !== 0x10) throw new KindleError(`CDIC record ${ri}: unsupported header length`, 'huffcdic');
    const phrases = data.getUint32(8);
    const recordBits = data.getUint32(12);
    if (ri === 0) {
      totalPhrases = phrases;
      bits = recordBits;
    } else if (phrases !== totalPhrases || recordBits !== bits) {
      throw new KindleError(`CDIC record ${ri} header disagrees with first record`, 'huffcdic');
    }
    const n = Math.max(0, Math.min(2 ** bits, totalPhrases - entries.length));
    if (n === 0) break;
    if (16 + n * 2 > record.length) throw new KindleError(`CDIC record ${ri} offset table runs past record end`, 'huffcdic');
    for (let i = 0; i < n; i++) {
      const offset = data.getUint16(16 + i * 2);
      if (16 + offset + 2 > record.length) throw new KindleError(`CDIC record ${ri} entry ${i} offset out of range`, 'huffcdic');
      const lengthAndFlag = data.getUint16(16 + offset);
      const start = 16 + offset + 2;
      const end = start + (lengthAndFlag & 0x7fff);
      if (end > record.length) throw new KindleError(`CDIC record ${ri} entry ${i} payload runs past record end`, 'huffcdic');
      entries.push({ bytes: record.subarray(start, end), precoded: (lengthAndFlag & 0x8000) !== 0 });
    }
  }
  if (entries.length !== totalPhrases) throw new KindleError('CDIC entry count disagrees with header', 'huffcdic');
  return entries;
}

function decompressHuffCdic(input: Uint8Array, huff: HuffTable, cdic: CdicEntry[], expanding = new Set<number>()): Uint8Array {
  const padded = new Uint8Array(input.length + 8);
  padded.set(input);
  const data = view(padded);
  let bitsLeft = input.length * 8;
  let pos = 0;
  let high = data.getUint32(0);
  let low = data.getUint32(4);
  let n = 32;
  const out = new ByteBuilder();
  for (;;) {
    if (n <= 0) {
      pos += 4;
      high = low;
      low = data.getUint32(pos + 4);
      n += 32;
    }
    const code = n === 32 ? high : n === 0 ? low : ((high << (32 - n)) | (low >>> n)) >>> 0;
    const top = code >>> 24;
    let codeLen = huff.cacheLength[top]!;
    let maxCode = huff.cacheMax[top]!;
    if (huff.cacheTerminal[top] === 0) {
      while (code < huff.minCode[codeLen]!) {
        codeLen++;
        if (codeLen > 32) throw new KindleError('codeword exceeds 32 bits', 'huffcdic');
      }
      maxCode = huff.maxCodeByLen[codeLen]!;
    }
    n -= codeLen;
    bitsLeft -= codeLen;
    if (bitsLeft < 0) break;
    const r = Math.floor((maxCode - code) / 2 ** (32 - codeLen));
    if (r < 0 || r >= cdic.length) throw new KindleError(`dictionary index ${r} out of range`, 'huffcdic');
    const entry = cdic[r]!;
    if (entry.precoded) {
      out.add(entry.bytes);
    } else {
      if (expanding.has(r)) throw new KindleError(`cycle in CDIC entry ${r}`, 'huffcdic');
      expanding.add(r);
      const expanded = decompressHuffCdic(entry.bytes, huff, cdic, expanding);
      expanding.delete(r);
      entry.bytes = expanded;
      entry.precoded = true;
      out.add(expanded);
    }
  }
  return out.toBytes();
}

export function decompressBookText(pdb: PdbFile, palmDoc: PalmDocHeader, mobi: MobiHeader): Uint8Array {
  if (palmDoc.encryption !== 0 || hasDrm(mobi)) {
    throw new KindleError('cannot decompress encrypted MOBI', 'drm');
  }
  const count = palmDoc.textRecordCount;
  if (count === 0) return new Uint8Array(0);
  if (1 + count > pdb.records.length) throw headerError(`PalmDOC header advertises ${count} text records but PDB has fewer`);
  let huff: HuffTable | null = null;
  let cdic: CdicEntry[] | null = null;
  if (palmDoc.compression === Compression.huffCdic) {
    const offset = mobi.huffmanRecordOffset;
    const huffCount = mobi.huffmanRecordCount;
    if (offset === 0 || huffCount < 2) throw headerError('HUFF/CDIC compression but MOBI header has no HUFF/CDIC records');
    if (offset + huffCount > pdb.records.length) throw headerError('HUFF/CDIC records extend past PDB record list');
    huff = parseHuff(pdb.records[offset]!.data);
    const tables: Uint8Array[] = [];
    for (let i = offset + 1; i < offset + huffCount; i++) tables.push(pdb.records[i]!.data);
    cdic = parseCdic(tables);
  }
  const out = new ByteBuilder();
  for (let i = 1; i <= count; i++) {
    const payload = stripTrailingDataEntries(pdb.records[i]!.data, mobi.extraDataFlags);
    if (palmDoc.compression === Compression.none) out.add(payload);
    else if (palmDoc.compression === Compression.palmDoc) out.add(decompressPalmDoc(payload));
    else out.add(decompressHuffCdic(payload, huff!, cdic!));
  }
  return out.toBytes();
}

// ---------------------------------------------------------------------------
// KF8 FDST / flows

export type FlowKind = 'html' | 'css' | 'svg' | 'other';

export interface FlowSection {
  index: number;
  kind: FlowKind;
  bytes: Uint8Array;
}

export function parseFdst(record: Uint8Array): Array<{ start: number; end: number }> {
  if (record.length < 12) throw headerError(`FDST record too short: ${record.length} bytes`);
  const data = view(record);
  const signature = latin1Decode(record.subarray(0, 4));
  if (signature !== 'FDST') throw headerError(`expected "FDST" signature, got "${signature}"`);
  const sections = data.getUint32(8);
  if (12 + sections * 8 > record.length) throw headerError(`FDST record advertises ${sections} sections but is too short`);
  const entries: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < sections; i++) entries.push({ start: data.getUint32(12 + i * 8), end: data.getUint32(16 + i * 8) });
  return entries;
}

export function splitFlows(rawML: Uint8Array, fdst: Array<{ start: number; end: number }>): FlowSection[] {
  return fdst.map((entry, index) => {
    if (entry.start < 0 || entry.end > rawML.length || entry.start > entry.end) {
      throw headerError(`FDST entry ${index} [${entry.start}, ${entry.end}) is invalid for rawML length ${rawML.length}`);
    }
    const bytes = rawML.subarray(entry.start, entry.end);
    return { index, kind: classifyFlow(bytes), bytes };
  });
}

function classifyFlow(bytes: Uint8Array): FlowKind {
  let i = 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  if (i >= bytes.length) return 'other';
  const head = latin1Decode(bytes.subarray(i, i + Math.min(bytes.length - i, 256)));
  if (head.startsWith('<')) return head.toLowerCase().includes('<svg') ? 'svg' : 'html';
  if (head.startsWith('@') || head.startsWith('/*')) return 'css';
  if (head.includes('{') && head.includes('}')) return 'css';
  return 'other';
}

// ---------------------------------------------------------------------------
// INDX (skeleton / fragment tables)

interface TagxEntry {
  tag: number;
  valuesPerEntry: number;
  mask: number;
  endFlag: number;
}

interface IndxEntry {
  name: Uint8Array;
  tagMap: Map<number, number[]>;
}

interface IndxHeader {
  headerLength: number;
  idxtStart: number;
  indexCount: number;
  nctoc: number;
  ordt1Count: number;
}

function parseIndxHeader(record: Uint8Array): IndxHeader {
  if (record.length < 0x40) throw headerError(`INDX record too short: ${record.length}`);
  const signature = latin1Decode(record.subarray(0, 4));
  if (signature !== 'INDX') throw headerError(`expected "INDX" signature, got "${signature}"`);
  const data = view(record);
  return {
    headerLength: data.getUint32(4),
    idxtStart: data.getUint32(20),
    indexCount: data.getUint32(24),
    nctoc: data.getUint32(52),
    ordt1Count: record.length >= 0xa4 + 20 ? data.getUint32(0xa4) : 0,
  };
}

function readVarWidth(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let consumed = 0;
  for (;;) {
    if (offset + consumed >= bytes.length) throw headerError(`variable-width int at offset ${offset} runs past buffer end`);
    const v = bytes[offset + consumed]!;
    consumed += 1;
    value = value * 128 + (v & 0x7f);
    if ((v & 0x80) !== 0) return [consumed, value];
  }
}

function countSetBits(value: number): number {
  let n = 0;
  for (let x = value; x !== 0; x >>= 1) n += x & 1;
  return n;
}

function decodeTagMap(record: Uint8Array, tagx: TagxEntry[], start: number, end: number): Map<number, number[]> {
  const controlByteCount = tagx.filter((t) => t.endFlag === 1).length;
  const pending: Array<{ tag: number; valueCount: number | null; valueBytes: number | null; valuesPerEntry: number }> = [];
  let controlByteIndex = 0;
  for (const t of tagx) {
    if (t.endFlag === 1) {
      controlByteIndex++;
      continue;
    }
    const masked = record[start + controlByteIndex]! & t.mask;
    if (masked === 0) continue;
    if (masked === t.mask) {
      pending.push({ tag: t.tag, valueCount: countSetBits(t.mask) > 1 ? null : 1, valueBytes: null, valuesPerEntry: t.valuesPerEntry });
    } else {
      let mask = t.mask;
      let value = masked;
      while ((mask & 0x01) === 0) {
        mask >>= 1;
        value >>= 1;
      }
      pending.push({ tag: t.tag, valueCount: value, valueBytes: null, valuesPerEntry: t.valuesPerEntry });
    }
  }
  let dataStart = start + controlByteCount;
  for (const p of pending) {
    if (p.valueCount === null && p.valueBytes === null) {
      const [consumed, length] = readVarWidth(record, dataStart);
      dataStart += consumed;
      p.valueBytes = length;
    }
  }
  const out = new Map<number, number[]>();
  for (const p of pending) {
    const values: number[] = [];
    if (p.valueCount !== null) {
      const total = p.valueCount * p.valuesPerEntry;
      for (let k = 0; k < total; k++) {
        const [consumed, value] = readVarWidth(record, dataStart);
        dataStart += consumed;
        values.push(value);
      }
    } else {
      const target = dataStart + p.valueBytes!;
      while (dataStart < target) {
        const [consumed, value] = readVarWidth(record, dataStart);
        dataStart += consumed;
        values.push(value);
      }
    }
    out.set(p.tag, values);
    if (dataStart > end) throw headerError(`INDX entry tag ${p.tag} consumed past entry end`);
  }
  return out;
}

function readIndx(pdb: PdbFile, recordIndex: number): { entries: IndxEntry[]; ctoc: Map<number, Uint8Array> } {
  if (recordIndex < 0 || recordIndex >= pdb.records.length) throw headerError(`INDX record ${recordIndex} out of range`);
  const main = pdb.records[recordIndex]!.data;
  const header = parseIndxHeader(main);
  if (header.ordt1Count !== 0) throw headerError(`INDX record ${recordIndex} uses ORDT-remapped names; not supported`);
  const tagxStart = header.headerLength;
  if (tagxStart + 12 > main.length) throw headerError('TAGX section past INDX record end');
  if (latin1Decode(main.subarray(tagxStart, tagxStart + 4)) !== 'TAGX') throw headerError('expected "TAGX" signature');
  const firstEntryOffset = view(main).getUint32(tagxStart + 4);
  const tagx: TagxEntry[] = [];
  for (let i = 12; i < firstEntryOffset; i += 4) {
    if (tagxStart + i + 4 > main.length) throw headerError(`TAGX row at offset ${tagxStart + i} truncated`);
    tagx.push({
      tag: main[tagxStart + i]!,
      valuesPerEntry: main[tagxStart + i + 1]!,
      mask: main[tagxStart + i + 2]!,
      endFlag: main[tagxStart + i + 3]!,
    });
  }
  const ctoc = new Map<number, Uint8Array>();
  const ctocStart = recordIndex + header.indexCount + 1;
  for (let i = 0; i < header.nctoc; i++) {
    const r = ctocStart + i;
    if (r >= pdb.records.length) throw headerError(`CTOC record ${r} past end of PDB`);
    const data = pdb.records[r]!.data;
    let offset = 0;
    while (offset < data.length) {
      if (data[offset] === 0) break;
      const keyOffset = offset + i * 0x10000;
      const [consumed, length] = readVarWidth(data, offset);
      offset += consumed;
      if (offset + length > data.length) throw headerError('CTOC string runs past record end');
      ctoc.set(keyOffset, data.subarray(offset, offset + length));
      offset += length;
    }
  }
  const entries: IndxEntry[] = [];
  for (let i = 1; i <= header.indexCount; i++) {
    const record = pdb.records[recordIndex + i]?.data;
    if (record === undefined) throw headerError(`INDX record ${recordIndex + i} out of range`);
    const entryHeader = parseIndxHeader(record);
    const data = view(record);
    const { idxtStart, indexCount: entryCount } = entryHeader;
    if (idxtStart + 4 + 2 * entryCount > record.length) throw headerError('IDXT positions extend past INDX record end');
    const positions: number[] = [];
    for (let j = 0; j < entryCount; j++) positions.push(data.getUint16(idxtStart + 4 + 2 * j));
    positions.push(idxtStart);
    for (let j = 0; j < entryCount; j++) {
      const start = positions[j]!;
      const end = positions[j + 1]!;
      if (start >= record.length || start + 1 > end) continue;
      const nameEnd = start + 1 + record[start]!;
      if (nameEnd > end) throw headerError(`INDX entry ${j} name length overflows entry bounds`);
      entries.push({ name: record.subarray(start + 1, nameEnd), tagMap: decodeTagMap(record, tagx, nameEnd, end) });
    }
  }
  return { entries, ctoc };
}

export interface SkeletonEntry {
  fileNumber: number;
  fragmentCount: number;
  start: number;
  length: number;
}

export interface FragmentEntry {
  insertPosition: number;
  idText: string;
  fileNumber: number;
  sequenceNumber: number;
  start: number;
  length: number;
}

export function parseSkeletons(pdb: PdbFile, mobi: MobiHeader): SkeletonEntry[] {
  const index = mobi.skeletonIndex;
  if (index === null || index === UNSET || index === 0) throw headerError('MOBI header has no skeletonIndex; not a KF8 file?');
  return readIndx(pdb, index).entries.map((entry, i) => {
    const fragmentCount = entry.tagMap.get(1)?.[0];
    const positions = entry.tagMap.get(6);
    if (fragmentCount === undefined || positions === undefined || positions.length < 2) {
      throw headerError(`Skeleton entry ${i} is missing tag 1 or tag 6`);
    }
    return { fileNumber: i, fragmentCount, start: positions[0]!, length: positions[1]! };
  });
}

export function parseFragments(pdb: PdbFile, mobi: MobiHeader): FragmentEntry[] {
  const index = mobi.fragmentIndex;
  if (index === null || index === UNSET || index === 0) throw headerError('MOBI header has no fragmentIndex; not a KF8 file?');
  const indx = readIndx(pdb, index);
  return indx.entries.map((entry, i) => {
    const ctocOffset = entry.tagMap.get(2)?.[0];
    const fileNumber = entry.tagMap.get(3)?.[0];
    const sequenceNumber = entry.tagMap.get(4)?.[0];
    const positions = entry.tagMap.get(6);
    if (ctocOffset === undefined || fileNumber === undefined || sequenceNumber === undefined || positions === undefined || positions.length < 2) {
      throw headerError(`Fragment entry ${i} is missing required tags`);
    }
    const ctoc = indx.ctoc.get(ctocOffset);
    if (ctoc === undefined) throw headerError(`Fragment entry ${i} references CTOC offset ${ctocOffset} which is absent`);
    const name = latin1Decode(entry.name);
    // Dart `int.parse` failures are FormatExceptions, not HeaderExceptions.
    if (!/^\s*[+-]?[0-9]+\s*$/.test(name)) throw new KindleError(`Invalid fragment position "${name}"`, 'format');
    return {
      insertPosition: Number.parseInt(name.trim(), 10),
      idText: latin1Decode(ctoc),
      fileNumber,
      sequenceNumber,
      start: positions[0]!,
      length: positions[1]!,
    };
  });
}

export interface XhtmlPart {
  fileNumber: number;
  bytes: Uint8Array;
}

export function partFilename(part: XhtmlPart): string {
  return `part${String(part.fileNumber).padStart(4, '0')}.xhtml`;
}

export function splitXhtml(primaryFlow: Uint8Array, skeletons: SkeletonEntry[], fragments: FragmentEntry[]): XhtmlPart[] {
  const parts: XhtmlPart[] = [];
  let fragPtr = 0;
  for (const skeleton of skeletons) {
    const skeletonEnd = skeleton.start + skeleton.length;
    if (skeletonEnd > primaryFlow.length) throw headerError(`Skeleton ${skeleton.fileNumber} ends past primary flow`);
    let working = Array.from(primaryFlow.subarray(skeleton.start, skeletonEnd));
    let basePtr = skeletonEnd;
    for (let i = 0; i < skeleton.fragmentCount; i++) {
      if (fragPtr >= fragments.length) throw headerError(`Skeleton ${skeleton.fileNumber} expects fragment ${i} but the fragment table is exhausted`);
      const fragment = fragments[fragPtr++]!;
      if (basePtr + fragment.length > primaryFlow.length) throw headerError(`Fragment ${fragPtr} extends past primary flow`);
      const fragmentBytes = primaryFlow.subarray(basePtr, basePtr + fragment.length);
      let insertAt = fragment.insertPosition - skeleton.start;
      if (insertAt < 0 || insertAt > working.length) throw headerError(`Fragment ${fragPtr} insert position ${insertAt} out of range`);
      insertAt = adjustForPartialTag(working, insertAt);
      working = [...working.slice(0, insertAt), ...fragmentBytes, ...working.slice(insertAt)];
      basePtr += fragment.length;
    }
    parts.push({ fileNumber: skeleton.fileNumber, bytes: Uint8Array.from(working) });
  }
  return parts;
}

function adjustForPartialTag(working: number[], insertAt: number): number {
  const headLastClose = working.lastIndexOf(0x3e, insertAt - 1);
  const headLastOpen = working.lastIndexOf(0x3c, insertAt - 1);
  const tailFirstClose = working.indexOf(0x3e, insertAt);
  const tailFirstOpen = working.indexOf(0x3c, insertAt);
  const headPartial = insertAt > 0 && headLastClose >= 0 && headLastOpen >= 0 && headLastClose < headLastOpen;
  const tailPartial = tailFirstClose >= 0 && (tailFirstOpen < 0 || tailFirstClose < tailFirstOpen);
  if (!headPartial && !tailPartial) return insertAt;
  return headLastClose >= 0 && insertAt > 0 ? headLastClose + 1 : insertAt;
}

// ---------------------------------------------------------------------------
// Images

export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'bmp' | 'svg';

const imageMagic: Array<[ImageFormat, number[]]> = [
  ['jpeg', [0xff, 0xd8, 0xff]],
  ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['gif', [0x47, 0x49, 0x46, 0x38]],
  ['bmp', [0x42, 0x4d]],
];
const imageExtension: Record<ImageFormat, string> = { jpeg: 'jpg', png: 'png', gif: 'gif', bmp: 'bmp', svg: 'svg' };
export const imageMime: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

export function detectImage(bytes: Uint8Array): ImageFormat | null {
  for (const [format, magic] of imageMagic) {
    if (bytes.length >= magic.length && magic.every((value, i) => bytes[i] === value)) return format;
  }
  if (bytes.length < 4) return null;
  const scan = Math.min(bytes.length, 256);
  for (let i = 0; i + 4 <= scan; i++) {
    if (bytes[i] === 0x3c && (bytes[i + 1]! | 0x20) === 0x73 && (bytes[i + 2]! | 0x20) === 0x76 && (bytes[i + 3]! | 0x20) === 0x67) {
      return 'svg';
    }
  }
  return null;
}

export interface ExtractedImage {
  blockIndex: number;
  recordIndex: number;
  format: ImageFormat;
  data: Uint8Array;
}

export function imageName(image: ExtractedImage): string {
  return `image${String(image.blockIndex).padStart(5, '0')}.${imageExtension[image.format]}`;
}

export interface BookImages {
  all: ExtractedImage[];
  coverBlockIndex: number | null;
}

export function coverImage(images: BookImages): ExtractedImage | null {
  if (images.coverBlockIndex === null) return null;
  return images.all.find((image) => image.blockIndex === images.coverBlockIndex) ?? null;
}

export function extractImages(pdb: PdbFile, mobi: MobiHeader, header: ExthHeader | null): BookImages {
  const firstImage = mobi.firstImageIndex;
  const coverBlockIndex = header === null ? null : exth.coverOffset(header);
  if (firstImage === UNSET || firstImage === 0 || firstImage >= pdb.records.length) return { all: [], coverBlockIndex };
  const all: ExtractedImage[] = [];
  for (let i = firstImage; i < pdb.records.length; i++) {
    const data = pdb.records[i]!.data;
    const format = detectImage(data);
    if (format !== null) all.push({ blockIndex: i - firstImage, recordIndex: i, format, data });
  }
  return { all, coverBlockIndex };
}

// ---------------------------------------------------------------------------
// Fonts

export type FontFormat = 'ttf' | 'ttc' | 'otf' | 'unknown';

export function fontExtension(format: FontFormat): string {
  return format === 'otf' ? 'otf' : format === 'unknown' ? 'dat' : 'ttf';
}

export function parseFont(record: Uint8Array): { payload: Uint8Array; format: FontFormat } {
  if (record.length < 24) throw headerError(`FONT record too short: ${record.length}`);
  if (latin1Decode(record.subarray(0, 4)) !== 'FONT') throw headerError('expected "FONT" signature');
  const data = view(record);
  const flags = data.getUint32(8);
  const dataStart = data.getUint32(12);
  const xorLength = data.getUint32(16);
  const xorStart = data.getUint32(20);
  if (dataStart > record.length) throw headerError(`FONT data offset ${dataStart} is past record end`);
  if (xorLength !== 0 && xorStart + xorLength > record.length) throw headerError('FONT XOR key is past record end');
  const xorKey = xorLength === 0 ? new Uint8Array(0) : record.subarray(xorStart, xorStart + xorLength);
  let payload = record.slice(dataStart);
  if ((flags & 0x0002) !== 0) {
    if (xorKey.length === 0) throw headerError('FONT marked obfuscated but no XOR key supplied');
    const extent = Math.min(payload.length, 1040);
    for (let i = 0; i < extent; i++) payload[i] = payload[i]! ^ xorKey[i % xorKey.length]!;
  }
  // Like Dart's ZLibCodec, a damaged stream is not a HeaderException.
  if ((flags & 0x0001) !== 0) payload = unzlibSync(payload);
  return { payload, format: sniffFont(payload) };
}

function sniffFont(payload: Uint8Array): FontFormat {
  if (payload.length < 4) return 'unknown';
  if (payload[0] === 0 && payload[1] === 1 && payload[2] === 0 && payload[3] === 0) return 'ttf';
  const head = latin1Decode(payload.subarray(0, 4));
  if (head === 'true') return 'ttf';
  if (head === 'ttcf') return 'ttc';
  if (head === 'OTTO') return 'otf';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// KindleBook

export interface KindleBook {
  pdb: PdbFile;
  format: KindleFormat;
  section: KindleSection;
  parts: XhtmlPart[];
  images: BookImages;
  flows: FlowSection[] | null;
  mobi: MobiHeader;
  exth: ExthHeader | null;
  title: string;
}

export function readKindleBook(bytes: Uint8Array): KindleBook {
  const pdb = parsePdb(bytes);
  const kindle = inspectKindle(pdb);
  const section = kindle.kf8 ?? kindle.mobi7!;
  const rawML = decompressBookText(pdb, section.palmDoc, section.mobi);
  let flows: FlowSection[] | null = null;
  let parts: XhtmlPart[];
  if (kindle.kf8 !== null) {
    if (section.mobi.fdstRecord === null) throw new TypeError('KF8 header has no FDST record');
    const fdstIndex = section.mobi.fdstRecord + section.recordOffset;
    const fdstRecord = pdb.records[fdstIndex];
    if (fdstRecord === undefined) throw new RangeError(`FDST record ${fdstIndex} out of range`);
    flows = splitFlows(rawML, parseFdst(fdstRecord.data));
    const primary = flows.find((flow) => flow.kind === 'html');
    if (primary === undefined) throw new TypeError('KF8 book has no HTML flow');
    try {
      parts = splitXhtml(primary.bytes, parseSkeletons(pdb, section.mobi), parseFragments(pdb, section.mobi));
    } catch (error) {
      // Some KF8 files lack full skeleton/fragment INDX: fall back to one part.
      if (!(error instanceof KindleError) || error.kind !== 'header') throw error;
      parts = [{ fileNumber: 0, bytes: primary.bytes }];
    }
  } else {
    parts = [{ fileNumber: 0, bytes: rawML }];
  }
  const images = extractImages(pdb, section.mobi, section.exth);
  const title = (section.exth === null ? null : exth.title(section.exth)) ?? mobiFullName(section.mobi, pdb.records[section.recordOffset]!.data);
  return { pdb, format: kindle.format, section, parts, images, flows, mobi: section.mobi, exth: section.exth, title };
}

// ---------------------------------------------------------------------------
// EPUB builder inputs (`epub.dart`); the converter's own builder writes the package.

export interface EpubAsset {
  name: string;
  bytes: Uint8Array;
  mediaType?: string | null;
}

export interface EpubMetadata {
  identifier: string;
  title: string;
  language: string;
  creators: string[];
  publisher: string | null;
  description: string | null;
  coverImageId: string | null;
}
