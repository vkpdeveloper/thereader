import { type Document, type Options, PdfError, invalid, limit } from "./model";
import { PDF } from "./parser";
import {
  type Dict,
  type Value,
  Ref,
  Stream,
  asArray,
  integer,
  named,
  number,
} from "./syntax";
import { Fonts, textString } from "./font";
import { FontPrograms } from "./font-program";
import { Assets } from "./assets";
import { Images } from "./images";
import { PositionedGraphics } from "./math";
import {
  type PageContent,
  Interpreter,
  deduplicateSpans,
  graphics,
  pageLinks,
} from "./content";
import { type Matrix } from "./geometry";
import { cleanMargins, bodyFontSize, runeCount } from "./lines";
import { layout } from "./layout";
import { xmp, structure, outlines, markSectionRoles } from "./metadata";
import { markdown } from "./render";
import { sha256 } from "./hash";

/** Extract in memory with no filesystem, server, DOM, or WebAssembly dependency. */
export function extract(data: Uint8Array, options: Options = {}): Document {
  const started = performance.now(),
    p = new PDF(data, options),
    root = p.dict(p.trailer.Root);
  if (named(root.Type) !== "Catalog") invalid("missing catalog");
  const info = p.dict(p.trailer.Info),
    out = p.out;
  out.title = textString(info.Title);
  out.author = textString(info.Author);
  out.subject = textString(info.Subject);
  out.keywords = textString(info.Keywords);
  out.creator = textString(info.Creator);
  out.created = textString(info.CreationDate);
  out.language = textString(root.Lang);
  xmp(p, root.Metadata);
  out.sha256 = sha256(data);
  out.language ||= "en";
  if (root.AcroForm != null)
    p.warn(
      "forms",
      0,
      "Interactive form field values are not included in the reading edition.",
    );
  if (p.dict(root.Names).EmbeddedFiles != null)
    p.warn(
      "attachments",
      0,
      "Embedded attachments are not included in the reading edition.",
    );
  if (root.OCProperties != null)
    p.warn(
      "optional-content",
      0,
      "Optional layer visibility is not evaluated.",
    );
  const [tags, alts] = structure(p, root.StructTreeRoot),
    pages: PageContent[] = [],
    seen = new Set<string>(),
    fonts = new Fonts(p),
    programs = new FontPrograms(p, fonts),
    assets = new Assets(p),
    images = new Images(p, assets),
    positioned = new PositionedGraphics(p, programs, assets);
  const walk = (v: Value | undefined, inherited: Dict, depth: number): void => {
    p.check();
    if (depth > 64) limit();
    const ref = v instanceof Ref ? v : undefined;
    if (ref) {
      if (seen.has(ref.key)) invalid("cyclic page tree");
      seen.add(ref.key);
    }
    const d = p.dict(v),
      props: Dict = Object.assign(Object.create(null), inherited);
    for (const k of ["Resources", "MediaBox", "CropBox", "Rotate"])
      if (k in d) props[k] = d[k];
    if (named(d.Type) === "Pages") {
      for (const child of p.array(d.Kids)) walk(child, props, depth + 1);
      return;
    }
    if (named(d.Type) !== "Page") invalid("expected page");
    if (pages.length >= p.limits.pages) limit();
    let box = p.array(props.CropBox);
    if (box.length !== 4) box = p.array(props.MediaBox);
    if (box.length !== 4) invalid("missing MediaBox");
    let [x0, y0, x1, y1] = box.map(number);
    const media = p.array(props.MediaBox);
    if (media.length === 4) {
      x0 = Math.max(x0, number(media[0]));
      y0 = Math.max(y0, number(media[1]));
      x1 = Math.min(x1, number(media[2]));
      y1 = Math.min(y1, number(media[3]));
    }
    let w = x1 - x0,
      h = y1 - y0;
    if (w <= 0 || h <= 0 || w > 1000000 || h > 1000000)
      invalid("page dimensions");
    const rotation = ((integer(p.resolve(props.Rotate)) % 360) + 360) % 360;
    let base: Matrix = [1, 0, 0, -1, -x0, y1];
    if (rotation === 90) {
      base = [0, 1, 1, 0, -y0, -x0];
      [w, h] = [h, w];
    } else if (rotation === 180) base = [-1, 0, 0, 1, x1, -y0];
    else if (rotation === 270) {
      base = [0, -1, -1, 0, y1, x1];
      [w, h] = [h, w];
    } else if (rotation !== 0) invalid("invalid page rotation");
    const pc: PageContent = {
      page: { number: pages.length + 1, width: w, height: h, blocks: [] },
      id: ref,
      tags: tags.get(ref?.id || 0) || new Map(),
      alt: alts.get(ref?.id || 0) || new Map(),
      spans: [],
      images: [],
      rules: [],
      paths: [],
    };
    if (number(d.UserUnit) > 1)
      p.warn(
        "user-unit",
        pc.page.number,
        "Page coordinates use unscaled PDF user units.",
      );
    const interpreter = new Interpreter(
        p,
        pc,
        graphics(base),
        p.dict(props.Resources),
        fonts,
        images,
      ),
      contents = p.resolve(d.Contents),
      streams = contents instanceof Stream ? [contents] : asArray(contents);
    for (const v of streams) {
      const s = p.resolve(v);
      if (!(s instanceof Stream)) {
        p.warn(
          "content-stream",
          pc.page.number,
          "Page content stream is missing.",
        );
        continue;
      }
      try {
        interpreter.run(p.decode(s));
      } catch (e) {
        if (
          e instanceof PdfError &&
          (e.code === "RESOURCE_LIMIT" || e.code === "ABORTED")
        )
          throw e;
        p.warn(
          "content-stream",
          pc.page.number,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    pc.spans = deduplicateSpans(pc.spans);
    pageLinks(p, pc, d, base);
    pages.push(pc);
    p.check();
  };
  walk(root.Pages, Object.create(null), 0);
  if (!pages.length) invalid("no pages");
  if (!options.keepArtifacts) cleanMargins(pages);
  const body = bodyFontSize(pages);
  for (const pc of pages) {
    p.check();
    pc.page.blocks = layout(pc, body, positioned);
    if (!pc.spans.length && pc.images.length) {
      pc.page.needsOCR = true;
      p.warn(
        "needs-ocr",
        pc.page.number,
        "This page contains images without a text layer. The images are preserved; OCR has not been performed.",
      );
    }
    for (const b of pc.page.blocks) {
      out.stats.characters += runeCount(b.text || "");
      for (const row of b.rows || [])
        for (const cell of row) out.stats.characters += runeCount(cell);
      if (b.kind === "image") out.stats.images++;
      else if (b.kind === "table") out.stats.tables++;
      else if (b.kind === "math") out.stats.math++;
      else if (b.kind === "heading") out.stats.headings++;
    }
    out.pages.push(pc.page);
  }
  outlines(p, root.Outlines, pages);
  if (!out.title.trim()) {
    for (const page of out.pages) {
      const heading = page.blocks.find((b) => b.kind === "heading");
      if (heading) {
        out.title = heading.text || "";
        if (out.title) break;
      }
    }
  }
  out.title ||= "Untitled PDF";
  markSectionRoles(out.pages);
  out.stats.pages = pages.length;
  out.markdown = markdown(out);
  out.stats.durationMs = performance.now() - started;
  p.check();
  return out;
}
