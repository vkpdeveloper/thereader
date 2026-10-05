import { describe, expect, test } from 'bun:test';
import { resolveFontStack } from '../reader/epub/styles';
import { libron, ReaderFonts, systemSans, systemSerif } from './fonts';
import { FONT_FAMILY_CLASSES } from './services/models';
import { defaultReaderPreferences } from './types';

describe('reader fonts', () => {
  test('Libron is the default serif for the reader and the book frame', () => {
    expect(ReaderFonts.resolve(defaultReaderPreferences)).toBe(libron);
    expect(resolveFontStack(defaultReaderPreferences).startsWith('"Libron", ')).toBe(true);
    expect(ReaderFonts.resolve({ font: 'serif', fontFamilyId: 'future-serif' })).toBe(libron);
    expect(ReaderFonts.resolve({ font: 'sans' })).toBe(systemSans);
    expect(ReaderFonts.all.filter((f) => f.recommended)).toEqual([libron]);
  });

  test('an explicit system serif choice is kept', () => {
    const prefs = ReaderFonts.select(defaultReaderPreferences, systemSerif);
    expect(ReaderFonts.resolve(prefs)).toBe(systemSerif);
    expect(resolveFontStack(prefs)).not.toContain('Libron');
  });

  test('every family is known to settings', () => {
    for (const f of ReaderFonts.all) expect(FONT_FAMILY_CLASSES[f.id]).toBe(f.fontClass);
  });
});
