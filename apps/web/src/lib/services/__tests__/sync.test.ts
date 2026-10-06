import { describe, expect, test } from 'bun:test';
import { ApiError } from '../contract';
import { entryIdentity } from '../models';
import { MAX_BACKOFF_MS, READING_IDLE_MS, cycleDelay, wirePreferences } from '../sync';
import { defaultReaderPreferences } from '../../types';
import { ORIGIN, addBook, emptyResponse, harness, makeBook } from './helpers';

const locator = (progression: number) => ({
  href: 'OEBPS/ch01.xhtml',
  progression,
  totalProgression: progression / 2,
  title: 'One',
  engine: 'web',
  raw: null,
});

describe('outbox capture and acknowledgement', () => {
  test('queues library membership, progress and preferences, then acknowledges them', async () => {
    const h = await harness();
    const book = makeBook();
    const entry = await addBook(h, book);
    await h.library.saveProgress(entry.id, locator(0.25), book.sha256);
    await h.settings.updateReader((p) => ({ ...p, fontSize: 22 }));
    await h.settle();

    expect(Object.keys(h.pending()).sort()).toEqual(['library:' + book.sha256, 'preferences', 'progress:' + book.sha256]);
    expect(h.sync.getSnapshot().pendingCount).toBe(3);

    await h.sync.syncNow();
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.deviceId).toMatch(/^[a-f0-9]{32}$/);
    expect(call.highlightsSince).toBe(0);
    const kinds = call.changes.map((c) => c.kind).sort();
    expect(kinds).toEqual(['library', 'preferences', 'progress']);
    const progress = call.changes.find((c) => c.kind === 'progress')!;
    expect(Object.keys(progress.payload).sort()).toEqual(['engine', 'href', 'progression', 'raw', 'title', 'totalProgression']);
    expect(progress.bookId).toBe('moby-dick');
    const prefs = call.changes.find((c) => c.kind === 'preferences')!;
    expect(prefs.bookId).toBe('_preferences');
    expect(prefs.sha256).toBe('0'.repeat(64));
    expect((prefs.payload.value as Record<string, unknown>).fontSize).toBe(22);

    expect(Object.keys(h.pending())).toHaveLength(0);
    expect(h.sync.getSnapshot().lastSyncedAt).not.toBeNull();

    // Nothing changed: the next sync sends nothing again.
    await h.settle();
    await h.sync.syncNow();
    expect(h.calls[1]!.changes).toHaveLength(0);
  });

  test('keeps an edit made while the request was in flight', async () => {
    const h = await harness();
    const book = makeBook();
    const entry = await addBook(h, book);
    await h.library.saveProgress(entry.id, locator(0.1), book.sha256);
    await h.settle();

    h.setHandler(async () => {
      h.clock.advance(1000);
      await h.library.saveProgress(entry.id, locator(0.5), book.sha256);
      await h.settle();
      return emptyResponse();
    });
    await h.sync.syncNow();

    const pending = h.pending()['progress:' + book.sha256];
    expect(pending).toBeDefined();
    expect(pending!.payload.progression).toBe(0.5);
    expect(h.calls[0]!.changes.find((c) => c.kind === 'progress')!.payload.progression).toBe(0.1);
  });

  test('batches at most 100 changes and drains the rest next time', async () => {
    const h = await harness();
    const book = makeBook();
    await addBook(h, book);
    for (let i = 0; i < 130; i++) {
      await h.highlights.create({
        bookId: book.id,
        sha256: book.sha256,
        origin: ORIGIN,
        locator: { href: 'OEBPS/ch01.xhtml', locations: { totalProgression: i / 200 } },
        text: `passage ${i}`,
        color: 'yellow',
      });
    }
    await h.settle();
    expect(Object.keys(h.pending())).toHaveLength(131);

    await h.sync.syncNow();
    expect(h.calls[0]!.changes).toHaveLength(100);
    expect(Object.keys(h.pending())).toHaveLength(31);
    await h.sync.syncNow();
    expect(h.calls[1]!.changes).toHaveLength(31);
    expect(Object.keys(h.pending())).toHaveLength(0);
  });

  test('bounds a batch by encoded size', async () => {
    const h = await harness();
    const book = makeBook();
    await addBook(h, book);
    const context = 'x'.repeat(7 * 1024);
    for (let i = 0; i < 60; i++) {
      await h.highlights.create({
        bookId: book.id,
        sha256: book.sha256,
        origin: ORIGIN,
        locator: { href: 'a.xhtml', text: { before: context, highlight: 'hi', after: '' } },
        text: 'hi',
        color: 'green',
      });
    }
    await h.settle();
    await h.sync.syncNow();
    const bytes = new TextEncoder().encode(JSON.stringify(h.calls[0]!.changes)).length;
    expect(bytes).toBeLessThanOrEqual(240 * 1024);
    expect(h.calls[0]!.changes.length).toBeLessThan(61);
  });

  test('holds changes of a book whose upload is still pending', async () => {
    const h = await harness();
    const book = makeBook({ id: 'epub-' + 'a'.repeat(64) });
    const entry = await addBook(h, book);
    h.pendingUploads.add(entry.id);
    await h.settle();
    await h.sync.syncNow();
    expect(h.calls[0]!.changes).toHaveLength(0);
    expect(h.pending()['library:' + book.sha256]).toBeDefined();
  });
});

