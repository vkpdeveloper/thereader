// Minimal typings for `bun test` (bun-types is not a dependency of the web app).
// Function declarations merge with bun-types' if it is ever installed.
declare module 'bun:test' {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => unknown, timeout?: number): void;
  export function afterEach(fn: () => unknown): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function expect(actual: unknown): any;
}
