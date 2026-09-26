import { useCallback, useEffect, useState } from 'react';
import { QuietButton } from '../components/buttons';
import { TextField } from '../components/controls';
import { SyncIcon } from '../components/icons';
import { Eyebrow, ScreenHeader } from '../components/states';
import { ThemeSection } from '../components/ThemeSection';
import { useToast } from '../components/toast';
import { formatBytes, formatReadingTime, formatRelativeTime } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { checkHealth, RemoteError } from '../lib/remote';
import type { StorageInfo } from '../lib/services/contract';
import { useServices, useStore } from '../lib/services/react';

type Tone = 'neutral' | 'plain' | 'good' | 'warn' | 'bad';

const toneClass: Record<Tone, string> = {
  neutral: 'tone-neutral',
  plain: 'tone-plain',
  good: 'tone-good',
  warn: 'tone-warn',
  bad: 'tone-bad',
};

/** Mirrors `ApiClient.normalizeBaseUrl`: bare hosts get http://, trailing slashes go. */
function validateApiUrl(raw: string): string {
  let s = raw.trim();
  if (!s) throw new Error('API URL is empty.');
  if (!s.includes('://')) s = `http://${s}`;
  while (s.endsWith('/')) s = s.slice(0, -1);
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new Error('API URL must be an http(s) origin.');
  }
  if (!url.host || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new Error('API URL must be an http(s) origin.');
  return s;
}

/**
 * Library API address, theme, cloud sync status, storage and about. The API
 * URL is the only configuration; this is the only screen that reports upload
 * or sync state.
 */
