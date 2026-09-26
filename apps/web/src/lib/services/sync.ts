import type { Book, Highlight, LibraryEntry, ReaderPreferences, ReadingLocator, ReadingProgress } from '../types';
import { ApiError, type SyncSnapshot, type SyncStore } from './contract';
import type { SyncResponse } from './api';
import { randomId } from './hash';
import type { HighlightStoreImpl } from './highlights';
import type { KeyValueStore } from './kv';
import type { LibraryStoreImpl } from './library';
import {
  clampReaderPreferences,
  isRecord,
  isoOrder,
  nowIso,
  parseLocator,
  parseReaderPreferences,
  progressToJson,
  readerPreferencesToJson,
  stableStringify,
  toIso,
  utf8Length,
} from './models';
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
const CHECKPOINT_MS = 15_000;
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

/** Values the API validates; anything else would reject the whole batch. */
const SERVER_THEME_IDS = new Set(['default', 'dracula', 'nord', 'tokyo-night', 'catppuccin-mocha', 'gruvbox']);
const FONT_FAMILY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HIGHLIGHT_COLOR = /^[a-z]{1,16}$/;
const PREFERENCES_SHA = '0'.repeat(64);

export interface SyncChange {
  id: string;
  bookId: string;
  sha256: string;
  kind: 'library' | 'progress' | 'session' | 'preferences' | 'highlight';
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
    keepalive?: boolean;
  }): Promise<SyncResponse>;
  getBook(id: string): Promise<Book>;
}

export interface SyncEnvironment {
  isVisible(): boolean;
  onVisibilityChange(handler: (visible: boolean) => void): () => void;
  onPageHide(handler: () => void): () => void;
}

