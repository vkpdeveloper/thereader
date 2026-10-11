import type { Book } from '../types';
import { ImportError, type InspectFile, type InspectedBook } from './contract';
import { ascii, ownBuffer, startsWith } from './bytes';
import { inspectCbr, inspectCbz, maxComicBytes, zipIsEpub } from './comic';
import { coverMediaType, inspectEpub, maxImportBytes } from './epub';
import { convertMobiFile, maxMobiBytes } from './mobi';
import { uploadBook } from './upload';
import { convertPdf } from './pdf';

export * from './contract';
export { uploadBook, maxImportBytes, maxMobiBytes, maxComicBytes };

export type SourceKind = 'zip' | 'rar' | 'mobi' | 'pdf' | null;

/** Bytes needed by `sourceKind` (a TAR header's magic sits at 257). */
export const SNIFF_BYTES = 263;

/**
 * Content sniffing, not extensions: a ZIP (EPUB or CBZ), a RAR4/RAR5 archive
 * (CBR) or a Kindle PalmDB. Comic containers we cannot read are refused with
 * a message naming them.
 */
export function sourceKind(head: Uint8Array): SourceKind {
  if (startsWith(head, [0x50, 0x4b])) return 'zip';
  if (startsWith(head, [...ascii('Rar!'), 0x1a, 0x07, 0x00]) || startsWith(head, [...ascii('Rar!'), 0x1a, 0x07, 0x01, 0x00])) return 'rar';
  if (head.length >= 68 && (startsWith(head, ascii('BOOKMOBI'), 60) || startsWith(head, ascii('TEXtREAd'), 60))) return 'mobi';
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
    throw new ImportError('CB7 (7-Zip) comics are not supported. Convert it to CBZ first.', 'UNSUPPORTED_FILE');
  }
  if (startsWith(head, ascii('ustar'), 257)) {
    throw new ImportError('CBT (TAR) comics are not supported. Convert it to CBZ first.', 'UNSUPPORTED_FILE');
  }
  if (startsWith(head, ascii('%PDF-'))) return 'pdf';
  return null;
}

export const inspectFile: InspectFile = async (file, options) => {
  const kind = sourceKind(new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer()));
  if (kind === null) throw new ImportError('Choose a PDF, EPUB, MOBI, CBZ or CBR file.', 'UNSUPPORTED_FILE');
  if (kind === 'rar') return inspectCbr(file);
  if (kind === 'zip' && !(await zipIsEpub(file))) return inspectCbz(file);
  if (file.size > maxImportBytes) throw new ImportError('Book imports are limited to 512 MiB.', 'TOO_LARGE');
  let epub: Blob;
  let bytes: Uint8Array;
  if (kind === 'pdf') {
    const origin = options?.origin ?? (typeof location === 'undefined' ? undefined : location.origin);
    if (!origin) throw new ImportError('Choose a reading server before importing a PDF.', 'PDF_UNAVAILABLE');
    epub = await convertPdf(file, origin);
    bytes = new Uint8Array(await epub.arrayBuffer());
  } else if (kind === 'mobi') {
    // Conversion materializes input and output. Keep it bounded; EPUBs use the 512 MiB path.
    if (file.size === 0 || file.size > maxMobiBytes) throw new ImportError('MOBI imports are limited to 64 MiB.', 'TOO_LARGE');
    bytes = convertMobiFile(new Uint8Array(await file.arrayBuffer()));
    if (bytes.length > maxImportBytes) throw new ImportError('The converted EPUB exceeds 512 MiB.', 'TOO_LARGE');
    epub = new Blob([ownBuffer(bytes)], { type: 'application/epub+zip' });
  } else {
    bytes = new Uint8Array(await file.arrayBuffer());
    epub = file.slice(0, file.size, 'application/epub+zip');
  }
  const metadata = await inspectEpub(bytes);
  return {
    epub,
    sha256: metadata.sha256,
    fileSize: metadata.fileSize,
    title: metadata.title,
    author: metadata.author,
    description: metadata.description,
    language: metadata.language,
    subjects: metadata.subjects,
    cover: metadata.cover === null ? null : new Blob([ownBuffer(metadata.cover)], { type: coverMediaType(metadata.cover) }),
    converted: kind === 'mobi' || kind === 'pdf',
  };
};

/** The provisional local `Book` mobile `_importPrepared` builds before the server canonicalizes it. */
export function bookFromInspected(inspected: InspectedBook): Book {
  const sha = inspected.sha256;
  const format = inspected.format ?? 'epub';
  return {
    id: `${format}-${sha}`,
    version: sha.substring(0, 12),
    title: inspected.title,
    author: inspected.author,
    description: inspected.description,
    language: inspected.language,
    subjects: [...inspected.subjects],
    coverUrl: null,
    downloadUrl: `/v1/books/${format}-${sha}/download`,
    fileSize: inspected.fileSize,
    sha256: sha,
    updatedAt: new Date().toISOString(),
    format,
  };
}
