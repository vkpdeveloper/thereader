import { type Rect, type Run } from "./model";
import { type PageContent, type Span } from "./content";
import { union } from "./geometry";

export interface Line {
  spans: Span[];
  baseline: number;
  math: boolean;
  box: Rect;
  size: number;
  bold: boolean;
  mono: boolean;
  role: string;
  cells: string[];
  starts: number[];
  text: string;
  runs: Run[];
  used: boolean;
}
export const newLine = (box: Rect, baseline = 0): Line => ({
  spans: [],
  baseline,
  math: false,
  box,
  size: 0,
  bold: false,
  mono: false,
  role: "",
  cells: [],
  starts: [],
  text: "",
  runs: [],
  used: false,
});
export function runeCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
export function byteLength(s: string): number {
  let n = 0;
  for (const c of s) {
    const v = c.codePointAt(0)!;
    n += v < 128 ? 1 : v < 2048 ? 2 : v < 65536 ? 3 : 4;
  }
  return n;
}
const ligatures: Record<string, string> = {
  ﬁ: "fi",
  ﬂ: "fl",
  ﬀ: "ff",
  ﬃ: "ffi",
  ﬄ: "ffl",
  "\u00ad": "",
  "\u00a0": " ",
};
export const deLigature = (s: string): string =>
  s.replace(/[ﬁﬂﬀﬃﬄ\u00ad\u00a0]/g, (c) => ligatures[c]);
export const spanBaseline = (s: Span): number =>
  s.baseline || s.box.y + s.box.height * 0.78;
