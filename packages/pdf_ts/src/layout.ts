import { type Block } from "./model";
import { type PageContent } from "./content";
import {
  type Line,
  makeLines,
  columnOrder,
  pageWords,
  classifyLine,
  codeLanguage,
  witnessedHyphen,
  canDehyphenate,
  endsSoftHyphen,
} from "./lines";
import { algorithmBlocks } from "./algorithm";
import { detectTables } from "./tables";
import { PositionedGraphics } from "./math";
import { union } from "./geometry";

export function layout(
  pc: PageContent,
  body: number,
  graphics: PositionedGraphics,
): Block[] {
  const lines = makeLines(pc.spans),
    algorithms = algorithmBlocks(lines, pc.rules, body),
    math = graphics.mathBlocks(pc, lines);
  graphics.vectorAsset(pc, math, lines);
  const tables = detectTables(lines, pc.rules, body),
    ordered = columnOrder(
      lines.filter((l) => !l.used),
      pc.page.width,
    ),
    words = pageWords(ordered);
  for (const l of ordered)
    if (l.math || l.text.includes("�")) graphics.inlineMath(pc, l);
  const blocks: Block[] = [];
  let current: Block | undefined, previous: Line | undefined;
  const flush = () => {
    if (current) {
      current.text =
        current.kind === "code"
          ? (current.text || "").replace(/[ \t\r\n]+$/, "")
          : (current.text || "").trim();
      if (current.kind === "code")
        current.language = codeLanguage(current.text);
      blocks.push(current);
      current = undefined;
    }
  };
  for (const l of ordered) {
    if (!l.text) continue;
    const [kind, level, role] = classifyLine(l, body),
      gap = previous ? l.box.y - previous.box.y - previous.box.height : 0;
    let join =
      !!current &&
      current.kind === kind &&
      kind !== "heading" &&
      kind !== "list" &&
      current.role === role &&
      !!previous &&
      gap >= -2 &&
      gap < Math.max(l.size * 0.8, 4) &&
      Math.abs(l.box.x - previous.box.x) < Math.max(l.size * 2, 24);
    if (kind === "heading" && current && previous)
      join =
        current.kind === "heading" &&
        current.level === level &&
        gap >= -2 &&
        gap < l.size * 0.8 &&
        (Math.abs(l.box.x - previous.box.x) < l.size ||
          Math.abs(
            l.box.x + l.box.width / 2 - previous.box.x - previous.box.width / 2,
          ) <
            l.size * 2);
    if (kind === "code")
      join =
        !!current && current.kind === "code" && gap >= -2 && gap < l.size * 3;
    if (join && current && previous) {
      let separator = " ";
      if (kind === "code") {
        separator = gap > l.size * 0.9 ? "\n\n" : "\n";
        const indent = Math.floor(
          Math.max(0, l.box.x - current.box.x) / Math.max(1, l.size * 0.6) +
            0.5,
        );
        separator += " ".repeat(Math.min(indent, 80));
      } else if (
        kind === "paragraph" &&
        !previous.math &&
        !l.math &&
        witnessedHyphen(current.text || "", l.text, words)
      ) {
        current.text = (current.text || "").replace(/-$/, "");
        const runs = current.runs || [];
        for (let j = runs.length - 1; j >= 0; j--)
          if (runs[j].text) {
            runs[j].text = runs[j].text.replace(/-$/, "");
            break;
          }
        separator = "";
      } else if (
        canDehyphenate(current.text || "", l.text) ||
        endsSoftHyphen(previous)
      )
        separator = "";
      current.text += separator + l.text;
      if (l.runs.length) {
        const runs = l.runs.map((r) => ({ ...r }));
        runs[0].text = separator + runs[0].text.replace(/^ +/, "");
        (current.runs ??= []).push(...runs);
      }
      current.box = union(current.box, l.box);
    } else {
      flush();
      current = { kind, text: l.text, runs: l.runs, level, role, box: l.box };
    }
    previous = l;
  }
  flush();
  for (const b of [...algorithms, ...math, ...tables, ...pc.images]) {
    let at = blocks.findIndex((t) => t.box.y > b.box.y + b.box.height * 0.25);
    if (at < 0) at = blocks.length;
    blocks.splice(at, 0, b);
  }
  return blocks;
}
