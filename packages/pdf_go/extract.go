package pdfextractor

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"
)

// Extract parses a complete PDF in memory. Independent calls are safe to run
// concurrently. Partial documents have explicit warnings and Complete=false.
// Resource limit, cancellation, encryption and malformed-object errors are fatal.
func Extract(data []byte, options Options) (*Document, error) {
	started := time.Now()
	p, err := openPDF(data, options.normalized())
	if err != nil {
		return nil, err
	}
	root := p.dict(p.trailer["Root"])
	if named(root["Type"]) != "Catalog" {
		return nil, fmt.Errorf("%w: missing catalog", ErrInvalid)
	}
	info := p.dict(p.trailer["Info"])
	out := p.out
	out.Title = textString(info["Title"])
	out.Author = textString(info["Author"])
	out.Subject = textString(info["Subject"])
	out.Keywords = textString(info["Keywords"])
	out.Creator = textString(info["Creator"])
	out.Created = textString(info["CreationDate"])
	out.Language = textString(root["Lang"])
	p.xmp(root["Metadata"])
	out.SHA256 = fmt.Sprintf("%x", sha256.Sum256(data))
	if out.Language == "" {
		out.Language = "en"
	}
	if root["AcroForm"] != nil {
		p.warn("forms", 0, "Interactive form field values are not included in the reading edition.")
	}
	names := p.dict(root["Names"])
	if names["EmbeddedFiles"] != nil {
		p.warn("attachments", 0, "Embedded attachments are not included in the reading edition.")
	}
	if root["OCProperties"] != nil {
		p.warn("optional-content", 0, "Optional layer visibility is not evaluated.")
	}
	tags, alts := p.structure(root["StructTreeRoot"])
	pages := []*pageContent{}
	seen := map[ref]bool{}
	var walk func(any, dict, int) error
	walk = func(v any, inherited dict, depth int) error {
		if e := p.check(); e != nil {
			return e
		}
		if depth > 64 {
			return ErrLimit
		}
		r, indirect := v.(ref)
		if indirect {
			if seen[r] {
				return fmt.Errorf("%w: cyclic page tree", ErrInvalid)
			}
			seen[r] = true
		}
		d := p.dict(v)
		if d == nil {
			return fmt.Errorf("%w: missing page tree node", ErrInvalid)
		}
		props := dict{}
		for k, v := range inherited {
			props[k] = v
		}
		for _, k := range []string{"Resources", "MediaBox", "CropBox", "Rotate"} {
			if v, ok := d[k]; ok {
				props[k] = v
			}
		}
		if named(d["Type"]) == "Pages" {
			for _, child := range p.array(d["Kids"]) {
				if e := walk(child, props, depth+1); e != nil {
					return e
				}
			}
			return nil
		}
		if named(d["Type"]) != "Page" {
			return fmt.Errorf("%w: expected page", ErrInvalid)
		}
		if len(pages) >= p.opts.Limits.Pages {
			return ErrLimit
		}
		box := p.array(props["CropBox"])
		if len(box) != 4 {
			box = p.array(props["MediaBox"])
		}
		if len(box) != 4 {
			return fmt.Errorf("%w: missing MediaBox", ErrInvalid)
		}
		x0, y0, x1, y1 := number(box[0]), number(box[1]), number(box[2]), number(box[3])
		w, h := x1-x0, y1-y0
		if w <= 0 || h <= 0 || w > 1000000 || h > 1000000 {
			return fmt.Errorf("%w: page dimensions", ErrInvalid)
		}
		rotation := (integer(p.resolve(props["Rotate"]))%360 + 360) % 360
		base := matrix{1, 0, 0, -1, -x0, y1}
		switch rotation {
		case 90:
			base = matrix{0, 1, 1, 0, -y0, -x0}
			w, h = h, w
		case 180:
			base = matrix{-1, 0, 0, 1, x1, -y0}
		case 270:
			base = matrix{0, -1, -1, 0, y1, x1}
			w, h = h, w
		case 0:
		default:
			return fmt.Errorf("%w: invalid page rotation", ErrInvalid)
		}
		pc := &pageContent{page: Page{Number: len(pages) + 1, Width: w, Height: h, Blocks: []Block{}}, id: r, tags: tags[r.id], alt: alts[r.id]}
		if number(d["UserUnit"]) > 1 {
			p.warn("user-unit", pc.page.Number, "Page coordinates use unscaled PDF user units.")
		}
		i := interpreter{p: p, page: pc, g: graphics{ctm: base, tm: identity, tl: identity, scale: 1, fill: "#000000", stroke: "#000000", lineWidth: 1}, resources: p.dict(props["Resources"]), active: map[*stream]bool{}}
		contents := p.resolve(d["Contents"])
		streams := asArray(contents)
		if s, ok := contents.(*stream); ok {
			streams = array{s}
		}
		for _, v := range streams {
			s, ok := p.resolve(v).(*stream)
			if !ok {
				p.warn("content-stream", pc.page.Number, "Page content stream is missing.")
				continue
			}
			b, e := p.decode(s)
			if e == nil {
				e = i.run(b)
			}
			if e != nil {
				if errors.Is(e, ErrLimit) || p.opts.Context.Err() != nil {
					return e
				}
				p.warn("content-stream", pc.page.Number, e.Error())
			}
		}
		pc.spans = deduplicateSpans(pc.spans)
		p.pageLinks(pc, d, base)
		pages = append(pages, pc)
		return p.check()
	}
	if err = walk(root["Pages"], dict{}, 0); err != nil {
		return nil, err
	}
	if len(pages) == 0 {
		return nil, fmt.Errorf("%w: no pages", ErrInvalid)
	}
	if !p.opts.KeepArtifacts {
		cleanMargins(pages)
	}
	bodySize := bodyFontSize(pages)
	for _, pc := range pages {
		if err = p.check(); err != nil {
			return nil, err
		}
		pc.page.Blocks = p.layout(pc, bodySize)
		if len(pc.spans) == 0 && len(pc.images) > 0 {
			pc.page.NeedsOCR = true
			p.warn("needs-ocr", pc.page.Number, "This page contains images without a text layer. The images are preserved; OCR has not been performed.")
		}
		for _, b := range pc.page.Blocks {
			out.Stats.Characters += utf8.RuneCountInString(b.Text)
			for _, row := range b.Rows {
				for _, cell := range row {
					out.Stats.Characters += utf8.RuneCountInString(cell)
				}
			}
			switch b.Kind {
			case "image":
				out.Stats.Images++
			case "table":
				out.Stats.Tables++
			case "heading":
				out.Stats.Headings++
			}
		}
		out.Pages = append(out.Pages, pc.page)
	}
	p.outlines(root["Outlines"], pages)
	if strings.TrimSpace(out.Title) == "" {
		for _, page := range out.Pages {
			for _, b := range page.Blocks {
				if b.Kind == "heading" {
					out.Title = b.Text
					break
				}
			}
			if out.Title != "" {
				break
			}
		}
	}
	if out.Title == "" {
		out.Title = "Untitled PDF"
	}
	markSectionRoles(out.Pages)
	out.Stats.Pages = len(pages)
	out.Markdown = Markdown(out)
	out.Stats.DurationMS = milliseconds(time.Since(started))
	return out, p.check()
}

