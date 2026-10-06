import { expect, test } from 'bun:test';
import { TopIntent } from '../topIntent';

const viewport = 800;
const max = 20_000;
const frame = 16;

/** Scrolls from the intent's last position to `to` at `speed` px/ms, one sample per frame; returns visibility after each. */
function scroll(intent: TopIntent, clock: { y: number; t: number }, to: number, speed: number, keyboard = false): boolean[] {
  const seen: boolean[] = [];
  const step = Math.sign(to - clock.y) * speed * frame;
  while (clock.y !== to) {
    clock.t += frame;
    clock.y = step > 0 ? Math.min(to, clock.y + step) : Math.max(to, clock.y + step);
    seen.push(intent.update({ y: clock.y, t: clock.t, viewport, max, keyboard }));
  }
  return seen;
}

function deepIn(y = 6000) {
  const clock = { y: 0, t: 1000 };
  const intent = new TopIntent(0);
  scroll(intent, clock, y, 0.8);
  return { intent, clock };
}

test('reading down never shows it', () => {
  const clock = { y: 0, t: 1000 };
  const intent = new TopIntent(0);
  expect(scroll(intent, clock, 15_000, 0.5).some(Boolean)).toBe(false);
  expect(scroll(intent, clock, 18_000, 4).some(Boolean)).toBe(false);
});

test('small corrective scroll-ups while reading never show it', () => {
  const { intent, clock } = deepIn();
  for (let i = 0; i < 10; i++) {
    expect(scroll(intent, clock, clock.y - 4, 0.25).some(Boolean)).toBe(false); // jitter
    expect(scroll(intent, clock, clock.y - 180, 0.6).some(Boolean)).toBe(false); // back a few lines
    expect(scroll(intent, clock, clock.y + 700, 0.6).some(Boolean)).toBe(false);
  }
});

test('re-reading half a screen slowly does not show it', () => {
  const { intent, clock } = deepIn();
  expect(scroll(intent, clock, clock.y - viewport * 0.6, 0.5).some(Boolean)).toBe(false);
});

test('a long upward run far down shows it', () => {
  const { intent, clock } = deepIn();
  const seen = scroll(intent, clock, clock.y - viewport * 1.4, 0.7);
  expect(seen.slice(-1)[0]).toBe(true);
  // Not before the run is long enough.
  expect(seen.slice(0, Math.floor(seen.length / 2)).some(Boolean)).toBe(false);
});

test('a fast fling up shows it sooner', () => {
  const { intent, clock } = deepIn();
  expect(scroll(intent, clock, clock.y - viewport * 0.5, 3).slice(-1)[0]).toBe(true);
});

test('a keyboard page-up is reading, not a fling', () => {
  const { intent, clock } = deepIn();
  expect(scroll(intent, clock, clock.y - viewport * 0.875, 4, true).some(Boolean)).toBe(false);
  // Paging back further still counts as heading back.
  expect(scroll(intent, clock, clock.y - viewport * 0.875, 4, true).slice(-1)[0]).toBe(true);
});

test('a one-frame jump up does not count as a run', () => {
  const { intent, clock } = deepIn();
  clock.t += frame;
  clock.y -= viewport * 2;
  expect(intent.update({ y: clock.y, t: clock.t, viewport, max })).toBe(false);
});

test('pausing at the deepest point does not slow the fling down', () => {
  const { intent, clock } = deepIn();
  clock.t += 10_000;
  expect(scroll(intent, clock, clock.y - viewport * 0.5, 3).slice(-1)[0]).toBe(true);
});

test('not shown near the top, even on a fast upward run', () => {
  const clock = { y: 0, t: 1000 };
  const intent = new TopIntent(0);
  scroll(intent, clock, viewport * 1.2, 1);
  expect(scroll(intent, clock, viewport * 0.4, 4).some(Boolean)).toBe(false);
});

test('hides when reading resumes downward, but not on trackpad noise', () => {
  const { intent, clock } = deepIn();
  scroll(intent, clock, clock.y - viewport * 1.5, 1);
  expect(intent.visible).toBe(true);
  expect(scroll(intent, clock, clock.y + 5, 0.3).slice(-1)[0]).toBe(true);
  expect(scroll(intent, clock, clock.y + 40, 0.5).slice(-1)[0]).toBe(false);
});

test('hides as the run nears the top', () => {
  const { intent, clock } = deepIn(3000);
  const seen = scroll(intent, clock, 200, 2);
  expect(seen.some(Boolean)).toBe(true);
  expect(seen.slice(-1)[0]).toBe(false);
});

test('hides after resting, unless held', () => {
  const { intent, clock } = deepIn();
  scroll(intent, clock, clock.y - viewport * 1.5, 1);
  expect(intent.settle(clock.t + 500)).toBe(true);
  expect(intent.settle(clock.t + intent.idleMs, true)).toBe(true);
  expect(intent.settle(clock.t + intent.idleMs)).toBe(false);
});

test('shows at the end of a long article and stays there at rest', () => {
  const clock = { y: 0, t: 1000 };
  const intent = new TopIntent(0);
  const end = 5000;
  const seen: boolean[] = [];
  while (clock.y < end) {
    clock.t += frame;
    clock.y = Math.min(end, clock.y + 12);
    seen.push(intent.update({ y: clock.y, t: clock.t, viewport, max: end }));
  }
  expect(seen.slice(0, -2).some(Boolean)).toBe(false);
  expect(seen.slice(-1)[0]).toBe(true);
  expect(intent.settle(clock.t + 60_000)).toBe(true);
});

test('never at the end of a short article', () => {
  const intent = new TopIntent(0);
  expect(intent.update({ y: 900, t: 1000, viewport, max: 900 })).toBe(false);
});

test('rest forgets the run, e.g. after a programmatic jump', () => {
  const { intent, clock } = deepIn();
  scroll(intent, clock, clock.y - viewport * 0.4, 0.5);
  intent.rest(clock.y, clock.t);
  // Continuing up now starts a fresh run.
  expect(scroll(intent, clock, clock.y - viewport * 0.9, 0.5).some(Boolean)).toBe(false);
});
