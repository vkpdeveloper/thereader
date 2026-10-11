package pdfextractor

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"fmt"
	"hash/crc32"
	"html"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
)

func xmlText(s string) string {
	return html.EscapeString(strings.Map(func(r rune) rune {
		if r == 9 || r == 10 || r == 13 || r >= 32 && r != 0xfffe && r != 0xffff {
			return r
		}
		return -1
	}, s))
}

var mdEscaper = strings.NewReplacer("\\", "\\\\", "`", "\\`", "*", "\\*", "_", "\\_", "[", "\\[", "]", "\\]", "<", "&lt;", ">", "&gt;", "|", "\\|")

func escapeMD(s string) string { return mdEscaper.Replace(s) }
func markdownRuns(b Block) string {
	if len(b.Runs) == 0 {
		return escapeMD(b.Text)
	}
	var out strings.Builder
	for _, r := range b.Runs {
		t := escapeMD(r.Text)
		prefix, suffix := "", ""
		if len(t) > 0 && unicode.IsSpace(rune(t[0])) {
			prefix = " "
			t = strings.TrimLeft(t, " ")
		}
		if strings.HasSuffix(t, " ") {
			suffix = " "
			t = strings.TrimRight(t, " ")
		}
		if r.Bold && b.Kind != "heading" {
			t = "**" + t + "**"
		}
		if r.Italic {
			t = "*" + t + "*"
		}
		if safeLink(r.Link) {
			t = "[" + t + "](" + strings.NewReplacer("(", "%28", ")", "%29", " ", "%20", "\n", "%0A").Replace(r.Link) + ")"
		}
		out.WriteString(prefix + t + suffix)
	}
	return strings.TrimSpace(out.String())
}

// Markdown renders the structured blocks. Asset URLs are relative to the
// output directory; the CLI writes the referenced files beside the Markdown.
func Markdown(d *Document) string {
	var out strings.Builder
	if len(d.Warnings) > 0 {
		out.WriteString("> Extraction notes: this document contains features that need review. See the structured warnings or the reading edition's extraction notes.\n\n")
	}
	for _, page := range d.Pages {
		fmt.Fprintf(&out, "<a id=\"page-%d\"></a>\n\n", page.Number)
		for _, b := range page.Blocks {
			switch b.Kind {
			case "heading":
				out.WriteString(strings.Repeat("#", max(1, min(6, b.Level))) + " " + markdownRuns(b) + "\n\n")
			case "code":
				fence := "```"
				for strings.Contains(b.Text, fence) {
					fence += "`"
				}
				out.WriteString(fence + b.Language + "\n" + b.Text + "\n" + fence + "\n\n")
			case "list":
				t := markdownRuns(b)
				trim := strings.TrimSpace(b.Text)
				if strings.HasPrefix(trim, "•") || strings.HasPrefix(trim, "●") || strings.HasPrefix(trim, "▪") {
					_, n := utf8First(trim)
					t = strings.TrimSpace(escapeMD(trim[n:]))
				}
				out.WriteString("- " + t + "\n\n")
			case "table":
				for j, row := range b.Rows {
					out.WriteString("| ")
					for k, cell := range row {
						if k > 0 {
							out.WriteString(" | ")
						}
						out.WriteString(strings.ReplaceAll(escapeMD(cell), "\n", "<br>"))
					}
					out.WriteString(" |\n")
					if j == 0 {
						out.WriteString("|" + strings.Repeat(" --- |", len(row)) + "\n")
					}
				}
				out.WriteString("\n")
			case "image":
				out.WriteString("![" + escapeMD(b.Alt) + "](" + b.Asset + ")\n\n")
			default:
				out.WriteString(markdownRuns(b) + "\n\n")
			}
		}
	}
	return strings.TrimSpace(out.String()) + "\n"
}
func utf8First(s string) (rune, int) {
	for _, r := range s {
		return r, len(string(r))
	}
	return 0, 0
}

