// Minimal typings for `bun:test` so these tests type-check with the app's
// tsconfig (which includes all of src) without adding bun-types.
declare module 'bun:test' {
  type TestFn = () => void | Promise<void>;
  interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toContain(expected: unknown): void;
    toHaveLength(length: number): void;
    toBeGreaterThan(n: number): void;
    toBeGreaterThanOrEqual(n: number): void;
    toBeLessThan(n: number): void;
    toBeLessThanOrEqual(n: number): void;
    toMatch(pattern: RegExp | string): void;
    toThrow(expected?: unknown): void;
    toMatchObject(expected: unknown): void;
    toBeInstanceOf(expected: unknown): void;
    toHaveProperty(path: string, value?: unknown): void;
    not: Matchers;
    rejects: { toThrow(expected?: unknown): Promise<void> };
  }
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: TestFn, timeout?: number): void;
  export function beforeEach(fn: TestFn): void;
  export function afterEach(fn: TestFn): void;
  export function expect(value: unknown): Matchers;
}
