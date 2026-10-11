import type { Book, BookFormat } from '../types';

/**
 * Contract for the import pipeline (implemented in this folder). The import
 * queue and library wiring live in `../services/imports.ts` and only use these.
 */

export interface InspectedBook {
  /**
   * Valid EPUB bytes (MOBI input is converted first), or for a comic the CBZ
   * to store (CBR input is repacked first).
   */
  epub: Blob;
  sha256: string;
  fileSize: number;
  title: string;
  author: string;
  description: string;
  language: string;
  subjects: string[];
  /** Embedded cover image, if the package names one. */
  cover: Blob | null;
  /** True when the source file was MOBI/AZW/PRC or CBR and was converted. */
  converted: boolean;
  /** Absent means `epub`. */
  format?: BookFormat;
}

/** File extensions the picker accepts. */
export const importAccept =
  '.pdf,.epub,.mobi,.azw,.azw3,.prc,.cbz,.cbr,application/pdf,application/epub+zip,application/x-mobipocket-ebook,application/vnd.comicbook+zip,application/vnd.comicbook-rar';

/** File names the library accepts when dropped (the content still decides the format). */
export const importExtensions = /\.(pdf|epub|mobi|azw3?|prc|cbz|cbr)$/i;

export type InspectFile = (file: File, options?: { origin?: string }) => Promise<InspectedBook>;

export interface UploadProgress {
  sent: number;
  total: number;
}

/**
 * Prepares, uploads (single PUT or resumable 8 MiB multipart) and completes
 * one EPUB or CBZ (by `book.format`) against `origin`, returning the canonical server `Book`. Throws
 * `ImportError` with a user-facing message. Honours `signal` for cancel.
 */
export type UploadBook = (options: {
  origin: string;
  book: Book;
  epub: Blob;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}) => Promise<Book>;

export class ImportError extends Error {
  constructor(message: string, readonly code = 'IMPORT_FAILED', readonly isNetwork = false) {
    super(message);
    this.name = 'ImportError';
  }
}
