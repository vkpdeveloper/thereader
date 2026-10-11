import { orderPages } from '../../lib/comic/pages';
import { ZipArchive, type ByteSource } from '../epub/zip';
import type { PageSize } from './layout';
import { pageMimeType, sniffImageSize } from './imageSize';

/**
 * A CBZ opened for reading. Only the ZIP directory is read up front; pages
 * are read (by range, so a comic that is still downloading asks for exactly
 * the pages on screen first), decoded off the critical path and kept as
 * object URLs only while they are near the reading position.
 */

export interface PageImage {
  url: string;
  width: number;
  height: number;
}

export type PageState = { status: 'loading' } | { status: 'ready'; image: PageImage } | { status: 'error' };

interface Slot {
  state: PageState;
  /** Kept alive so the browser keeps the decoded bitmap for its URL. */
  img: HTMLImageElement | null;
  done: Promise<void>;
  /** Holds one of the CONCURRENCY places until it finishes or is abandoned. */
  counted: boolean;
}

/** Bytes read from a page's start to find its size in the header. */
const HEAD_BYTES = 64 * 1024;
/** Pages read and decoded at once; the rest wait their turn in priority order. */
const CONCURRENCY = 2;

export class ComicBook {
  private readonly slots = new Map<number, Slot>();
  private readonly sizes: (PageSize | null)[];
  private readonly listeners = new Set<() => void>();
  private wanted: number[] = [];
  private keep = new Set<number>();
  private running = 0;
  private destroyed = false;
  private version = 0;

  private constructor(
    private readonly zip: ZipArchive,
    private readonly source: ByteSource,
    readonly pages: string[],
  ) {
    this.sizes = pages.map(() => null);
  }

  static async open(source: ByteSource): Promise<ComicBook> {
    const zip = await ZipArchive.open(source);
    const pages = orderPages(zip.names());
    if (pages.length === 0) throw new Error('This comic has no pages.');
    return new ComicBook(zip, source, pages);
  }

  get count(): number {
    return this.pages.length;
  }

  // ---------------------------------------------------------------- observation

  /** Changes on every page state or size update; for `useSyncExternalStore`. */
  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private changed(): void {
    this.version += 1;
    for (const l of this.listeners) l();
  }

  size(page: number): PageSize | null {
    return this.sizes[page] ?? null;
  }

  state(page: number): PageState | undefined {
    return this.slots.get(page)?.state;
  }

  // ---------------------------------------------------------------- loading

  /**
   * The pages to hold, most urgent first. Pages not listed are released
   * (their object URLs revoked); listed ones load in order.
   */
  want(pages: number[]): void {
    if (this.destroyed) return;
    this.wanted = pages.filter((p, i) => p >= 0 && p < this.count && pages.indexOf(p) === i);
    this.keep = new Set(this.wanted);
    for (const [page, slot] of this.slots) {
      if (!this.keep.has(page)) this.release(page, slot);
    }
    this.pump();
  }

  /** Resolves once every page in `pages` has loaded or failed. */
  ready(pages: number[]): Promise<void> {
    return Promise.all(pages.map((p) => this.slots.get(p)?.done ?? Promise.resolve())).then(() => undefined);
  }

  /**
   * A load still reading gives up its place at once, so a jump across a
   * comic that is still downloading is not stuck behind pages left behind;
   * its result is dropped when it arrives.
   */
  private release(page: number, slot: Slot): void {
    this.uncount(slot);
    if (slot.state.status === 'ready') URL.revokeObjectURL(slot.state.image.url);
    if (slot.img) slot.img.src = '';
    this.slots.delete(page);
    this.changed();
  }

  private pump(): void {
    while (!this.destroyed && this.running < CONCURRENCY) {
      const page = this.wanted.find((p) => !this.slots.has(p));
      if (page === undefined) return;
      this.running += 1;
      const slot: Slot = { state: { status: 'loading' }, img: null, done: Promise.resolve(), counted: true };
      this.slots.set(page, slot);
      slot.done = this.load(page, slot).finally(() => {
        this.uncount(slot);
        this.pump();
      });
      this.changed();
    }
  }

  private uncount(slot: Slot): void {
    if (!slot.counted) return;
    slot.counted = false;
    this.running -= 1;
  }

  private async load(page: number, slot: Slot): Promise<void> {
    const name = this.pages[page]!;
    let url: string | null = null;
    try {
      const blob = await this.zip.readBlob(name, pageMimeType(name));
      if (!blob) throw new Error(`Missing page ${name}`);
      if (this.destroyed || this.slots.get(page) !== slot) return;
      url = URL.createObjectURL(blob);
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      if (this.destroyed || this.slots.get(page) !== slot) {
        URL.revokeObjectURL(url);
        return;
      }
      slot.img = img;
      slot.state = { status: 'ready', image: { url, width: img.naturalWidth, height: img.naturalHeight } };
      this.sizes[page] = { width: img.naturalWidth, height: img.naturalHeight };
    } catch {
      if (url) URL.revokeObjectURL(url);
      if (this.destroyed || this.slots.get(page) !== slot) return;
      slot.state = { status: 'error' };
    }
    // Finished pages nobody wants any more go straight away.
    if (!this.keep.has(page)) this.release(page, slot);
    else this.changed();
  }

  /**
   * Learns page sizes from image headers in the background, so wide pages
   * take their own spread before the reader gets near them. Only for a
   * verified copy: a still-downloading comic must not be read ahead.
   */
  async sniffSizes(): Promise<void> {
    let found = 0;
    for (let page = 0; page < this.count && !this.destroyed; page++) {
      if (this.sizes[page]) continue;
      const size = await this.sniff(this.pages[page]!).catch(() => null);
      if (this.destroyed) return;
      if (size && !this.sizes[page]) {
        this.sizes[page] = size;
        found += 1;
        if (found % 24 === 0) this.changed();
      }
      if (page % 8 === 7) await idle();
    }
    if (found % 24 !== 0) this.changed();
  }

  private async sniff(name: string): Promise<PageSize | null> {
    const entry = this.zip.entry(name);
    if (!entry || entry.method !== 0) return null;
    const end = Math.min(this.source.size, entry.offset + 30 + 1024 + Math.min(entry.compressedSize, HEAD_BYTES));
    const chunk = await this.source.read(entry.offset, end);
    if (chunk.length < 30) return null;
    const v = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const start = 30 + v.getUint16(26, true) + v.getUint16(28, true);
    return sniffImageSize(chunk.subarray(start, start + Math.min(entry.compressedSize, HEAD_BYTES)));
  }

  destroy(): void {
    this.destroyed = true;
    for (const [page, slot] of [...this.slots]) {
      if (slot.state.status === 'ready') URL.revokeObjectURL(slot.state.image.url);
      if (slot.img) slot.img.src = '';
      this.slots.delete(page);
    }
    this.listeners.clear();
  }
}

function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window !== 'undefined' && window.requestIdleCallback) window.requestIdleCallback(() => resolve(), { timeout: 500 });
    else setTimeout(resolve, 16);
  });
}
