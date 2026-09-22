export interface Book {
  id: string;
  version: string;
  title: string;
  author: string;
  description: string;
  language: string;
  subjects: string[];
  coverUrl: string | null;
  downloadUrl: string;
  fileSize: number;
  sha256: string;
  updatedAt: string;
}

export interface CatalogBook extends Book {
  objectKey: string;
  cover: {
    objectKey: string;
    contentType: string;
    fileSize: number;
  } | null;
}

export interface CatalogManifest {
  schemaVersion: 1;
  generatedAt: string;
  books: CatalogBook[];
}

export interface Env {
  BOOKS: R2Bucket;
  DB: D1Database;
}