describe('highlights', () => {
  test('advances the pull cursor and does not echo pulled highlights', async () => {
    const book = makeBook();
    const h = await harness();
    await addBook(h, book);
    await h.settle();
    h.setHandler(() => ({
      ...emptyResponse(),
      highlights: {
        items: [
          {
            id: 'remote1',
            bookId: book.id,
            sha256: book.sha256,
            locator: { href: 'a.xhtml' },
            text: 'Call me Ishmael.',
            color: 'blue',
            note: null,
            createdAt: '2026-09-27T09:00:00.123456Z',
            updatedAt: '2026-09-27T09:00:00.123456Z',
            deleted: false,
          },
        ],
        cursor: 7,
        more: false,
      },
    }));
    await h.sync.syncNow();
    expect(h.highlights.forEdition(ORIGIN, book.sha256).map((x) => x.id)).toEqual(['remote1']);
    expect(h.sync.stored.origins[ORIGIN]!.highlightCursor).toBe(7);

    h.setHandler(() => emptyResponse());
    await h.settle();
    await h.sync.syncNow();
    expect(h.calls[1]!.highlightsSince).toBe(7);
    expect(h.calls[1]!.changes).toHaveLength(0);

    // A local edit afterwards is newer and is sent.
    await h.highlights.recolor('remote1', 'pink');
    await h.settle();
    await h.sync.syncNow();
    const sent = h.calls[2]!.changes.find((c) => c.kind === 'highlight')!;
    expect(sent.payload.highlightId).toBe('remote1');
    expect(sent.payload.color).toBe('pink');
    expect(Object.keys(sent.payload).sort()).toEqual(['color', 'createdAt', 'deleted', 'highlightId', 'locator', 'text']);
  });

  test('falls back without highlights when the server rejects them', async () => {
    const h = await harness();
    const book = makeBook();
    await addBook(h, book);
    await h.highlights.create({ bookId: book.id, sha256: book.sha256, origin: ORIGIN, locator: { href: 'a.xhtml' }, text: 't', color: 'yellow' });
    await h.settle();
    h.setHandler((call) => {
      if (call.highlightsSince !== undefined) throw new ApiError('Sync request is invalid.', 'INVALID_SYNC', 400);
      return emptyResponse();
    });
    await h.sync.syncNow();

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.highlightsSince).toBeUndefined();
    expect(h.calls[1]!.changes.map((c) => c.kind)).toEqual(['library']);
    expect(h.sync.getSnapshot().error).toBeNull();
    const pendingKinds = Object.values(h.pending()).map((c) => c.kind);
    expect(pendingKinds).toEqual(['highlight']);
    expect(h.sync.stored.origins[ORIGIN]!.highlightsUnsupportedUntil).toBeDefined();

    // Until the retry time, highlights are neither sent nor pulled.
    await h.sync.syncNow();
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]!.highlightsSince).toBeUndefined();
    expect(h.calls[2]!.changes).toHaveLength(0);
  });

  test('article highlights sync on their own sentinel edition and stay out of book editions', async () => {
    const h = await harness();
    const book = makeBook();
    await addBook(h, book);
    const articleId = 'c'.repeat(32);
    const locator = { type: 'article', href: 'https://example.org/post', articleId, block: 3, start: 4, endBlock: 3, end: 9, locations: { progression: 0.2, totalProgression: 0.2 } };
    // Created under another API origin: articles sync wherever the app points.
    const mine = await h.highlights.create({ bookId: `article-${articleId}`, sha256: '0'.repeat(64), origin: 'http://elsewhere.test', locator, text: 'quote', color: 'green' });
    await h.settle();
    h.setHandler(() => ({
      ...emptyResponse(),
      highlights: {
        items: [
          { id: 'remote-article', bookId: `article-${articleId}`, sha256: '0'.repeat(64), locator: { ...locator, block: 1 }, text: 'earlier', color: 'blue', note: 'n', createdAt: '2026-09-27T09:00:00.000Z', updatedAt: '2026-09-27T09:00:00.000Z', deleted: false },
        ],
        cursor: 3,
        more: false,
      },
    }));
    await h.sync.syncNow();
    const sent = h.calls[0]!.changes.find((c) => c.kind === 'highlight')!;
    expect(sent).toMatchObject({ bookId: `article-${articleId}`, sha256: '0'.repeat(64), payload: { highlightId: mine.id, locator, color: 'green' } });

    expect(h.highlights.forArticle(articleId).map((x) => x.id)).toEqual(['remote-article', mine.id]);
    expect(h.highlights.forEdition(ORIGIN, book.sha256)).toEqual([]);

    h.setHandler(() => emptyResponse());
    await h.settle();
    await h.sync.syncNow();
    expect(h.calls[1]!.changes).toHaveLength(0);
  });

  test('other errors keep the outbox and report the mobile wording', async () => {
    const h = await harness();
    await addBook(h, makeBook());
    await h.settle();
    h.setHandler(() => {
      throw new ApiError('Could not reach api.test.', 'NETWORK', null, true);
    });
    await h.sync.syncNow();
    expect(h.sync.getSnapshot().error).toBe('Could not reach api.test. Changes remain saved on this device.');
    expect(Object.keys(h.pending())).toHaveLength(1);
  });
});

