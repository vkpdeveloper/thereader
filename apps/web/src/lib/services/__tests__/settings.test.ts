import { describe, expect, test } from 'bun:test';
import { MemoryKv } from '../kv';
import { isoOrder } from '../models';
import { SettingsStoreImpl } from '../settings';
import type { TabBus, Topic } from '../tabs';
import { Clock } from './helpers';

/** Two tabs' buses: a post on one reaches the other's listeners. */
function linkedBuses(): [TabBus, TabBus] {
  const handlers: Array<Set<(t: Topic) => void>> = [new Set(), new Set()];
  const bus = (self: number): TabBus => ({
    post: (topic) => {
      for (const h of handlers[1 - self]!) h(topic);
    },
    listen: (h) => {
      handlers[self]!.add(h);
      return () => handlers[self]!.delete(h);
    },
  });
  return [bus(0), bus(1)];
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe('settings store', () => {
  test('defaults, persistence and clamping', async () => {
    const kv = new MemoryKv();
    const clock = new Clock();
    const a = new SettingsStoreImpl(kv, 'http://api.test', undefined, clock.now);
    await a.load();
    expect(a.getSnapshot().reader).toEqual({ fontSize: 18, lineHeight: 1.6, font: 'serif', flow: 'scrolled', marginScale: 1, justify: false, keepAwake: true });
    expect(a.readerUpdatedAt).toBeNull();
    await a.updateReader((p) => ({ ...p, fontSize: 40, lineHeight: 9, marginScale: 0 }));
    expect(a.reader.fontSize).toBe(28);
    expect(a.reader.lineHeight).toBe(2.2);
    expect(a.reader.marginScale).toBe(0.5);
    await a.setFontFamily('inter');
    expect(a.reader.font).toBe('sans');
    expect(a.reader.fontFamilyId).toBe('inter');
    await a.setThemeId('nord');
    await a.setApiBaseUrl('  http://other.test/  ');
    await a.flush();

    const b = new SettingsStoreImpl(kv, 'http://api.test');
    await b.load();
    expect(b.reader).toEqual(a.reader);
    expect(b.readerUpdatedAt).toBe(a.readerUpdatedAt);
    expect(b.settings.apiBaseUrl).toBe('http://other.test/');
    expect(b.currentOrigin()).toBe('http://other.test');

    await b.setApiBaseUrl('not a url ::');
    expect(b.currentOrigin()).toBe('http://invalid.invalid');
    await b.setApiBaseUrl('   ');
    expect(b.settings.apiBaseUrl).toBe('http://api.test');
  });

  test('an edit that changes nothing is not stamped and does not notify', async () => {
    const clock = new Clock();
    const s = new SettingsStoreImpl(new MemoryKv(), 'http://api.test', undefined, clock.now);
    await s.load();
    await s.updateReader((p) => ({ ...p, justify: true }));
    const stamp = s.readerUpdatedAt;
    let emits = 0;
    s.subscribe(() => emits++);
    clock.advance(1000);
    await s.updateReader((p) => ({ ...p }));
    await s.setApiBaseUrl('http://api.test');
    expect(emits).toBe(0);
    expect(s.readerUpdatedAt).toBe(stamp);
  });

  test('stamps move forward past a pulled copy even when the clock is behind', async () => {
    const clock = new Clock();
    const s = new SettingsStoreImpl(new MemoryKv(), 'http://api.test', undefined, clock.now);
    await s.load();
    const future = new Date(clock.ms + 60_000).toISOString();
    await s.applyCloudReader({ ...s.reader, fontSize: 24 }, future);
    expect(s.reader.fontSize).toBe(24);
    await s.updateReader((p) => ({ ...p, fontSize: 20 }));
    expect(isoOrder(s.readerUpdatedAt)).toBeGreaterThan(isoOrder(future));
    // An older cloud copy never replaces the local edit.
    await s.applyCloudReader({ ...s.reader, fontSize: 16 }, future);
    expect(s.reader.fontSize).toBe(20);
  });

  test('another tab\'s change is adopted, and nothing is emitted when it changed nothing', async () => {
    const kv = new MemoryKv();
    const [busA, busB] = linkedBuses();
    const clock = new Clock();
    const a = new SettingsStoreImpl(kv, 'http://api.test', busA, clock.now);
    const b = new SettingsStoreImpl(kv, 'http://api.test', busB, clock.now);
    await a.load();
    await b.load();
    let emits = 0;
    b.subscribe(() => emits++);

    clock.advance(1000);
    await a.updateReader((p) => ({ ...p, flow: 'paginated' }));
    await settle();
    expect(b.reader.flow).toBe('paginated');
    expect(emits).toBe(1);

    busA.post('settings'); // nothing new
    await settle();
    expect(emits).toBe(1);

    await a.setApiBaseUrl('http://other.test');
    await settle();
    expect(b.currentOrigin()).toBe('http://other.test');
    expect(emits).toBe(2);
  });
});
