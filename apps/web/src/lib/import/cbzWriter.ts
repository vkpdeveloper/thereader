import { COMIC_TYPE } from '../comic/zip';
import { orderPages, pickComicInfo } from '../comic/pages';
import { Sha256 } from '../services/hash';
import { utf8Encode } from './bytes';
import { ImportError } from './contract';

/**
 * The deterministic CBR → CBZ repack of docs/comics.md: stored entries, fixed
 * header fields, no extras, comments, data descriptors or ZIP64. The mobile
 * app writes the same bytes, so one comic imported on both deduplicates.
 */

export interface RepackEntry {
  /** Normalized entry name (`/` separators, no leading slash). */
  path: string;
  data: Blob;
  crc32: number;
}

export interface WrittenCbz {
  blob: Blob;
  sha256: string;
  size: number;
}

/** Entry names the repack keeps, in their order: the pages, then one `ComicInfo.xml`. */
export function repackOrder(paths: Iterable<string>): string[] {
  const all = [...paths];
  const info = pickComicInfo(all);
  const pages = orderPages(all);
  return info === null ? pages : [...pages, info];
}

const MAX_ZIP32 = 0xffffffff;
/** The bytes are hashed in slices this size, one page (or part of one) in memory at a time. */
const HASH_SLICE = 8 * 1024 * 1024;

/**
 * Writes `entries` in the given order. The archive is assembled as a Blob of
 * parts, so page bytes stay in blob storage; each is read back once to hash.
 */
export async function writeCbz(entries: RepackEntry[]): Promise<WrittenCbz> {
  if (entries.length > 0xffff) throw new ImportError('The comic has too many pages.', 'TOO_LARGE');
  const hasher = new Sha256();
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = utf8Encode(entry.path);
    const size = entry.data.size;
    if (name.length > 0xffff) throw new ImportError('The comic has a file name that is too long.');
    if (offset + 30 + name.length + size > MAX_ZIP32) throw new ImportError('The comic is too large.', 'TOO_LARGE');
    const local = header(30, name);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 10, true);
    fields(view, 6, entry.crc32, size, name.length);
    hasher.update(local);
    parts.push(local as BlobPart, entry.data);
    for (let at = 0; at < size; at += HASH_SLICE) {
      hasher.update(new Uint8Array(await entry.data.slice(at, Math.min(size, at + HASH_SLICE)).arrayBuffer()));
    }

    const record = header(46, name);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x02014b50, true);
    recordView.setUint16(4, 10, true); // version made by
    recordView.setUint16(6, 10, true); // version needed
    fields(recordView, 8, entry.crc32, size, name.length);
    // Comment length, disk, internal and external attributes stay 0.
    recordView.setUint32(42, offset, true);
    central.push(record);
    offset += local.length + size;
  }
  let directorySize = 0;
  for (const record of central) directorySize += record.length;
  if (offset + directorySize + 22 > MAX_ZIP32) throw new ImportError('The comic is too large.', 'TOO_LARGE');
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);
  for (const record of central) {
    hasher.update(record);
    parts.push(record as BlobPart);
  }
  hasher.update(end);
  parts.push(end as BlobPart);
  const blob = new Blob(parts, { type: COMIC_TYPE });
  return { blob, sha256: hasher.hex(), size: blob.size };
}

/** A header of `fixed` bytes followed by `name`. */
function header(fixed: number, name: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(fixed + name.length);
  bytes.set(name, fixed);
  return bytes;
}

/** Flags through extra length, shared by local and central headers from `at`. */
function fields(view: DataView, at: number, crc: number, size: number, nameLength: number): void {
  view.setUint16(at, 0x0800, true); // UTF-8 names
  view.setUint16(at + 2, 0, true); // stored
  view.setUint16(at + 4, 0, true); // DOS time
  view.setUint16(at + 6, 0x0021, true); // DOS date 1980-01-01
  view.setUint32(at + 8, crc >>> 0, true);
  view.setUint32(at + 12, size, true);
  view.setUint32(at + 16, size, true);
  view.setUint16(at + 20, nameLength, true);
  view.setUint16(at + 22, 0, true); // extra length
}
