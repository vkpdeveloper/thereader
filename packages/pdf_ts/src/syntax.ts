import { invalid, limit } from "./model";

export class Name {
  constructor(readonly value: string) {}
}
export class Literal {
  constructor(readonly bytes: Uint8Array) {}
}
export class Keyword {
  constructor(readonly value: string) {}
}
export class Ref {
  constructor(
    readonly id: number,
    readonly gen: number,
  ) {}
  get key(): string {
    return `${this.id}:${this.gen}`;
  }
}
export type Value =
  | Name
  | Literal
  | Keyword
  | Ref
  | Stream
  | Dict
  | Value[]
  | number
  | boolean
  | null;
export type Dict = { [key: string]: Value };
export class Stream {
  constructor(
    readonly dict: Dict,
    readonly raw: Uint8Array,
  ) {}
}
export const white = (b: number): boolean =>
  b === 0 || b === 9 || b === 10 || b === 12 || b === 13 || b === 32;
const delimiters = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
export const delimiter = (b: number): boolean => white(b) || delimiters.has(b);
export const number = (v: unknown): number => (typeof v === "number" ? v : 0);
export const integer = (v: unknown): number => Math.trunc(number(v));
export const named = (v: unknown): string => (v instanceof Name ? v.value : "");
export function asDict(v: unknown): Dict {
  if (v instanceof Stream) return v.dict;
  return v !== null &&
    typeof v === "object" &&
    Object.getPrototypeOf(v) === null
    ? (v as Dict)
    : Object.create(null);
}
export const asArray = (v: unknown): Value[] => (Array.isArray(v) ? v : []);
export function binary(b: Uint8Array): string {
  if (b.length <= 32) {
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  const chunks: string[] = [];
  for (let i = 0; i < b.length; i += 8192)
    chunks.push(
      String.fromCharCode.apply(
        null,
        b.subarray(i, i + 8192) as unknown as number[],
      ),
    );
  return chunks.join("");
}
export function bytes(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
}
export function hexDecode(s: string): Uint8Array {
  if (!/^[\da-f]*$/i.test(s) || s.length % 2)
    invalid("Invalid hexadecimal string");
  return Uint8Array.from({ length: s.length / 2 }, (_, i) =>
    parseInt(s.slice(i * 2, i * 2 + 2), 16),
  );
}
export function intWord(w: string): number {
  if (!/^[+-]?\d+$/.test(w) || !Number.isSafeInteger(Number(w)))
    invalid("Invalid integer");
  return Number(w);
}
export class Lexer {
  nodes = 0;
  constructor(
    readonly data: Uint8Array,
    public pos = 0,
  ) {}
  fail(message: string): never {
    return invalid(`${message} at byte ${this.pos}`);
  }
  skip(): void {
    while (this.pos < this.data.length) {
      if (white(this.data[this.pos])) {
        this.pos++;
        continue;
      }
      if (this.data[this.pos] === 37) {
        while (
          this.pos < this.data.length &&
          this.data[this.pos] !== 10 &&
          this.data[this.pos] !== 13
        )
          this.pos++;
        continue;
      }
      break;
    }
  }
  word(): string {
    this.skip();
    const start = this.pos;
    while (this.pos < this.data.length && !delimiter(this.data[this.pos]))
      this.pos++;
    return binary(this.data.subarray(start, this.pos));
  }
  value(depth = 0): Value {
    if (depth > 64 || ++this.nodes > 2000000) limit();
    this.skip();
    const b = this.data;
    if (this.pos >= b.length) this.fail("Unexpected EOF");
    switch (b[this.pos]) {
      case 47: {
        const start = ++this.pos;
        while (this.pos < b.length && !delimiter(b[this.pos])) this.pos++;
        return new Name(
          binary(b.subarray(start, this.pos)).replace(
            /#([\da-f]{2})/gi,
            (_, h) => String.fromCharCode(parseInt(h, 16)),
          ),
        );
      }
      case 40: {
        this.pos++;
        let nesting = 1;
        const out: number[] = [];
        while (this.pos < b.length) {
          let c = b[this.pos++];
          if (c === 92) {
            if (this.pos === b.length) break;
            c = b[this.pos++];
            const escapes: Record<number, number> = {
              110: 10,
              114: 13,
              116: 9,
              98: 8,
              102: 12,
            };
            if (escapes[c] !== undefined) c = escapes[c];
            else if (c === 13 || c === 10) {
              if (c === 13 && b[this.pos] === 10) this.pos++;
              continue;
            } else if (c >= 48 && c <= 55) {
              let v = c - 48;
              for (
                let j = 0;
                j < 2 && b[this.pos] >= 48 && b[this.pos] <= 55;
                j++
              )
                v = v * 8 + b[this.pos++] - 48;
              c = v & 255;
            }
          } else if (c === 40) {
            if (++nesting > 64) limit();
          } else if (c === 41) {
            if (--nesting === 0) return new Literal(Uint8Array.from(out));
          } else if (c === 13) {
            if (b[this.pos] === 10) this.pos++;
            c = 10;
          }
          out.push(c);
        }
        return this.fail("Unterminated string");
      }
      case 60: {
        this.pos++;
        if (b[this.pos] === 60) {
          this.pos++;
          const d: Dict = Object.create(null);
          let count = 0;
          for (;;) {
            this.skip();
            if (b[this.pos] === 62 && b[this.pos + 1] === 62) {
              this.pos += 2;
              return d;
            }
            const k = this.value(depth + 1);
            if (!(k instanceof Name)) this.fail("Dictionary key is not a name");
            if (!(k.value in d) && ++count > 50000) limit();
            d[k.value] = this.value(depth + 1);
          }
        }
        let h = "";
        while (this.pos < b.length && b[this.pos] !== 62) {
          if (!white(b[this.pos])) h += String.fromCharCode(b[this.pos]);
          this.pos++;
        }
        if (this.pos === b.length) this.fail("Unterminated hex string");
        this.pos++;
        if (h.length % 2) h += "0";
        return new Literal(hexDecode(h));
      }
      case 91: {
        this.pos++;
        const a: Value[] = [];
        for (;;) {
          this.skip();
          if (b[this.pos] === 93) {
            this.pos++;
            return a;
          }
          a.push(this.value(depth + 1));
          if (a.length > 200000) limit();
        }
      }
      default: {
        const w = this.word();
        if (!w) this.fail("Unexpected delimiter");
        if (w === "true") return true;
        if (w === "false") return false;
        if (w === "null") return null;
        if (
          /^[+\-\d.]/.test(w) &&
          /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(w)
        ) {
          const v = Number(w);
          if (!Number.isFinite(v) || Math.abs(v) > 1e15)
            this.fail("Invalid number");
          if (v >= 0 && Number.isInteger(v)) {
            const saved = this.pos;
            const w2 = this.word();
            const g = Number(w2);
            if (
              /^[+-]?\d+$/.test(w2) &&
              g >= 0 &&
              g <= 65535 &&
              this.word() === "R"
            )
              return new Ref(v, g);
            this.pos = saved;
          }
          return v;
        }
        return new Keyword(w);
      }
    }
  }
}
