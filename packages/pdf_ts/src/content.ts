import {
  type Block,
  type Page,
  type Rect,
  PdfError,
  invalid,
  limit,
} from "./model";
import {
  type Dict,
  type Value,
  Keyword,
  Lexer,
  Literal,
  Name,
  Ref,
  Stream,
  asArray,
  integer,
  named,
  number,
} from "./syntax";
import { PDF } from "./parser";
import { Font, Fonts, textString } from "./font";
import {
  type Matrix,
  IDENTITY,
  finiteRect,
  fnum,
  intersects,
  mul,
  point,
  rect,
  rgb,
  safeLink,
  translation,
  union,
  validMatrix,
} from "./geometry";

export interface Graphics {
  ctm: Matrix;
  tm: Matrix;
  tl: Matrix;
  font?: Font;
  size: number;
  charSpace: number;
  wordSpace: number;
  scale: number;
  leading: number;
  rise: number;
  mode: number;
  fill: string;
  stroke: string;
  lineWidth: number;
}
export interface Span {
  text: string;
  box: Rect;
  size: number;
  bold: boolean;
  italic: boolean;
  mono: boolean;
  link: string;
  role: string;
  mcid: number;
  baseline: number;
  script: string;
  font: Font;
  encoded: Uint8Array;
  graphics: Graphics;
}
export interface Ruling {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface VectorPath {
  svg: string;
  box: Rect;
}
export interface PageContent {
  page: Page;
  spans: Span[];
  images: Block[];
  rules: Ruling[];
  id?: Ref;
  tags: Map<number, string>;
  alt: Map<number, string>;
  paths: VectorPath[];
}
interface Marked {
  role: string;
  actual: string;
  alt: string;
  artifact: boolean;
  start: number;
  mcid: number;
}
export interface ImageReader {
  image(s: Stream, page: number): string;
  inline(i: Interpreter, l: Lexer): void;
}
export function graphics(ctm: Matrix = IDENTITY): Graphics {
  return {
    ctm,
    tm: IDENTITY,
    tl: IDENTITY,
    size: 0,
    charSpace: 0,
    wordSpace: 0,
    scale: 1,
    leading: 0,
    rise: 0,
    mode: 0,
    fill: "#000000",
    stroke: "#000000",
    lineWidth: 1,
  };
}
function nums(a: Value[], n: number): number[] | undefined {
  return a.length === n &&
    a.every((v) => typeof v === "number" && Math.abs(v) <= 1e8)
    ? (a as number[])
    : undefined;
}
export class Interpreter {
  stack: Graphics[] = [];
  marks: Marked[] = [];
  path = "";
  pathBox?: Rect;
  currentX = 0;
  currentY = 0;
  pathStartX = 0;
  pathStartY = 0;
  depth = 0;
  readonly active: Set<Stream>;
  constructor(
    readonly p: PDF,
    readonly page: PageContent,
    public g: Graphics,
    public resources: Dict,
    readonly fonts: Fonts,
    readonly images: ImageReader,
    active = new Set<Stream>(),
  ) {
    this.active = active;
  }
  run(data: Uint8Array): void {
    validMatrix(this.g.ctm);
    const l = new Lexer(data);
    let args: Value[] = [];
    while (l.pos < data.length) {
      l.skip();
      if (l.pos === data.length) break;
      const v = l.value();
      if (!(v instanceof Keyword)) {
        args.push(v);
        if (args.length > 10000) limit();
        continue;
      }
      if (++this.p.operations > this.p.limits.operations) limit();
      if (this.p.operations % 1024 === 0) this.p.check();
      this.op(v.value, args, l);
      args = [];
    }
  }
  op(op: string, a: Value[], l: Lexer): void {
    const g = this.g;
    switch (op) {
      case "q":
        if (this.stack.length > 64) limit();
        this.stack.push({ ...g });
        break;
      case "Q":
        if (this.stack.length) this.g = this.stack.pop()!;
        break;
      case "cm": {
        const n = nums(a, 6);
        if (n) {
          g.ctm = mul(g.ctm, n as Matrix);
          validMatrix(g.ctm);
        }
        break;
      }
      case "BT":
        g.tm = IDENTITY;
        g.tl = IDENTITY;
        break;
      case "ET":
        break;
      case "Tf":
        if (a.length === 2) {
          g.font = this.fonts.get(
            this.p.dict(this.resources.Font)[named(a[0])],
            this.page.page.number,
          );
          g.size = number(a[1]);
        }
        break;
      case "Tm": {
        const n = nums(a, 6);
        if (n) {
          g.tm = n as Matrix;
          g.tl = g.tm;
        }
        break;
      }
      case "Td":
      case "TD": {
        const n = nums(a, 2);
        if (n) {
          if (op === "TD") g.leading = -n[1];
          g.tl = mul(g.tl, translation(n[0], n[1]));
          g.tm = g.tl;
        }
        break;
      }
      case "T*":
        g.tl = mul(g.tl, translation(0, -g.leading));
        g.tm = g.tl;
        break;
      case "Tc":
      case "Tw":
      case "Tz":
      case "TL":
      case "Ts":
      case "Tr":
        if (a.length === 1) {
          const n = number(a[0]);
          if (op === "Tc") g.charSpace = n;
          else if (op === "Tw") g.wordSpace = n;
          else if (op === "Tz") g.scale = n / 100;
          else if (op === "TL") g.leading = n;
          else if (op === "Ts") g.rise = n;
          else g.mode = Math.trunc(n);
        }
        break;
      case "Tj":
        if (a.length === 1 && a[0] instanceof Literal) this.show(a[0].bytes);
        break;
      case "'":
      case '"':
        if (op === '"' && a.length === 3) {
          g.wordSpace = number(a[0]);
          g.charSpace = number(a[1]);
        }
        g.tl = mul(g.tl, translation(0, -g.leading));
        g.tm = g.tl;
        if (a.length) {
          const s = a[a.length - 1];
          if (s instanceof Literal) this.show(s.bytes);
        }
        break;
      case "TJ":
        if (a.length === 1)
          for (const v of asArray(a[0])) {
            if (v instanceof Literal) this.show(v.bytes);
            else
              g.tm = mul(
                g.tm,
                translation((-number(v) * g.size * g.scale) / 1000, 0),
              );
          }
        break;
      case "Do":
        if (a.length === 1) this.xobject(named(a[0]));
        break;
      case "BMC":
      case "BDC": {
        if (this.marks.length > 64) limit();
        const parent = this.marks.at(-1);
        const m: Marked = {
          role: named(a[0]),
          actual: "",
          alt: "",
          artifact: named(a[0]) === "Artifact" || !!parent?.artifact,
          start: this.page.spans.length,
          mcid: -1,
        };
        if (op === "BDC" && a.length === 2) {
          let v = a[1];
          if (v instanceof Name)
            v = this.p.dict(this.resources.Properties)[v.value];
          const d = this.p.dict(v);
          if ("MCID" in d) {
            m.mcid = integer(d.MCID);
            m.role = this.page.tags.get(m.mcid) || m.role;
            m.alt = this.page.alt.get(m.mcid) || "";
          }
          m.actual = textString(d.ActualText);
        }
        this.marks.push(m);
        break;
      }
      case "EMC": {
        const m = this.marks.pop();
        if (m?.actual && m.start < this.page.spans.length) {
          const s = { ...this.page.spans[m.start] };
          for (const v of this.page.spans.slice(m.start + 1))
            s.box = union(s.box, v.box);
          s.text = m.actual;
          this.page.spans.splice(m.start, this.page.spans.length - m.start, s);
        }
        break;
      }
      case "BI":
        this.images.inline(this, l);
        break;
      case "gs":
        if (a.length === 1) {
          const d = this.p.dict(
              this.p.dict(this.resources.ExtGState)[named(a[0])],
            ),
            f = this.p.array(d.Font);
          if (f.length === 2) {
            g.font = this.fonts.get(f[0], this.page.page.number);
            g.size = number(f[1]);
          }
          if (d.SMask != null && named(d.SMask) !== "None")
            this.p.warn(
              "transparency",
              this.page.page.number,
              "Graphics soft masks need visual review.",
            );
        }
        break;
      case "w":
        if (a.length === 1) g.lineWidth = number(a[0]);
        break;
      case "g":
      case "G":
        if (a.length === 1) {
          const n = number(a[0]),
            c = rgb(n, n, n);
          if (op === "g") g.fill = c;
          else g.stroke = c;
        }
        break;
      case "rg":
      case "RG": {
        const n = nums(a, 3);
        if (n) {
          const c = rgb(n[0], n[1], n[2]);
          if (op === "rg") g.fill = c;
          else g.stroke = c;
        }
        break;
      }
      case "k":
      case "K": {
        const n = nums(a, 4);
        if (n) {
          const c = rgb(
            (1 - n[0]) * (1 - n[3]),
            (1 - n[1]) * (1 - n[3]),
            (1 - n[2]) * (1 - n[3]),
          );
          if (op === "k") g.fill = c;
          else g.stroke = c;
        }
        break;
      }
      case "m":
      case "l": {
        const n = nums(a, 2);
        if (n) {
          const [x, y] = point(g.ctm, n[0], n[1]);
          if (op === "l")
            this.page.rules.push({
              x1: this.currentX,
              y1: this.currentY,
              x2: x,
              y2: y,
            });
          else {
            this.pathStartX = x;
            this.pathStartY = y;
          }
          this.pointPath(x, y);
          this.path += `${op.toUpperCase()}${fnum(x)} ${fnum(y)} `;
          this.currentX = x;
          this.currentY = y;
        }
        break;
      }
      case "c": {
        const n = nums(a, 6);
        if (n) {
          this.path += "C";
          for (let j = 0; j < 6; j += 2) {
            const [x, y] = point(g.ctm, n[j], n[j + 1]);
            this.pointPath(x, y);
            this.path += `${fnum(x)} ${fnum(y)} `;
            this.currentX = x;
            this.currentY = y;
          }
        }
        break;
      }
      case "v":
      case "y": {
        const n = nums(a, 4);
        if (n) {
          const [x1, y1] = point(g.ctm, n[0], n[1]),
            [x2, y2] = point(g.ctm, n[2], n[3]);
          const c =
            op === "y"
              ? [x1, y1, x2, y2]
              : [this.currentX, this.currentY, x1, y1];
          this.path += `C${[...c, x2, y2].map(fnum).join(" ")} `;
          this.pointPath(x1, y1);
          this.pointPath(x2, y2);
          this.currentX = x2;
          this.currentY = y2;
        }
        break;
      }
      case "re": {
        const n = nums(a, 4);
        if (n) {
          const pts = [
            [n[0], n[1]],
            [n[0] + n[2], n[1]],
            [n[0] + n[2], n[1] + n[3]],
            [n[0], n[1] + n[3]],
          ];
          let previous: [number, number] = [0, 0];
          pts.forEach((pt, j) => {
            const [x, y] = point(g.ctm, pt[0], pt[1]);
            this.pointPath(x, y);
            if (j)
              this.page.rules.push({
                x1: previous[0],
                y1: previous[1],
                x2: x,
                y2: y,
              });
            this.path += `${j ? "L" : "M"}${fnum(x)} ${fnum(y)} `;
            previous = [x, y];
          });
          const [x, y] = point(g.ctm, n[0], n[1]);
          this.page.rules.push({
            x1: previous[0],
            y1: previous[1],
            x2: x,
            y2: y,
          });
          this.path += "Z ";
        }
        break;
      }
      case "h":
        this.path += "Z ";
        this.currentX = this.pathStartX;
        this.currentY = this.pathStartY;
        break;
      case "S":
      case "s":
      case "f":
      case "F":
      case "f*":
      case "B":
      case "B*":
      case "b":
      case "b*":
        this.paint(op);
        break;
      case "n":
        this.path = "";
        this.pathBox = undefined;
        break;
      case "W":
      case "W*": {
        const r = this.pathBox;
        const full =
          r &&
          Math.abs(r.x) < 1 &&
          Math.abs(r.y) < 1 &&
          Math.abs(r.width - this.page.page.width) < 2 &&
          Math.abs(r.height - this.page.page.height) < 2;
        if (!full)
          this.p.warn(
            "clipping",
            this.page.page.number,
            "A clipping path is present; exported graphics may extend outside it.",
          );
        break;
      }
      case "sh":
        this.p.warn(
          "shading",
          this.page.page.number,
          "Gradient shading is not reconstructed.",
        );
        break;
      case "CS":
      case "cs":
      case "SC":
      case "SCN":
      case "sc":
      case "scn":
        this.p.warn(
          "color-space",
          this.page.page.number,
          "Custom graphics colors are approximated.",
        );
        break;
      case "d":
      case "J":
      case "j":
      case "M":
      case "ri":
      case "i":
      case "BX":
      case "EX":
      case "MP":
      case "DP":
        break;
      default:
        this.p.warn(
          "operator",
          this.page.page.number,
          `Unrecognized content operator: ${op}`,
        );
    }
  }
  show(encoded: Uint8Array): void {
    const g = this.g;
    if (!g.font) {
      g.font = this.fonts.get(undefined, this.page.page.number);
      this.p.warn(
        "missing-font",
        this.page.page.number,
        "Text without a font uses fallback positioning.",
      );
    }
    if (!g.size) return;
    let width = 0,
      text = "";
    for (let at = 0; at < encoded.length; ) {
      const [u, code, n] = g.font.glyph(encoded.subarray(at));
      width +=
        ((g.font.width(code, u) * g.size) / 1000 + g.charSpace) * g.scale;
      if (n === 1 && encoded[at] === 32) width += g.wordSpace * g.scale;
      text += u;
      at += n;
    }
    const transform = mul(g.ctm, g.tm),
      saved = { ...g },
      box = rect(transform, 0, g.rise - g.size * 0.22, width, g.size);
    g.tm = mul(g.tm, translation(width, 0));
    if (!text) return;
    const m = this.marks.at(-1);
    if (m?.artifact && !this.p.options.keepArtifacts) return;
    if (text.includes("�"))
      this.p.warn(
        "unmapped-glyph",
        this.page.page.number,
        "Some glyphs could not be mapped to Unicode.",
      );
    finiteRect(box);
    if (++this.p.spanCount > this.p.limits.spans) limit();
    const size = Math.abs(g.size) * Math.hypot(transform[2], transform[3]);
    if (!size) return;
    const [, baseline] = point(transform, 0, g.rise);
    if (
      !this.p.options.keepArtifacts &&
      Math.abs(transform[1]) > Math.abs(transform[0]) * 2 &&
      (box.x + box.width < this.page.page.width * 0.08 ||
        box.x > this.page.page.width * 0.92)
    )
      return;
    this.page.spans.push({
      text,
      box,
      size,
      bold: g.font.bold,
      italic: g.font.italic,
      mono: g.font.mono,
      link: "",
      role: m?.role || "",
      mcid: m?.mcid ?? -1,
      baseline,
      script: "",
      font: g.font,
      encoded,
      graphics: saved,
    });
  }
  xobject(key: string): void {
    const s = this.p.resolve(this.p.dict(this.resources.XObject)[key]);
    if (!(s instanceof Stream)) return;
    if (named(s.dict.Subtype) === "Image") {
      try {
        const asset = this.images.image(s, this.page.page.number),
          box = rect(this.g.ctm, 0, 0, 1, 1);
        finiteRect(box);
        this.page.images.push({
          kind: "image",
          asset,
          alt: this.marks.at(-1)?.alt || "Image",
          box,
        });
      } catch (e) {
        this.imageError(e);
      }
      return;
    }
    if (named(s.dict.Subtype) !== "Form") {
      this.p.warn(
        "xobject",
        this.page.page.number,
        "Unsupported XObject subtype",
      );
      return;
    }
    if (this.depth >= 32 || this.active.has(s))
      invalid("Recursive form XObject");
    const b = this.p.decode(s),
      child = new Interpreter(
        this.p,
        this.page,
        { ...this.g },
        this.resources,
        this.fonts,
        this.images,
        this.active,
      );
    child.depth = this.depth + 1;
    child.marks = this.marks.map((m) => ({ ...m }));
    const a = this.p.array(s.dict.Matrix);
    if (a.length === 6) child.g.ctm = mul(child.g.ctm, a.map(number) as Matrix);
    if (s.dict.Resources != null)
      child.resources = this.p.dict(s.dict.Resources);
    this.active.add(s);
    try {
      child.run(b);
    } finally {
      this.active.delete(s);
    }
  }
  imageError(e: unknown): void {
    if (
      e instanceof PdfError &&
      (e.code === "RESOURCE_LIMIT" || e.code === "ABORTED")
    )
      throw e;
    this.p.warn(
      "image",
      this.page.page.number,
      e instanceof Error ? e.message : String(e),
    );
  }
  pointPath(x: number, y: number): void {
    const r = { x, y, width: 0, height: 0 };
    this.pathBox = this.pathBox ? union(this.pathBox, r) : r;
  }
  paint(op: string): void {
    if (this.marks.at(-1)?.artifact && !this.p.options.keepArtifacts) {
      this.path = "";
      this.pathBox = undefined;
      return;
    }
    const box = this.pathBox;
    if (box) {
      const fill = op === "S" || op === "s" ? "none" : this.g.fill,
        stroke = /[SsBb]/.test(op) ? this.g.stroke : "none";
      const close = op === "s" || op.startsWith("b") ? " Z" : "",
        rule = op.includes("*") ? "evenodd" : "nonzero";
      const background =
        fill === "#ffffff" &&
        box.width >= this.page.page.width * 0.95 &&
        box.height >= this.page.page.height * 0.95;
      if (!background && (box.width > 0.05 || box.height > 0.05))
        this.page.paths.push({
          svg: `<path d="${this.path}${close}" fill="${fill}" stroke="${stroke}" stroke-width="${fnum(Math.abs(this.g.lineWidth))}" fill-rule="${rule}"/>`,
          box,
        });
    }
    this.path = "";
    this.pathBox = undefined;
  }
}
export function pageLinks(
  p: PDF,
  pc: PageContent,
  d: Dict,
  base: Matrix,
): void {
  for (const v of p.array(d.Annots)) {
    const a = p.dict(v);
    if (named(a.Subtype) !== "Link") {
      if (named(a.Subtype))
        p.warn(
          "annotation",
          pc.page.number,
          `Non-link annotation: ${named(a.Subtype)}`,
        );
      continue;
    }
    const action = p.dict(a.A),
      url = textString(action.URI);
    if (!safeLink(url)) continue;
    const r = p.array(a.Rect);
    if (r.length !== 4) continue;
    const box = rect(
      base,
      number(r[0]),
      number(r[1]),
      number(r[2]) - number(r[0]),
      number(r[3]) - number(r[1]),
    );
    for (const s of pc.spans) if (intersects(s.box, box)) s.link = url;
  }
}
export function deduplicateSpans(spans: Span[]): Span[] {
  spans.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const out: Span[] = [];
  for (const s of spans) {
    let duplicate = false;
    for (let j = out.length - 1; j >= 0 && j >= out.length - 12; j--) {
      const t = out[j];
      if (
        Math.abs(t.box.y - s.box.y) < 1 &&
        Math.abs(t.box.x - s.box.x) < 1 &&
        s.text === t.text
      ) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) out.push(s);
  }
  return out;
}