export function bodyFontSize(pages: PageContent[]): number {
  const counts = new Map<number, number>();
  for (const pc of pages)
    for (const s of pc.spans)
      if (s.size > 0 && s.size < 100) {
        const k = Math.floor(s.size * 2 + 0.5);
        counts.set(k, (counts.get(k) || 0) + runeCount(s.text));
      }
  let best = 22,
    weight = 0;
  for (const [k, n] of counts)
    if (n > weight || (n === weight && k < best)) {
      best = k;
      weight = n;
    }
  return best / 2;
}
export function makeLines(spans: Span[]): Line[] {
  // Go copies spans by value. Preserve that ownership here when adding scripts.
  const ordered = spans
      .map((s) => ({ ...s }))
      .sort((a, b) => spanBaseline(a) - spanBaseline(b)),
    lines: Line[] = [];
  for (const s of ordered) {
    if (!s.text.trim()) continue;
    const baseline = spanBaseline(s);
    let target: Line | undefined;
    const last = lines.at(-1);
    if (
      last &&
      Math.abs(baseline - last.baseline) <
        Math.max(0.6, Math.min(s.size, last.size) * 0.25)
    )
      target = last;
    if (!target) {
      target = newLine(s.box, baseline);
      lines.push(target);
    } else target.box = union(target.box, s.box);
    target.size = Math.max(target.size, s.size);
    target.spans.push(s);
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i],
      kept: Span[] = [];
    for (const s of l.spans) {
      let host: Line | undefined,
        best = Infinity;
      const accent = !s.script && /^[\p{M}\s]*$/u.test(s.text);
      for (let j = Math.max(0, i - 4); j < Math.min(lines.length, i + 5); j++) {
        const h = lines[j],
          dy = spanBaseline(s) - h.baseline;
        if (
          i === j ||
          (!accent && h.size < s.size * 1.18) ||
          Math.abs(dy) > h.size * 0.72 ||
          Math.abs(dy) < h.size * 0.12
        )
          continue;
        const dx = Math.max(
          h.box.x - s.box.x - s.box.width,
          s.box.x - h.box.x - h.box.width,
        );
        if (dx > h.size * 0.6) continue;
        const score = Math.abs(dy) + Math.max(0, dx);
        if (score < best) {
          host = h;
          best = score;
        }
      }
      if (host) {
        s.script = spanBaseline(s) > host.baseline ? "sub" : "sup";
        host.spans.push(s);
        host.box = union(host.box, s.box);
      } else kept.push(s);
    }
    l.spans = kept;
  }
  const out = lines.filter((l) => l.spans.length);
  out.forEach(finishLine);
  return out.sort((a, b) =>
    Math.abs(a.baseline - b.baseline) > 0.5
      ? a.baseline - b.baseline
      : a.box.x - b.box.x,
  );
}
export function finishLine(l: Line): void {
  l.spans.sort((a, b) => a.box.x - b.box.x);
  let text = "",
    cell = "";
  l.cells = [];
  l.starts = [];
  l.runs = [];
  l.text = "";
  const weights = new Map<number, number>();
  l.mono = true;
  l.math = false;
  l.bold = true;
  l.spans.forEach((s, j) => {
    const t = deLigature(s.text),
      prev = l.spans[j - 1],
      gap = prev ? s.box.x - prev.box.x - prev.box.width : 0;
    if (j === 0 || gap > Math.max(8, s.size * 1.5)) {
      if (j) {
        l.cells.push(cell.trim());
        cell = "";
      }
      l.starts.push(s.box.x);
    }
    const space =
      j > 0 &&
      gap > Math.max(1, s.size * 0.15) &&
      !text.endsWith(" ") &&
      !t.startsWith(" ")
        ? " "
        : "";
    text += space + t;
    cell += space + t;
    const last = l.runs.at(-1);
    if (
      last &&
      !!last.bold === s.bold &&
      !!last.italic === s.italic &&
      (last.link || "") === s.link &&
      (last.script || "") === s.script
    )
      last.text += space + t;
    else
      l.runs.push({
        text: space + t,
        ...(s.bold ? { bold: true } : {}),
        ...(s.italic ? { italic: true } : {}),
        ...(s.link ? { link: s.link } : {}),
        ...(s.script ? { script: s.script } : {}),
      });
    if (!s.script) {
      const size = Math.floor(s.size * 10 + 0.5) / 10;
      weights.set(size, (weights.get(size) || 0) + runeCount(t));
    }
    l.math ||= s.font.math;
    l.bold &&= s.bold;
    l.mono &&= s.mono;
    if (s.role && s.role !== "Span") l.role = s.role;
  });
  if (!weights.size) for (const s of l.spans) l.size = Math.max(l.size, s.size);
  let best = 0;
  for (const [size, weight] of weights)
    if (weight > best || (weight === best && size > l.size)) {
      l.size = size;
      best = weight;
    }
  l.cells.push(cell.trim());
  l.text = l.mono ? text.replace(/[ \t\r\n]+$/, "") : text.trim();
}
export function cleanMargins(pages: PageContent[]): void {
  if (pages.length < 2) return;
  const body = bodyFontSize(pages),
    grouped = pages.map((p) => makeLines(p.spans)),
    counts = new Map<string, number>();
  const key = (pc: PageContent, l: Line): string => {
    if (
      l.size > body * 1.1 ||
      (l.bold && l.size >= body * 0.98) ||
      byteLength(l.text) > 180
    )
      return "";
    let side = "top:";
    if (l.box.y + l.box.height < pc.page.height * 0.08) {
    } else if (l.box.y > pc.page.height * 0.94) side = "bottom:";
    else return "";
    return side + l.text.trim().toLowerCase().replace(/\d+/g, "#");
  };
  grouped.forEach((lines, n) => {
    const seen = new Set<string>();
    for (const l of lines) {
      const k = key(pages[n], l);
      if (k && !seen.has(k)) {
        seen.add(k);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
  });
  const position = (s: Span) => `${s.box.x}:${s.box.y}:${s.text}`;
  grouped.forEach((lines, n) => {
    const drop = new Set<string>();
    for (const l of lines) {
      const k = key(pages[n], l);
      if (
        k &&
        ((counts.get(k) || 0) >=
          Math.max(2, Math.min(6, Math.floor((pages.length + 1) / 2))) ||
          /^(?:page\s+)?(?:\d+|[ivxlcdm]+)(?:\s*(?:of|\/)\s*\d+)?$/i.test(
            l.text,
          ))
      )
        for (const s of l.spans) drop.add(position(s));
    }
    pages[n].spans = pages[n].spans.filter((s) => !drop.has(position(s)));
  });
}
export function columnOrder(lines: Line[], width: number): Line[] {
  const candidates: number[] = [];
  for (const l of lines)
    for (let j = 1; j < l.spans.length; j++) {
      const a = l.spans[j - 1],
        b = l.spans[j],
        gap = b.box.x - a.box.x - a.box.width,
        mid = (b.box.x + a.box.x + a.box.width) / 2;
      if (gap > width * 0.035 && mid > width * 0.3 && mid < width * 0.7)
        candidates.push(mid);
    }
  lines.forEach((l, i) => {
    if (l.mono || l.box.width < width * 0.15) return;
    for (
      let j = i + 1;
      j < lines.length && lines[j].baseline - l.baseline < l.size * 0.9;
      j++
    ) {
      const r = lines[j];
      if (r.mono || r.box.width < width * 0.15) continue;
      const [a, b] = l.box.x > r.box.x ? [r, l] : [l, r];
      const gap = b.box.x - a.box.x - a.box.width,
        mid = (b.box.x + a.box.x + a.box.width) / 2;
      if (gap > width * 0.015 && mid > width * 0.3 && mid < width * 0.7)
        candidates.push(mid);
    }
  });
  if (candidates.length < 3) return lines;
  candidates.sort((a, b) => a - b);
  const cut = candidates[Math.floor(candidates.length / 2)];
  const out: Line[] = [];
  let left: Line[] = [],
    right: Line[] = [];
  const flush = () => {
    out.push(...left, ...right);
    left = [];
    right = [];
  };
  const part = (spans: Span[]): Line => {
    const n = newLine(spans[0].box, spanBaseline(spans[0]));
    n.spans = spans;
    for (const s of spans.slice(1)) n.box = union(n.box, s.box);
    finishLine(n);
    return n;
  };
  for (const l of lines) {
    const ls: Span[] = [],
      rs: Span[] = [];
    let cross = false;
    for (const s of l.spans) {
      if (s.box.x < cut && s.box.x + s.box.width > cut) cross = true;
      (s.box.x < cut ? ls : rs).push(s);
    }
    if (cross) {
      flush();
      out.push(l);
      continue;
    }
    if (ls.length) left.push(part(ls));
    if (rs.length) right.push(part(rs));
  }
  flush();
  return out;
}
export function classifyLine(l: Line, body: number): [string, number, string] {
  let role = "";
  switch (l.role) {
    case "Formula":
      return ["math", 0, "formula"];
    case "Code":
      return ["code", 0, ""];
    case "H":
    case "H1":
      return ["heading", 1, ""];
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return ["heading", Number(l.role[1]), ""];
    case "LI":
    case "LBody":
      return ["list", 0, ""];
    case "Caption":
      role = "caption";
      break;
    case "Note":
      role = "footnote";
      break;
    case "Reference":
    case "BibEntry":
      role = "reference";
      break;
    case "Index":
      role = "index";
      break;
  }
  if (l.mono && runeCount(l.text) > 0) return ["code", 0, role];
  const n = byteLength(l.text);
  if (
    l.bold &&
    l.size >= body * 0.8 &&
    n < 150 &&
    /^(?:[A-Z]|\d+)(?:\.\d+){1,3}\s+\p{L}/u.test(l.text)
  )
    return ["heading", 3, role];
  if (
    n < 200 &&
    ((l.size >= body * 1.18 && l.size - body >= 1) ||
      (l.bold &&
        n < 80 &&
        l.text.trim().split(/\s+/).length <= 10 &&
        l.size >= body * 0.98 &&
        !/[.,]$/.test(l.text)))
  )
    return [
      "heading",
      l.size >= body * 1.65 ? 1 : l.size < body * 1.25 ? 3 : 2,
      role,
    ];
  if (/^(?:[•●▪◦‣]|[-*]\s|\d+[.)]\s)/.test(l.text)) return ["list", 0, role];
  if (/^(figure|table) /i.test(l.text) && l.size < body * 1.05)
    role = "caption";
  if (l.size < body * 0.82 && !role) role = "footnote";
  return ["paragraph", 0, role];
}
export const canDehyphenate = (a: string, b: string): boolean =>
  /\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b);
