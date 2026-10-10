import { normalizeEntryName } from './pages';

/**
 * The ZIP central directory of a CBZ, read through byte ranges so a large
 * comic never has to be in memory at once. Bounds match the API's comic
 * validation (`apps/api/src/upload.ts` `centralDirectory`).
 */

/** MIME type of a stored comic (docs/comics.md). */
export const COMIC_TYPE = 'application/vnd.comicbook+zip';

/** Largest end-of-central-directory search window (22 + 65535 bytes). */
export const EOCD_WINDOW = 65_557;
export const MAX_COMIC_ENTRIES = 10_000;
export const MAX_DIRECTORY_BYTES = 4 * 1024 * 1024;

export interface ZipDirectoryEnd {
  entryCount: number;
  directoryOffset: number;
  directorySize: number;
}

export interface ZipEntry {
  /** As stored. */
  name: string;
  /** `\` → `/` and no leading slash: the name readers address pages by. */
  path: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

export class ZipFormatError extends Error {
  constructor(message = 'The comic archive is damaged.') {
    super(message);
    this.name = 'ZipFormatError';
  }
}

const u16 = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8);
const u32 = (bytes: Uint8Array, at: number): number =>
  (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;

/**
 * Locates the directory from the last bytes of a ZIP of `size` bytes
 * (`tail` ends at `size`). Null when the tail has no usable EOCD record.
 */
export function findDirectoryEnd(tail: Uint8Array, size: number): ZipDirectoryEnd | null {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) !== 0x06054b50 || i + 22 + u16(tail, i + 20) !== tail.length) continue;
    const entryCount = u16(tail, i + 10);
    const directorySize = u32(tail, i + 12);
    const directoryOffset = u32(tail, i + 16);
    if (
      u16(tail, i + 4) !== 0 ||
      u16(tail, i + 6) !== 0 ||
      u16(tail, i + 8) !== entryCount ||
      entryCount === 0 ||
      entryCount === 0xffff ||
      directoryOffset === 0xffffffff ||
      directoryOffset + directorySize > size - (tail.length - i)
    ) {
      return null;
    }
    return { entryCount, directoryOffset, directorySize };
  }
  return null;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Parses `count` central directory records. Throws `ZipFormatError` on damage. */
export function parseDirectory(directory: Uint8Array, count: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > directory.length || u32(directory, offset) !== 0x02014b50) throw new ZipFormatError();
    const nameLength = u16(directory, offset + 28);
    const end = offset + 46 + nameLength + u16(directory, offset + 30) + u16(directory, offset + 32);
    if (end > directory.length) throw new ZipFormatError();
    let name: string;
    try {
      name = utf8.decode(directory.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      throw new ZipFormatError('The comic has file names that are not UTF-8.');
    }
    entries.push({
      name,
      path: normalizeEntryName(name),
      flags: u16(directory, offset + 8),
      method: u16(directory, offset + 10),
      crc32: u32(directory, offset + 16),
      compressedSize: u32(directory, offset + 20),
      uncompressedSize: u32(directory, offset + 24),
      localOffset: u32(directory, offset + 42),
    });
    offset = end;
  }
  if (offset !== directory.length) throw new ZipFormatError();
  return entries;
}

/** Reads and parses the directory of a ZIP of `size` bytes through `read(start, end)`. */
export async function readDirectory(
  size: number,
  read: (start: number, end: number) => Promise<Uint8Array>,
): Promise<{ end: ZipDirectoryEnd; entries: ZipEntry[] }> {
  if (size < 22) throw new ZipFormatError();
  const tailStart = Math.max(0, size - EOCD_WINDOW);
  const end = findDirectoryEnd(await read(tailStart, size), size);
  if (end === null) throw new ZipFormatError();
  if (end.entryCount > MAX_COMIC_ENTRIES || end.directorySize > MAX_DIRECTORY_BYTES) {
    throw new ZipFormatError('The comic has too many files.');
  }
  const directory = await read(end.directoryOffset, end.directoryOffset + end.directorySize);
  return { end, entries: parseDirectory(directory, end.entryCount) };
}

/**
 * Offset of an entry's data, from its local header (30 bytes plus the
 * local name and extra field, which may differ from the central ones).
 */
export function localDataOffset(entry: ZipEntry, localHeader: Uint8Array): number {
  if (localHeader.length < 30 || u32(localHeader, 0) !== 0x04034b50) throw new ZipFormatError();
  return entry.localOffset + 30 + u16(localHeader, 26) + u16(localHeader, 28);
}