describe('applying pulled state', () => {
  test('newer cloud progress wins, older is ignored, and neither is re-queued', async () => {
    const h = await harness();
    const book = makeBook();
    const entry = await addBook(h, book);
    await h.library.saveProgress(entry.id, locator(0.2), book.sha256);
    await h.settle();
    await h.sync.syncNow();

    const row = (progression: number, at: string) => ({
      bookId: book.id,
      sha256: book.sha256,
      inLibrary: true,
      addedAt: entry.addedAt,
      progress: { ...locator(progression), engine: 'readium', totalProgression: 0 },
      progressUpdatedAt: at,
      lastOpenedAt: at,
      readingMilliseconds: 5000,
    });
    h.setHandler(() => ({ ...emptyResponse(), books: [row(0.9, '2026-09-27T11:00:00.000001Z')] }));
    await h.sync.syncNow();
    expect(h.library.entry(entry.id)!.progress!.locator.progression).toBe(0.9);
    expect(h.library.entry(entry.id)!.progress!.locator.engine).toBe('readium');
    expect(h.sync.readingMillisecondsFor(h.library.entry(entry.id)!)).toBe(5000);

    h.setHandler(() => ({ ...emptyResponse(), books: [row(0.1, '2026-09-27T09:00:00.000Z')] }));
    await h.settle();
    await h.sync.syncNow();
    expect(h.library.entry(entry.id)!.progress!.locator.progression).toBe(0.9);
    await h.settle();
    expect(h.pending()['progress:' + book.sha256]).toBeUndefined();
  });

  test('an open reader does not jump to a pulled position', async () => {
    const h = await harness();
    const book = makeBook();
    const entry = await addBook(h, book);
    await h.settle();
    h.sync.beginReading(h.library.entry(entry.id)!);
    h.setHandler(() => ({
      ...emptyResponse(),
      books: [
        {
          bookId: book.id,
          sha256: book.sha256,
          inLibrary: true,
          addedAt: entry.addedAt,
          progress: locator(0.8),
          progressUpdatedAt: '2026-09-27T12:00:00.000Z',
          lastOpenedAt: null,
          readingMilliseconds: 0,
        },
      ],
    }));
    await h.sync.syncNow();
    expect(h.library.entry(entry.id)!.progress).toBeNull();
    h.sync.endReading();
  });

  test('adds cloud-only books as metadata without downloading them', async () => {
    const other = makeBook({ id: 'walden', sha256: 'b'.repeat(64) });
    const h = await harness({ books: { walden: other } });
    h.setHandler(() => ({
      ...emptyResponse(),
      books: [
        {
          bookId: 'walden',
          sha256: other.sha256,
          inLibrary: true,
          addedAt: '2026-09-01T00:00:00.000Z',
          progress: null,
          progressUpdatedAt: null,
          lastOpenedAt: null,
          readingMilliseconds: 0,
        },
      ],
    }));
    await h.sync.syncNow();
    const entry = h.library.entry(entryIdentity('walden', ORIGIN))!;
    expect(entry.download.status).toBe('none');
    expect(entry.addedAt).toBe('2026-09-01T00:00:00.000Z');
    await h.settle();
    expect(h.pending()['library:' + other.sha256]).toBeUndefined();
  });

  test('preferences resolve by last write wins', async () => {
    const h = await harness();
    await h.settings.updateReader((p) => ({ ...p, fontSize: 20 }));
    await h.settle();
    const localStamp = h.settings.readerUpdatedAt!;

    // Older cloud copy: ignored; local change stays queued until acknowledged.
    h.setHandler(() => ({
      ...emptyResponse(),
      preferences: { value: { ...defaultReaderPreferences, fontSize: 26 }, updatedAt: '2020-01-01T00:00:00.000Z' },
    }));
    await h.sync.syncNow();
    expect(h.settings.reader.fontSize).toBe(20);
    expect(h.settings.readerUpdatedAt).toBe(localStamp);

    // Newer cloud copy (with a future theme id): applied and not echoed.
    h.setHandler(() => ({
      ...emptyResponse(),
      preferences: {
        value: { ...defaultReaderPreferences, fontSize: 24, themeId: 'solarized-future', highlightColor: 'teal' },
        updatedAt: '2026-09-27T12:00:00.000123Z',
      },
    }));
    await h.sync.syncNow();
    expect(h.settings.reader.fontSize).toBe(24);
    expect(h.settings.reader.themeId).toBe('solarized-future');
    expect(h.settings.readerUpdatedAt).toBe('2026-09-27T12:00:00.000123Z');
    await h.settle();
    expect(h.pending().preferences).toBeUndefined();
  });
});

