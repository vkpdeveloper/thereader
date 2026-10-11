export const VERSION = "0.3.0";
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  link?: string;
  script?: string;
  asset?: string;
  heightEm?: number;
  depthEm?: number;
  monochrome?: boolean;
}
export interface TableCell {
  row: number;
  column: number;
  rowSpan: number;
  colSpan: number;
  text: string;
  runs?: Run[];
  header?: boolean;
  scope?: string;
  box: Rect;
}
export interface Table {
  rows: number;
  columns: number;
  headerRows?: number;
  cells: TableCell[];
}
export interface Block {
  kind: string;
  text?: string;
  runs?: Run[];
  level?: number;
  rows?: string[][];
  table?: Table;
  asset?: string;
  alt?: string;
  role?: string;
  language?: string;
  representation?: string;
  widthEm?: number;
  monochrome?: boolean;
  box: Rect;
}
export interface Page {
  number: number;
  width: number;
  height: number;
  blocks: Block[];
  needsOCR?: boolean;
}
export interface Asset {
  name: string;
  mediaType: string;
  width: number;
  height: number;
  data: Uint8Array;
}
export interface Outline {
  title: string;
  page: number;
  level: number;
}
export interface Warning {
  code: string;
  page?: number;
  message: string;
}
export interface Stats {
  pages: number;
  characters: number;
  images: number;
  tables: number;
  math: number;
  headings: number;
  durationMs: number;
}
export interface Document {
  engine: string;
  version: string;
  title: string;
  author?: string;
  language?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  created?: string;
  sha256: string;
  pages: Page[];
  assets: Asset[];
  outline: Outline[];
  warnings: Warning[];
  complete: boolean;
  markdown: string;
  stats: Stats;
}
export interface Limits {
  inputBytes: number;
  decodedBytes: number;
  objects: number;
  pages: number;
  operations: number;
  spans: number;
  imagePixels: number;
  assetBytes: number;
}
export interface Options {
  limits?: Partial<Limits>;
  keepArtifacts?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  inputBytes: 64 << 20,
  decodedBytes: 256 << 20,
  objects: 200000,
  pages: 10000,
  operations: 5000000,
  spans: 2000000,
  imagePixels: 20000000,
  assetBytes: 128 << 20,
});
export class PdfError extends Error {
  constructor(
    readonly code:
      | "INVALID_PDF"
      | "ENCRYPTED_PDF"
      | "RESOURCE_LIMIT"
      | "ABORTED"
      | "UNSUPPORTED"
      | "INVALID_REQUEST"
      | "TIMEOUT"
      | "WORKER_FAILED"
      | "EXTRACTION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "PdfError";
  }
}
export function invalid(message = "Invalid PDF"): never {
  throw new PdfError("INVALID_PDF", message);
}
export function limit(): never {
  throw new PdfError("RESOURCE_LIMIT", "PDF resource limit exceeded");
}
export function unsupported(message: string): never {
  throw new PdfError("UNSUPPORTED", message);
}
export function emptyDocument(): Document {
  return {
    engine: "PDF Extractor",
    version: VERSION,
    title: "",
    sha256: "",
    pages: [],
    assets: [],
    outline: [],
    warnings: [],
    complete: true,
    markdown: "",
    stats: {
      pages: 0,
      characters: 0,
      images: 0,
      tables: 0,
      math: 0,
      headings: 0,
      durationMs: 0,
    },
  };
}
