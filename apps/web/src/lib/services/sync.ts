import type { ArticleSummary, Book, Highlight, LibraryEntry, ReadingLocator, ReadingProgress } from '../types';
import { ApiError, type SyncSnapshot, type SyncStore } from './contract';
import type { SyncResponse } from './api';
import { MAX_ARTICLE_BODY_BYTES, positionFromFraction, type ArticleStoreImpl, type RemoteArticle } from './articles';
import { randomId } from './hash';
import { articleIdOf } from '../articleAnchors';
import type { HighlightStoreImpl } from './highlights';
import type { KeyValueStore } from './kv';
import type { LibraryStoreImpl } from './library';
import { isRecord, isoOrder, nowIso, parseLocator, progressToJson, stableStringify, toIso, utf8Length } from './models';
import { Emitter, WriteQueue } from './observable';
import type { SettingsStoreImpl } from './settings';
import { createMemoryLocks, noopBus, type Locks, type TabBus } from './tabs';

/**
 * One personal cloud profile with an origin-scoped durable outbox, ported
 * from mobile `SyncRepository`. Device IDs deduplicate reading sessions; they
 * are not authentication.
 *
 * The API runs on a metered free tier, so traffic follows one schedule: a
 * single pull+push request every two minutes while the tab is visible,
 * nothing while hidden, exponential backoff after failures, and best-effort
 * flushes when reading stops or the tab is hidden. Local edits are saved and
 * queued at once but never send a request of their own.
 *
 * Several tabs may be open. Outbox edits are read-modify-write sequences on
 * the stored state under a Web Lock, and only one tab sends at a time.
 *
 * Reader preferences (theme, typography, highlight colour) stay on this
 * device and are never sent; see `SettingsStoreImpl`.
 */

export const SYNC_INTERVAL_MS = 2 * 60_000;
/** Start/visible only syncs when the last attempt is at least this old. */
export const RESUME_GAP_MS = 60_000;
/** A flush is skipped when a sync was attempted this recently. */
export const FLUSH_GAP_MS = 15_000;
export const MAX_BACKOFF_MS = 15 * 60_000;
/** Lets the reader's final progress save land before a flush reads it. */
const FLUSH_SETTLE_MS = 1_000;
/** Only used when a full batch left more of the outbox to send. */
const DRAIN_DELAY_MS = 5_000;
/** How long to stop sending highlights after a server rejected them. */
export const HIGHLIGHTS_RETRY_MS = 6 * 60 * 60_000;
/** Same for articles, against a server without article sync. */
export const ARTICLES_RETRY_MS = 6 * 60 * 60_000;
/** Article documents uploaded per cycle; the rest wait for the next one. */
export const ARTICLE_UPLOADS_PER_CYCLE = 5;
/** Small synced documents downloaded per cycle, so they open offline. */
export const ARTICLE_PREFETCH_PER_CYCLE = 5;
const CHECKPOINT_MS = 15_000;
/**
 * A visible tab has no screen lock to pause it the way a phone does, so a
 * reader left open stops counting this long after the last sign of reading
 * (input, a page turn or scroll that saved progress). Time up to that point
 * counts, like a phone that locks after its timeout.
 */
export const READING_IDLE_MS = 10 * 60_000;
const MAX_CHANGES = 100;
const MAX_BATCH_BYTES = 240 * 1024;
const MAX_SESSION_MS = 7 * 24 * 60 * 60_000;

const SYNC_KEY = 'cloud_sync.v1';
/** Metadata-refresh throttle, kept apart so the state format can evolve. */
const METADATA_KEY = 'cloud_sync.metadata_refresh.v1';
const METADATA_RETRY_MS = 5 * 60_000;
const METADATA_FRESH_MS = 6 * 60 * 60_000;
const STATE_LOCK = 'thereader-sync-state';
const REQUEST_LOCK = 'thereader-sync-request';

/** Highlight colours the API validates; anything else would reject the whole batch. */
const HIGHLIGHT_COLOR = /^[a-z]{1,16}$/;
/** Article changes use a sentinel edition; the article is `payload.articleId`. */
const ARTICLES_BOOK_ID = '_articles';
const ARTICLES_SHA = '0'.repeat(64);
const ARTICLE_IMAGE = /^(?:https?:\/\/|data:image\/)\S+$/i;

export interface SyncChange {
  id: string;
  bookId: string;
  sha256: string;
  kind: 'library' | 'progress' | 'session' | 'highlight' | 'article' | 'articleProgress';
  updatedAt: string;
  payload: Record<string, unknown>;
}

export interface OriginState {
  pending: Record<string, SyncChange>;
  seen: Record<string, string>;
  totals: Record<string, number>;
  sessionAcknowledged: Record<string, number>;
  lastSyncedAt: string | null;
  /** Server highlight rev already pulled; absent means never pulled. */
  highlightCursor?: number;
  /** Set when the server rejected highlight sync (not yet deployed). */
  highlightsUnsupportedUntil?: string;
  /** Server article rev already pulled; absent means never pulled. */
  articleCursor?: number;
  /** Set when the server rejected article sync (not yet deployed). */
  articlesUnsupportedUntil?: string;
  /** Article documents this device saved and still has to upload: id to SHA-256. */
  articleUploads?: Record<string, string>;
}

export interface StoredSync {
  deviceId: string;
  origins: Record<string, OriginState>;
  /** Last request attempt by any tab, so visible tabs share one cadence. */
  lastAttemptAt?: string;
}

export interface SyncApi {
  syncState(options: {
    deviceId: string;
    changes: Record<string, unknown>[];
    highlightsSince?: number;
    articlesSince?: number;
    keepalive?: boolean;
  }): Promise<SyncResponse>;
  getBook(id: string): Promise<Book>;
  putArticleBody?(sha256: string, json: Uint8Array): Promise<void>;
}