func (p *pdf) structure(v any) (map[int]map[int]string, map[int]map[int]string) {
	tags := map[int]map[int]string{}
	alts := map[int]map[int]string{}
	root := p.dict(v)
	roles := p.dict(root["RoleMap"])
	seen := map[ref]bool{}
	nodes := 0
	var walk func(any, int, string, string, int)
	walk = func(v any, pageID int, role, alt string, depth int) {
		nodes++
		if depth > 64 || nodes > p.opts.Limits.Objects {
			p.err = ErrLimit
			return
		}
		if r, ok := v.(ref); ok {
			if seen[r] {
				return
			}
			seen[r] = true
		}
		v = p.resolve(v)
		if a, ok := v.(array); ok {
			for _, child := range a {
				walk(child, pageID, role, alt, depth+1)
			}
			return
		}
		if n, ok := v.(float64); ok {
			if pageID != 0 {
				if tags[pageID] == nil {
					tags[pageID] = map[int]string{}
					alts[pageID] = map[int]string{}
				}
				tags[pageID][int(n)] = role
				alts[pageID][int(n)] = alt
			}
			return
		}
		d := asDict(v)
		if d == nil {
			return
		}
		if pg, ok := d["Pg"].(ref); ok {
			pageID = pg.id
		}
		if n := named(d["S"]); n != "" {
			role = n
			if mapped := named(roles[n]); mapped != "" {
				role = mapped
			}
		}
		if a := textString(d["Alt"]); a != "" {
			alt = a
		}
		if mcid, ok := d["MCID"]; ok {
			walk(mcid, pageID, role, alt, depth+1)
		}
		if child, ok := d["K"]; ok {
			walk(child, pageID, role, alt, depth+1)
		}
	}
	walk(root["K"], 0, "", "", 0)
	return tags, alts
}
func (p *pdf) outlines(v any, pages []*pageContent) {
	pageNumbers := map[int]int{}
	for _, pc := range pages {
		pageNumbers[pc.id.id] = pc.page.Number
	}
	seen := map[ref]bool{}
	count := 0
	var walk func(any, int)
	walk = func(v any, level int) {
		for v != nil {
			count++
			if count > 10000 || level > 64 {
				p.warn("outline-limit", 0, "The document outline exceeds the traversal limit.")
				return
			}
			if r, ok := v.(ref); ok {
				if seen[r] {
					return
				}
				seen[r] = true
			}
			d := p.dict(v)
			if d == nil {
				return
			}
			dest := p.array(d["Dest"])
			if len(dest) == 0 {
				dest = p.array(p.dict(d["A"])["D"])
			}
			page := 0
			if len(dest) > 0 {
				if r, ok := dest[0].(ref); ok {
					page = pageNumbers[r.id]
				}
			}
			title := textString(d["Title"])
			if title != "" {
				p.out.Outline = append(p.out.Outline, Outline{title, page, level})
			}
			walk(d["First"], level+1)
			v = d["Next"]
		}
	}
	walk(p.dict(v)["First"], 1)
}

func bodyFontSize(pages []*pageContent) float64 {
	counts := map[int]int{}
	for _, pc := range pages {
		for _, s := range pc.spans {
			if s.size > 0 && s.size < 100 {
				counts[int(math.Round(s.size*2))] += utf8.RuneCountInString(s.text)
			}
		}
	}
	best, weight := 22, 0
	for k, n := range counts {
		if n > weight || (n == weight && k < best) {
			best, weight = k, n
		}
	}
	return float64(best) / 2
}
