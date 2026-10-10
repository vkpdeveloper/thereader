import { describe, expect, test } from 'bun:test';
import type { ReadingLocator } from '../../lib/types';
import { sniffImageSize } from './imageSize';
import { comicKeyAction } from './keys';
import { comicLocator, pageForLocator } from './locator';
import { dragProgress, easeInOut, releaseTarget, turnShading } from './turn';

const pages = ['Comic/Cover.webp', 'Comic/extras/001.jpg', 'Comic/page2.JPG', 'Comic/page02b.png', 'Comic/page10.jpg'];

describe('comic locator', () => {
  test('matches the contract example', () => {
    expect(comicLocator(pages, 4)).toEqual({
      href: 'Comic/page10.jpg',
      progression: 0,
      totalProgression: 1,
      title: 'Page 5 of 5',
      engine: 'comic',
      raw: { page: 4, pages: 5 },
    });
    expect(comicLocator(pages, 3).totalProgression).toBe(0.75);
    expect(comicLocator(['only.png'], 0).totalProgression).toBe(1);
    expect(comicLocator(pages, 99).raw).toEqual({ page: 4, pages: 5 });
  });

  test('restores by href first, then raw.page', () => {
    const at = (href: string, page: unknown): ReadingLocator => ({ href, progression: 0, totalProgression: null, title: null, engine: 'comic', raw: { page } });
    expect(pageForLocator(pages, comicLocator(pages, 2))).toBe(2);
    // The href wins when the index disagrees (the archive gained a page elsewhere).
    expect(pageForLocator(pages, at('Comic/page02b.png', 0))).toBe(3);
    expect(pageForLocator(pages, at('Comic/missing.jpg', 1))).toBe(1);
    expect(pageForLocator(pages, at('', 42))).toBe(4);
    expect(pageForLocator(pages, at('', 'x'))).toBe(0);
    expect(pageForLocator(pages, null)).toBe(0);
  });

  test('round-trips every page', () => {
    for (let page = 0; page < pages.length; page++) expect(pageForLocator(pages, comicLocator(pages, page))).toBe(page);
  });
});

describe('comic keys', () => {
  test('turning keys', () => {
    for (const key of ['ArrowRight', 'PageDown', ' ']) expect(comicKeyAction({ key })).toBe('next');
    for (const key of ['ArrowLeft', 'PageUp']) expect(comicKeyAction({ key })).toBe('previous');
    expect(comicKeyAction({ key: ' ', shiftKey: true })).toBe('previous');
    expect(comicKeyAction({ key: 'Home' })).toBe('first');
    expect(comicKeyAction({ key: 'End' })).toBe('last');
    expect(comicKeyAction({ key: 'Escape' })).toBe('close');
  });

  test('no book tools and no modified keys', () => {
    for (const key of ['t', 'h', '/', 'a', 'd', 'e', 'p', '[', ']', '?']) expect(comicKeyAction({ key })).toBeNull();
    expect(comicKeyAction({ key: 'ArrowRight', metaKey: true })).toBeNull();
    expect(comicKeyAction({ key: 'f', ctrlKey: true })).toBeNull();
    expect(comicKeyAction({ key: 'Escape', metaKey: true })).toBe('close');
  });

  test('zoom keys, leaving the browser its own ⌘/Ctrl zoom', () => {
    for (const key of ['+', '=']) expect(comicKeyAction({ key })).toBe('zoomIn');
    expect(comicKeyAction({ key: '+', shiftKey: true })).toBe('zoomIn');
    for (const key of ['-', '_']) expect(comicKeyAction({ key })).toBe('zoomOut');
    expect(comicKeyAction({ key: '0' })).toBe('zoomReset');
    for (const key of ['+', '=', '-', '0']) {
      expect(comicKeyAction({ key, metaKey: true })).toBeNull();
      expect(comicKeyAction({ key, ctrlKey: true })).toBeNull();
    }
  });
});

describe('page turn', () => {
  test('angle and shading across a turn', () => {
    expect(turnShading(0)).toMatchObject({ angle: -0, front: 0, cast: 0, edge: 1 });
    const mid = turnShading(0.5);
    expect(mid.angle).toBe(-90);
    expect(mid.cast).toBeCloseTo(0.6);
    expect(mid.edge).toBeCloseTo(0);
    expect(turnShading(1)).toMatchObject({ angle: -180, back: 0 });
    expect(turnShading(1).cast).toBeCloseTo(0);
    expect(turnShading(1, 90).angle).toBe(-90);
    expect(turnShading(1, 90).edge).toBeCloseTo(0);
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5);
  });

  test('the free edge follows the finger', () => {
    // A spread leaf 600 px wide: dragging 600 px left stands it upright.
    expect(dragProgress(0, -600, 600)).toBeCloseTo(0.5);
    expect(dragProgress(0, -1200, 600)).toBeCloseTo(1);
    expect(dragProgress(0, 300, 600)).toBe(0);
    // Turning back starts flat on the left.
    expect(dragProgress(1, 600, 600)).toBeCloseTo(0.5);
    // A single page turns (90°) within its own width.
    expect(dragProgress(0, -390, 390, 90)).toBeCloseTo(1);
    expect(dragProgress(1, 195, 390, 90)).toBeCloseTo(2 / 3);
  });

  test('release completes, flicks win, short drags snap back', () => {
    expect(releaseTarget(0, 0.6, 0)).toBe(1);
    expect(releaseTarget(0, 0.1, 0)).toBe(0);
    expect(releaseTarget(0, 0.1, -0.8)).toBe(1);
    expect(releaseTarget(0, 0.7, 0.8)).toBe(0);
    expect(releaseTarget(1, 0.4, 0)).toBe(0);
    expect(releaseTarget(1, 0.9, 0)).toBe(1);
    expect(releaseTarget(1, 0.9, 0.6)).toBe(0);
  });
});

describe('image size sniffing', () => {
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const pad = (bytes: number[]) => new Uint8Array([...bytes, ...new Array(64).fill(0)]);

  test('PNG', () => {
    const png = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(1988), ...be32(3056)]);
    expect(sniffImageSize(png)).toEqual({ width: 1988, height: 3056 });
  });

  test('JPEG past an APP segment', () => {
    const jpeg = pad([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x06, 1, 2, 3, 4, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xe8, 0x0f, 0xa0]);
    expect(sniffImageSize(jpeg)).toEqual({ width: 4000, height: 3048 });
  });

  test('GIF and WebP', () => {
    expect(sniffImageSize(pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02]))).toEqual({ width: 800, height: 600 });
    const riff = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
    const vp8x = pad([...riff, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0, 0x1f, 0x03, 0x00, 0xdf, 0x04, 0x00]);
    expect(sniffImageSize(vp8x)).toEqual({ width: 800, height: 1248 });
    const vp8 = pad([...riff, 0x56, 0x50, 0x38, 0x20, 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x20, 0x03, 0x58, 0x02]);
    expect(sniffImageSize(vp8)).toEqual({ width: 800, height: 600 });
  });

  test('unknown or truncated', () => {
    expect(sniffImageSize(new Uint8Array(10))).toBeNull();
    expect(sniffImageSize(pad([0x00, 0x01]))).toBeNull();
  });
});