func htmlRuns(b Block) string {
	if len(b.Runs) == 0 {
		return xmlText(b.Text)
	}
	var out strings.Builder
	for _, r := range b.Runs {
		t := xmlText(r.Text)
		if r.Bold && b.Kind != "heading" {
			t = "<strong>" + t + "</strong>"
		}
		if r.Italic {
			t = "<em>" + t + "</em>"
		}
		if safeLink(r.Link) {
			t = `<a href="` + xmlText(r.Link) + `">` + t + `</a>`
		}
		out.WriteString(t)
	}
	return out.String()
}
func pageHTML(page Page) string {
	var out strings.Builder
	fmt.Fprintf(&out, `<section id="page-%d" aria-label="Page %d">`, page.Number, page.Number)
	for j, b := range page.Blocks {
		switch b.Kind {
		case "heading":
			level := strconv.Itoa(max(1, min(6, b.Level)))
			fmt.Fprintf(&out, `<h%s id="b-%d">%s</h%s>`, level, j, htmlRuns(b), level)
		case "code":
			fmt.Fprintf(&out, `<pre><code class="language-%s">%s</code></pre>`, xmlText(b.Language), xmlText(b.Text))
		case "image":
			fmt.Fprintf(&out, `<figure><img src="%s" alt="%s"/></figure>`, xmlText(b.Asset), xmlText(b.Alt))
		case "table":
			out.WriteString("<table>")
			for r, row := range b.Rows {
				out.WriteString("<tr>")
				tag := "td"
				if r == 0 {
					tag = "th"
				}
				for _, cell := range row {
					out.WriteString("<" + tag + ">" + xmlText(cell) + "</" + tag + ">")
				}
				out.WriteString("</tr>")
			}
			out.WriteString("</table>")
		case "list":
			out.WriteString("<p class=\"list-item\">" + htmlRuns(b) + "</p>")
		default:
			out.WriteString(`<p class="` + xmlText(b.Role) + `">` + htmlRuns(b) + "</p>")
		}
	}
	out.WriteString("</section>")
	return out.String()
}
func xhtml(title, body string) string {
	return `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>` + xmlText(title) + `</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>` + body + `</body></html>`
}