export interface SyncEnvironment {
  isVisible(): boolean;
  onVisibilityChange(handler: (visible: boolean) => void): () => void;
  onPageHide(handler: () => void): () => void;
  /** User input anywhere on the page (reading idle detection). */
  onActivity?(handler: () => void): () => void;
}

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function browserSyncEnvironment(): SyncEnvironment {
  const hasDocument = typeof document !== 'undefined';
  return {
    onActivity(handler) {
      if (!hasDocument) return () => {};
      const options = { capture: true, passive: true } as const;
      for (const type of ACTIVITY_EVENTS) document.addEventListener(type, handler, options);
      return () => {
        for (const type of ACTIVITY_EVENTS) document.removeEventListener(type, handler, options);
      };
    },
    isVisible: () => !hasDocument || document.visibilityState === 'visible',
    onVisibilityChange(handler) {
      if (!hasDocument) return () => {};
      const listener = () => handler(document.visibilityState === 'visible');
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    onPageHide(handler) {
      if (typeof window === 'undefined') return () => {};
      window.addEventListener('pagehide', handler);
      return () => window.removeEventListener('pagehide', handler);
    },
  };
}

export interface SyncDeps {
  kv: KeyValueStore;
  library: LibraryStoreImpl;
  settings: SettingsStoreImpl;
  highlights?: HighlightStoreImpl;
  articles?: ArticleStoreImpl;
  clientFor(origin: string): SyncApi;
  isUploadPending?(entryId: string): boolean;
  retryUploads?(): void;
  bus?: TabBus;
  locks?: Locks;
  env?: SyncEnvironment;
  now?: () => number;
  pollInterval?: number;
}

interface ReadingSession {
  entry: LibraryEntry;
  id: string;
  accumulated: number;
  /** Start of the current counting stretch; null while paused. */
  startedAt: number | null;
  lastSaved: number;
  /** Paused by the reader UI (`setReadingActive(false)`). */
  paused: boolean;
  lastActivity: number;
  /** Progress stamp last seen, so a saved position counts as activity. */
  progressStamp: string | null;
}

type Capture = [key: string, stamp: string, change: SyncChange | null];

const emptyOrigin = (): OriginState => ({ pending: {}, seen: {}, totals: {}, sessionAcknowledged: {}, lastSyncedAt: null });

export class SyncStoreImpl extends Emitter<SyncSnapshot> implements SyncStore {
  private state: StoredSync = { deviceId: '', origins: {} };
  private readonly bus: TabBus;
  private readonly locks: Locks;
  private readonly env: SyncEnvironment;
  private readonly now: () => number;
  readonly pollInterval: number;
  private readonly stateWrites = new WriteQueue();
  private readonly metadataWrites = new WriteQueue();
  private readonly unsubscribers: Array<() => void> = [];

  private loaded = false;
  private disposed = false;
  private visible: boolean;
  private applying = false;
  private autoSync = false;
  private drainMore = false;
  private failures = 0;
  private isSyncing = false;
  private error: string | null = null;
  private lastAttemptAt: number | null = null;
  private next: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readingTimer: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<void> | null = null;
  private captureQueued = false;
  private reading: ReadingSession | null = null;
  private readonly activeEditions = new Set<string>();
  private readonly metadataNextRefresh = new Map<string, number>();
  private readonly metadataRefreshInFlight = new Set<string>();
  private metadataRefreshing = false;

  constructor(private readonly deps: SyncDeps) {
    super({ isSyncing: false, lastSyncedAt: null, pendingCount: 0, totalReadingMilliseconds: 0, error: null });
    this.bus = deps.bus ?? noopBus;
    this.locks = deps.locks ?? createMemoryLocks();
    this.env = deps.env ?? browserSyncEnvironment();
    this.now = deps.now ?? Date.now;
    this.pollInterval = deps.pollInterval ?? SYNC_INTERVAL_MS;
    this.visible = this.env.isVisible();
  }

  get deviceId(): string {
    return this.state.deviceId;
  }

  /** Current in-memory copy of the stored state (tests and diagnostics). */
  get stored(): StoredSync {
    return this.state;
  }

  private get origin(): string {
    return this.deps.settings.currentOrigin();
  }

  private current(state = this.state): OriginState {
    return state.origins[this.origin] ?? emptyOrigin();
  }

  // ---------------------------------------------------------------- snapshot

  /** Emits only when a visible value changed, so subscribers re-render only then. */
  private publish(): void {
    const st = this.current();
    const next: SyncSnapshot = {
      isSyncing: this.isSyncing,
      lastSyncedAt: st.lastSyncedAt,
      pendingCount: Object.keys(st.pending).length,
      totalReadingMilliseconds: totalMilliseconds(st),
      error: this.error,
    };
    const prev = this.snapshot;
    if (
      prev.isSyncing === next.isSyncing &&
      prev.lastSyncedAt === next.lastSyncedAt &&
      prev.pendingCount === next.pendingCount &&
      prev.totalReadingMilliseconds === next.totalReadingMilliseconds &&
      prev.error === next.error
    ) {
      return;
    }
    this.emit(next);
  }

  readingMillisecondsFor(entry: LibraryEntry): number {
    return milliseconds(this.state.origins[entry.origin] ?? emptyOrigin(), entry.book.sha256);
  }

  // ---------------------------------------------------------------- stored state

  private async readStored(): Promise<StoredSync> {
    let saved: unknown = null;
    try {
      saved = await this.deps.kv.get<unknown>(SYNC_KEY);
    } catch {
      return structuredCloneJson(this.state);
    }
    const deviceId =
      isRecord(saved) && typeof saved.deviceId === 'string' && saved.deviceId ? saved.deviceId : this.state.deviceId || randomId();
    const origins: Record<string, OriginState> = {};
    const raw = isRecord(saved) && isRecord(saved.origins) ? saved.origins : {};
    for (const [origin, value] of Object.entries(raw)) {
      try {
        origins[origin] = parseOriginState(value);
      } catch {
        /* Preserve other origins if one old state record is corrupt. */
      }
    }
    const lastAttemptAt = isRecord(saved) ? toIso(saved.lastAttemptAt) : null;
    return { deviceId, origins, ...(lastAttemptAt ? { lastAttemptAt } : {}) };
  }

  /**
   * Read-modify-write of the stored state under the cross-tab lock, so edits
   * from several tabs never overwrite each other.
   */
  private mutate(change: (state: StoredSync) => void): Promise<void> {
    return this.stateWrites.run(
      () =>
        this.locks.exclusive(STATE_LOCK, async () => {
          const fresh = await this.readStored();
          change(fresh);
          this.state = fresh;
          await this.deps.kv.set(SYNC_KEY, fresh);
          this.bus.post('sync');
          this.publish();
        }),
      () => {
        this.error = 'Could not save the sync queue on this device.';
        if (!this.disposed) this.publish();
      },
    );
  }

  private async reloadFromOtherTab(): Promise<void> {
    await this.locks.exclusive(STATE_LOCK, async () => {
      this.state = await this.readStored();
    });
    if (!this.disposed) this.publish();
  }

  flush(): Promise<void> {
    return Promise.all([this.stateWrites.flush(), this.metadataWrites.flush()]).then(() => undefined);
  }

  // ---------------------------------------------------------------- lifecycle

  async load(options: { startTimers?: boolean } = {}): Promise<void> {
    try {
      await this.mutate(() => {});
    } catch {
      // Storage is unavailable: sync still works for this session.
      this.state.deviceId ||= randomId();
    }
    await this.loadMetadataThrottle();
    this.loaded = true;
    const capture = () => this.scheduleCapture();
    this.unsubscribers.push(
      this.deps.library.subscribe(() => {
        this.readingProgressChanged();
        capture();
      }),
      // A new API URL switches the status shown, and the queue, to that origin.
      this.deps.settings.subscribe(() => {
        this.publish();
        capture();
      }),
      ...(this.deps.highlights ? [this.deps.highlights.subscribe(capture)] : []),
      ...(this.deps.articles ? [this.deps.articles.subscribe(capture)] : []),
      this.bus.listen((topic) => {
        if (topic === 'sync') void this.reloadFromOtherTab();
      }),
      this.env.onVisibilityChange((visible) => this.visibilityChanged(visible)),
      this.env.onPageHide(() => void this.flushNow(true)),
      ...(this.env.onActivity ? [this.env.onActivity(() => this.noteReadingActivity())] : []),
    );
    await this.captureNow();
    this.publish();
    if (options.startTimers !== false) {
      this.autoSync = true;
      this.resume();
    }
  }

  dispose(): void {
    this.endReading();
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    if (this.next) clearTimeout(this.next);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.next = null;
    this.flushTimer = null;
  }

  private visibilityChanged(visible: boolean): void {
    const was = this.visible;
    this.visible = visible;
    // Returning to the tab is itself a sign of reading.
    if (visible) this.noteReadingActivity();
    else this.updateReadingClock();
    if (visible) {
      if (!was) this.resume();
      return;
    }
    // No polling while hidden; only flush what is already queued.
    if (this.next) clearTimeout(this.next);
    this.next = null;
    void this.flushNow(true);
  }

  // ---------------------------------------------------------------- capture

  private scheduleCapture(): void {
    if (this.captureQueued) return;
    this.captureQueued = true;
    queueMicrotask(() => {
      this.captureQueued = false;
      void this.captureNow();
    });
  }

  /** Queues every local change this origin has not sent yet. */
  async captureNow(): Promise<void> {
    if (!this.loaded || this.disposed || this.applying || !this.deps.library.loaded) return;
    const origin = this.origin;
    // Cheap in-memory check first; the locked write recomputes on fresh state.
    if (this.computeCapture(this.current(), origin).length === 0) return;
    let changed = false;
    try {
      await this.mutate((s) => {
        const st = (s.origins[origin] ??= emptyOrigin());
        const captures = this.computeCapture(st, origin);
        for (const [key, stamp, change] of captures) {
          st.seen[key] = stamp;
          if (change) st.pending[key] = change;
          if (change?.kind === 'article') this.trackArticleUpload(st, change);
        }
        changed = captures.length > 0;
      });
    } catch {
      return; // The error is on the snapshot; the next change retries.
    }
    if (changed) this.requestSync();
  }

  private computeCapture(state: OriginState, origin: string): Capture[] {
    const out: Capture[] = [];
    const library = this.deps.library;
    if (!library.loaded) return out;
    const entries = library.all.filter((e) => e.source === 'api' && e.origin === origin);
    for (const entry of entries) {
      const sha = entry.book.sha256;
      const memberKey = `library:${sha}`;
      if (state.seen[memberKey] !== entry.addedAt) {
        out.push([memberKey, entry.addedAt, this.change(entry, 'library', entry.addedAt, { present: true, addedAt: entry.addedAt })]);
      }
      if (entry.progress) {
        const key = `progress:${sha}`;
        const stamp = stableStringify(progressToJson(entry.progress));
        if (state.seen[key] !== stamp) {
          const payload = boundedLocator(entry.progress.locator);
          out.push([key, stamp, payload ? this.change(entry, 'progress', entry.progress.updatedAt, payload) : null]);
        }
      }
    }
    this.captureHighlights(origin, state, entries, out);
    this.captureArticles(state, out);
    return out;
  }

  /**
   * Highlights of this origin's cloud books, and of saved articles (which,
   * like the articles, go to whichever origin is current). Highlights on
   * unknown editions, and on articles that stay on this device, stay local.
   */
  private captureHighlights(origin: string, state: OriginState, entries: LibraryEntry[], out: Capture[]): void {
    const store = this.deps.highlights;
    if (!store?.loaded) return;
    let bySha: Map<string, LibraryEntry> | null = null;
    for (const h of store.getSnapshot().all) {
      const key = `highlight:${h.id}`;
      if (state.seen[key] === h.updatedAt) continue;
      const articleId = articleIdOf(h);
      if (articleId !== null) {
        const summary = this.deps.articles?.summary(articleId);
        if (summary && !articleSyncable(summary)) continue;
        const payload = highlightPayload(h);
        out.push([key, h.updatedAt, payload ? { id: randomId(), bookId: h.bookId, sha256: h.sha256, kind: 'highlight', updatedAt: h.updatedAt, payload } : null]);
        continue;
      }
      if (h.origin !== origin) continue;
      bySha ??= new Map(entries.map((e) => [e.book.sha256, e]));
      const entry = bySha.get(h.sha256);
      if (!entry) continue;
      const payload = highlightPayload(h);
      out.push([key, h.updatedAt, payload ? this.change(entry, 'highlight', h.updatedAt, payload) : null]);
    }
  }

  /**
   * Saved articles: each save or deletion, then reading positions. A deletion
   * is only sent for an article this origin has seen.
   */
  private captureArticles(state: OriginState, out: Capture[]): void {
    const store = this.deps.articles;
    if (!store?.loaded) return;
    for (const s of store.all) {
      // One the API cannot take stays on this device: its save, positions and
      // deletion are never sent, so it cannot fail a batch.
      if (!articleSyncable(s)) continue;
      const key = `article:${s.id}`;
      const stamp = `saved:${s.addedAt}`;
      if (state.seen[key] !== stamp) out.push([key, stamp, articleChange('article', s.addedAt, articlePayload(s)!)]);
      if (s.progress != null && s.progressUpdatedAt && state.seen[`articleProgress:${s.id}`] !== s.progressUpdatedAt) {
        const position = positionFromFraction(s.progress, s.blockCount);
        out.push([`articleProgress:${s.id}`, s.progressUpdatedAt, articleChange('articleProgress', s.progressUpdatedAt, { articleId: s.id, position })]);
      }
    }
    for (const [id, at] of store.deleted) {
      const key = `article:${id}`;
      const stamp = `deleted:${at}`;
      if (state.seen[key] === undefined || state.seen[key] === stamp) continue;
      out.push([key, stamp, articleChange('article', at, { articleId: id, deleted: true })]);
    }
  }

  /** A queued save uploads this device's document once; a deletion cancels both. */
  private trackArticleUpload(st: OriginState, change: SyncChange): void {
    const id = String(change.payload.articleId);
    if (change.payload.deleted === true) {
      if (st.articleUploads) delete st.articleUploads[id];
      delete st.pending[`articleProgress:${id}`];
      return;
    }
    const summary = this.deps.articles?.summary(id);
    if (summary && summary.stored !== false && summary.bodySha256 && summary.bodySha256 === change.payload.bodySha256) {
      (st.articleUploads ??= {})[id] = summary.bodySha256;
    }
  }

  private change(
    entry: LibraryEntry,
    kind: SyncChange['kind'],
    updatedAt: string,
    payload: Record<string, unknown>,
    id = randomId(),
  ): SyncChange {
    return {
      id,
      bookId: this.deps.library.entry(entry.id)?.book.id ?? entry.book.id,
      sha256: entry.book.sha256,
      kind,
      updatedAt,
      payload,
    };
  }

  /** Re-check after an upload publishes its canonical cloud identity. */
  uploadsChanged(): void {
    if (this.loaded && !this.disposed) this.scheduleCapture();
  }

  // ---------------------------------------------------------------- scheduling

  /**
   * The single entry point for "synced data changed locally". The change is
   * already saved and queued; it rides the next scheduled cycle.
   */
  requestSync(): void {
    this.scheduleNext(this.cycleDelay(), false);
  }

  private cycleDelay(): number {
    return cycleDelay(this.pollInterval, this.failures);
  }

  private lastAttempt(): number | null {
    const stamps = [this.lastAttemptAt, isoOrder(this.state.lastAttemptAt) / 1000, isoOrder(this.current().lastSyncedAt) / 1000]
      .filter((v): v is number => v !== null && Number.isFinite(v));
    return stamps.length ? Math.max(...stamps) : null;
  }

  private attemptedWithin(gap: number): boolean {
    const last = this.lastAttempt();
    if (last === null) return false;
    // A stamp in the future (clock moved back) must not suppress syncing.
    const since = this.now() - last;
    return since >= 0 && since < gap;
  }

  private scheduleNext(delay: number, replace = true): void {
    if (!this.loaded || this.disposed || !this.autoSync || !this.visible) return;
    if (!replace && this.next !== null) return;
    if (this.next) clearTimeout(this.next);
    this.next = setTimeout(() => {
      this.next = null;
      if (!this.visible || this.disposed) return;
      // Another visible tab ran this cycle: keep the cadence without a second request.
      const shared = isoOrder(this.state.lastAttemptAt) / 1000;
      if (shared > (this.lastAttemptAt ?? 0) && this.attemptedWithin(this.pollInterval * 0.9)) {
        this.scheduleNext(this.cycleDelay());
        return;
      }
      this.deps.retryUploads?.();
      void this.syncNow();
    }, delay);
  }

  /** Start or return to the tab: sync once unless a sync ran very recently. */
  private resume(): void {
    if (!this.loaded || this.disposed || !this.autoSync) return;
    this.deps.retryUploads?.();
    if (this.attemptedWithin(RESUME_GAP_MS)) this.scheduleNext(this.cycleDelay());
    else void this.syncNow();
  }

  /** Best-effort push when reading stops. */
  private flushSoon(): void {
    if (!this.loaded || this.disposed || !this.autoSync) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.disposed) void this.flushNow(false);
    }, FLUSH_SETTLE_MS);
  }

  /** Pushes queued changes unless there are none or a sync was just attempted. */
  private async flushNow(keepalive: boolean): Promise<void> {
    if (!this.loaded || this.disposed || !this.autoSync) return;
    this.checkpointReading();
    await this.captureNow();
    await this.stateWrites.flush();
    if (Object.keys(this.current().pending).length === 0 || this.attemptedWithin(FLUSH_GAP_MS)) return;
    await this.syncNow({ keepalive });
  }

  /** Syncs now (Settings button and the schedule). Calls during a sync join it. */
  syncNow(options: { keepalive?: boolean } = {}): Promise<void> {
    if (this.disposed || !this.loaded) return Promise.resolve();
    return (this.syncing ??= this.locks
      .tryExclusive(REQUEST_LOCK, () => this.sync(options.keepalive === true))
      .then(() => undefined)
      .finally(() => {
        this.syncing = null;
        this.lastAttemptAt = this.now();
        this.scheduleNext(this.drainMore ? DRAIN_DELAY_MS : this.cycleDelay());
      }));
  }

  // ---------------------------------------------------------------- sync

  private async sync(keepalive: boolean): Promise<void> {
    this.checkpointReading();
    await this.captureNow();
    await this.stateWrites.flush();
    const origin = this.origin;
    const snapshotState = await this.locks.exclusive(STATE_LOCK, () => this.readStored());
    this.state = snapshotState;
    const state = snapshotState.origins[origin] ?? emptyOrigin();
    const client = this.deps.clientFor(origin);
    this.isSyncing = true;
    this.drainMore = false;
    this.error = null;
    this.publish();
    const now = this.now();
    let withHighlights =
      this.deps.highlights !== undefined &&
      !(state.highlightsUnsupportedUntil && isoOrder(state.highlightsUnsupportedUntil) / 1000 > now);
    let highlightsRejected = false;
    let withArticles =
      this.deps.articles !== undefined && !(state.articlesUnsupportedUntil && isoOrder(state.articlesUnsupportedUntil) / 1000 > now);
    let articlesRejected = false;
    const submitted = new Map<string, SyncChange>();
    let bytes = 100;
    try {
      // Bound both count and encoded body; huge payloads must not block every
      // other queued change behind the API's request-size limit.
      const library = this.deps.library.all;
      for (const [key, pending] of Object.entries(state.pending)) {
        const value = { ...pending };
        if (value.kind === 'highlight' && !withHighlights) continue;
        if (isArticleKind(value.kind)) {
          if (!withArticles) continue;
        } else {
          const entry = library.find((e) => e.origin === origin && e.book.sha256 === value.sha256);
          if (entry) {
            if (this.deps.isUploadPending?.(entry.id)) continue;
            value.bookId = entry.book.id;
          }
        }
        const length = utf8Length(JSON.stringify(value));
        if (submitted.size >= MAX_CHANGES || bytes + length > MAX_BATCH_BYTES) break;
        submitted.set(key, value);
        bytes += length + 1;
      }
      const before = new Map([...submitted.keys()].map((key) => [key, JSON.stringify(state.pending[key])]));
      let response: SyncResponse;
      for (;;) {
        try {
          response = await client.syncState({
            deviceId: snapshotState.deviceId,
            changes: [...submitted.values()] as unknown as Record<string, unknown>[],
            ...(withHighlights ? { highlightsSince: state.highlightCursor ?? 0 } : {}),
            ...(withArticles ? { articlesSince: state.articleCursor ?? 0 } : {}),
            keepalive,
          });
          break;
        } catch (error) {
          if (!(withHighlights || withArticles) || !(error instanceof ApiError) || error.status !== 400 || error.code !== 'INVALID_SYNC') {
            throw error;
          }
          // A server without article (or highlight) sync rejects the whole
          // atomic batch. Keep everything else syncing and try that part
          // again later: articles first, as the newer feature.
          const dropArticles = withArticles;
          if (dropArticles) {
            withArticles = false;
            articlesRejected = true;
          } else {
            withHighlights = false;
            highlightsRejected = true;
          }
          for (const [key, value] of [...submitted]) {
            if (dropArticles ? isArticleKind(value.kind) : value.kind === 'highlight') {
              submitted.delete(key);
              before.delete(key);
            }
          }
        }
      }
      if (this.disposed) return;
      const rows = (Array.isArray(response.books) ? response.books : []).filter(isRecord);

      // Preserve local changes made while HTTP was in flight, even when their
      // outbox key/session ID matches the acknowledged request.
      await this.mutate((s) => {
        const st = (s.origins[origin] ??= emptyOrigin());
        for (const [key, value] of submitted) {
          if (value.kind === 'session') {
            st.sessionAcknowledged[value.id] = Number(value.payload.readingMilliseconds) || 0;
          }
          if (JSON.stringify(st.pending[key]) === before.get(key)) delete st.pending[key];
        }
        for (const id of Object.keys(st.sessionAcknowledged)) {
          if (id !== this.reading?.id && !st.pending[`session:${id}`]) delete st.sessionAcknowledged[id];
        }
        st.totals = {};
        for (const row of rows) {
          const sha = String(row.sha256);
          st.totals[sha] = (st.totals[sha] ?? 0) + (Number(row.readingMilliseconds) || 0);
        }
        if (highlightsRejected) st.highlightsUnsupportedUntil = new Date(now + HIGHLIGHTS_RETRY_MS).toISOString();
        if (articlesRejected) st.articlesUnsupportedUntil = new Date(now + ARTICLES_RETRY_MS).toISOString();
      });

      const seen: Record<string, string> = {};
      let cursor: number | undefined;
      let articleCursor: number | undefined;
      const metadataRefresh: LibraryEntry[] = [];
      this.applying = true;
      try {
        await this.applyBooks(origin, client, rows, seen, metadataRefresh);
        const pulled = response.highlights;
        if (withHighlights && isRecord(pulled)) cursor = await this.applyHighlights(origin, pulled, seen);
        if (withArticles && isRecord(response.articles)) articleCursor = await this.applyArticles(response.articles, seen);
        await this.mutate((s) => {
          const st = (s.origins[origin] ??= emptyOrigin());
          Object.assign(st.seen, seen);
          if (cursor !== undefined) st.highlightCursor = cursor;
          if (articleCursor !== undefined) st.articleCursor = articleCursor;
          st.lastSyncedAt = nowIso(this.now);
          s.lastAttemptAt = nowIso(this.now);
        });
      } finally {
        this.applying = false;
      }
      // Documents go up once the server holds their saves: the server deletes
      // a document no live article references, so uploading first could race
      // a deletion and leave a save pointing at nothing.
      if (withArticles && !keepalive) await this.uploadArticleBodies(origin, client);
      await this.captureNow();
      this.failures = 0;
      this.scheduleMetadataRefresh(origin, client, metadataRefresh);
      const more = isRecord(response.highlights) && response.highlights.more === true;
      const moreArticles = isRecord(response.articles) && response.articles.more === true;
      this.drainMore = submitted.size === MAX_CHANGES || bytes > 200 * 1024 || (withHighlights && more) || (withArticles && moreArticles);
      if (withArticles && !keepalive && origin === this.origin) void this.deps.articles!.prefetch(ARTICLE_PREFETCH_PER_CYCLE).catch(() => undefined);
    } catch (error) {
      this.failures++;
      this.error =
        error instanceof ApiError
          ? `${error.message} Changes remain saved on this device.`
          : 'Cloud sync is unavailable. Changes remain saved on this device.';
      await this.mutate((s) => {
        s.lastAttemptAt = nowIso(this.now);
      }).catch(() => undefined);
    } finally {
      this.isSyncing = false;
      if (!this.disposed) this.publish();
    }
  }

  private async applyBooks(
    origin: string,
    client: SyncApi,
    rows: Record<string, unknown>[],
    seen: Record<string, string>,
    metadataRefresh: LibraryEntry[],
  ): Promise<void> {
    const library = this.deps.library;
    for (const row of rows) {
      const sha = typeof row.sha256 === 'string' ? row.sha256 : '';
      const id = typeof row.bookId === 'string' ? row.bookId : '';
      if (!sha || !id) continue;
      const local = library.all.find((e) => e.origin === origin && e.book.id === id);
      if (!local && row.inLibrary !== true) continue;
      let book: Book;
      if (!local) {
        const key = `${origin}\n${id}`;
        const refreshAt = this.metadataNextRefresh.get(key);
        if (refreshAt !== undefined && refreshAt > this.now()) continue;
        this.metadataNextRefresh.set(key, this.now() + METADATA_RETRY_MS);
        this.persistMetadataThrottle();
        try {
          book = await client.getBook(id);
        } catch (error) {
          if (error instanceof ApiError) continue;
          throw error;
        }
        this.metadataNextRefresh.set(key, this.now() + METADATA_FRESH_MS);
        this.persistMetadataThrottle();
      } else {
        book = local.book;
        metadataRefresh.push(local);
      }
      if (book.sha256 !== sha) continue;
      const active = this.activeEditions.has(`${origin}\n${sha}`);
      const stamp = toIso(row.progressUpdatedAt);
      let progress: ReadingProgress | null = null;
      if (isRecord(row.progress) && stamp) {
        try {
          progress = { locator: parseLocator(row.progress), updatedAt: stamp };
        } catch {
          progress = null;
        }
      }
      await library.applyCloudEntry({
        book,
        origin,
        addedAt: toIso(row.addedAt) ?? book.updatedAt,
        // An open reader does not jump; the position applies after it closes.
        progress: active ? null : progress,
        lastOpenedAt: toIso(row.lastOpenedAt),
      });
      const applied = library.all.find((e) => e.origin === origin && e.book.id === id);
      if (applied) {
        seen[`library:${sha}`] = applied.addedAt;
        if (!active && progress && applied.progress?.updatedAt === progress.updatedAt) {
          // The server can normalize JSON numbers (0.0 to 0) or key order. At an
          // acknowledged timestamp, fingerprint the retained local locator so
          // representation differences cannot re-queue the same position.
          seen[`progress:${sha}`] = stableStringify(progressToJson(applied.progress));
        }
      }
    }
  }

  /** Stores rows changed on other devices; returns the new pull cursor. */
  private async applyHighlights(origin: string, pulled: Record<string, unknown>, seen: Record<string, string>): Promise<number | undefined> {
    const store = this.deps.highlights!;
    const remote: Highlight[] = [];
    for (const row of Array.isArray(pulled.items) ? pulled.items : []) {
      try {
        if (!isRecord(row) || !isRecord(row.locator) || typeof row.id !== 'string' || typeof row.color !== 'string') continue;
        const createdAt = toIso(row.createdAt), updatedAt = toIso(row.updatedAt);
        if (!createdAt || !updatedAt || typeof row.bookId !== 'string' || typeof row.sha256 !== 'string') continue;
        remote.push({
          id: row.id,
          bookId: row.bookId,
          sha256: row.sha256,
          origin,
          locator: row.locator,
          text: typeof row.text === 'string' ? row.text : '',
          color: row.color,
          note: typeof row.note === 'string' ? row.note : null,
          createdAt,
          updatedAt,
          deleted: row.deleted === true,
        });
      } catch {
        continue;
      }
    }
    await store.applyRemote(remote);
    for (const h of remote) {
      const local = store.byId(h.id);
      // Matching copies need no upload; a newer local edit stays queued.
      if (local && isoOrder(local.updatedAt) === isoOrder(h.updatedAt)) seen[`highlight:${h.id}`] = local.updatedAt;
    }
    return typeof pulled.cursor === 'number' && Number.isSafeInteger(pulled.cursor) ? pulled.cursor : undefined;
  }

  /**
   * Uploads documents this device saved, a few per cycle, once the server has
   * accepted their saves. A network or server failure keeps the rest queued
   * for the next cycle; a document the server refuses (too large, invalid) or
   * that is gone locally is dropped, and its article stays readable here and
   * pending elsewhere.
   */
  private async uploadArticleBodies(origin: string, client: SyncApi): Promise<void> {
    const store = this.deps.articles;
    if (!store || !client.putArticleBody) return;
    const state = this.state.origins[origin] ?? emptyOrigin();
    const ready = Object.entries(state.articleUploads ?? {}).filter(([id]) => !state.pending[`article:${id}`]);
    for (const [id, sha] of ready.slice(0, ARTICLE_UPLOADS_PER_CYCLE)) {
      const body = await store.bodyFor(id);
      if (body && body.sha256 === sha) {
        try {
          await client.putArticleBody(sha, body.bytes);
        } catch (error) {
          if (!(error instanceof ApiError) || error.isNetwork || error.status === null) return;
          // A server without article bodies answers its generic 404.
          if (error.status >= 500 || error.status === 408 || error.status === 429 || error.status === 404) return;
          console.warn(`Article ${id} could not be uploaded: ${error.message}`);
        }
      }
      await this.mutate((s) => {
        const uploads = s.origins[origin]?.articleUploads;
        if (uploads?.[id] === sha) delete uploads[id];
      });
    }
  }

  /** Stores articles changed on other devices; returns the new pull cursor. */
  private async applyArticles(pulled: Record<string, unknown>, seen: Record<string, string>): Promise<number | undefined> {
    const store = this.deps.articles!;
    const remote: RemoteArticle[] = [];
    for (const row of Array.isArray(pulled.items) ? pulled.items : []) {
      const parsed = parseRemoteArticle(row);
      if (parsed) remote.push(parsed);
    }
    await store.applyRemote(remote);
    for (const r of remote) {
      const local = store.summary(r.id);
      // Matching copies need no upload; a newer local edit stays queued.
      if (r.deleted) {
        const deletedAt = store.deleted.get(r.id);
        if (!local && (!deletedAt || isoOrder(deletedAt) === isoOrder(r.updatedAt))) seen[`article:${r.id}`] = `deleted:${deletedAt ?? r.updatedAt}`;
        continue;
      }
      if (local && isoOrder(local.addedAt) === isoOrder(r.updatedAt)) seen[`article:${r.id}`] = `saved:${local.addedAt}`;
      if (local?.progressUpdatedAt && r.positionUpdatedAt && isoOrder(local.progressUpdatedAt) === isoOrder(r.positionUpdatedAt)) {
        seen[`articleProgress:${r.id}`] = local.progressUpdatedAt;
      }
    }
    return typeof pulled.cursor === 'number' && Number.isSafeInteger(pulled.cursor) ? pulled.cursor : undefined;
  }

  // ---------------------------------------------------------------- metadata refresh

  private async loadMetadataThrottle(): Promise<void> {
    try {
      const saved = await this.deps.kv.get<unknown>(METADATA_KEY);
      const now = this.now();
      for (const [key, value] of Object.entries(isRecord(saved) ? saved : {})) {
        const at = typeof value === 'string' ? Date.parse(value) : NaN;
        // Ignore stale or implausibly distant stamps (clock changes, damage).
        if (Number.isFinite(at) && at > now && at <= now + METADATA_FRESH_MS) this.metadataNextRefresh.set(key, at);
      }
    } catch {
      /* An unreadable throttle only means metadata may be refreshed early. */
    }
  }

  private persistMetadataThrottle(): void {
    const now = this.now();
    for (const [key, at] of this.metadataNextRefresh) if (at <= now) this.metadataNextRefresh.delete(key);
    const snapshot = Object.fromEntries([...this.metadataNextRefresh].map(([k, at]) => [k, new Date(at).toISOString()]));
    void this.metadataWrites.run(() => this.deps.kv.set(METADATA_KEY, snapshot), () => undefined);
  }

  private scheduleMetadataRefresh(origin: string, client: SyncApi, entries: LibraryEntry[]): void {
    if (this.disposed || !this.visible || this.origin !== origin || this.metadataRefreshing) return;
    const now = this.now();
    const candidates: Array<{ key: string; entryId: string; bookId: string; sha256: string }> = [];
    for (const entry of entries) {
      const key = `${origin}\n${entry.book.id}`;
      if (this.metadataRefreshInFlight.has(key) || (this.metadataNextRefresh.get(key) ?? 0) > now) continue;
      this.metadataRefreshInFlight.add(key);
      this.metadataNextRefresh.set(key, now + METADATA_RETRY_MS);
      candidates.push({ key, entryId: entry.id, bookId: entry.book.id, sha256: entry.book.sha256 });
    }
    if (candidates.length === 0) return;
    this.persistMetadataThrottle();
    void this.refreshMetadata(origin, client, candidates);
  }

  private async refreshMetadata(
    origin: string,
    client: SyncApi,
    candidates: Array<{ key: string; entryId: string; bookId: string; sha256: string }>,
  ): Promise<void> {
    this.metadataRefreshing = true;
    try {
      for (const candidate of candidates) {
        if (this.disposed || !this.visible || this.origin !== origin) break;
        let refreshed: Book;
        try {
          refreshed = await client.getBook(candidate.bookId);
        } catch {
          continue;
        }
        if (this.disposed || !this.visible || this.origin !== origin) break;
        // A successful response is throttled even if the server now points the
        // ID at another edition; never relabel already verified local bytes.
        this.metadataNextRefresh.set(candidate.key, this.now() + METADATA_FRESH_MS);
        const current = this.deps.library.entry(candidate.entryId);
        if (!current || current.origin !== origin || current.book.sha256 !== candidate.sha256 || refreshed.sha256 !== candidate.sha256) {
          continue;
        }
        await this.deps.library.applyCloudEntry({ book: refreshed, origin, addedAt: current.addedAt });
      }
    } catch {
      // Metadata refresh is best effort and never fails the durable sync.
    } finally {
      this.metadataRefreshing = false;
      for (const candidate of candidates) this.metadataRefreshInFlight.delete(candidate.key);
      if (!this.disposed) this.persistMetadataThrottle();
    }
  }

  // ---------------------------------------------------------------- reading time

  /**
   * Time advances only while the reader is open, the tab is visible, the
   * reader UI has not paused it, and the reader was active within
   * `READING_IDLE_MS`. The cumulative session counter is saved every 15 s and
   * whenever counting stops.
   */
  beginReading(entry: LibraryEntry): void {
    this.endReading();
    if (entry.source !== 'api' || this.disposed) return;
    const now = this.now();
    this.reading = {
      entry,
      id: randomId(),
      accumulated: 0,
      startedAt: this.visible ? now : null,
      lastSaved: 0,
      paused: false,
      lastActivity: now,
      progressStamp: entry.progress?.updatedAt ?? null,
    };
    this.activeEditions.add(`${entry.origin}\n${entry.book.sha256}`);
    this.readingTimer = setInterval(() => {
      this.updateReadingClock();
      this.checkpointReading();
    }, CHECKPOINT_MS);
  }

  /**
   * Pauses or resumes counting for the open book (mobile `setReadingActive`),
   * e.g. while a modal hides the page. Visibility is handled here already.
   */
  setReadingActive(active: boolean): void {
    const reading = this.reading;
    if (!reading) return;
    reading.paused = !active;
    if (active) this.noteReadingActivity();
    else this.updateReadingClock();
  }

  /**
   * A sign that the user is reading (input, a page turn). Input on the page
   * itself is observed automatically; the reader should call this for input
   * inside its content frame. Saved progress counts as activity too.
   */
  noteReadingActivity(): void {
    const reading = this.reading;
    if (!reading) return;
    // Settle an idle stretch first, so the gap before this input never counts.
    this.updateReadingClock();
    reading.lastActivity = this.now();
    this.updateReadingClock();
  }

  /** Current session counter in milliseconds (0 without an open book). */
  get currentReadingMilliseconds(): number {
    return this.reading ? this.readingElapsed(this.reading) : 0;
  }

  private readingProgressChanged(): void {
    const reading = this.reading;
    if (!reading) return;
    const stamp = this.deps.library.entry(reading.entry.id)?.progress?.updatedAt ?? null;
    if (stamp === reading.progressStamp) return;
    reading.progressStamp = stamp;
    this.noteReadingActivity();
  }

  private readingElapsed(reading: ReadingSession): number {
    if (reading.startedAt === null) return reading.accumulated;
    const end = Math.min(this.now(), reading.lastActivity + READING_IDLE_MS);
    return reading.accumulated + Math.max(0, end - reading.startedAt);
  }

  /** Starts or stops the session clock to match visibility, pause and idleness. */
  private updateReadingClock(): void {
    const reading = this.reading;
    if (!reading) return;
    const now = this.now();
    const run = this.visible && !reading.paused && now - reading.lastActivity < READING_IDLE_MS;
    if (run) {
      reading.startedAt ??= now;
      return;
    }
    if (reading.startedAt !== null) {
      reading.accumulated = this.readingElapsed(reading);
      reading.startedAt = null;
    }
    this.checkpointReading();
  }

  private checkpointReading(): void {
    const reading = this.reading;
    if (!reading) return;
    const elapsed = Math.round(this.readingElapsed(reading));
    if (elapsed <= reading.lastSaved) return;
    reading.lastSaved = elapsed;
    void this.recordReadingSession(reading.entry, reading.id, elapsed);
  }

  /** Cumulative per-session counter; the server keeps the maximum, so retries never double count. */
  recordReadingSession(entry: LibraryEntry, sessionId: string, readingMilliseconds: number): Promise<void> {
    if (entry.source !== 'api' || readingMilliseconds <= 0) return Promise.resolve();
    return this.mutate((s) => {
      const st = (s.origins[entry.origin] ??= emptyOrigin());
      const key = `session:${sessionId}`;
      const previous = Number(st.pending[key]?.payload.readingMilliseconds ?? 0) || 0;
      const elapsed = Math.min(MAX_SESSION_MS, Math.max(Math.round(readingMilliseconds), previous));
      st.pending[key] = this.change(entry, 'session', nowIso(this.now), { readingMilliseconds: elapsed }, sessionId);
    }).catch(() => undefined);
  }

  endReading(): void {
    const reading = this.reading;
    if (reading && reading.startedAt !== null) {
      reading.accumulated = this.readingElapsed(reading);
      reading.startedAt = null;
    }
    this.checkpointReading();
    if (reading) this.activeEditions.delete(`${reading.entry.origin}\n${reading.entry.book.sha256}`);
    this.reading = null;
    if (this.readingTimer) clearInterval(this.readingTimer);
    this.readingTimer = null;
    if (reading && !this.disposed) this.flushSoon();
  }
}

