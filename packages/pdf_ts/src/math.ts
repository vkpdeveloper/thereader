import { type Block, type Rect, type Run, PdfError, limit } from "./model";
import { type PageContent, type Span, type VectorPath } from "./content";
import { PDF } from "./parser";
import { Font } from "./font";
import { FontPrograms } from "./font-program";
import { Assets } from "./assets";
import {
  type Matrix,
  contained,
  expand,
  finiteRect,
  fnum,
  intersects,
  mul,
  rect,
  translation,
  union,
} from "./geometry";
import {
  type Line,
  byteLength,
  deLigature,
  finishLine,
  runeCount,
} from "./lines";

export function xmlText(s: string): string {
  return s
    .replace(
      /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu,
      "",
    )
    .replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&#34;",
          "'": "&#39;",
        })[c]!,
    );
}
function general(n: number): string {
  if (n === 0) return Object.is(n, -0) ? "-0" : "0";
  const s = n.toPrecision(12);
  const [a, exp] = s.split("e");
  const trimmed = a.includes(".") ? a.replace(/0+$/, "").replace(/\.$/, "") : a;
  return exp === undefined
    ? trimmed
    : trimmed +
        "e" +
        (Number(exp) < 0 ? "-" : "+") +
        Math.abs(Number(exp)).toString().padStart(2, "0");
}
const matrixSVG = (m: Matrix) => "matrix(" + m.map(general).join(" ") + ")";
const mathWords = new Set(
  "sin cos tan cot sec csc log ln exp lim max min sup inf dim null range span rank det mod for and etc".split(
    " ",
  ),
);
const proseWords = (s: string): string[] => s.match(/[A-Za-z]{3,}/g) || [];
const operators = /[=+−×÷∑∫√≤≥∈→]/;
export function monochromeMath(spans: Span[], paths: VectorPath[]): boolean {
  return (
    spans.every((s) => ["#000000", "#ffffff"].includes(s.graphics.fill)) &&
    paths.every((p) =>
      (p.svg.match(/#[0-9a-fA-F]{6}/g) || []).every(
        (c) => c === "#000000" || c === "#ffffff",
      ),
    )
  );
}
export function mathLine(l: Line): boolean {
  if (!l.math || l.mono) return l.role === "Formula";
  if (
    [
      "of ",
      "and ",
      "where ",
      "for ",
      "with ",
      "suppose ",
      "let ",
      "then ",
      "if ",
      "proof ",
      "thus ",
      "hence ",
    ].some((w) => l.text.toLowerCase().startsWith(w))
  )
    return false;
  let math = 0,
    total = 0;
  for (const s of l.spans) {
    const n = runeCount(s.text.trim());
    total += n;
    if (s.font?.math) math += n;
  }
  return (
    total > 0 &&
    proseWords(l.text).every((w) => mathWords.has(w.toLowerCase())) &&
    (math * 2 >= total || operators.test(l.text))
  );
}
export function mathFragment(l: Pick<Line, "mono" | "text">): boolean {
  return (
    !l.mono &&
    byteLength(l.text) <= 180 &&
    proseWords(l.text).every((w) => mathWords.has(w.toLowerCase())) &&
    !["of ", "and ", "for ", "if "].some((w) =>
      l.text.toLowerCase().startsWith(w),
    )
  );
}
export function annotationContinuation(previous: Line, next: Line): boolean {
  const text = previous.text.trim(),
    first = [...next.text.trim()][0] || "";
  return (
    !!text &&
    !/[.!?;:]$/.test(text) &&
    !next.mono &&
    next.size <= previous.size * 1.1 &&
    /\p{Ll}/u.test(first) &&
    proseWords(next.text).length > 0
  );
}
export class PositionedGraphics {
  constructor(
    readonly p: PDF,
    readonly programs: FontPrograms,
    readonly assets: Assets,
  ) {}
  positionedAsset(
    pc: PageContent,
    spans: Span[],
    paths: VectorPath[],
    box: Rect,
    label: string,
  ): [string, Rect] {
    const p = this.p;
    let defs = "",
      body = "",
      count = 0,
      bodyBytes = 0;
    const ids = new Map<Font, Map<number, string>>();
    const appendBody = (s: string) => {
      body += s;
      bodyBytes += byteLength(s);
    };
    const budget = () => {
      if (
        defs.length + bodyBytes + p.assetBytes + p.outlineBytes >
        p.limits.assetBytes
      )
        limit();
    };
    for (const v of paths) {
      appendBody(v.svg);
      box = union(box, v.box);
      budget();
    }
    for (const s of spans) {
      if (!s.font || !s.encoded.length) continue;
      const f = s.font,
        g = s.graphics,
        transform = mul(g.ctm, g.tm),
        program = this.programs.get(f, pc.page.number);
      let offset = 0;
      for (let at = 0; at < s.encoded.length; ) {
        p.check();
        const raw = s.encoded.subarray(at),
          [u, code, n] = f.glyph(raw);
        let advance =
          ((f.width(code, u) * g.size) / 1000 + g.charSpace) * g.scale;
        if (n === 1 && raw[0] === 32) advance += g.wordSpace * g.scale;
        const placed = mul(transform, translation(offset, g.rise));
        let painted = false;
        if (program) {
          const name = code < 256 ? f.names[code] : "",
            previous = program.cache.size;
          let error: unknown,
            result: ReturnType<typeof program.outline> | undefined;
          try {
            result = program.outline(code, name);
          } catch (e) {
            error = e;
          }
          const gid = program.names
              ? program.names.get(name)
              : program.codes.get(code),
            cached = gid === undefined ? undefined : program.cache.get(gid);
          if (program.cache.size > previous && cached) {
            p.operations += cached.operations;
            p.outlineBytes += byteLength(cached.path);
          }
          if (p.operations > p.limits.operations) limit();
          budget();
          if (result) {
            const placedGlyph = mul(
              mul(placed, [g.size * g.scale, 0, 0, g.size, 0, 0]),
              program.matrix,
            );
            let map = ids.get(f);
            if (!map) {
              map = new Map();
              ids.set(f, map);
            }
            let id = map.get(code);
            if (!id) {
              id = "g" + count++;
              map.set(code, id);
              defs += `<path id="${id}" d="${result.path}"/>`;
            }
            appendBody(
              `<use href="#${id}" transform="${matrixSVG(placedGlyph)}" fill="${g.fill}"/>`,
            );
            if (result.box) {
              const r = result.box,
                drawn = rect(placedGlyph, r.x, r.y, r.width, r.height);
              finiteRect(drawn);
              box = union(box, drawn);
            }
            painted = true;
          } else {
            if (
              error instanceof PdfError &&
              (error.code === "RESOURCE_LIMIT" || error.code === "ABORTED")
            )
              throw error;
            p.warn(
              "glyph-outline",
              pc.page.number,
              "Some positioned glyphs use Unicode fallback: " +
                (error instanceof Error ? error.message : String(error)),
            );
          }
        }
        if (!painted) {
          const family = f.mono ? "monospace" : "serif",
            style =
              (f.bold ? ' font-weight="bold"' : "") +
              (f.italic ? ' font-style="italic"' : "");
          const m = mul(placed, [g.scale, 0, 0, -1, 0, 0]);
          appendBody(
            `<text transform="${matrixSVG(m)}" font-family="${family}" font-size="${fnum(Math.abs(g.size))}" fill="${g.fill}"${style}>${xmlText(u)}</text>`,
          );
        }
        offset += advance;
        at += n;
        budget();
      }
    }
    box = expand(box, 1);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fnum(box.x)} ${fnum(box.y)} ${fnum(box.width)} ${fnum(box.height)}" width="${fnum(box.width)}" height="${fnum(box.height)}" role="img"><title>${xmlText(label)}</title><rect x="${fnum(box.x)}" y="${fnum(box.y)}" width="${fnum(box.width)}" height="${fnum(box.height)}" fill="white"/><defs>${defs}</defs>${body}</svg>`;
    return [
      this.assets.add(
        new TextEncoder().encode(svg),
        "image/svg+xml",
        "svg",
        Math.ceil(box.width),
        Math.ceil(box.height),
      ),
      box,
    ];
  }
  mathBlocks(pc: PageContent, lines: Line[]): Block[] {
    const blocks: Block[] = [];
    for (let j = 0; j < lines.length; j++) {
      const l = lines[j];
      if (l.used || !mathLine(l)) continue;
      l.used = true;
      const group = [...l.spans];
      let box = l.box,
        text = l.text;
      for (let k = j + 1; k < lines.length; k++) {
        const next = lines[k];
        if (next.box.y > box.y + box.height + Math.max(l.size, 10) * 1.6) break;
        if (
          next.used ||
          !mathFragment(next) ||
          next.box.x > box.x + box.width + l.size ||
          box.x > next.box.x + next.box.width + l.size
        )
          continue;
        next.used = true;
        group.push(...next.spans);
        box = union(box, next.box);
        text += " " + next.text;
      }
      for (let k = 0; k < lines.length; k++) {
        const candidate = lines[k];
        if (
          candidate.used ||
          !candidate.math ||
          candidate.baseline < box.y ||
          candidate.baseline > box.y + box.height ||
          candidate.box.x > box.x + box.width + l.size * 2 ||
          candidate.box.x + candidate.box.width < box.x - l.size * 2
        )
          continue;
        const words = proseWords(candidate.text).filter(
          (w) => !mathWords.has(w.toLowerCase()),
        );
        if (
          !words.length ||
          words.join("").length > 28 ||
          !operators.test(candidate.text)
        )
          continue;
        let mathCount = 0,
          annotationX = Infinity;
        for (const s of candidate.spans) {
          if (s.font?.math) mathCount += runeCount(s.text);
          if (proseWords(s.text).some((w) => !mathWords.has(w.toLowerCase())))
            annotationX = Math.min(annotationX, s.box.x);
        }
        if (mathCount < 3) continue;
        candidate.used = true;
        group.push(...candidate.spans);
        box = union(box, candidate.box);
        text += " " + candidate.text;
        if (k + 1 < lines.length && annotationX > box.x + box.width * 0.45) {
          let n = k + 1;
          while (n < lines.length && lines[n].used) n++;
          if (n === lines.length) continue;
          const next = lines[n];
          if (
            !next.used &&
            annotationContinuation(candidate, next) &&
            Math.abs(next.box.x - annotationX) <= l.size &&
            next.box.x + next.box.width <= box.x + box.width + l.size &&
            next.baseline > candidate.baseline &&
            next.baseline - candidate.baseline < l.size * 2 &&
            byteLength(next.text) < 70
          ) {
            next.used = true;
            group.push(...next.spans);
            box = union(box, next.box);
            text += " " + next.text;
          }
        }
      }
      for (const candidate of lines) {
        if (
          candidate.used ||
          !intersects(candidate.box, expand(box, Math.max(l.size, 10) * 0.4))
        )
          continue;
        const kept: Span[] = [];
        for (const s of candidate.spans) {
          if (
            contained(s.box, box, Math.max(l.size, 10) * 0.4) &&
            mathFragment({ text: s.text, mono: s.mono })
          ) {
            group.push(s);
            box = union(box, s.box);
            text += " " + s.text;
          } else kept.push(s);
        }
        if (kept.length === candidate.spans.length) continue;
        candidate.spans = kept;
        if (!kept.length) candidate.used = true;
        else {
          candidate.box = kept
            .slice(1)
            .reduce((b, s) => union(b, s.box), kept[0].box);
          finishLine(candidate);
        }
      }
      const paths = pc.paths.filter((path) =>
          contained(path.box, box, l.size * 0.4),
        ),
        [asset, visualBox] = this.positionedAsset(pc, group, paths, box, text);
      blocks.push({
        kind: "math",
        text,
        asset,
        alt: text,
        box: visualBox,
        representation: "positioned",
        role: "formula",
        widthEm: visualBox.width / l.size,
        monochrome: monochromeMath(group, paths),
      });
    }
    if (blocks.length)
      this.p.warn(
        "math-positioned",
        0,
        "Equations preserve PDF glyph positions and paths. Their linear text is not semantic LaTeX or MathML.",
      );
    return blocks;
  }
  inlineMath(pc: PageContent, l: Line): void {
    const runs: Run[] = [];
    for (let j = 0; j < l.spans.length; ) {
      const s = l.spans[j];
      let end = j + 1;
      if (s.font?.math)
        while (end < l.spans.length) {
          const n = l.spans[end],
            prev = l.spans[end - 1];
          if (
            !n.font?.math ||
            n.box.x - prev.box.x - prev.box.width > l.size * 0.8
          )
            break;
          end++;
        }
      let unmapped = false,
        visual = false,
        box = s.box;
      for (let k = j; k < end; k++) {
        const v = l.spans[k];
        unmapped ||= !!v.font && v.text.includes("�");
        box = union(box, v.box);
        visual ||= !!v.script || v.size > l.size * 1.35;
      }
      visual ||= unmapped;
      let prefix = "";
      if (j > 0) {
        const prev = l.spans[j - 1];
        if (
          s.box.x - prev.box.x - prev.box.width > Math.max(1, l.size * 0.15) &&
          !prev.text.endsWith(" ") &&
          !s.text.startsWith(" ")
        )
          prefix = " ";
      }
      if (visual && s.font && (s.font.math || unmapped)) {
        const group = l.spans.slice(j, end),
          text = group.map((v) => deLigature(v.text)).join(""),
          [asset, box2] = this.positionedAsset(pc, group, [], box, text);
        if (prefix) runs.push({ text: prefix });
        runs.push({
          text,
          asset,
          heightEm: box2.height / l.size,
          depthEm: Math.max(0, (box2.y + box2.height - l.baseline) / l.size),
          monochrome: monochromeMath(group, []),
        });
      } else
        for (let k = j; k < end; k++) {
          const v = l.spans[k];
          runs.push({
            text: (k === j ? prefix : "") + deLigature(v.text),
            bold: v.bold,
            italic: v.italic,
            link: v.link,
            script: v.script,
          });
        }
      j = end;
    }
    l.runs = runs;
  }
  vectorAsset(pc: PageContent, represented: Block[], lines: Line[]): void {
    if (pc.paths.length > 5000) {
      this.p.warn(
        "vector-complexity",
        pc.page.number,
        "More than 5000 paths on a page; vector grouping skipped.",
      );
      return;
    }
    const groups: { box: Rect; paths: VectorPath[] }[] = [];
    for (const path of pc.paths) {
      if (
        represented.some((b) => contained(path.box, b.box, 2)) ||
        path.box.width < 0.1 ||
        path.box.height < 0.1
      )
        continue;
      const c = { box: path.box, paths: [path] };
      for (let j = 0; j < groups.length; ) {
        if (intersects(expand(c.box, 2), groups[j].box)) {
          c.box = union(c.box, groups[j].box);
          c.paths.push(...groups[j].paths);
          groups.splice(j, 1);
          j = 0;
        } else j++;
      }
      groups.push(c);
    }
    for (const group of groups) {
      const box = group.box;
      if (box.width < 12 || box.height < 12) continue;
      const labels: Span[] = [],
        texts: string[] = [];
      let chars = 0;
      for (const l of lines)
        if (!l.used)
          for (const s of l.spans)
            if (contained(s.box, box, 2)) {
              labels.push(s);
              texts.push(s.text);
              chars += byteLength(s.text);
            }
      if (group.paths.length < 8 && chars > 50) continue;
      if (
        group.paths.length === 1 &&
        !chars &&
        (group.paths[0].svg.match(/C/g) || []).length < 5
      )
        continue;
      for (const l of lines) {
        if (l.used) continue;
        const kept = l.spans.filter((s) => !contained(s.box, box, 2));
        if (kept.length === l.spans.length) continue;
        l.spans = kept;
        if (!kept.length) l.used = true;
        else {
          l.box = kept.slice(1).reduce((b, s) => union(b, s.box), kept[0].box);
          finishLine(l);
        }
      }
      const text = texts.join(" "),
        [asset, visualBox] = this.positionedAsset(
          pc,
          labels,
          group.paths,
          box,
          text,
        );
      pc.images.push({
        kind: "image",
        asset,
        alt: "Vector illustration",
        text,
        box: visualBox,
        representation: "positioned",
      });
    }
  }
}