export const endsSoftHyphen = (l: Line): boolean =>
  !!l.spans.at(-1)?.text.trim().endsWith("\u00ad");
export function pageWords(lines: Line[]): Set<string> {
  const words = new Set<string>();
  for (const l of lines)
    if (!l.mono && !l.math)
      for (const w of l.text.split(/[^\p{L}-]+/u))
        if (byteLength(w) > 2 && !w.endsWith("-")) words.add(w.toLowerCase());
  return words;
}
export function witnessedHyphen(
  a: string,
  b: string,
  words: Set<string>,
): boolean {
  if (!canDehyphenate(a, b)) return false;
  const prefix = a.match(/(\p{L}+)-$/u)?.[1].toLowerCase(),
    suffix = b.match(/^\p{L}+/u)?.[0].toLowerCase();
  return (
    !!prefix &&
    !!suffix &&
    words.has(prefix + suffix) &&
    !words.has(prefix + "-" + suffix)
  );
}
export function codeLanguage(text: string): string {
  const t = text.trim();
  if (t.includes("package ") && (t.includes("func ") || t.includes("import ")))
    return "go";
  if (t.includes("def ") && t.includes(":")) return "python";
  if (/#include|std::/.test(t)) return "cpp";
  if (t.includes("fn ") && (t.includes("let ") || t.includes("->")))
    return "rust";
  if (/interface |: string|: number/.test(t)) return "typescript";
  if (/const |function |console\.log\(/.test(t)) return "javascript";
  if (t.toUpperCase().includes("SELECT ") && t.toUpperCase().includes(" FROM "))
    return "sql";
  if (t.startsWith("#!/bin/") || t.startsWith("$ ")) return "bash";
  if (t.startsWith("{\n") && t.includes('\":')) return "json";
  if (t.includes("<html") || t.includes("<!DOCTYPE")) return "html";
  return "";
}