// ---------------------------------------------------------------- pure helpers

/** Wait before the next cycle: the poll interval, doubled per consecutive failure up to 15 min. */
export function cycleDelay(pollInterval: number, failures: number): number {
  if (failures <= 0) return pollInterval;
  return Math.min(pollInterval * 2 ** Math.min(failures, 16), MAX_BACKOFF_MS);
}

function sessionDelta(state: OriginState, change: SyncChange): number {
  return Math.max(0, (Number(change.payload.readingMilliseconds) || 0) - (state.sessionAcknowledged[change.id] ?? 0));
}

function milliseconds(state: OriginState, sha: string): number {
  let total = state.totals[sha] ?? 0;
  for (const c of Object.values(state.pending)) {
    if (c.kind === 'session' && c.sha256 === sha) total += sessionDelta(state, c);
  }
  return total;
}

export function totalMilliseconds(state: OriginState): number {
  let total = 0;
  for (const sha of Object.keys(state.totals)) total += milliseconds(state, sha);
  for (const c of Object.values(state.pending)) {
    if (c.kind === 'session' && !(c.sha256 in state.totals)) total += sessionDelta(state, c);
  }
  return total;
}

/**
 * Older builds synced reader preferences under this outbox key. They are
 * device-local now, so a change queued before the upgrade is dropped.
 */
