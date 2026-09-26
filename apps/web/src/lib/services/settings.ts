import { defaultReaderPreferences, type AppSettings, type ReaderPreferences } from '../types';
import type { SettingsSnapshot, SettingsStore } from './contract';
import type { KeyValueStore } from './kv';
import {
  FONT_FAMILY_CLASSES,
  clampReaderPreferences,
  isAfter,
  isRecord,
  normalizeOrigin,
  nowIso,
  parseReaderPreferences,
  readerPreferencesToJson,
  toIso,
} from './models';
import { Emitter, WriteQueue } from './observable';
import { noopBus, type TabBus } from './tabs';

const SETTINGS_KEY = 'settings.v1';
const READER_KEY = 'reader_prefs.v1';

/**
 * API URL and reader preferences, persisted immediately. Every preference
 * edit stamps `_updatedAt` so the cloud copy resolves by last write wins.
 */
export class SettingsStoreImpl extends Emitter<SettingsSnapshot> implements SettingsStore {
  private readonly writes = new WriteQueue();

  constructor(
    private readonly kv: KeyValueStore,
    readonly defaultApiBaseUrl: string,
    private readonly bus: TabBus = noopBus,
    private readonly now: () => number = Date.now,
  ) {
    super({
      loaded: false,
      settings: { apiBaseUrl: defaultApiBaseUrl },
      reader: { ...defaultReaderPreferences },
      readerUpdatedAt: null,
    });
    bus.listen((topic) => {
      if (topic === 'settings') void this.reload();
    });
  }

  get settings(): AppSettings {
    return this.snapshot.settings;
  }

  get reader(): ReaderPreferences {
    return this.snapshot.reader;
  }

  get readerUpdatedAt(): string | null {
    return this.snapshot.readerUpdatedAt;
  }

  async load(): Promise<void> {
    const next = await this.read();
    this.emit({ ...next, loaded: true });
  }

  private async read(): Promise<Omit<SettingsSnapshot, 'loaded'>> {
    const s = await this.kv.get<unknown>(SETTINGS_KEY).catch(() => null);
    const r = await this.kv.get<unknown>(READER_KEY).catch(() => null);
    const apiBaseUrl = isRecord(s) && typeof s.apiBaseUrl === 'string' && s.apiBaseUrl.trim() ? s.apiBaseUrl : this.defaultApiBaseUrl;
    return {
      settings: { apiBaseUrl },
      reader: isRecord(r) ? parseReaderPreferences(r) : { ...defaultReaderPreferences },
      readerUpdatedAt: isRecord(r) ? toIso(r._updatedAt) : null,
    };
  }

  /** Another tab changed settings: adopt its API URL and any newer preferences. */
  private async reload(): Promise<void> {
    const stored = await this.read();
    const reader = isAfter(stored.readerUpdatedAt, this.snapshot.readerUpdatedAt)
      ? { reader: stored.reader, readerUpdatedAt: stored.readerUpdatedAt }
      : {};
    this.emit({ ...this.snapshot, settings: stored.settings, ...reader });
  }

  currentOrigin(): string {
    try {
      return normalizeOrigin(this.snapshot.settings.apiBaseUrl);
    } catch {
      return 'http://invalid.invalid';
    }
  }

  async setApiBaseUrl(url: string): Promise<void> {
    const apiBaseUrl = url.trim() || this.defaultApiBaseUrl;
    this.emit({ ...this.snapshot, settings: { ...this.snapshot.settings, apiBaseUrl } });
    await this.kv.set(SETTINGS_KEY, { apiBaseUrl });
    this.bus.post('settings');
  }

  setThemeId(id: string): Promise<void> {
    return this.updateReader((r) => ({ ...r, themeId: id }));
  }

  /** The id is always written, with its serif/sans class, so a stale id cannot survive a merge. */
  setFontFamily(familyId: string): Promise<void> {
    return this.updateReader((r) => ({ ...r, font: FONT_FAMILY_CLASSES[familyId] ?? r.font, fontFamilyId: familyId }));
  }

  async updateReader(change: (prefs: ReaderPreferences) => ReaderPreferences): Promise<void> {
    const reader = clampReaderPreferences(change({ ...this.snapshot.reader }));
    this.emit({ ...this.snapshot, reader, readerUpdatedAt: nowIso(this.now) });
    await this.persistReader();
  }

  /** Applies the cloud copy only when it is newer than the local edit. */
  async applyCloudReader(value: ReaderPreferences, updatedAt: string): Promise<void> {
    const current = this.snapshot.readerUpdatedAt;
    if (current !== null && !isAfter(updatedAt, current)) return;
    this.emit({ ...this.snapshot, reader: clampReaderPreferences(value), readerUpdatedAt: updatedAt });
    await this.persistReader();
  }

  private persistReader(): Promise<void> {
    const value = { ...readerPreferencesToJson(this.snapshot.reader), _updatedAt: this.snapshot.readerUpdatedAt };
    return this.writes.run(async () => {
      await this.kv.set(READER_KEY, value);
      this.bus.post('settings');
    });
  }

  flush(): Promise<void> {
    return this.writes.flush();
  }
}