export function browserSyncEnvironment(): SyncEnvironment {
  const hasDocument = typeof document !== 'undefined';
  return {
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
  startedAt: number | null;
  lastSaved: number;
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

  private publish(): void {
    const st = this.current();
    this.emit({
      isSyncing: this.isSyncing,
      lastSyncedAt: st.lastSyncedAt,
      pendingCount: Object.keys(st.pending).length,
      totalReadingMilliseconds: totalMilliseconds(st),
      error: this.error,
    });
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
      this.deps.library.subscribe(capture),
      this.deps.settings.subscribe(capture),
      ...(this.deps.highlights ? [this.deps.highlights.subscribe(capture)] : []),
      this.bus.listen((topic) => {
        if (topic === 'sync') void this.reloadFromOtherTab();
      }),
      this.env.onVisibilityChange((visible) => this.visibilityChanged(visible)),
      this.env.onPageHide(() => void this.flushNow(true)),
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
    this.setReadingActive(visible);
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
    const updatedAt = this.deps.settings.readerUpdatedAt;
    if (updatedAt !== null && state.seen.preferences !== updatedAt) {
      out.push([
        'preferences',
        updatedAt,
        {
          id: randomId(),
          kind: 'preferences',
          bookId: '_preferences',
          sha256: PREFERENCES_SHA,
          updatedAt,
          payload: { value: wirePreferences(this.deps.settings.reader) },
        },
      ]);
    }
    return out;
  }

  /** Highlights of this origin's cloud books. Highlights on unknown editions stay local. */
  private captureHighlights(origin: string, state: OriginState, entries: LibraryEntry[], out: Capture[]): void {
    const store = this.deps.highlights;
    if (!store?.loaded) return;
    let bySha: Map<string, LibraryEntry> | null = null;
    for (const h of store.getSnapshot().all) {
      if (h.origin !== origin) continue;
      const key = `highlight:${h.id}`;
      if (state.seen[key] === h.updatedAt) continue;
      bySha ??= new Map(entries.map((e) => [e.book.sha256, e]));
      const entry = bySha.get(h.sha256);
      if (!entry) continue;
      const payload = highlightPayload(h);
      out.push([key, h.updatedAt, payload ? this.change(entry, 'highlight', h.updatedAt, payload) : null]);
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
    if (this.failures === 0) return this.pollInterval;
    return Math.min(this.pollInterval * 2 ** Math.min(this.failures, 16), MAX_BACKOFF_MS);
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
    const submitted = new Map<string, SyncChange>();
    let bytes = 100;
    try {
      // Bound both count and encoded body; huge payloads must not block every
      // other queued change behind the API's request-size limit.
      const library = this.deps.library.all;
      for (const [key, pending] of Object.entries(state.pending)) {
        const value = { ...pending };
        if (value.kind === 'highlight' && !withHighlights) continue;
        if (value.kind !== 'preferences') {
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
      try {
        response = await client.syncState({
          deviceId: snapshotState.deviceId,
          changes: [...submitted.values()] as unknown as Record<string, unknown>[],
          ...(withHighlights ? { highlightsSince: state.highlightCursor ?? 0 } : {}),
          keepalive,
        });
      } catch (error) {
        if (!withHighlights || !(error instanceof ApiError) || error.status !== 400 || error.code !== 'INVALID_SYNC') throw error;
        // A server without highlight sync rejects the whole atomic batch.
        // Keep everything else syncing and try highlights again later.
        withHighlights = false;
        highlightsRejected = true;
        for (const [key, value] of [...submitted]) {
          if (value.kind === 'highlight') {
            submitted.delete(key);
            before.delete(key);
          }
        }
        response = await client.syncState({
          deviceId: snapshotState.deviceId,
          changes: [...submitted.values()] as unknown as Record<string, unknown>[],
          keepalive,
        });
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
      });

      const seen: Record<string, string> = {};
      let cursor: number | undefined;
      const metadataRefresh: LibraryEntry[] = [];
      this.applying = true;
      try {
        await this.applyBooks(origin, client, rows, seen, metadataRefresh);
        const pulled = response.highlights;
        if (withHighlights && isRecord(pulled)) cursor = await this.applyHighlights(origin, pulled, seen);
        const prefs = response.preferences;
        if (isRecord(prefs) && origin === this.origin) {
          const updatedAt = toIso(prefs.updatedAt);
          if (updatedAt) {
            await this.deps.settings.applyCloudReader(parseReaderPreferences(prefs.value), updatedAt);
            const local = this.deps.settings.readerUpdatedAt;
            if (local !== null && isoOrder(local) === isoOrder(updatedAt)) seen.preferences = local;
          }
        }
        await this.mutate((s) => {
          const st = (s.origins[origin] ??= emptyOrigin());
          Object.assign(st.seen, seen);
          if (cursor !== undefined) st.highlightCursor = cursor;
          st.lastSyncedAt = nowIso(this.now);
          s.lastAttemptAt = nowIso(this.now);
        });
      } finally {
        this.applying = false;
      }
      await this.captureNow();
      this.failures = 0;
      this.scheduleMetadataRefresh(origin, client, metadataRefresh);
      const more = isRecord(response.highlights) && response.highlights.more === true;
      this.drainMore = submitted.size === MAX_CHANGES || bytes > 200 * 1024 || (withHighlights && more);
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

  /** Time advances only while the reader is open and the tab is visible. */
  beginReading(entry: LibraryEntry): void {
    this.endReading();
    if (entry.source !== 'api' || this.disposed) return;
    this.reading = {
      entry,
      id: randomId(),
      accumulated: 0,
      startedAt: this.visible ? this.now() : null,
      lastSaved: 0,
    };
    this.activeEditions.add(`${entry.origin}\n${entry.book.sha256}`);
    this.readingTimer = setInterval(() => this.checkpointReading(), CHECKPOINT_MS);
  }

  private setReadingActive(active: boolean): void {
    const reading = this.reading;
    if (!reading) return;
    if (active && this.visible) {
      reading.startedAt ??= this.now();
    } else {
      if (reading.startedAt !== null) reading.accumulated += Math.max(0, this.now() - reading.startedAt);
      reading.startedAt = null;
      this.checkpointReading();
    }
  }

  private checkpointReading(): void {
    const reading = this.reading;
    if (!reading) return;
    const elapsed = Math.round(reading.accumulated + (reading.startedAt === null ? 0 : Math.max(0, this.now() - reading.startedAt)));
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
      reading.accumulated += Math.max(0, this.now() - reading.startedAt);
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

function parseOriginState(value: unknown): OriginState {
  if (!isRecord(value)) throw new Error('Origin state must be an object.');
  const st = emptyOrigin();
  if (isRecord(value.pending)) {
    for (const [key, change] of Object.entries(value.pending)) {
      if (isRecord(change) && typeof change.id === 'string' && isRecord(change.payload)) st.pending[key] = change as unknown as SyncChange;
    }
  }
  if (isRecord(value.seen)) {
    for (const [key, stamp] of Object.entries(value.seen)) if (typeof stamp === 'string') st.seen[key] = stamp;
  }
  for (const field of ['totals', 'sessionAcknowledged'] as const) {
    const map = value[field];
    if (isRecord(map)) for (const [k, v] of Object.entries(map)) if (typeof v === 'number') st[field][k] = Math.trunc(v);
  }
  st.lastSyncedAt = toIso(value.lastSyncedAt);
  if (typeof value.highlightCursor === 'number') st.highlightCursor = Math.trunc(value.highlightCursor);
  const unsupported = toIso(value.highlightsUnsupportedUntil);
  if (unsupported) st.highlightsUnsupportedUntil = unsupported;
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

/**
 * Preferences as the API validates them. Values it would reject (a web-only
 * theme, say) are left out, which keeps the server's copy of that field.
 */
export function wirePreferences(p: ReaderPreferences): Record<string, unknown> {
  const value = readerPreferencesToJson(clampReaderPreferences(p));
  if (typeof value.themeId === 'string' && !SERVER_THEME_IDS.has(value.themeId)) delete value.themeId;
  if (typeof value.fontFamilyId === 'string' && !FONT_FAMILY_ID.test(value.fontFamilyId)) delete value.fontFamilyId;
  if (typeof value.highlightColor === 'string' && !HIGHLIGHT_COLOR.test(value.highlightColor)) delete value.highlightColor;
  return value;
}
