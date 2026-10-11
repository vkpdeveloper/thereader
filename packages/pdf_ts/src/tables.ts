import { type Block, type Rect, type Table } from "./model";
import { type Ruling, type Span } from "./content";
import {
  type Line,
  byteLength,
  deLigature,
  finishLine,
  makeLines,
  newLine,
  spanBaseline,
} from "./lines";
import { union } from "./geometry";

const median = (v: number[]): number =>
  v.sort((a, b) => a - b)[Math.floor(v.length / 2)];
const lowerBound = (v: number[], n: number): number => {
  let lo = 0,
    hi = v.length;
  while (lo < hi) {
    const m = Math.floor((lo + hi) / 2);
    if (v[m] < n) lo = m + 1;
    else hi = m;
  }
  return lo;
};
export function tableBand(
  rules: Ruling[],
  region: Rect,
  y: number,
  x: number,
): [number, number] {
  let top = region.y,
    bottom = region.y + region.height;
  for (const r of rules) {
    if (
      Math.abs(r.y1 - r.y2) > 1 ||
      x < Math.min(r.x1, r.x2) - 1 ||
      x > Math.max(r.x1, r.x2) + 1
    )
      continue;
    if (r.y1 < y && r.y1 > top) top = r.y1;
    if (r.y1 > y && r.y1 < bottom) bottom = r.y1;
  }
  return [top, bottom];
}
function removeRegion(l: Line, region: Rect): void {
  l.spans = l.spans.filter(
    (s) =>
      s.box.x < region.x - 2 ||
      s.box.x + s.box.width > region.x + region.width + 2,
  );
  if (!l.spans.length) l.used = true;
  else {
    l.box = l.spans[0].box;
    for (const s of l.spans.slice(1)) l.box = union(l.box, s.box);
    finishLine(l);
  }
}
function tableParts(l: Line, region: Rect, rules: Ruling[]): Line[] {
  const out: Line[] = [];
  let part: Line | undefined;
  for (const s of l.spans) {
    if (
      s.box.x < region.x - 2 ||
      s.box.x + s.box.width > region.x + region.width + 2
    )
      continue;
    let split = !part;
    if (part) {
      const prev = part.spans.at(-1)!;
      split =
        s.box.x - prev.box.x - prev.box.width > Math.max(4, s.size * 0.75);
      for (const r of rules)
        if (
          Math.abs(r.x1 - r.x2) < 1 &&
          r.x1 > prev.box.x + prev.box.width &&
          r.x1 < s.box.x &&
          l.baseline >= Math.min(r.y1, r.y2) &&
          l.baseline <= Math.max(r.y1, r.y2)
        ) {
          split = true;
          break;
        }
    }
    if (split) {
      part = newLine(s.box, l.baseline);
      out.push(part);
    } else part!.box = union(part!.box, s.box);
    part!.spans.push(s);
  }
  out.forEach(finishLine);
  return out;
}
export function buildRuledTable(
  lines: Line[],
  rules: Ruling[],
  region: Rect,
  body: number,
): Block | undefined {
  const rows: { line: Line; parts: Line[] }[] = [];
  let headerEnd = region.y;
  for (const r of rules)
    if (
      Math.abs(r.y1 - r.y2) < 1 &&
      r.y1 > region.y + body * 0.7 &&
      r.y1 < region.y + region.height - 1 &&
      Math.min(r.x1, r.x2) <= region.x + 2 &&
      Math.max(r.x1, r.x2) >= region.x + region.width - 2
    ) {
      if (headerEnd === region.y || r.y1 < headerEnd) headerEnd = r.y1;
    }
  const freq = new Map<number, number>();
  for (const l of lines) {
    if (
      l.used ||
      l.baseline < region.y ||
      l.baseline > region.y + region.height + 1
    )
      continue;
    const parts = tableParts(l, region, rules);
    if (!parts.length) continue;
    rows.push({ line: l, parts });
    if (l.baseline > headerEnd && parts.length >= 2 && parts.length <= 64)
      freq.set(parts.length, (freq.get(parts.length) || 0) + 1);
  }
  let columns = 0,
    count = 0;
  for (const [n, f] of freq)
    if (f > count || (f === count && n > columns)) {
      columns = n;
      count = f;
    }
  if (columns < 2 || count < 2 || rows.length < 3) return;
  if (columns <= 3 && rows.length >= 8) {
    let prose = 0,
      total = 0;
    for (const r of rows)
      for (const part of r.parts) {
        total++;
        if (
          part.text.trim().split(/\s+/).length >= 6 &&
          byteLength(part.text) > 35
        )
          prose++;
      }
    let rowRules = 0;
    for (const r of rules)
      if (
        Math.abs(r.y1 - r.y2) < 1 &&
        r.y1 > region.y + body &&
        r.y1 < region.y + region.height - body &&
        Math.min(r.x1, r.x2) <= region.x + 2 &&
        Math.max(r.x1, r.x2) >= region.x + region.width - 2
      )
        rowRules++;
    if (prose * 2 > total && rowRules < 3) return;
  }
  const left: number[] = [],
    right: number[] = [];
  for (let c = 0; c < columns; c++) {
    const a: number[] = [],
      b: number[] = [];
    for (const r of rows)
      if (r.line.baseline > headerEnd && r.parts.length === columns) {
        a.push(r.parts[c].box.x);
        b.push(r.parts[c].box.x + r.parts[c].box.width);
      }
    left.push(median(a));
    right.push(median(b));
  }
  const extras: { left: number; right: number; n: number }[] = [];
  for (const r of rows) {
    if (r.line.baseline <= headerEnd) continue;
    for (const part of r.parts) {
      const a = part.box.x,
        b = a + part.box.width;
      if (b >= left[0] - body * 0.4 && a <= right.at(-1)! + body * 0.4)
        continue;
      const e = extras.find(
        (e) =>
          Math.abs(a - e.left) < body * 0.5 ||
          Math.abs((a + b - e.left - e.right) / 2) < body,
      );
      if (!e) extras.push({ left: a, right: b, n: 1 });
      else {
        e.left = (e.left * e.n + a) / (e.n + 1);
        e.right = (e.right * e.n + b) / (e.n + 1);
        e.n++;
      }
    }
  }
  for (const e of extras)
    if (e.n >= 2) {
      left.push(e.left);
      right.push(e.right);
    }
  const cols = left
    .map((v, i) => ({ left: v, right: right[i] }))
    .sort((a, b) => a.left - b.left);
  if (cols.length > 64) return;
  const bound = [
    region.x,
    ...cols.slice(1).map((c, i) => (cols[i].right + c.left) / 2),
    region.x + region.width,
  ];
  for (let c = 1; c < bound.length; c++) if (bound[c] <= bound[c - 1]) return;
  const columnAt = (box: Rect): number => {
    let best = 0,
      overlap = -1;
    cols.forEach((_, c) => {
      const n = Math.max(
        0,
        Math.min(box.x + box.width, bound[c + 1]) - Math.max(box.x, bound[c]),
      );
      if (n > overlap) {
        best = c;
        overlap = n;
      }
    });
    return best;
  };
  const headerCuts: number[] = [];
  for (const r of rules)
    if (
      Math.abs(r.y1 - r.y2) < 1 &&
      r.y1 > region.y + 1 &&
      r.y1 < headerEnd - 1 &&
      Math.abs(r.x2 - r.x1) > body * 3
    )
      headerCuts.push(r.y1);
  headerCuts.sort((a, b) => a - b);
  const cuts: number[] = [];
  for (const y of headerCuts)
    if (!cuts.length || y - cuts.at(-1)! > 2) cuts.push(y);
  const headerBaselines = Array.from(
    { length: cuts.length + 1 },
    () => [] as number[],
  );
  for (const r of rows)
    if (r.line.baseline < headerEnd)
      headerBaselines[lowerBound(cuts, r.line.baseline)].push(r.line.baseline);
  const ys = headerBaselines.filter((b) => b.length).map(median),
    headerRows = ys.length;
  for (const r of rows)
    if (
      r.line.baseline >= headerEnd &&
      r.parts.length >= Math.max(2, columns - 2)
    )
      ys.push(r.line.baseline);
  if (ys.length - headerRows < 2) return;
  for (const r of rows) {
    if (
      r.parts.length !== 1 ||
      r.line.baseline < headerEnd ||
      byteLength(r.parts[0].text) > 100
    )
      continue;
    const part = r.parts[0];
    if (part.box.x + part.box.width / 2 < region.x + region.width * 0.3)
      continue;
    const [top, bottom] = tableBand(
      rules,
      region,
      r.line.baseline,
      region.x + region.width / 2,
    );
    if (!ys.some((y) => y > top && y < bottom) && bottom - top < body * 3)
      ys.push(r.line.baseline);
  }
  ys.sort((a, b) => a - b);
  if (ys.length * cols.length > 100000) return;
  const t: Table = {
      rows: ys.length,
      columns: cols.length,
      ...(headerRows ? { headerRows } : {}),
      cells: [],
    },
    partsByCell = new Map<string, Span[]>(),
    cellIndex = new Map<string, number>();
  const key = (r: number, c: number) => `${r}:${c}`;
  for (const r of rows)
    for (const part of r.parts) {
      let row = 0,
        dy = Infinity;
      ys.forEach((y, j) => {
        const d = Math.abs(y - r.line.baseline);
        if (d < dy) {
          row = j;
          dy = d;
        }
      });
      let col = columnAt(part.box),
        cs = 1;
      if (row < headerRows) {
        for (const rule of rules) {
          const a = Math.min(rule.x1, rule.x2),
            b = Math.max(rule.x1, rule.x2);
          if (
            Math.abs(rule.y1 - rule.y2) > 1 ||
            rule.y1 <= r.line.baseline ||
            rule.y1 - r.line.baseline > body ||
            b - a >= region.width * 0.9 ||
            part.box.x < a - body ||
            part.box.x + part.box.width > b + body
          )
            continue;
          let first = -1,
            last = -1;
          cols.forEach((v, c) => {
            const center = (v.left + v.right) / 2;
            if (center >= a - 1 && center <= b + 1) {
              if (first < 0) first = c;
              last = c;
            }
          });
          if (first >= 0) {
            col = first;
            cs = last - first + 1;
            break;
          }
        }
      } else if (
        r.parts.length === 1 &&
        byteLength(part.text) <= 100 &&
        part.box.x + part.box.width / 2 >= region.x + region.width * 0.3
      ) {
        const [top, bottom] = tableBand(
          rules,
          region,
          r.line.baseline,
          region.x + region.width / 2,
        );
        if (
          ys.filter((y) => y > top && y < bottom).length === 1 &&
          bottom - top < body * 3
        ) {
          col = 0;
          cs = cols.length;
        }
      }
      const k = key(row, col),
        spans = partsByCell.get(k) || [];
      for (const s of part.spans)
        spans.push({ ...s, baseline: r.line.baseline });
      partsByCell.set(k, spans);
      const at = cellIndex.get(k);
      if (at !== undefined) {
        const c = t.cells[at];
        c.colSpan = Math.max(c.colSpan, cs);
        c.box = union(c.box, part.box);
      } else {
        cellIndex.set(k, t.cells.length);
        t.cells.push({
          row,
          column: col,
          rowSpan: 1,
          colSpan: cs,
          text: "",
          box: part.box,
        });
      }
    }
  if (headerRows > 0 && cols.length > columns)
    for (const c of t.cells) {
      if (c.row !== headerRows - 1 || c.column !== 1 || c.colSpan !== 1)
        continue;
      if (
        !t.cells.some((other) => other.row === c.row && other.column === 0) &&
        c.box.x < bound[1] &&
        c.box.x + c.box.width > bound[1]
      ) {
        c.column = 0;
        c.colSpan = 2;
        partsByCell.set(key(c.row, 0), partsByCell.get(key(c.row, 1))!);
      }
    }
  const byColumn = Array.from({ length: cols.length }, () => [] as number[]);
  t.cells.forEach((c, j) => {
    if (c.row >= headerRows)
      for (
        let col = c.column;
        col < Math.min(cols.length, c.column + c.colSpan);
        col++
      )
        byColumn[col].push(j);
  });
  t.cells.forEach((c, j) => {
    const spans = partsByCell.get(key(c.row, c.column))!;
    c.runs = [];
    for (const l of makeLines(spans)) {
      if (c.text) {
        c.text += " ";
        c.runs.push({ text: " " });
      }
      c.text += l.text;
      c.runs.push(...l.runs);
    }
    if (c.row < headerRows) {
      c.header = true;
      c.scope = c.colSpan > 1 ? "colgroup" : "col";
      return;
    }
    if (byColumn[c.column].length * 2 > ys.length - headerRows) return;
    const baseline = spanBaseline(spans[0]),
      [top, bottom] = tableBand(
        rules,
        region,
        baseline,
        (cols[c.column].left + cols[c.column].right) / 2,
      );
    let first = -1,
      last = -1;
    ys.forEach((y, r) => {
      if (r >= headerRows && y > top && y < bottom) {
        if (first < 0) first = r;
        last = r;
      }
    });
    if (
      first < 0 ||
      last - first < 1 ||
      Math.abs(baseline - (ys[first] + ys[last]) / 2) >
        Math.max(body, (bottom - top) * 0.12)
    )
      return;
    const occupied = byColumn[c.column].some((k) => {
      const other = t.cells[k];
      return (
        k !== j &&
        other.row <= last &&
        other.row + other.rowSpan > first &&
        other.column <= c.column &&
        other.column + other.colSpan > c.column
      );
    });
    if (!occupied) {
      c.row = first;
      c.rowSpan = last - first + 1;
      if (c.column === 0) {
        c.header = true;
        c.scope = "rowgroup";
      }
    }
  });
  const used = new Uint8Array(t.rows * t.columns);
  for (const c of t.cells)
    for (let r = c.row; r < c.row + c.rowSpan; r++)
      for (let col = c.column; col < c.column + c.colSpan; col++) {
        const at = r * t.columns + col;
        if (at < 0 || at >= used.length || col >= t.columns || used[at]) return;
        used[at] = 1;
      }
  const textRows = Array.from({ length: t.rows }, () =>
    Array<string>(t.columns).fill(""),
  );
  for (let r = 0; r < t.rows; r++)
    for (let c = 0; c < t.columns; c++)
      if (!used[r * t.columns + c])
        t.cells.push({
          row: r,
          column: c,
          rowSpan: 1,
          colSpan: 1,
          text: "",
          ...(r < headerRows ? { header: true } : {}),
          box: { x: 0, y: 0, width: 0, height: 0 },
        });
  for (const c of t.cells) textRows[c.row][c.column] = c.text;
  t.cells.sort((a, b) => a.row - b.row || a.column - b.column);
  for (const r of rows) removeRegion(r.line, region);
  return { kind: "table", rows: textRows, table: t, box: region };
}
interface RuleGroup {
  x1: number;
  x2: number;
  ys: number[];
}
function ruleGroups(rules: Ruling[], body: number): RuleGroup[] {
  const groups: RuleGroup[] = [];
  for (const r of rules) {
    const x1 = Math.min(r.x1, r.x2),
      x2 = Math.max(r.x1, r.x2);
    if (Math.abs(r.y1 - r.y2) > 1 || x2 - x1 < body * 10) continue;
    let g = groups.find(
      (g) => Math.abs(g.x1 - x1) < 2 && Math.abs(g.x2 - x2) < 2,
    );
    if (!g) {
      g = { x1, x2, ys: [] };
      groups.push(g);
    }
    g.ys.push(r.y1);
  }
  return groups;
}
function legacyRuledTables(
  lines: Line[],
  rules: Ruling[],
  body: number,
): Block[] {
  const out: Block[] = [];
  for (const g of ruleGroups(rules, body)) {
    g.ys.sort((a, b) => a - b);
    for (let first = 0; first < g.ys.length; ) {
      let end = first + 1;
      while (end < g.ys.length && g.ys[end] - g.ys[end - 1] < body * 14) end++;
      const top = g.ys[first],
        bottom = g.ys[end - 1];
      first = end;
      if (bottom - top < body * 1.8) continue;
      const region = {
          x: g.x1,
          y: top,
          width: g.x2 - g.x1,
          height: bottom - top,
        },
        rows: Line[] = [],
        sources: Line[] = [],
        freq = new Map<number, number>();
      for (const l of lines) {
        if (l.used || l.mono || l.baseline < top || l.baseline > bottom + 1)
          continue;
        const part = l.spans.filter(
          (s) =>
            s.box.x >= region.x - 2 &&
            s.box.x + s.box.width <= region.x + region.width + 2,
        );
        if (!part.length) continue;
        const row = newLine(part[0].box, l.baseline);
        row.spans = part;
        for (const s of part.slice(1)) row.box = union(row.box, s.box);
        finishLine(row);
        rows.push(row);
        sources.push(l);
        if (row.cells.length >= 2 && row.cells.length <= 20)
          freq.set(row.cells.length, (freq.get(row.cells.length) || 0) + 1);
      }
      let columns = 0,
        count = 0;
      for (const [n, f] of freq)
        if (f > count || (f === count && n > columns)) {
          columns = n;
          count = f;
        }
      if (
        columns < 2 ||
        count < 2 ||
        rows.length < 2 ||
        count * 3 < rows.length
      )
        continue;
      const starts = Array.from({ length: columns }, (_, c) =>
          median(
            rows
              .filter((l) => l.cells.length === columns)
              .map((l) => l.starts[c]),
          ),
        ),
        boundaries: number[] = [];
      for (let c = 0; c < columns - 1; c++) {
        let right = starts[c];
        for (const l of rows)
          if (l.cells.length === columns)
            for (const s of l.spans)
              if (s.box.x >= l.starts[c] - 1 && s.box.x < l.starts[c + 1] - 1)
                right = Math.max(
                  right,
                  Math.min(s.box.x + s.box.width, starts[c + 1] - 1),
                );
        boundaries.push(right + (starts[c + 1] - right) * 0.25);
      }
      const cells: string[][] = [];
      rows.forEach((l, j) => {
        if (l.cells.length === 1 && byteLength(l.text) > 100) return;
        const row = Array<string>(columns).fill(""),
          last = Array<Span | undefined>(columns);
        for (const s of l.spans) {
          const c = lowerBound(
              boundaries,
              s.box.x + Math.min(s.box.width * 0.3, 2),
            ),
            t = deLigature(s.text),
            prev = last[c];
          if (
            prev &&
            s.box.x - prev.box.x - prev.box.width >
              Math.max(1, s.size * 0.15) &&
            !row[c].endsWith(" ") &&
            !t.startsWith(" ")
          )
            row[c] += " ";
          row[c] += t;
          last[c] = s;
        }
        cells.push(row.map((t) => t.trim()));
        removeRegion(sources[j], region);
      });
      out.push({ kind: "table", rows: cells, box: region });
    }
  }
  return out;
}
function ruledTables(lines: Line[], rules: Ruling[], body: number): Block[] {
  const regions: Rect[] = [];
  for (const g of ruleGroups(rules, body)) {
    g.ys.sort((a, b) => a - b);
    let start = 0;
    for (let end = 1; end <= g.ys.length; end++) {
      let separate = end === g.ys.length;
      if (!separate) {
        let prose = 0;
        for (const l of lines) {
          if (l.used || l.baseline <= g.ys[end - 1] || l.baseline >= g.ys[end])
            continue;
          if (/^(table|figure) /i.test(l.text)) {
            separate = true;
            break;
          }
          if (
            byteLength(l.text) > 100 &&
            l.cells.length === 1 &&
            l.box.width > (g.x2 - g.x1) * 0.8
          )
            prose++;
        }
        separate ||= prose >= 2;
      }
      if (separate) {
        if (end - start >= 2 && g.ys[end - 1] - g.ys[start] > body * 1.8)
          regions.push({
            x: g.x1,
            y: g.ys[start],
            width: g.x2 - g.x1,
            height: g.ys[end - 1] - g.ys[start],
          });
        start = end;
      }
    }
  }
  regions.sort((a, b) => b.width * b.height - a.width * a.height);
  const out: Block[] = [];
  for (const region of regions) {
    const b = buildRuledTable(lines, rules, region, body);
    if (b) out.push(b);
  }
  out.push(...legacyRuledTables(lines, rules, body));
  return out.sort((a, b) => a.box.y - b.box.y);
}
export function detectTables(
  lines: Line[],
  rules: Ruling[],
  body: number,
): Block[] {
  const out = ruledTables(lines, rules, body);
  for (let i = 0; i < lines.length; ) {
    const l = lines[i],
      columns = l.cells.length;
    if (l.used || columns < 2 || columns > 20 || l.mono || l.math) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < lines.length) {
      const next = lines[end],
        prev = lines[end - 1];
      if (
        next.used ||
        next.math ||
        next.cells.length !== columns ||
        next.box.y - prev.box.y > body * 3 ||
        next.box.y - prev.box.y < 0 ||
        next.starts.some((s, c) => Math.abs(s - l.starts[c]) > body * 2)
      )
        break;
      end++;
    }
    let box = l.box,
      long = false;
    const rows: string[][] = [];
    for (let j = i; j < end; j++) {
      box = union(box, lines[j].box);
      rows.push(lines[j].cells);
      if (lines[j].cells.some((c) => byteLength(c) > 100)) long = true;
    }
    const ruled = rules.some(
        (r) =>
          Math.abs(r.y1 - r.y2) < 1 &&
          r.y1 >= box.y - body * 2 &&
          r.y1 <= box.y + box.height + body &&
          Math.abs(r.x2 - r.x1) >= box.width * 0.65,
      ),
      tagged = l.role === "TH" || l.role === "TD";
    if (
      end - i >= 2 &&
      !long &&
      (ruled || tagged || (end - i >= 3 && (columns >= 3 || l.bold)))
    ) {
      for (let j = i; j < end; j++) lines[j].used = true;
      out.push({ kind: "table", rows, box });
      i = end;
    } else i++;
  }
  return out;
}