describe('reading time', () => {
  test('counts only visible time, checkpoints cumulatively and keeps acknowledged counters', async () => {
    const h = await harness();
    const book = makeBook();
    const entry = await addBook(h, book);
    await h.settle();
    await h.sync.syncNow();

    h.sync.beginReading(h.library.entry(entry.id)!);
    h.clock.advance(20_000);
    h.env.setVisible(false); // checkpoint at 20 s
    h.clock.advance(60_000); // hidden: not counted
    h.env.setVisible(true);
    h.clock.advance(10_000);
    h.sync.endReading(); // checkpoint at 30 s
    await h.settle();

    const sessions = Object.values(h.pending()).filter((c) => c.kind === 'session');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.payload).toEqual({ readingMilliseconds: 30_000 });
    expect(h.sync.getSnapshot().totalReadingMilliseconds).toBe(30_000);

    h.setHandler((call) => ({
      ...emptyResponse(),
      books: [
        {
          bookId: book.id,
          sha256: book.sha256,
          inLibrary: true,
          addedAt: entry.addedAt,
          progress: null,
          progressUpdatedAt: null,
          lastOpenedAt: null,
          readingMilliseconds: call.changes.some((c) => c.kind === 'session') ? 30_000 : 0,
        },
      ],
    }));
    await h.sync.syncNow();
    expect(Object.keys(h.pending())).toHaveLength(0);
    expect(h.sync.getSnapshot().totalReadingMilliseconds).toBe(30_000);
  });
});

