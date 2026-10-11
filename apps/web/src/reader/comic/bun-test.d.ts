// Adds the matcher these tests use to the minimal `bun:test` typings
// (src/lib/services/__tests__/bun-test.d.ts); ambient declarations merge.
declare module 'bun:test' {
  interface Matchers {
    toBeCloseTo(expected: number, digits?: number): void;
  }
}
