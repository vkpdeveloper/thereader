import { describe, expect, test } from 'bun:test';
import { dashArray, nearStroke, strokePath, thin } from './inkPaths';

describe('ink paths', () => {
  test('paths: a dot, a line and a smoothed curve', () => {
    expect(strokePath([5, 5])).toBe('M5 5l0.01 0');
    expect(strokePath([0, 0, 10, 10])).toBe('M0 0L10 10');
    expect(strokePath([0, 0, 10, 0, 20, 10, 30, 10])).toBe('M0 0Q10 0 15 5Q20 10 25 10L30 10');
  });

  test('thinning keeps the ends and drops samples too close together', () => {
    expect(thin([0, 0, 0.5, 0, 1, 0, 3, 0, 3.2, 0, 6, 0])).toEqual([0, 0, 3, 0, 6, 0]);
  });

  test('the eraser finds lines it passes near', () => {
    const line = [0, 0, 100, 0];
    expect(nearStroke(line, 50, 6, 8)).toBe(true);
    expect(nearStroke(line, 50, 12, 8)).toBe(false);
    expect(nearStroke(line, 106, 0, 8)).toBe(true);
    expect(nearStroke([10, 10], 14, 13, 8)).toBe(true);
  });

  test('pen styles', () => {
    expect(dashArray('pen', 2)).toBeUndefined();
    expect(dashArray('marker', 2)).toBeUndefined();
    expect(dashArray('dotted', 2)).toBe('0 4.8');
    expect(dashArray('dashed', 2)).toBe('6.4 5.2');
  });
});