describe('wire values', () => {
  test('drops preference values the API would reject', () => {
    const value = wirePreferences({ ...defaultReaderPreferences, themeId: 'web-only', fontFamilyId: 'Bad Id', highlightColor: 'yellow', lineHeight: 5 });
    expect(value.themeId).toBeUndefined();
    expect(value.fontFamilyId).toBeUndefined();
    expect(value.highlightColor).toBe('yellow');
    expect(value.lineHeight).toBe(2.2);
    expect(wirePreferences({ ...defaultReaderPreferences, themeId: 'nord' }).themeId).toBe('nord');
  });
});

describe('schedule', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('backoff doubles from the poll interval and caps at 15 minutes', () => {
    expect(cycleDelay(120_000, 0)).toBe(120_000);
    expect(cycleDelay(120_000, 1)).toBe(240_000);
    expect(cycleDelay(120_000, 2)).toBe(480_000);
    expect(cycleDelay(120_000, 3)).toBe(MAX_BACKOFF_MS);
    expect(cycleDelay(120_000, 40)).toBe(MAX_BACKOFF_MS);
  });

  test('edits never send a request of their own; they ride the next cycle', async () => {
    const h = await harness({ startTimers: true });
    await h.settle();
    expect(h.calls).toHaveLength(1); // start-up pull
    const book = makeBook();
    const entry = await addBook(h, book);
    for (let i = 1; i <= 5; i++) await h.library.saveProgress(entry.id, locator(i / 10), book.sha256);
    await h.settings.updateReader((p) => ({ ...p, fontSize: 20 }));
    await h.highlights.create({ bookId: book.id, sha256: book.sha256, origin: ORIGIN, locator: { href: 'a' }, text: 't', color: 'blue' });
    await h.settle();
    expect(h.calls).toHaveLength(1);
    // Coalesced: one progress change however many saves.
    expect(Object.keys(h.pending()).filter((k) => k.startsWith('progress:'))).toHaveLength(1);
    h.sync.dispose();
  });

  test('polls only while visible and syncs on return after the resume gap', async () => {
    const h = await harness({ startTimers: true, pollInterval: 30 });
    await h.settle();
    expect(h.calls).toHaveLength(1);
    await wait(80);
    const whileVisible = h.calls.length;
    expect(whileVisible).toBeGreaterThanOrEqual(2);

    h.env.setVisible(false);
    await h.settle();
    const hidden = h.calls.length;
    await wait(100);
    expect(h.calls.length).toBe(hidden);

    // Back within a minute of the last attempt: no extra request at once.
    h.env.setVisible(true);
    await h.settle();
    expect(h.calls.length).toBe(hidden);

    h.env.setVisible(false);
    await h.settle();
    h.clock.advance(61_000);
    const before = h.calls.length;
    h.env.setVisible(true);
    await h.settle();
    expect(h.calls.length).toBe(before + 1);
    h.sync.dispose();
  });

  test('hiding the tab flushes queued changes unless a sync just ran', async () => {
    const h = await harness();
    const book = makeBook();
    await addBook(h, book);
    await h.settle();
    h.sync['autoSync'] = true; // as after load with timers, without the start-up pull
    h.env.setVisible(false);
    await h.settle();
    expect(h.calls).toHaveLength(1);
    expect(Object.keys(h.pending())).toHaveLength(0);

    await h.settings.updateReader((p) => ({ ...p, fontSize: 24 }));
    h.env.setVisible(true);
    h.env.setVisible(false);
    await h.settle();
    expect(h.calls).toHaveLength(1); // within the 15 s flush gap
    h.sync.dispose();
  });
});

