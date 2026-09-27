import type { Book } from '../types';

/**
 * Contract for the import pipeline (implemented in this folder). The import
 * queue and library wiring live in `../services/imports.ts` and only use these.
 */

export interface InspectedBook {
  /** Valid EPUB bytes. MOBI input is converted first. */
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
  /** True when the source file was MOBI/AZW/PRC and was converted. */
  converted: boolean;
}

/** File extensions the picker accepts. */
export const importAccept = '.epub,.mobi,.azw,.azw3,.prc,application/epub+zip,application/x-mobipocket-ebook';

export type InspectFile = (file: File) => Promise<InspectedBook>;

export interface UploadProgress {
  sent: number;
  total: number;
}

/**
 * Prepares, uploads (single PUT or resumable 8 MiB multipart) and completes
 * one EPUB against `origin`, returning the canonical server `Book`. Throws
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