// EPUB creates a deterministic EPUB 3 reading edition with a table of contents,
// chapter/page anchors, code, tables, images, and explicit extraction notes.
// Metadata never executes markup and PDF actions, scripts and files are not copied.
func EPUB(d *Document) ([]byte, error) {
	var buffer bytes.Buffer
	z := zip.NewWriter(&buffer)
	add := func(name string, b []byte, stored bool) error {
		h := &zip.FileHeader{Name: name, Method: zip.Deflate, CRC32: crc32.ChecksumIEEE(b), UncompressedSize64: uint64(len(b))}
		h.SetModTime(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC))
		h.Extra = nil
		compressed := b
		if stored {
			h.Method = zip.Store
		} else {
			var buf bytes.Buffer
			w, _ := flate.NewWriter(&buf, flate.BestSpeed)
			if _, err := w.Write(b); err != nil {
				return err
			}
			if err := w.Close(); err != nil {
				return err
			}
			compressed = buf.Bytes()
		}
		h.CompressedSize64 = uint64(len(compressed))
		w, err := z.CreateRaw(h)
		if err != nil {
			return err
		}
		_, err = w.Write(compressed)
		return err
	}
	if e := add("mimetype", []byte("application/epub+zip"), true); e != nil {
		return nil, e
	}
	if e := add("META-INF/container.xml", []byte(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`), false); e != nil {
		return nil, e
	}
	manifest := `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>`
	spine := ""
	toc := ""
	if len(d.Warnings) > 0 {
		body := `<h1>About this reading edition</h1><p>PDF Extractor recovered the available content and converted it into reflowable blocks. Some source features need review. These notes describe known gaps; the absence of a note is not an accuracy guarantee.</p><ul>`
		messages := []string{}
		pagesByMessage := map[string][]int{}
		for _, w := range d.Warnings {
			if _, ok := pagesByMessage[w.Message]; !ok {
				messages = append(messages, w.Message)
				pagesByMessage[w.Message] = nil
			}
			if w.Page > 0 {
				pagesByMessage[w.Message] = append(pagesByMessage[w.Message], w.Page)
			}
		}
		for _, message := range messages {
			where := ""
			pages := pagesByMessage[message]
			if len(pages) == 1 {
				where = fmt.Sprintf(" (page %d)", pages[0])
			} else if len(pages) > 1 {
				where = fmt.Sprintf(" (%d page reports; details in the structured output)", len(pages))
			}
			body += "<li>" + xmlText(message+where) + "</li>"
		}
		body += "</ul>"
		if e := add("OEBPS/notes.xhtml", []byte(xhtml("Extraction notes", body)), false); e != nil {
			return nil, e
		}
		manifest += `<item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/>`
		spine += `<itemref idref="notes"/>`
		toc += `<li><a href="notes.xhtml">Extraction notes</a></li>`
	}
	for _, page := range d.Pages {
		file := fmt.Sprintf("page-%d.xhtml", page.Number)
		id := fmt.Sprintf("p%d", page.Number)
		hasSVG := false
		for _, b := range page.Blocks {
			if strings.HasSuffix(b.Asset, ".svg") {
				hasSVG = true
			}
		}
		props := ""
		if hasSVG {
			props = ` properties="svg"`
		}
		manifest += fmt.Sprintf(`<item id="%s" href="%s" media-type="application/xhtml+xml"%s/>`, id, file, props)
		spine += `<itemref idref="` + id + `"/>`
		if e := add("OEBPS/"+file, []byte(xhtml(d.Title, pageHTML(page))), false); e != nil {
			return nil, e
		}
		found := false
		for j, b := range page.Blocks {
			if b.Kind == "heading" {
				toc += fmt.Sprintf(`<li><a href="%s#b-%d">%s</a></li>`, file, j, xmlText(b.Text))
				found = true
			}
		}
		if !found {
			toc += fmt.Sprintf(`<li><a href="%s">Page %d</a></li>`, file, page.Number)
		}
	}
	for j, a := range d.Assets {
		if !strings.HasPrefix(a.Name, "assets/") || strings.Contains(a.Name, "..") || strings.ContainsAny(a.Name, "\\\x00") {
			return nil, ErrInvalid
		}
		if e := add("OEBPS/"+a.Name, a.Data, false); e != nil {
			return nil, e
		}
		manifest += fmt.Sprintf(`<item id="a%d" href="%s" media-type="%s"/>`, j, xmlText(a.Name), xmlText(a.MediaType))
	}
	if e := add("OEBPS/nav.xhtml", []byte(xhtml("Contents", `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>`+toc+`</ol></nav>`)), false); e != nil {
		return nil, e
	}
	css := `body { line-height:1.6; } img,svg { max-width:100%; height:auto; } table { border-collapse:collapse; width:100%; margin:1em 0; } td,th { border:1px solid currentColor; padding:.4em .65em; text-align:left; } pre { white-space:pre-wrap; overflow-wrap:anywhere; font-family:monospace; padding:1em; } figure { margin:1.4em 0; } .caption,.footnote { font-size:.9em; } .caption { font-style:italic; } .list-item { padding-left:1em; } h1,h2,h3 { line-height:1.3; }`
	if e := add("OEBPS/style.css", []byte(css), false); e != nil {
		return nil, e
	}
	language := d.Language
	if _, e := url.Parse(language); e != nil || strings.ContainsAny(language, " <>\n\t") {
		language = "en"
	}
	metadata := `<dc:identifier id="id">urn:sha256:` + xmlText(d.SHA256) + `</dc:identifier><dc:title>` + xmlText(d.Title) + `</dc:title><dc:creator>` + xmlText(d.Author) + `</dc:creator><dc:language>` + xmlText(language) + `</dc:language><dc:description>` + xmlText(d.Subject) + `</dc:description><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta>`
	opf := `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` + metadata + `</metadata><manifest>` + manifest + `</manifest><spine>` + spine + `</spine></package>`
	if e := add("OEBPS/package.opf", []byte(opf), false); e != nil {
		return nil, e
	}
	if e := z.Close(); e != nil {
		return nil, e
	}
	return buffer.Bytes(), nil
}

// WriteAssets writes only generated relative asset names using the caller's
// storage abstraction, so libraries need no filesystem or HTTP dependency.
func WriteAssets(d *Document, write func(name string, r io.Reader) error) error {
	for _, a := range d.Assets {
		if e := write(a.Name, bytes.NewReader(a.Data)); e != nil {
			return e
		}
	}
	return nil
}