const LEGACY_PREFERENCES = 'preferences';

function parseOriginState(value: unknown): OriginState {
  if (!isRecord(value)) throw new Error('Origin state must be an object.');
  const st = emptyOrigin();
  if (isRecord(value.pending)) {
    for (const [key, change] of Object.entries(value.pending)) {
      if (key === LEGACY_PREFERENCES || !isRecord(change) || change.kind === LEGACY_PREFERENCES) continue;
      if (typeof change.id === 'string' && isRecord(change.payload)) st.pending[key] = change as unknown as SyncChange;
    }
  }
  if (isRecord(value.seen)) {
    for (const [key, stamp] of Object.entries(value.seen)) if (key !== LEGACY_PREFERENCES && typeof stamp === 'string') st.seen[key] = stamp;
  }
  for (const field of ['totals', 'sessionAcknowledged'] as const) {
    const map = value[field];
    if (isRecord(map)) for (const [k, v] of Object.entries(map)) if (typeof v === 'number') st[field][k] = Math.trunc(v);
  }
  st.lastSyncedAt = toIso(value.lastSyncedAt);
  if (typeof value.highlightCursor === 'number') st.highlightCursor = Math.trunc(value.highlightCursor);
  const unsupported = toIso(value.highlightsUnsupportedUntil);
  if (unsupported) st.highlightsUnsupportedUntil = unsupported;
  if (typeof value.articleCursor === 'number') st.articleCursor = Math.trunc(value.articleCursor);
  const articlesUnsupported = toIso(value.articlesUnsupportedUntil);
  if (articlesUnsupported) st.articlesUnsupportedUntil = articlesUnsupported;
  if (isRecord(value.articleUploads)) {
    for (const [id, sha] of Object.entries(value.articleUploads)) if (typeof sha === 'string') (st.articleUploads ??= {})[id] = sha;
  }
  return st;
}

function structuredCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const clamp01 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * The wire locator the API validates (href, progression, totalProgression,
 * title, engine, raw). Long engine payloads are dropped rather than poisoning
 * a whole batch; a locator without href cannot be sent at all.
 */
export function boundedLocator(locator: ReadingLocator): Record<string, unknown> | null {
  if (typeof locator.href !== 'string' || locator.href.length === 0 || locator.href.length > 4096) return null;
  const value: Record<string, unknown> = {
    href: locator.href,
    progression: clamp01(locator.progression),
    totalProgression:
      typeof locator.totalProgression === 'number' && Number.isFinite(locator.totalProgression) ? clamp01(locator.totalProgression) : null,
    title: typeof locator.title === 'string' ? locator.title.slice(0, 1000) : null,
    engine: typeof locator.engine === 'string' ? locator.engine.slice(0, 64) : 'web',
    raw: isRecord(locator.raw) ? locator.raw : null,
  };
  if (utf8Length(JSON.stringify(value)) > 30 * 1024) value.raw = null;
  return value;
}

/** The API caps a highlight locator at 16 KB; context text is the only part that grows. */
export function boundedHighlightLocator(locator: Record<string, unknown>): Record<string, unknown> {
  if (utf8Length(JSON.stringify(locator)) <= 15 * 1024) return locator;
  const copy = { ...locator };
  if (isRecord(copy.text)) {
    const { before: _before, after: _after, ...rest } = copy.text;
    copy.text = rest;
  }
  if (utf8Length(JSON.stringify(copy)) <= 15 * 1024) return copy;
  delete copy.text;
  return copy;
}

