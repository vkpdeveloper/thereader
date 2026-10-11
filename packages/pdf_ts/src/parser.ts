import {
  DEFAULT_LIMITS,
  type Document,
  type Limits,
  type Options,
  PdfError,
  emptyDocument,
  invalid,
  limit,
  unsupported,
} from "./model";
import {
  type Dict,
  type Value,
  Lexer,
  Name,
  Ref,
  Stream,
  asArray,
  asDict,
  binary,
  integer,
  intWord,
  named,
} from "./syntax";
import {
  ascii85,
  asciiHex,
  inflate,
  lzwDecode,
  predict,
  runLength,
} from "./filters";

interface XEntry {
  type: number;
  offset: number;
  gen: number;
}
export class PDF {
  readonly limits: Limits;
  readonly out: Document = emptyDocument();
  readonly xref = new Map<number, XEntry>();
  readonly objects = new Map<string, Value>();
  readonly loading = new Set<string>();
  readonly decoded = new Map<Stream, Uint8Array>();
  readonly objectStreams = new Set<number>();
  readonly warned = new Set<string>();
  readonly assetIDs = new Map<Stream, string>();
  trailer: Dict = Object.create(null);
  decodedSize = 0;
  operations = 0;
  spanCount = 0;
  assetBytes = 0;
  outlineBytes = 0;
  private readonly deadline: number;
  constructor(
    readonly data: Uint8Array,
    readonly options: Options = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS };
    for (const key of Object.keys(this.limits) as (keyof Limits)[]) {
      const value = options.limits?.[key];
      if (value !== undefined && value > 0) {
        if (!Number.isSafeInteger(value)) limit();
        this.limits[key] = value;
      }
    }
    this.deadline =
      options.timeoutMs && options.timeoutMs > 0
        ? performance.now() + options.timeoutMs
        : Infinity;
    this.check();
    if (data.length > this.limits.inputBytes) limit();
    if (!binary(data.subarray(0, 1024)).includes("%PDF-"))
      invalid("Missing PDF header");
    const marker = [115, 116, 97, 114, 116, 120, 114, 101, 102];
    let start = -1;
    outer: for (let i = data.length - marker.length; i >= 0; i--) {
      if (data[i] !== marker[0]) continue;
      for (let j = 1; j < marker.length; j++)
        if (data[i + j] !== marker[j]) continue outer;
      start = i;
      break;
    }
    if (start < 0) invalid("Missing startxref");
    const l = new Lexer(data, start + 9);
    this.readXref(intWord(l.word()), new Set(), 0);
    if (this.trailer.Encrypt != null)
      throw new PdfError("ENCRYPTED_PDF", "Encrypted PDFs are not supported");
  }
  check(): void {
    if (this.options.signal?.aborted || performance.now() >= this.deadline)
      throw new PdfError("ABORTED", "PDF extraction cancelled");
  }
  warn(code: string, page: number, message: string): void {
    this.out.complete = false;
    if (this.out.warnings.length >= 1000) return;
    const key = `${code}:${page}:${message}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.out.warnings.push({ code, ...(page ? { page } : {}), message });
  }
  dict(v: Value | undefined): Dict {
    return asDict(this.resolve(v));
  }
  array(v: Value | undefined): Value[] {
    return asArray(this.resolve(v));
  }
  putXref(id: number, entry: XEntry): void {
    if (id < 0 || id > this.limits.objects * 10) limit();
    if (!this.xref.has(id)) this.xref.set(id, entry);
    if (this.xref.size > this.limits.objects) limit();
  }
  private readXref(off: number, seen: Set<number>, depth: number): void {
    this.check();
    if (off < 0 || off >= this.data.length || seen.has(off))
      invalid("Cyclic or invalid xref");
    if (depth > 64) limit();
    seen.add(off);
    const l = new Lexer(this.data, off);
    let trailer: Dict;
    if (l.word() === "xref") {
      for (;;) {
        const word = l.word();
        if (word === "trailer") {
          trailer = asDict(l.value());
          break;
        }
        const first = intWord(word),
          count = intWord(l.word());
        if (count < 0 || count > this.limits.objects) limit();
        for (let i = 0; i < count; i++) {
          const offset = intWord(l.word()),
            gen = intWord(l.word()),
            flag = l.word();
          if (flag !== "n" && flag !== "f") invalid("Invalid xref entry");
          this.putXref(first + i, { type: flag === "n" ? 1 : 0, offset, gen });
        }
      }
    } else {
      const [, s] = this.indirect(off);
      if (!(s instanceof Stream) || named(s.dict.Type) !== "XRef")
        invalid("Expected xref stream");
      trailer = s.dict;
      const b = this.decode(s),
        w = asArray(trailer.W);
      if (w.length !== 3) invalid("Invalid xref widths");
      const widths = w.map(integer);
      let row = 0;
      for (const n of widths) {
        if (n < 0 || n > 8) invalid();
        row += n;
      }
      if (!row) invalid();
      let indices = asArray(trailer.Index);
      if (!indices.length) indices = [0, trailer.Size];
      if (indices.length % 2) invalid();
      let pos = 0;
      for (let i = 0; i < indices.length; i += 2) {
        const first = integer(indices[i]),
          count = integer(indices[i + 1]);
        if (
          count < 0 ||
          count > this.limits.objects ||
          count > (b.length - pos) / row
        )
          invalid();
        for (let j = 0; j < count; j++) {
          const fields = [0, 0, 0];
          for (let k = 0; k < 3; k++)
            for (let z = 0; z < widths[k]; z++) {
              fields[k] = fields[k] * 256 + b[pos++];
              if (!Number.isSafeInteger(fields[k])) limit();
            }
          if (widths[0] === 0) fields[0] = 1;
          this.putXref(first + j, {
            type: fields[0],
            offset: fields[1],
            gen: fields[2],
          });
        }
      }
    }
    for (const [k, v] of Object.entries(trailer))
      if (!(k in this.trailer)) this.trailer[k] = v;
    if ("XRefStm" in trailer)
      this.readXref(integer(trailer.XRefStm), seen, depth + 1);
    if ("Prev" in trailer)
      this.readXref(integer(trailer.Prev), seen, depth + 1);
  }
  indirect(off: number): [Ref, Value] {
    if (off < 0 || off >= this.data.length) invalid();
    const l = new Lexer(this.data, off),
      id = intWord(l.word()),
      gen = intWord(l.word());
    if (l.word() !== "obj") invalid(`Invalid object at ${off}`);
    const ref = new Ref(id, gen);
    let v = l.value();
    l.skip();
    if (
      v !== null &&
      Object.getPrototypeOf(v) === null &&
      l.word() === "stream"
    ) {
      const d = v as Dict;
      if (l.data[l.pos] === 13) l.pos++;
      if (l.data[l.pos] === 10) l.pos++;
      else if (l.pos === 0 || l.data[l.pos - 1] !== 13)
        invalid("Missing stream newline");
      const n = this.resolve(d.Length);
      if (
        typeof n !== "number" ||
        !Number.isInteger(n) ||
        n < 0 ||
        n > this.data.length - l.pos
      )
        invalid("Invalid stream length");
      const raw = l.data.subarray(l.pos, l.pos + n);
      l.pos += n;
      if (l.word() !== "endstream") invalid("Missing endstream");
      v = new Stream(d, raw);
    }
    return [ref, v];
  }
  resolve(value: Value | undefined): Value | undefined {
    let v = value;
    for (let i = 0; i < 64; i++) {
      if (!(v instanceof Ref)) return v;
      v = this.get(v);
    }
    return invalid("Reference cycle");
  }
  get(r: Ref): Value | undefined {
    if (this.objects.has(r.key)) return this.objects.get(r.key);
    if (this.loading.has(r.key)) invalid("Object cycle");
    this.loading.add(r.key);
    try {
      const e = this.xref.get(r.id);
      if (!e || e.type === 0) return null;
      if (e.type === 1) {
        if (r.gen !== e.gen) return null;
        const [actual, v] = this.indirect(e.offset);
        if (actual.key !== r.key) invalid("Object identity mismatch");
        this.objects.set(r.key, v);
        return v;
      }
      if (e.type !== 2 || r.gen !== 0) invalid("Invalid xref entry type");
      if (!this.objectStreams.has(e.offset)) {
        this.objectStreams.add(e.offset);
        const s = this.get(new Ref(e.offset, 0));
        if (!(s instanceof Stream)) invalid("Missing object stream");
        const b = this.decode(s),
          n = integer(s.dict.N),
          first = integer(s.dict.First);
        if (
          named(s.dict.Type) !== "ObjStm" ||
          n < 0 ||
          n > this.limits.objects ||
          first < 0 ||
          first > b.length
        )
          invalid();
        const l = new Lexer(b.subarray(0, first)),
          pairs: [number, number][] = [];
        for (let j = 0; j < n; j++) {
          const id = intWord(l.word()),
            pos = intWord(l.word());
          if (pos < 0 || pos >= b.length - first) invalid();
          pairs.push([id, pos]);
        }
        for (let i = 0; i < pairs.length; i++) {
          const [id, pos] = pairs[i],
            x = this.xref.get(id);
          if (!x || x.type !== 2 || x.offset !== e.offset || x.gen !== i)
            continue;
          this.objects.set(
            new Ref(id, 0).key,
            new Lexer(b, first + pos).value(),
          );
        }
      }
      return this.objects.get(r.key);
    } finally {
      this.loading.delete(r.key);
    }
  }
  decode(s: Stream): Uint8Array {
    const cached = this.decoded.get(s);
    if (cached) return cached;
    const [b, terminal] = this.decodeFilters(s);
    if (terminal) unsupported(`Unsupported stream filter ${terminal}`);
    this.decoded.set(s, b);
    return b;
  }
  decodeFilters(s: Stream): [Uint8Array, string] {
    const filter = this.resolve(s.dict.Filter),
      parameters = this.resolve(s.dict.DecodeParms);
    const filters = filter instanceof Name ? [filter] : asArray(filter);
    const params = Array.isArray(parameters)
      ? parameters
      : parameters
        ? [parameters]
        : [];
    let b = s.raw;
    for (let i = 0; i < filters.length; i++) {
      this.check();
      const kind = named(this.resolve(filters[i])),
        d = this.dict(params[i]);
      const maximum = this.limits.decodedBytes - this.decodedSize;
      switch (kind) {
        case "FlateDecode":
        case "Fl":
          b = inflate(b, maximum);
          break;
        case "ASCII85Decode":
        case "A85":
          b = ascii85(b, maximum);
          break;
        case "ASCIIHexDecode":
        case "AHx":
          b = asciiHex(b, maximum);
          break;
        case "RunLengthDecode":
        case "RL":
          b = runLength(b, maximum);
          break;
        case "LZWDecode":
        case "LZW":
          b = lzwDecode(
            b,
            maximum,
            "EarlyChange" in d ? integer(d.EarlyChange) : 1,
          );
          break;
        case "DCTDecode":
        case "DCT":
        case "JPXDecode":
        case "CCITTFaxDecode":
        case "CCF":
        case "JBIG2Decode":
          if (i !== filters.length - 1)
            unsupported("Unsupported image filter chain");
          return [b, kind];
        default:
          unsupported(`Unsupported stream filter ${kind}`);
      }
      if (["FlateDecode", "Fl", "LZWDecode", "LZW"].includes(kind))
        b = predict(b, d, maximum);
      this.decodedSize += b.length;
      if (this.decodedSize > this.limits.decodedBytes) limit();
    }
    if (!filters.length) {
      this.decodedSize += b.length;
      if (this.decodedSize > this.limits.decodedBytes) limit();
    }
    return [b, ""];
  }
}
