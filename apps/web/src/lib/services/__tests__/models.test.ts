import { describe, expect, test } from 'bun:test';
import { errorFrom } from '../api';
import { validCoverBytes } from '../coverValidation';
import { sha256Hex } from '../hash';
import { HighlightStoreImpl } from '../highlights';
import { MemoryKv } from '../kv';
import { isoOrder, normalizeOrigin, parseReaderPreferences } from '../models';
import { Clock } from './helpers';

describe('models', () => {
  test('sha256 matches the standard vectors', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  });

  test('origins normalize like mobile', () => {
    expect(normalizeOrigin(' reader.ordinity.com/ ')).toBe('http://reader.ordinity.com');
    expect(normalizeOrigin('https://reader.ordinity.com///')).toBe('https://reader.ordinity.com');
    expect(() => normalizeOrigin('')).toThrow('API URL is empty.');
    expect(() => normalizeOrigin('ftp://x')).toThrow('API URL must be an http(s) origin.');
  });

  test('reader preferences are forward compatible and clamped', () => {
    const p = parseReaderPreferences({ fontSize: 99, lineHeight: 1.85, font: 'mono', flow: 'paginated', themeId: 'future', marginScale: 'x', unknownField: 1 });
    expect(p.fontSize).toBe(28);
    expect(p.lineHeight).toBe(1.85);
    expect(p.font).toBe('serif');
    expect(p.flow).toBe('paginated');
    expect(p.themeId).toBe('future');
    expect(p.marginScale).toBe(1);
    expect('unknownField' in p).toBe(false);
  });

  test('timestamps order with microsecond precision', () => {
    expect(isoOrder('2026-09-27T10:00:00.123456Z')).toBeGreaterThan(isoOrder('2026-09-27T10:00:00.123Z'));
    expect(isoOrder('2026-09-27T10:00:00.123000Z')).toBe(isoOrder('2026-09-27T10:00:00.123Z'));
  });

  test('API error JSON is parsed', () => {
    const e = errorFrom(400, JSON.stringify({ error: { code: 'INVALID_SYNC', message: 'Sync request is invalid.' } }));
    expect(e.code).toBe('INVALID_SYNC');
    expect(e.status).toBe(400);
    expect(e.message).toBe('Sync request is invalid.');
    expect(errorFrom(502, '<html>').message).toBe('Request failed with HTTP 502.');
  });

  test('cover validation accepts rasters and rejects active SVG', () => {
    expect(validCoverBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(validCoverBytes(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]))).toBe(true);
    expect(validCoverBytes(new TextEncoder().encode('<html></html>'))).toBe(false);
    expect(validCoverBytes(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#g)"/></svg>'))).toBe(true);
    expect(validCoverBytes(new TextEncoder().encode('<svg><script>alert(1)</script></svg>'))).toBe(false);
    expect(validCoverBytes(new TextEncoder().encode('<svg><image href="https://evil.test/x.png"/></svg>'))).toBe(false);
    expect(validCoverBytes(new TextEncoder().encode('<svg onload="x()"></svg>'))).toBe(false);
  });
});

describe('highlight store', () => {
  test('stamps move forward, deletes are tombstones, reading order sorts', async () => {
    const clock = new Clock();
    const store = new HighlightStoreImpl(new MemoryKv(), undefined, clock.now);
    await store.load();
    const base = { bookId: 'b', sha256: 's', origin: 'o', text: 't', color: 'yellow' };
    const late = await store.create({ ...base, locator: { href: 'a', locations: { totalProgression: 0.9 } } });
    const early = await store.create({ ...base, locator: { href: 'a', locations: { totalProgression: 0.1 } } });
    expect(store.forEdition('o', 's').map((h) => h.id)).toEqual([early.id, late.id]);

    clock.advance(-60_000); // clock moved back
    await store.recolor(late.id, 'blue');
    expect(isoOrder(store.byId(late.id)!.updatedAt)).toBeGreaterThan(isoOrder(late.updatedAt));
    await store.delete(late.id);
    expect(store.byId(late.id)!.deleted).toBe(true);
    expect(store.forEdition('o', 's').map((h) => h.id)).toEqual([early.id]);

    // Older remote copies never replace newer local edits.
    await store.applyRemote([{ ...late, deleted: false, updatedAt: late.updatedAt }]);
    expect(store.byId(late.id)!.deleted).toBe(true);
  });
});