function highlightPayload(h: Highlight): Record<string, unknown> | null {
  if (typeof h.locator.href !== 'string' || h.locator.href.length === 0 || h.locator.href.length > 4096) return null;
  const locator = boundedHighlightLocator(h.locator);
  if (utf8Length(JSON.stringify(locator)) > 16 * 1024) return null;
  return {
    highlightId: h.id,
    locator,
    text: h.text.slice(0, 4000),
    color: HIGHLIGHT_COLOR.test(h.color) ? h.color : 'yellow',
    ...(typeof h.note === 'string' ? { note: h.note.slice(0, 4000) } : {}),
    createdAt: h.createdAt,
    deleted: h.deleted,
  };
}

const isArticleKind = (kind: string): boolean => kind === 'article' || kind === 'articleProgress';

function articleChange(kind: 'article' | 'articleProgress', updatedAt: string, payload: Record<string, unknown>): SyncChange {
  return { id: randomId(), bookId: ARTICLES_BOOK_ID, sha256: ARTICLES_SHA, kind, updatedAt, payload };
}

const clampInt = (v: unknown, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : min;

/**
 * Whether an article syncs: one whose document exceeds the upload limit, or
 * whose URL the API cannot take, stays on this device.
 */
export function articleSyncable(s: ArticleSummary): boolean {
  if (!s.bodySha256 || !s.bodySize || s.bodySize > MAX_ARTICLE_BODY_BYTES) return false;
  return s.url.length <= 2048 && /^https?:\/\/\S+$/i.test(s.url);
}

/**
 * A saved article's metadata as the API validates it. Long text is clipped
 * and unusable image URLs dropped. Null for an article that stays on this
 * device.
 */
export function articlePayload(s: ArticleSummary): Record<string, unknown> | null {
  if (!articleSyncable(s)) return null;
  const text = (v: string | null | undefined, max: number) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);
  const image = (v: string | null | undefined) => (typeof v === 'string' && v.length <= 2048 && ARTICLE_IMAGE.test(v) ? v : null);
  return {
    articleId: s.id,
    url: s.url,
    title: s.title.slice(0, 1000),
    siteName: text(s.siteName, 300),
    byline: text(s.byline, 500),
    excerpt: text(s.excerpt, 2000),
    leadImage: image(s.image),
    favicon: image(s.favicon),
    language: text(s.language, 35),
    dir: s.dir === 'rtl' ? 'rtl' : 'ltr',
    wordCount: clampInt(s.wordCount, 0, 10_000_000),
    readingMinutes: clampInt(s.readingMinutes, 1, 100_000),
    blockCount: clampInt(s.blockCount, 0, 1_000_000),
    publishedAt: text(s.publishedAt, 64),
    savedAt: s.addedAt,
    bodySha256: s.bodySha256,
    bodySize: s.bodySize,
    schema: 1,
    deleted: false,
  };
}

const textOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function parseRemoteArticle(row: unknown): RemoteArticle | null {
  if (!isRecord(row) || typeof row.id !== 'string' || !/^[a-f0-9]{32}$/.test(row.id)) return null;
  const updatedAt = toIso(row.updatedAt);
  if (!updatedAt) return null;
  const p = row.position;
  const position = isRecord(p) ? { block: Math.max(0, Math.trunc(finite(p.block))), offset: finite(p.offset), percent: finite(p.percent) } : null;
  return {
    id: row.id,
    url: typeof row.url === 'string' ? row.url : '',
    title: typeof row.title === 'string' ? row.title : '',
    siteName: textOrNull(row.siteName),
    byline: textOrNull(row.byline),
    excerpt: textOrNull(row.excerpt),
    leadImage: textOrNull(row.leadImage),
    favicon: textOrNull(row.favicon),
    language: textOrNull(row.language),
    dir: row.dir === 'rtl' ? 'rtl' : 'ltr',
    wordCount: Math.max(0, Math.trunc(finite(row.wordCount))),
    readingMinutes: Math.max(1, Math.trunc(finite(row.readingMinutes))),
    blockCount: Math.max(0, Math.trunc(finite(row.blockCount))),
    publishedAt: textOrNull(row.publishedAt),
    bodySha256: typeof row.bodySha256 === 'string' && /^[a-f0-9]{64}$/.test(row.bodySha256) ? row.bodySha256 : null,
    bodySize: typeof row.bodySize === 'number' ? row.bodySize : null,
    position,
    positionUpdatedAt: toIso(row.positionUpdatedAt),
    updatedAt,
    deleted: row.deleted === true,
  };
}
