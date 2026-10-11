import { SaxesParser } from "saxes";
import { PDF } from "./parser";
import { type Value, Stream, Ref, asDict, named } from "./syntax";
import { type Page, PdfError, limit } from "./model";
import { textString } from "./font";
import { type PageContent } from "./content";

export function xmp(p: PDF, v: Value | undefined): void {
  const s = p.resolve(v);
  if (!(s instanceof Stream)) return;
  let data: Uint8Array;
  try {
    data = p.decode(s);
  } catch (e) {
    if (
      e instanceof PdfError &&
      (e.code === "RESOURCE_LIMIT" || e.code === "ABORTED")
    )
      throw e;
    p.warn("metadata", 0, "XMP metadata could not be decoded.");
    return;
  }
  if (data.length > 4 * 1048576) {
    p.warn("metadata", 0, "XMP metadata exceeds the metadata limit.");
    return;
  }
  const stack: string[] = [],
    values = new Map<string, string[]>(),
    fields = new Set([
      "title",
      "creator",
      "description",
      "language",
      "subject",
      "Keywords",
      "CreatorTool",
      "CreateDate",
    ]);
  let message = "XMP metadata is malformed.";
  const parser = new SaxesParser({ xmlns: false, fragment: true });
  parser.on("opentag", (node) => {
    if (stack.length > 64) {
      message = "XMP metadata nesting exceeds the limit.";
      throw new Error(message);
    }
    stack.push(node.name.split(":").at(-1)!);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  const text = (text: string) => {
    text = text.trim();
    if (!text) return;
    for (const field of stack)
      if (fields.has(field)) {
        const v = values.get(field) || [];
        v.push(text);
        values.set(field, v);
      }
  };
  parser.on("text", text);
  parser.on("cdata", text);
  try {
    parser.write(new TextDecoder().decode(data)).close();
  } catch {
    p.warn("metadata", 0, message);
    return;
  }
  const first = (k: string) => values.get(k)?.[0] || "",
    out = p.out;
  out.title ||= first("title");
  out.author ||= (values.get("creator") || []).join("; ");
  out.subject ||= first("description");
  out.keywords ||=
    first("Keywords") || (values.get("subject") || []).join(", ");
  out.creator ||= first("CreatorTool");
  out.created ||= first("CreateDate");
  out.language ||= first("language");
}
export function structure(
  p: PDF,
  v: Value | undefined,
): [Map<number, Map<number, string>>, Map<number, Map<number, string>>] {
  const tags = new Map<number, Map<number, string>>(),
    alts = new Map<number, Map<number, string>>(),
    root = p.dict(v),
    roles = p.dict(root.RoleMap),
    seen = new Set<string>();
  let nodes = 0;
  const walk = (
    v: Value | undefined,
    pageID: number,
    role: string,
    alt: string,
    depth: number,
  ) => {
    if (++nodes > p.limits.objects || depth > 64) limit();
    if (v instanceof Ref) {
      if (seen.has(v.key)) return;
      seen.add(v.key);
    }
    v = p.resolve(v);
    if (Array.isArray(v)) {
      for (const child of v) walk(child, pageID, role, alt, depth + 1);
      return;
    }
    if (typeof v === "number") {
      if (pageID) {
        if (!tags.has(pageID)) {
          tags.set(pageID, new Map());
          alts.set(pageID, new Map());
        }
        tags.get(pageID)!.set(Math.trunc(v), role);
        alts.get(pageID)!.set(Math.trunc(v), alt);
      }
      return;
    }
    const d = asDict(v);
    if (d.Pg instanceof Ref) pageID = d.Pg.id;
    const n = named(d.S);
    if (n) role = named(roles[n]) || n;
    alt = textString(d.Alt) || alt;
    if ("MCID" in d) walk(d.MCID, pageID, role, alt, depth + 1);
    if ("K" in d) walk(d.K, pageID, role, alt, depth + 1);
  };
  walk(root.K, 0, "", "", 0);
  return [tags, alts];
}
export function outlines(
  p: PDF,
  v: Value | undefined,
  pages: PageContent[],
): void {
  const pageNumbers = new Map(
      pages.map((pc) => [pc.id?.id || 0, pc.page.number]),
    ),
    seen = new Set<string>();
  let count = 0;
  const walk = (v: Value | undefined, level: number) => {
    while (v != null) {
      if (++count > 10000 || level > 64) {
        p.warn(
          "outline-limit",
          0,
          "The document outline exceeds the traversal limit.",
        );
        return;
      }
      if (v instanceof Ref) {
        if (seen.has(v.key)) return;
        seen.add(v.key);
      }
      const d = p.dict(v);
      let dest = p.array(d.Dest);
      if (!dest.length) dest = p.array(p.dict(d.A).D);
      const page =
          dest[0] instanceof Ref ? pageNumbers.get(dest[0].id) || 0 : 0,
        title = textString(d.Title);
      if (title) p.out.outline.push({ title, page, level });
      walk(d.First, level + 1);
      v = d.Next;
    }
  };
  walk(p.dict(v).First, 1);
}
export function markSectionRoles(pages: Page[]): void {
  let role = "";
  for (const page of pages)
    for (const b of page.blocks) {
      if (b.kind === "heading") {
        const title = (b.text || "")
          .trim()
          .replace(/^[\d. ]+|[\d. ]+$/g, "")
          .toLowerCase();
        if (
          [
            "references",
            "bibliography",
            "works cited",
            "further reading",
          ].includes(title)
        )
          role = "reference";
        else if (["index", "subject index", "name index"].includes(title))
          role = "index";
        else if ((b.level || 0) <= 2) role = "";
      } else if (!b.role && (b.kind === "paragraph" || b.kind === "list"))
        b.role = role;
    }
}
