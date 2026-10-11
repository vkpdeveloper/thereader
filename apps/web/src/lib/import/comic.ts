import { inflateSync } from 'fflate';
import { orderPages, pickComicInfo } from '../comic/pages';
import { COMIC_TYPE, localDataOffset, readDirectory, ZipFormatError, type ZipEntry } from '../comic/zip';
import { coverType, MAX_COVER_BYTES } from '../services/coverValidation';
import { sha256OfBlob } from '../services/hash';
import { crc32 } from './bytes';
import { writeCbz } from './cbzWriter';
import { comicMetadata, MAX_COMIC_INFO_BYTES } from './comicInfo';
import { ImportError, type InspectedBook } from './contract';

/**
 * Comic imports (docs/comics.md). A CBZ is kept byte for byte; a CBR is
 * extracted in the browser and repacked into the deterministic CBZ layout.
 * Either way the library stores a CBZ.
 */

/** Comics may be twice the size of an EPUB import (the API's limit). */
export const maxComicBytes = 1024 * 1024 * 1024;

/** A compressed first page larger than this does not become the cover. */
const MAX_INFLATED_PAGE = 64 * 1024 * 1024;
/** Covers are drawn at this height when the browser can decode the page. */
const COVER_HEIGHT = 960;

const invalid = (message = 'This file is not a valid comic archive.') => new ImportError(message, 'INVALID_COMIC');
const tooLarge = () => new ImportError('Comic imports are limited to 1 GiB.', 'TOO_LARGE');

const read = (file: Blob) => async (start: number, end: number) => new Uint8Array(await file.slice(start, end).arrayBuffer());

/** The archive's entries, checked the way the API checks them on completion. */
async function comicEntries(file: Blob): Promise<ZipEntry[]> {
  let entries: ZipEntry[];
  let directoryOffset: number;
  try {
    const directory = await readDirectory(file.size, read(file));
    entries = directory.entries;
    directoryOffset = directory.end.directoryOffset;
  } catch (error) {
    throw error instanceof ZipFormatError ? invalid(error.message) : error;
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if ((entry.flags & 1) !== 0) throw new ImportError('Password-protected comics are not supported.', 'ENCRYPTED');
    if (entry.method !== 0 && entry.method !== 8) throw invalid('The comic uses an unsupported ZIP compression method.');
    if (
      entry.name.length > 1024 ||
      entry.path.length === 0 ||
      entry.name.includes('\0') ||
      entry.path.split('/').includes('..') ||
      seen.has(entry.path) ||
      entry.localOffset >= directoryOffset
    ) {
      throw invalid('The comic archive has unsafe or duplicate file names.');
    }
    seen.add(entry.path);
  }
  return entries;
}

/**
 * True when a ZIP should go to the EPUB inspector: its directory names an
 * EPUB package, or it has no pages and is not named as a comic, so the EPUB
 * inspector explains what is missing. The same holds for unreadable directories.
 */
export async function zipIsEpub(file: Blob): Promise<boolean> {
  const namedComic = /\.cb[zr]$/i.test((file as Partial<File>).name ?? '');
  try {
    const { entries } = await readDirectory(file.size, read(file));
    if (entries.some((entry) => entry.path === 'mimetype' || entry.path === 'META-INF/container.xml')) return true;
    return !namedComic && orderPages(entries.map((entry) => entry.path)).length === 0;
  } catch {
    return !namedComic;
  }
}