describe('snapshots', () => {
  test('emit only when a visible value changes', async () => {
    const h = await harness();
    await h.settle();
    let emits = 0;
    h.sync.subscribe(() => emits++);
    await h.sync.syncNow();
    const afterFirst = emits;
    expect(afterFirst).toBeGreaterThan(0);
    const snapshot = h.sync.getSnapshot();
    h.clock.advance(0);
    await h.sync.syncNow(); // same lastSyncedAt stamp, nothing pending
    expect(h.sync.getSnapshot().lastSyncedAt).toBe(snapshot.lastSyncedAt);
    // isSyncing toggled on and off, and nothing else changed.
    expect(emits - afterFirst).toBe(2);
    await h.library.markOpened('none', 'x').catch(() => undefined);
    await h.settle();
    expect(emits - afterFirst).toBe(2);
  });

  test('switching the API origin shows that origin\'s status', async () => {
    const h = await harness();
    const book = makeBook();
    await addBook(h, book);
    await h.settle();
    expect(h.sync.getSnapshot().pendingCount).toBe(1);
    await h.settings.setApiBaseUrl('http://other.test');
    await h.settle();
    expect(h.sync.getSnapshot().pendingCount).toBe(0);
    await h.settings.setApiBaseUrl(ORIGIN);
    await h.settle();
    expect(h.sync.getSnapshot().pendingCount).toBe(1);
  });
});

describe('reading idle handling', () => {
  const sessionMs = (h: Awaited<ReturnType<typeof harness>>) =>
    Object.values(h.pending())
      .filter((c) => c.kind === 'session')
      .reduce((n, c) => n + Number(c.payload.readingMilliseconds), 0);

  test('stops counting after the idle limit and resumes on activity', async () => {
    const h = await harness();
    const book = makeBook();
    const entry = await addBook(h, book);
    await h.settle();
    h.sync.beginReading(h.library.entry(entry.id)!);
    h.clock.advance(READING_IDLE_MS + 30 * 60_000); // walked away
    expect(h.sync.currentReadingMilliseconds).toBe(READING_IDLE_MS);
    h.sync.noteReadingActivity(); // came back: the gap does not count
    h.clock.advance(60_000);
    h.sync.endReading();
    await h.settle();
    expect(sessionMs(h)).toBe(READING_IDLE_MS + 60_000);
  });

  test('saved progress counts as activity', async () => {
    const h = await harness();
    const book = makeBook();
    const entry = await addBook(h, book);
    await h.settle();
    h.sync.beginReading(h.library.entry(entry.id)!);
    h.clock.advance(READING_IDLE_MS - 1000);
    await h.library.saveProgress(entry.id, locator(0.3), book.sha256);
    await h.settle();
    h.clock.advance(READING_IDLE_MS - 1000);
    h.sync.endReading();
    await h.settle();
    expect(sessionMs(h)).toBe(2 * (READING_IDLE_MS - 1000));
  });

  test('setReadingActive pauses the clock without ending the session', async () => {
    const h = await harness();
    const book = makeBook();
    const entry = await addBook(h, book);
    await h.settle();
    h.sync.beginReading(h.library.entry(entry.id)!);
    h.clock.advance(5_000);
    h.sync.setReadingActive(false);
    h.clock.advance(60_000);
    h.env.setVisible(false);
    h.env.setVisible(true); // visibility alone does not resume a paused reader
    h.clock.advance(60_000);
    h.sync.setReadingActive(true);
    h.clock.advance(5_000);
    h.sync.endReading();
    await h.settle();
    const sessions = Object.values(h.pending()).filter((c) => c.kind === 'session');
    expect(sessions).toHaveLength(1);
    expect(sessionMs(h)).toBe(10_000);
  });
});
