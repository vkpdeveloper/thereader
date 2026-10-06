/**
 * When the article reader's "back to top" control may show. Reading is mostly
 * scrolling down with small scroll-ups to re-read a line, so the control stays
 * out of the way until the reader clearly heads back: a long or fast upward
 * run well down the page, or reaching the end. It hides again on the way
 * down, near the top and after a short rest. Pure, so it is tested without a
 * DOM; the component feeds it one sample per animation frame.
 */

export interface ScrollSample {
  /** `window.scrollY`. */
  y: number;
  /** Timestamp in ms (`performance.now()`). */
  t: number;
  /** Viewport height. */
  viewport: number;
  /** Largest `scrollY` the page allows. */
  max: number;
  /** A scroll key (PgUp, ↑, ⇧ Space) moved the page just now. */
  keyboard?: boolean;
}

/** Depths and distances in viewports, speeds in px/ms. */
export const topIntentDefaults = {
  /** Deeper than this before an upward run can reveal the control. */
  showDepth: 1.5,
  /** Closer to the top than this, it hides (the top is a flick away). */
  hideDepth: 0.75,
  /** An upward run this long always reveals it. */
  travel: 1.25,
  /** A shorter run reveals it when fast: a fling, not a re-read. */
  flick: 0.45,
  flickSpeed: 1.6,
  /** Upward frames a run needs, so a one-frame jump (scroll anchoring, a missed programmatic scroll) never counts. */
  minSteps: 3,
  /** Pixels of opposite movement ignored, so trackpad noise neither breaks a run nor hides the control. */
  jitter: 8,
  /** Within this many px of the end counts as the end. */
  endSlack: 8,
  /** Shown by an upward run, it hides after this long at rest. */
  idleMs: 2200,
};

export type TopIntentOptions = typeof topIntentDefaults;

export class TopIntent {
  private readonly o: TopIntentOptions;
  private dir: 'down' | 'up' = 'down';
  /** Deepest point of the current downward run, or where the current upward run started. */
  private peak = 0;
  /** Highest point of the current upward run. */
  private low = 0;
  /** When the current upward run started moving. */
  private upT = 0;
  private steps = 0;
  private keyboardRun = false;
  private lastT = 0;
  private wanted = false;
  private end = false;
  private movedT = 0;

  constructor(y = 0, options: Partial<TopIntentOptions> = {}) {
    this.o = { ...topIntentDefaults, ...options };
    this.peak = this.low = y;
  }

  /** Whether the control should show after the latest sample. */
  get visible(): boolean {
    return this.end || this.wanted;
  }

  /** Forgets the current run and hides, e.g. after a programmatic scroll lands at `y`. */
  rest(y: number, t = this.lastT): void {
    this.dir = 'down';
    this.peak = this.low = y;
    this.steps = 0;
    this.keyboardRun = false;
    this.wanted = false;
    this.end = false;
    this.lastT = t;
  }

  update({ y, t, viewport, max, keyboard = false }: ScrollSample): boolean {
    const o = this.o;
    const deep = y > o.showDepth * viewport;
    this.end = deep && y >= max - o.endSlack;
    if (this.dir === 'down') {
      if (y >= this.peak) {
        this.peak = y;
        this.upT = 0;
      } else {
        // The first frame moving up dates the run: the movement began about a frame earlier, not when the page last moved.
        if (!this.upT) this.upT = Math.max(this.lastT, t - 16);
        if (this.peak - y > o.jitter) {
          this.dir = 'up';
          this.low = y;
          this.steps = 1;
          this.keyboardRun = keyboard;
        }
      }
    } else if (y <= this.low) {
      if (y < this.low) this.steps++;
      this.low = y;
      this.keyboardRun ||= keyboard;
    } else if (y - this.low > o.jitter) {
      // Heading down again: reading resumed.
      this.dir = 'down';
      this.peak = y;
      this.upT = 0;
      this.steps = 0;
      this.wanted = false;
    }
    if (this.dir === 'up' && deep && !this.wanted && this.steps >= o.minSteps) {
      const travel = this.peak - y;
      const speed = travel / Math.max(16, t - this.upT);
      if (travel >= o.travel * viewport || (!this.keyboardRun && travel >= o.flick * viewport && speed >= o.flickSpeed)) this.wanted = true;
    }
    if (y < o.hideDepth * viewport) this.wanted = false;
    this.lastT = t;
    this.movedT = t;
    return this.visible;
  }

  /**
   * Called when the page has been still for a while (`idleMs` after the last
   * sample): a revealed control fades unless held, e.g. under the pointer or
   * with focus. At the end it stays.
   */
  settle(t: number, held = false): boolean {
    if (!held && t - this.movedT >= this.o.idleMs) this.wanted = false;
    return this.visible;
  }

  get idleMs(): number {
    return this.o.idleMs;
  }
}
