import { type Block } from "./model";
import { type Ruling } from "./content";
import { type Line, byteLength } from "./lines";
import { union } from "./geometry";
const step = /^(\d{1,4}):\s*/;
export function algorithmBlocks(
  lines: Line[],
  rules: Ruling[],
  body: number,
): Block[] {
  const out: Block[] = [];
  for (let start = 0; start < lines.length; start++) {
    const title = lines[start];
    if (title.used || !/^Algorithm\s+\d+[.:\s]/i.test(title.text)) continue;
    const ends = rules
      .filter(
        (r) =>
          Math.abs(r.y1 - r.y2) < 1 &&
          r.y1 > title.baseline + body * 4 &&
          Math.min(r.x1, r.x2) <= title.box.x + body &&
          Math.abs(r.x2 - r.x1) >= title.box.width,
      )
      .map((r) => r.y1)
      .sort((a, b) => a - b);
    for (const bottom of ends) {
      const selected: Line[] = [];
      let last = 0,
        numbered = 0,
        valid = true;
      for (const l of lines.slice(start + 1)) {
        if (l.baseline > bottom) break;
        if (l.used) {
          valid = false;
          break;
        }
        const m = step.exec(l.text);
        if (m) {
          const n = Number(m[1]);
          if (n !== last + 1) {
            valid = false;
            break;
          }
          last = n;
          numbered++;
        }
        selected.push(l);
      }
      if (!valid || numbered < 3) continue;
      const code: Block = {
        kind: "code",
        language: "pseudocode",
        role: "algorithm",
        text: "",
        box: selected[0].box,
      };
      let baseX = Infinity;
      const contentX = (l: Line) => {
        const m = step.exec(l.text)?.[0];
        if (!m) return l.box.x;
        let n = 0;
        for (const s of l.spans) {
          n += byteLength(s.text);
          if (n >= byteLength(m.trim())) {
            if (n === byteLength(m.trim())) continue;
            return s.box.x;
          }
        }
        return l.box.x;
      };
      for (const l of selected)
        if (step.test(l.text)) baseX = Math.min(baseX, contentX(l));
      selected.forEach((l, j) => {
        let text = l.text;
        const m = step.exec(text)?.[0];
        if (m) {
          const indent = Math.min(
            40,
            Math.floor(
              Math.max(0, contentX(l) - baseX) / Math.max(1, l.size * 0.75) +
                0.5,
            ),
          );
          text = m.trim() + " " + " ".repeat(indent) + text.slice(m.length);
        }
        if (j) {
          code.text += "\n";
          code.box = union(code.box, l.box);
        }
        code.text += text;
        l.used = true;
      });
      title.used = true;
      out.push(
        {
          kind: "paragraph",
          text: title.text,
          runs: title.runs,
          role: "caption",
          box: title.box,
        },
        code,
      );
      break;
    }
  }
  return out;
}
