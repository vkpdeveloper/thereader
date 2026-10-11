import { zipSync, type Zippable } from "fflate";
import {
  type Block,
  type Document,
  type Page,
  type Table,
  type TableCell,
  invalid,
} from "./model";
import { xmlText } from "./math";
import { safeLink } from "./geometry";

export const escapeMD = (s: string): string =>
  s.replace(/[\\`*_\[\]<>|]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "\\" + c,
  );
export function markdownRuns(b: Pick<Block, "kind" | "runs" | "text">): string {
  if (!b.runs?.length) return escapeMD(b.text || "");
  let out = "";
  for (const r of b.runs) {
    if (r.asset) {
      out += `![${escapeMD(r.text)}](${r.asset})`;
      continue;
    }
    let t = escapeMD(r.text),
      prefix = "",
      suffix = "";
    if (/^\s/.test(t)) {
      prefix = " ";
      t = t.replace(/^ +/, "");
    }
    if (t.endsWith(" ")) {
      suffix = " ";
      t = t.replace(/ +$/, "");
    }
    if (r.script === "sup" || r.script === "sub")
      t = `<${r.script}>${t}</${r.script}>`;
    if (r.bold && b.kind !== "heading") t = "**" + t + "**";
    if (r.italic) t = "*" + t + "*";
    if (safeLink(r.link || ""))
      t = `[${t}](${r.link!.replace(/[() \n]/g, (c) => ({ "(": "%28", ")": "%29", " ": "%20", "\n": "%0A" })[c]!)})`;
    out += prefix + t + suffix;
  }
  return out.trim();
}
export function htmlRuns(
  b: Pick<Block, "runs" | "text"> & { kind?: string },
): string {
  if (!b.runs?.length) return xmlText(b.text || "");
  let out = "";
  for (const r of b.runs) {
    if (r.asset) {
      out += `<img class="math-inline" data-math-representation="positioned" data-math-monochrome="${!!r.monochrome}" src="${xmlText(r.asset)}" alt="${xmlText(r.text)}" style="height:${(r.heightEm || 0).toFixed(4)}em;vertical-align:-${(r.depthEm || 0).toFixed(4)}em"/>`;
      continue;
    }
    let t = xmlText(r.text);
    if (r.script === "sup" || r.script === "sub")
      t = `<${r.script}>${t}</${r.script}>`;
    if (r.bold && b.kind !== "heading") t = "<strong>" + t + "</strong>";
    if (r.italic) t = "<em>" + t + "</em>";
    if (safeLink(r.link || "")) t = `<a href="${xmlText(r.link!)}">${t}</a>`;
    out += t;
  }
  return out;
}
export const complexTable = (t: Table | undefined): boolean =>
  !!t &&
  ((t.headerRows || 0) > 1 ||
    t.cells.some((c) => c.rowSpan > 1 || c.colSpan > 1));
export function tableHTML(b: Block, prefix: string): string {
  let t = b.table;
  if (!t) {
    t = {
      rows: b.rows?.length || 0,
      columns: 0,
      headerRows: Math.min(1, b.rows?.length || 0),
      cells: [],
    };
    (b.rows || []).forEach((row, r) => {
      t!.columns = Math.max(t!.columns, row.length);
      row.forEach((text, col) =>
        t!.cells.push({
          row: r,
          column: col,
          rowSpan: 1,
          colSpan: 1,
          text,
          header: r === 0,
          box: { x: 0, y: 0, width: 0, height: 0 },
        }),
      );
    });
  }
  const headers = t.headerRows || 0,
    byRow = new Map<number, TableCell[]>(),
    columns = new Map<number, string[]>(),
    rows = new Map<number, string[]>();
  const add = <T>(m: Map<number, T[]>, n: number, v: T) => {
    const a = m.get(n) || [];
    a.push(v);
    m.set(n, a);
  };
  for (const c of t.cells) {
    add(byRow, c.row, c);
    if (!c.header || !c.text) continue;
    const id = `${prefix}-r${c.row}-c${c.column}`;
    if (c.row < headers)
      for (
        let col = Math.max(0, c.column);
        col < Math.min(t.columns, c.column + c.colSpan);
        col++
      )
        add(columns, col, id);
    else if (c.scope === "row" || c.scope === "rowgroup")
      for (
        let row = Math.max(0, c.row);
        row < Math.min(t.rows, c.row + c.rowSpan);
        row++
      )
        add(rows, row, id);
  }
  const proposed = new Set<number>(),
    cuts = new Set<number>();
  for (const c of t.cells)
    if (c.header && c.scope === "rowgroup") {
      proposed.add(c.row);
      proposed.add(c.row + c.rowSpan);
    }
  let activeEnd = headers;
  for (let r = headers; r < t.rows; r++) {
    if (r > headers && proposed.has(r) && activeEnd <= r) cuts.add(r);
    for (const c of byRow.get(r) || [])
      activeEnd = Math.max(activeEnd, c.row + c.rowSpan);
  }
  let out = "<table>\n" + (headers > 0 ? "<thead>\n" : "<tbody>\n");
  for (let r = 0; r < t.rows; r++) {
    if (r === headers && r > 0) out += "</thead>\n<tbody>\n";
    if (cuts.has(r)) out += "</tbody>\n<tbody>\n";
    out += "<tr>";
    for (const c of (byRow.get(r) || []).sort((a, b) => a.column - b.column)) {
      const tag = c.header ? "th" : "td";
      out += "<" + tag;
      if (c.rowSpan > 1) out += ` rowspan="${c.rowSpan}"`;
      if (c.colSpan > 1) out += ` colspan="${c.colSpan}"`;
      if (c.header) {
        out += ` id="${xmlText(prefix)}-r${c.row}-c${c.column}"`;
        if (["col", "colgroup", "row", "rowgroup"].includes(c.scope || ""))
          out += ` scope="${c.scope}"`;
      } else {
        const ids = new Set<string>();
        for (
          let col = Math.max(0, c.column);
          col < Math.min(t.columns, c.column + c.colSpan);
          col++
        )
          for (const id of columns.get(col) || []) ids.add(id);
        for (
          let row = Math.max(0, c.row);
          row < Math.min(t.rows, c.row + c.rowSpan);
          row++
        )
          for (const id of rows.get(row) || []) ids.add(id);
        if (ids.size) out += ` headers="${xmlText([...ids].join(" "))}"`;
      }
      out += ">" + htmlRuns(c) + `</${tag}>`;
    }
    out += "</tr>\n";
  }
  return (
    out +
    (headers >= t.rows && headers > 0 ? "</thead>\n" : "</tbody>\n") +
    "</table>"
  );
}
export function markdown(d: Document): string {
  let out = d.warnings.length
    ? "> Extraction notes: this document contains features that need review. See the structured warnings or the reading edition's extraction notes.\n\n"
    : "";
  for (const page of d.pages) {
    out += `<a id="page-${page.number}"></a>\n\n`;
    page.blocks.forEach((b, bi) => {
      const text = b.text || "";
      if (b.kind === "heading")
        out +=
          "#".repeat(Math.max(1, Math.min(6, b.level || 0))) +
          " " +
          markdownRuns(b) +
          "\n\n";
      else if (b.kind === "code") {
        let fence = "```";
        while (text.includes(fence)) fence += "`";
        out += fence + (b.language || "") + "\n" + text + "\n" + fence + "\n\n";
      } else if (b.kind === "list") {
        const trimmed = text.trim(),
          t = /^[•●▪]/.test(trimmed)
            ? escapeMD(trimmed.slice(1)).trim()
            : markdownRuns(b);
        out += "- " + t + "\n\n";
      } else if (b.kind === "table") {
        if (complexTable(b.table))
          out += tableHTML(b, `table-${page.number}-${bi}`) + "\n\n";
        else {
          (b.rows || []).forEach((row, j) => {
            out +=
              "| " +
              row.map((c) => escapeMD(c).replace(/\n/g, "<br>")).join(" | ") +
              " |\n";
            if (!j) out += "|" + " --- |".repeat(row.length) + "\n";
          });
          out += "\n";
        }
      } else if (b.kind === "image" || b.kind === "math")
        out += `![${escapeMD(b.alt || "")}](${b.asset || ""})\n\n`;
      else out += markdownRuns(b) + "\n\n";
    });
  }
  return out.trim() + "\n";
}
export function pageHTML(page: Page): string {
  let out = `<section id="page-${page.number}" aria-label="Page ${page.number}">`;
  page.blocks.forEach((b, j) => {
    if (b.kind === "heading") {
      const level = Math.max(1, Math.min(6, b.level || 0));
      out += `<h${level} id="b-${j}">${htmlRuns(b)}</h${level}>`;
    } else if (b.kind === "code")
      out += `<pre><code class="language-${xmlText(b.language || "")}">${xmlText(b.text || "")}</code></pre>`;
    else if (b.kind === "math")
      out += `<figure class="math-display"><img data-math-representation="positioned" data-math-monochrome="${!!b.monochrome}" src="${xmlText(b.asset || "")}" alt="${xmlText(b.text || "")}" style="--pdf-math-width:${(b.widthEm || 0).toFixed(4)}em;width:${(b.widthEm || 0).toFixed(4)}em;max-width:100%;height:auto"/></figure>`;
    else if (b.kind === "image")
      out += `<figure><img src="${xmlText(b.asset || "")}" alt="${xmlText(b.alt || "")}"/></figure>`;
    else if (b.kind === "table")
      out += tableHTML(b, `table-${page.number}-${j}`);
    else if (b.kind === "list")
      out += '<p class="list-item">' + htmlRuns(b) + "</p>";
    else out += `<p class="${xmlText(b.role || "")}">${htmlRuns(b)}</p>`;
  });
  return out + "</section>";
}
const xhtml = (title: string, body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${xmlText(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`;
export function epub(d: Document): Uint8Array {
  const files: Zippable = Object.create(null),
    encoder = new TextEncoder(),
    date = new Date(2000, 0, 1, 0, 0, 0);
  const add = (name: string, value: string | Uint8Array, stored = false) => {
    files[name] = [
      typeof value === "string" ? encoder.encode(value) : value,
      { level: stored ? 0 : 1, mtime: date },
    ];
  };
  add("mimetype", "application/epub+zip", true);
  add(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  let manifest =
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>',
    spine = "",
    toc = "";
  if (d.warnings.length) {
    let body =
      "<h1>About this reading edition</h1><p>PDF Extractor recovered the available content and converted it into reflowable blocks. Some source features need review. These notes describe known gaps; the absence of a note is not an accuracy guarantee.</p><ul>";
    const messages = new Map<string, number[]>();
    for (const w of d.warnings) {
      const pages = messages.get(w.message) || [];
      if (w.page && w.page > 0) pages.push(w.page);
      messages.set(w.message, pages);
    }
    for (const [message, pages] of messages) {
      const where =
        pages.length === 1
          ? ` (page ${pages[0]})`
          : pages.length > 1
            ? ` (${pages.length} page reports; details in the structured output)`
            : "";
      body += "<li>" + xmlText(message + where) + "</li>";
    }
    body += "</ul>";
    add("OEBPS/notes.xhtml", xhtml("Extraction notes", body));
    manifest +=
      '<item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/>';
    spine += '<itemref idref="notes"/>';
    toc += '<li><a href="notes.xhtml">Extraction notes</a></li>';
  }
  for (const page of d.pages) {
    const file = `page-${page.number}.xhtml`,
      id = "p" + page.number,
      hasSVG = page.blocks.some(
        (b) =>
          b.asset?.endsWith(".svg") ||
          b.runs?.some((r) => r.asset?.endsWith(".svg")),
      );
    manifest += `<item id="${id}" href="${file}" media-type="application/xhtml+xml"${hasSVG ? ' properties="svg"' : ""}/>`;
    spine += `<itemref idref="${id}"/>`;
    add("OEBPS/" + file, xhtml(d.title, pageHTML(page)));
    let found = false;
    page.blocks.forEach((b, j) => {
      if (b.kind === "heading") {
        toc += `<li><a href="${file}#b-${j}">${xmlText(b.text || "")}</a></li>`;
        found = true;
      }
    });
    if (!found) toc += `<li><a href="${file}">Page ${page.number}</a></li>`;
  }
  d.assets.forEach((a, j) => {
    if (
      !a.name.startsWith("assets/") ||
      a.name.includes("..") ||
      /[\\\0]/.test(a.name)
    )
      invalid("Unsafe asset name");
    add("OEBPS/" + a.name, a.data);
    manifest += `<item id="a${j}" href="${xmlText(a.name)}" media-type="${xmlText(a.mediaType)}"/>`;
  });
  add(
    "OEBPS/nav.xhtml",
    xhtml(
      "Contents",
      '<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>' +
        toc +
        "</ol></nav>",
    ),
  );
  add(
    "OEBPS/style.css",
    "body { line-height:1.6; } .math-inline { display:inline; width:auto; max-width:none; margin:0; } .math-display { text-align:center; overflow-x:auto; } .math-display img { width:auto; max-width:100%; } sup,sub { font-size:.7em; line-height:0; } img,svg { max-width:100%; height:auto; } table { border-collapse:collapse; width:100%; margin:1em 0; } td,th { border:1px solid currentColor; padding:.4em .65em; text-align:left; } pre { white-space:pre-wrap; overflow-wrap:anywhere; font-family:monospace; padding:1em; } figure { margin:1.4em 0; } .caption,.footnote { font-size:.9em; } .caption { font-style:italic; } .list-item { padding-left:1em; } h1,h2,h3 { line-height:1.3; }",
  );
  const language = /[ <>\n\t]/.test(d.language || "")
    ? "en"
    : d.language || "en";
  const metadata = `<dc:identifier id="id">urn:sha256:${xmlText(d.sha256)}</dc:identifier><dc:title>${xmlText(d.title)}</dc:title><dc:creator>${xmlText(d.author || "")}</dc:creator><dc:language>${xmlText(language)}</dc:language><dc:description>${xmlText(d.subject || "")}</dc:description><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta>`;
  add(
    "OEBPS/package.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${metadata}</metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`,
  );
  return zipSync(files);
}