export function SettingsScreen() {
  useDocumentTitle('Settings');
  const services = useServices();
  const settings = useStore(services.settings);
  const sync = useStore(services.sync);
  const imports = useStore(services.imports);
  const lib = useStore(services.library);
  const toast = useToast();

  const [url, setUrl] = useState(settings.settings.apiBaseUrl);
  const [seeded, setSeeded] = useState(settings.loaded);
  const [check, setCheck] = useState<{ text: string; tone: Tone } | null>(null);
  const [checking, setChecking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [storage, setStorage] = useState<StorageInfo | null>(null);

  useEffect(() => {
    if (!seeded && settings.loaded) {
      setUrl(settings.settings.apiBaseUrl);
      setSeeded(true);
    }
  }, [seeded, settings.loaded, settings.settings.apiBaseUrl]);

  const refreshStorage = useCallback(() => {
    services.storage.info().then(setStorage, () => setStorage(null));
  }, [services.storage]);
  const readyCount = lib.entries.filter((e) => e.download.status === 'ready').length;
  useEffect(refreshStorage, [refreshStorage, readyCount]);

  const runCheck = async () => {
    setChecking(true);
    setCheck(null);
    try {
      const normalized = validateApiUrl(url);
      await services.settings.setApiBaseUrl(normalized);
      const h = await checkHealth(services.settings.currentOrigin());
      setCheck(h.ok ? { text: `Connected · ${h.service}`, tone: 'good' } : { text: 'Server is not healthy', tone: 'warn' });
    } catch (e) {
      setCheck({ text: e instanceof RemoteError || e instanceof Error ? e.message : String(e), tone: 'bad' });
    } finally {
      setChecking(false);
    }
  };

  const useDefault = async () => {
    setUrl(services.settings.defaultApiBaseUrl);
    setCheck(null);
    await services.settings.setApiBaseUrl(services.settings.defaultApiBaseUrl);
  };

  const syncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await services.sync.syncNow();
    } finally {
      setSyncing(false);
    }
  };

  const retryUploads = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await services.imports.retryPending();
    } finally {
      setRetrying(false);
    }
  };

  const keepBooks = async () => {
    const granted = await services.storage.requestPersistence().catch(() => false);
    refreshStorage();
    if (!granted) toast.show("The browser didn't allow persistent storage. Books stay, but it may clear them when space runs low.", { durationMs: 6000 });
  };

  const isDefault = settings.settings.apiBaseUrl === services.settings.defaultApiBaseUrl;
  const isSyncing = sync.isSyncing || syncing;
  const activeUpload = lib.entries.find((e) => e.id === imports.uploadingId);
  const failedUploads = lib.entries.map((e) => imports.errors[e.id]).filter((x): x is string => !!x);
  const uploading = imports.busy || activeUpload != null || retrying;

  const uploadsText = activeUpload
    ? imports.uploadFraction == null
      ? `Uploading ${activeUpload.book.title}`
      : `Uploading ${activeUpload.book.title} · ${Math.round(imports.uploadFraction * 100)}%`
    : imports.busy
      ? 'Importing'
      : imports.pendingCount === 0
        ? 'All books uploaded'
        : imports.pendingCount === 1
          ? '1 book waiting to upload'
          : `${imports.pendingCount} books waiting to upload`;

  return (
    <div className="page-narrow settings">
      <ScreenHeader title="Settings" size="sm" />

      <section className="settings-section" aria-labelledby="api-eyebrow">
        <Eyebrow as="h2" id="api-eyebrow">
          Library API
        </Eyebrow>
        <form
          className="api-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!checking) void runCheck();
          }}
        >
          <TextField
            mono
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-labelledby="api-eyebrow"
            placeholder={services.settings.defaultApiBaseUrl}
            value={url}
            onValueChange={(v) => {
              setUrl(v);
              setCheck(null);
            }}
          />
          <div className="button-row">
            <QuietButton type="submit" label={checking ? 'Checking' : 'Save and check'} disabled={checking} />
            {!isDefault && <QuietButton label="Use default" disabled={checking} onClick={() => void useDefault()} />}
          </div>
          {check && (
            <p className={`t-body-sm ${toneClass[check.tone]}`} role="status">
              {check.text}
            </p>
          )}
        </form>
      </section>

      <ThemeSection selectedId={settings.reader.themeId} onSelect={(id) => void services.settings.setThemeId(id)} />

      <section className="settings-section" aria-labelledby="sync-eyebrow">
        <Eyebrow as="h2" id="sync-eyebrow">
          Cloud sync
        </Eyebrow>
        <dl className="status-rows">
          <StatusRow
            label="Last sync"
            value={sync.isSyncing ? 'Syncing now' : sync.lastSyncedAt == null ? 'Never' : formatRelativeTime(sync.lastSyncedAt)}
          />
          <StatusRow
            label="Waiting"
            value={
              sync.pendingCount === 0
                ? 'Up to date'
                : sync.pendingCount === 1
                  ? '1 change not yet synced'
                  : `${sync.pendingCount} changes not yet synced`
            }
            tone={sync.pendingCount === 0 ? 'plain' : 'warn'}
          />
          <StatusRow label="Reading time" value={formatReadingTime(sync.totalReadingMilliseconds)} />
          {sync.error && <StatusRow label="Problem" value={sync.error} tone="bad" />}
          <StatusRow label="Uploads" value={uploadsText} tone={imports.pendingCount === 0 || imports.busy ? 'plain' : 'warn'} />
          {imports.error && <StatusRow label="Import problem" value={imports.error} tone="bad" />}
          {failedUploads.length > 0 && (
            <StatusRow
              label="Upload problem"
              value={failedUploads.length === 1 ? failedUploads[0] : `${failedUploads[0]} (${failedUploads.length} books)`}
              tone="bad"
            />
          )}
        </dl>
        <div className="button-row">
          <QuietButton label={isSyncing ? 'Syncing' : 'Sync now'} icon={SyncIcon} disabled={isSyncing} onClick={() => void syncNow()} />
          {(imports.pendingCount > 0 || failedUploads.length > 0) && (
            <QuietButton label={uploading ? 'Uploading' : 'Retry uploads'} disabled={uploading} onClick={() => void retryUploads()} />
          )}
        </div>
      </section>

      <section className="settings-section" aria-labelledby="storage-eyebrow">
        <Eyebrow as="h2" id="storage-eyebrow">
          Storage
        </Eyebrow>
        <p className="t-body muted">
          {storage?.persisted
            ? 'Downloads are saved on this device.'
            : 'Downloads are saved in this browser. It may clear them when the device runs low on space.'}
        </p>
        {storage && (
          <dl className="status-rows">
            <StatusRow
              label="Books"
              value={storage.bookCount === 0 ? 'None downloaded' : `${storage.bookCount} ${storage.bookCount === 1 ? 'book' : 'books'} · ${formatBytes(storage.bookBytes)}`}
            />
            {storage.usageBytes != null && (
              <StatusRow
                label="Used"
                value={storage.quotaBytes ? `${formatBytes(storage.usageBytes)} of ${formatBytes(storage.quotaBytes)}` : formatBytes(storage.usageBytes)}
              />
            )}
            <StatusRow label="Kept" value={storage.persisted ? 'Protected from automatic cleanup' : 'Browser may clear when space is low'} tone={storage.persisted ? 'plain' : 'warn'} />
          </dl>
        )}
        {storage && !storage.persisted && (
          <div className="button-row">
            <QuietButton label="Keep books on this device" onClick={() => void keepBooks()} />
          </div>
        )}
      </section>

      <section className="settings-section desktop-only" aria-labelledby="keys-eyebrow">
        <Eyebrow as="h2" id="keys-eyebrow">
          Keyboard
        </Eyebrow>
        <dl className="status-rows keys">
          <KeyRow keys={['←', '→']} label="Previous / next page" />
          <KeyRow keys={['Space']} label="Next page (Shift for previous)" />
          <KeyRow keys={['Home']} label="Start of chapter" />
          <KeyRow keys={['T']} label="Contents" />
          <KeyRow keys={['H']} label="Highlights" />
          <KeyRow keys={['/']} label="Search the book, or the catalog in Browse" />
          <KeyRow keys={['A']} label="Typography" />
          <KeyRow keys={['F']} label="Full screen" />
          <KeyRow keys={['Esc']} label="Close panel, then controls, then the book" />
        </dl>
      </section>

      <section className="settings-section" aria-labelledby="about-eyebrow">
        <Eyebrow as="h2" id="about-eyebrow">
          About
        </Eyebrow>
        <p className="t-body-sm">The Reader · personal EPUB reader</p>
      </section>
    </div>
  );
}

function StatusRow({ label, value, tone = 'plain' }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="status-row">
      <dt>{label}</dt>
      <dd className={toneClass[tone]}>{value}</dd>
    </div>
  );
}

function KeyRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="status-row">
      <dt>
        {keys.map((k) => (
          <kbd key={k}>{k}</kbd>
        ))}
      </dt>
      <dd className="tone-plain">{label}</dd>
    </div>
  );
}