/** One entry's bytes, or null when it is larger than `limit` or damaged. */
async function entryBytes(file: Blob, entry: ZipEntry, limit: number): Promise<Uint8Array | null> {
  if (entry.uncompressedSize > limit || entry.compressedSize > Math.max(limit, entry.uncompressedSize)) return null;
  try {
    const start = localDataOffset(entry, await read(file)(entry.localOffset, entry.localOffset + 30));
    if (start + entry.compressedSize > file.size) return null;
    const raw = await read(file)(start, start + entry.compressedSize);
    const bytes = entry.method === 0 ? raw : inflateSync(raw, { out: new Uint8Array(entry.uncompressedSize) });
    return bytes.length === entry.uncompressedSize && crc32(bytes) === entry.crc32 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * A cover from the first page: downscaled to a JPEG where the browser can
 * decode it (pages are often several MiB), else the page itself when it is a
 * safe raster image within the cover limit.
 */
async function coverFrom(page: Blob): Promise<Blob | null> {
  const scaled = await downscale(page).catch(() => null);
  if (scaled) return scaled;
  if (page.size === 0 || page.size > MAX_COVER_BYTES) return null;
  const bytes = new Uint8Array(await page.arrayBuffer());
  const type = coverType(bytes);
  return type === null || type === 'image/svg+xml' ? null : new Blob([bytes as BlobPart], { type });
}

async function downscale(page: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  const bitmap = await createImageBitmap(page);
  try {
    const scale = Math.min(1, COVER_HEIGHT / bitmap.height);
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    return blob.size > 0 && blob.size <= MAX_COVER_BYTES ? blob : null;
  } finally {
    bitmap.close();
  }
}

function inspected(options: {
  cbz: Blob;
  sha256: string;
  fileName: string;
  comicInfo: Uint8Array | null;
  cover: Blob | null;
  converted: boolean;
}): InspectedBook {
  const metadata = comicMetadata(options.comicInfo, options.fileName);
  return {
    epub: options.cbz,
    sha256: options.sha256,
    fileSize: options.cbz.size,
    ...metadata,
    cover: options.cover,
    converted: options.converted,
    format: 'comic',
  };
}

/** A CBZ: validated through its directory and imported as the picked bytes. */
export async function inspectCbz(file: File): Promise<InspectedBook> {
  if (file.size > maxComicBytes) throw tooLarge();
  const entries = await comicEntries(file);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const pages = orderPages(byPath.keys());
  if (pages.length === 0) throw new ImportError('This archive has no comic pages.', 'NO_PAGES');
  const infoPath = pickComicInfo(byPath.keys());
  const comicInfo = infoPath === null ? null : await entryBytes(file, byPath.get(infoPath)!, MAX_COMIC_INFO_BYTES);
  const first = byPath.get(pages[0]!)!;
  let page: Blob | null = null;
  if (first.method === 0) {
    const start = localDataOffset(first, await read(file)(first.localOffset, first.localOffset + 30));
    page = file.slice(start, start + first.compressedSize);
  } else {
    const bytes = await entryBytes(file, first, MAX_INFLATED_PAGE);
    page = bytes === null ? null : new Blob([bytes as BlobPart]);
  }
  const cover = page === null ? null : await coverFrom(page).catch(() => null);
  return inspected({
    cbz: file.slice(0, file.size, COMIC_TYPE),
    sha256: await sha256OfBlob(file),
    fileName: file.name,
    comicInfo,
    cover,
    converted: false,
  });
}

/** A CBR: extracted with the lazily loaded unrar WebAssembly, then repacked. */
export async function inspectCbr(file: File): Promise<InspectedBook> {
  if (file.size > maxComicBytes) throw tooLarge();
  const [{ extractRar }, { loadUnrarWasm }] = await Promise.all([import('./rar'), import('./rarWasm')]);
  let wasm: ArrayBuffer;
  try {
    wasm = await loadUnrarWasm();
  } catch {
    throw new ImportError('Could not load the CBR converter. Check your connection and try again.', 'NETWORK', true);
  }
  const { entries, comicInfo } = await extractRar(await file.arrayBuffer(), wasm, maxComicBytes);
  const cbz = await writeCbz(entries);
  if (cbz.size > maxComicBytes) throw tooLarge();
  const cover = await coverFrom(entries[0]!.data).catch(() => null);
  return inspected({ cbz: cbz.blob, sha256: cbz.sha256, fileName: file.name, comicInfo, cover, converted: true });
}
