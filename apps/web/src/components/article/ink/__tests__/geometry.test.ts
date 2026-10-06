import { describe, expect, test } from 'bun:test';
import { keepInside, marginOf, pickAnchor, placeStroke, toAnchor } from '../geometry';

const box = (top: number, height: number, left = 100, width = 600) => ({ left, top, width, height });

describe('ink geometry', () => {
  test('a stroke stored against its block comes back at the same place', () => {
    const drawnOn = box(400, 120);
    const surface = [150, 470, 300, 480, 460, 470];
    const stroke = {
      anchor: { block: 3, width: drawnOn.width, height: drawnOn.height },
      points: toAnchor(surface, drawnOn),
    };
    expect(placeStroke(stroke, drawnOn)).toEqual(surface);
    // Blocks above grew by 250px: the stroke moves down with its block.
    expect(placeStroke(stroke, box(650, 120))).toEqual([150, 720, 300, 730, 460, 720]);
    // The block reflowed to half the width and twice the height: the stroke stretches with it.
    expect(placeStroke(stroke, { left: 100, top: 400, width: 300, height: 240 })).toEqual([125, 540, 200, 560, 280, 540]);
  });

  test('the anchor is the block under the middle of the stroke, else the nearest', () => {
    const boxes = [
      { key: -1, box: box(0, 200) },
      { key: 0, box: box(240, 100) },
      { key: 1, box: box(360, 300) },
    ];
    expect(pickAnchor(boxes, 100)!.key).toBe(-1);
    expect(pickAnchor(boxes, 500)!.key).toBe(1);
    // In the gap between two blocks, the closer one.
    expect(pickAnchor(boxes, 345)!.key).toBe(0);
    expect(pickAnchor(boxes, 355)!.key).toBe(1);
    expect(pickAnchor(boxes, 215)!.key).toBe(-1);
    // Below the last block.
    expect(pickAnchor(boxes, 2000)!.key).toBe(1);
    expect(pickAnchor([], 10)).toBeNull();
  });

  test('strokes past the page edge slide back inside', () => {
    const one = (points: number[]) => keepInside([{ group: null, points }], 400)[0];
    expect(one([10, 0, 50, 5])).toEqual([10, 0, 50, 5]);
    expect(one([380, 0, 420, 5])).toEqual([356, 0, 396, 5]);
    expect(one([-20, 0, 30, 5])).toEqual([4, 0, 54, 5]);
    // Wider than the page: the start stays in view.
    expect(one([-10, 0, 500, 5])).toEqual([4, 0, 514, 5]);
  });

  test('a margin note slides as one, keeping its letters apart', () => {
    const [a, b, c] = keepInside(
      [
        { group: '3:right', points: [380, 0, 390, 10] },
        { group: '3:right', points: [400, 0, 420, 10] },
        { group: null, points: [100, 0, 200, 0] },
      ],
      400,
    );
    expect(a).toEqual([356, 0, 366, 10]);
    expect(b).toEqual([376, 0, 396, 10]);
    expect(c).toEqual([100, 0, 200, 0]);
  });

  test('margins: wholly beside the block, or not in one', () => {
    const block = { left: 100, top: 0, width: 300, height: 50 };
    expect(marginOf([410, 0, 450, 10], block)).toBe('right');
    expect(marginOf([20, 0, 90, 10], block)).toBe('left');
    expect(marginOf([350, 0, 450, 10], block)).toBeNull();
  });
});
