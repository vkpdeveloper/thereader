import { createExtractorFromData, UnrarError } from 'node-unrar-js/esm';
import { normalizeEntryName, pickComicInfo } from '../comic/pages';
import { crc32 } from './bytes';
import { repackOrder, type RepackEntry } from './cbzWriter';
import { ImportError } from './contract';

/**
 * CBR extraction with the official unrar library compiled to WebAssembly
 * (`node-unrar-js`, RAR4 and RAR5). Loaded only when a CBR is imported.
 * Pages leave the JS heap as Blobs as soon as they are extracted.
 */

export interface ExtractedRar {
  /** Pages, then `ComicInfo.xml` if any: the repack's order. */
  entries: RepackEntry[];
  comicInfo: Uint8Array | null;
}

const ENCRYPTED = 'Password-protected comics are not supported.';

/** Normalized names the repack may store (the API refuses the rest). */
function usable(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.includes('\0') && !path.split('/').includes('..');
}

function failure(error: unknown): ImportError {
  if (error instanceof ImportError) return error;
  if (error instanceof UnrarError) {
    switch (error.reason) {
      case 'ERAR_MISSING_PASSWORD':
      case 'ERAR_BAD_PASSWORD':
        return new ImportError(ENCRYPTED, 'ENCRYPTED');
      case 'ERAR_NO_MEMORY':
        return new ImportError('This comic is too large to convert in the browser.', 'TOO_LARGE');
      case 'ERAR_UNKNOWN_FORMAT':
        return new ImportError('This CBR uses a RAR format that is not supported.', 'INVALID_COMIC');
    }
  }
  return new ImportError('The CBR archive is damaged.', 'INVALID_COMIC');
}

/**
 * Extracts the pages and `ComicInfo.xml` of a RAR archive. `maxBytes` bounds
 * the pages' total size before anything is decompressed.
 */
export async function extractRar(data: ArrayBuffer, wasmBinary: ArrayBuffer, maxBytes: number): Promise<ExtractedRar> {
  try {
    const extractor = await createExtractorFromData({ data, wasmBinary });
    const list = extractor.getFileList();
    if (list.arcHeader.flags.volume) throw new ImportError('Split (multi-volume) CBR archives are not supported.', 'INVALID_COMIC');
    // Iterate every header: an unfinished iterator leaks the native archive.
    const sizes = new Map<string, number>();
    const rawNames = new Map<string, string>();
    let encrypted = false;
    for (const header of list.fileHeaders) {
      if (header.flags.encrypted) encrypted = true;
      if (header.flags.directory) continue;
      const path = normalizeEntryName(header.name);
      // A repeated name keeps its first copy, as readers address pages by name.
      if (!usable(path) || rawNames.has(path)) continue;
      rawNames.set(path, header.name);
      sizes.set(path, header.unpSize);
    }
    if (encrypted) throw new ImportError(ENCRYPTED, 'ENCRYPTED');
    const order = repackOrder(rawNames.keys());
    const comicInfoPath = pickComicInfo(rawNames.keys());
    if (order.length - (comicInfoPath === null ? 0 : 1) === 0) {
      throw new ImportError('This archive has no comic pages.', 'NO_PAGES');
    }
    // Each entry adds a local header and a central record (76 bytes) and its name twice.
    let total = 22;
    for (const path of order) total += (sizes.get(path) ?? 0) + 76 + 2 * path.length;
    if (total > maxBytes) throw new ImportError('Comic imports are limited to 1 GiB.', 'TOO_LARGE');

    const wanted = new Map(order.map((path) => [rawNames.get(path)!, path]));
    const extracted = new Map<string, RepackEntry>();
    let comicInfo: Uint8Array | null = null;
    const store = (extractor as unknown as { dataFiles?: Record<string, unknown> }).dataFiles;
    const files = extractor.extract({ files: (header) => wanted.has(header.name) && !extracted.has(wanted.get(header.name)!) }).files;
    for (const file of files) {
      const path = wanted.get(file.fileHeader.name)!;
      const bytes = file.extraction ?? new Uint8Array(0);
      extracted.set(path, { path, data: new Blob([bytes as BlobPart]), crc32: crc32(bytes) });
      if (path === comicInfoPath) comicInfo = bytes;
      // The extractor keeps every output in memory until it is collected; let this one go now.
      if (store) delete store[`*Extracted*/${file.fileHeader.name}`];
      // Hand the main thread back between pages so the interface keeps painting.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const entries = order.map((path) => {
      const entry = extracted.get(path);
      if (!entry) throw new ImportError('The CBR archive is damaged.', 'INVALID_COMIC');
      return entry;
    });
    return { entries, comicInfo };
  } catch (error) {
    throw failure(error);
  }
}
