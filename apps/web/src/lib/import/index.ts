import type { Book } from '../types';
import { ImportError, type InspectFile, type InspectedBook } from './contract';
import { ascii, ownBuffer, startsWith } from './bytes';
import { coverMediaType, inspectEpub, maxImportBytes } from './epub';
import { convertMobiFile, maxMobiBytes } from './mobi';
import { uploadBook } from './upload';

export * from './contract';
export { uploadBook, maxImportBytes, maxMobiBytes };

type SourceKind = 'epub' | 'mobi' | null;

/** Content sniffing, not extensions: ZIP container or a Kindle PalmDB. */
function sourceKind(head: Uint8Array): SourceKind {
  if (startsWith(head, [0x50, 0x4b])) return 'epub';
  if (head.length >= 68 && (startsWith(head, ascii('BOOKMOBI'), 60) || startsWith(head, ascii('TEXtREAd'), 60))) return 'mobi';
  return null;
}

export const inspectFile: InspectFile = async (file) => {
  const kind = sourceKind(new Uint8Array(await file.slice(0, 78).arrayBuffer()));
  if (kind === null) throw new ImportError('Choose an EPUB or MOBI file.', 'UNSUPPORTED_FILE');
  if (file.size > maxImportBytes) throw new ImportError('Book imports are limited to 512 MiB.', 'TOO_LARGE');
  let epub: Blob;
  let bytes: Uint8Array;
  if (kind === 'mobi') {
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
    converted: kind === 'mobi',
  };
};

/** The provisional local `Book` mobile `_importPrepared` builds before the server canonicalizes it. */
export function bookFromInspected(inspected: InspectedBook): Book {
  const sha = inspected.sha256;
  return {
    id: `epub-${sha}`,
    version: sha.substring(0, 12),
    title: inspected.title,
    author: inspected.author,
    description: inspected.description,
    language: inspected.language,
    subjects: [...inspected.subjects],
    coverUrl: null,
    downloadUrl: `/v1/books/epub-${sha}/download`,
    fileSize: inspected.fileSize,
    sha256: sha,
    updatedAt: new Date().toISOString(),
  };
}
