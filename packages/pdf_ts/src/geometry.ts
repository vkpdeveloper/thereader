import { type Rect, limit } from "./model";
export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export const translation = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
export function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export function validMatrix(a: Matrix): void {
  if (a.some((n) => !Number.isFinite(n) || Math.abs(n) > 1e12)) limit();
}
export const point = (a: Matrix, x: number, y: number): [number, number] => [
  a[0] * x + a[2] * y + a[4],
  a[1] * x + a[3] * y + a[5],
];
export function rect(
  a: Matrix,
  x: number,
  y: number,
  width: number,
  height: number,
): Rect {
  const points = [
    point(a, x, y),
    point(a, x + width, y),
    point(a, x, y + height),
    point(a, x + width, y + height),
  ];
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]),
    left = Math.min(...xs),
    top = Math.min(...ys);
  return {
    x: left,
    y: top,
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - top,
  };
}
export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}
export const intersects = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;
export const contained = (a: Rect, b: Rect, pad: number): boolean =>
  a.x >= b.x - pad &&
  a.y >= b.y - pad &&
  a.x + a.width <= b.x + b.width + pad &&
  a.y + a.height <= b.y + b.height + pad;
export const expand = (r: Rect, n: number): Rect => ({
  x: r.x - n,
  y: r.y - n,
  width: r.width + 2 * n,
  height: r.height + 2 * n,
});
export function finiteRect(r: Rect): void {
  if (Object.values(r).some((n) => !Number.isFinite(n) || Math.abs(n) > 1e9))
    limit();
}
export const fnum = (n: number): string => n.toFixed(3);
export const rgb = (r: number, g: number, b: number): string =>
  "#" +
  [r, g, b]
    .map((v) =>
      Math.floor(Math.max(0, Math.min(1, v)) * 255 + 0.5)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
export const safeLink = (s: string): boolean =>
  /^(https?:\/\/|mailto:)/i.test(s.trim());
