package pdfextractor

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

func matrixSVG(m matrix) string {
	values := make([]string, 6)
	for j, n := range m {
		values[j] = strconv.FormatFloat(n, 'g', 12, 64)
	}
	return "matrix(" + strings.Join(values, " ") + ")"
}
func contained(a, b Rect, pad float64) bool {
	return a.X >= b.X-pad && a.Y >= b.Y-pad && a.X+a.W <= b.X+b.W+pad && a.Y+a.H <= b.Y+b.H+pad
}
func expand(r Rect, pad float64) Rect { return Rect{r.X - pad, r.Y - pad, r.W + pad*2, r.H + pad*2} }

// Positioned SVG is a faithful visual representation, not guessed LaTeX. Its
// searchable linear text and source rectangle are retained in the block model.
func (p *pdf) positionedAsset(pc *pageContent, spans []span, paths []vectorPath, box Rect, label string) (string, Rect) {
	var defs, body strings.Builder
	budget := func() bool {
		if defs.Len()+body.Len()+p.assetBytes+p.outlineBytes > p.opts.Limits.AssetBytes {
			p.err = ErrLimit
			return false
		}
		return true
	}
	type glyphKey struct {
		f    *font
		code uint32
	}
	ids := map[glyphKey]string{}
	for _, v := range paths {
		body.WriteString(v.svg)
		box = union(box, v.box)
		if !budget() {
			return "", box
		}
	}
	for _, s := range spans {
		if s.font == nil || s.encoded == "" {
			continue
		}
		f := s.font
		g := s.graphics
		transform := g.ctm.mul(g.tm)
		offset := 0.0
		program := p.fontProgram(f, pc.page.Number)
		for raw := s.encoded; len(raw) > 0; {
			if p.check() != nil {
				return "", box
			}
			u, code, n := f.glyph(raw)
			advance := (f.width(code, u)*g.size/1000 + g.charSpace) * g.scale
			if n == 1 && raw[0] == ' ' {
				advance += g.wordSpace * g.scale
			}
			placed := transform.mul(translation(offset, g.rise))
			painted := false
			if program != nil {
				name := ""
				if code < 256 {
					name = f.names[code]
				}
				previous := len(program.cache)
				path, fm, e := program.outline(code, name)
				gid := program.codes[code]
				if program.names != nil {
					gid = program.names[name]
				}
				if len(program.cache) > previous {
					p.operations += program.cache[gid].operations
					p.outlineBytes += len(program.cache[gid].path)
				}
				if p.operations > p.opts.Limits.Operations || !budget() {
					p.err = ErrLimit
					return "", box
				}
				if e == nil {
					placedGlyph := placed.mul(matrix{g.size * g.scale, 0, 0, g.size, 0, 0}).mul(fm)
					key := glyphKey{f, code}
					id := ids[key]
					if id == "" {
						id = fmt.Sprintf("g%d", len(ids))
						ids[key] = id
						defs.WriteString(`<path id="` + id + `" d="` + path + `"/>`)
					}
					body.WriteString(`<use href="#` + id + `" transform="` + matrixSVG(placedGlyph) + `" fill="` + g.fill + `"/>`)
					gid = program.codes[code]
					if program.names != nil {
						gid = program.names[name]
					}
					cached := program.cache[gid]
					if cached.hasBox {
						r := cached.box
						drawn := placedGlyph.rect(r.X, r.Y, r.W, r.H)
						if finiteRect(drawn) {
							box = union(box, drawn)
						}
					}
					painted = true
				} else {
					if errors.Is(e, ErrLimit) {
						p.err = e
						return "", box
					}
					p.warn("glyph-outline", pc.page.Number, "Some positioned glyphs use Unicode fallback: "+e.Error())
				}
			}
			if !painted {
				family := "serif"
				if f.mono {
					family = "monospace"
				}
				style := ""
				if f.bold {
					style += ` font-weight="bold"`
				}
				if f.italic {
					style += ` font-style="italic"`
				}
				m := placed.mul(matrix{g.scale, 0, 0, -1, 0, 0})
				body.WriteString(`<text transform="` + matrixSVG(m) + `" font-family="` + family + `" font-size="` + fnum(math.Abs(g.size)) + `" fill="` + g.fill + `"` + style + `>` + xmlText(u) + `</text>`)
			}
			offset += advance
			raw = raw[n:]
			if !budget() {
				return "", box
			}
		}
	}
	box = expand(box, 1)
	svg := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="` + fnum(box.X) + " " + fnum(box.Y) + " " + fnum(box.W) + " " + fnum(box.H) + `" width="` + fnum(box.W) + `" height="` + fnum(box.H) + `" role="img"><title>` + xmlText(label) + `</title><rect x="` + fnum(box.X) + `" y="` + fnum(box.Y) + `" width="` + fnum(box.W) + `" height="` + fnum(box.H) + `" fill="white"/><defs>` + defs.String() + `</defs>` + body.String() + `</svg>`
	return p.addAsset([]byte(svg), "image/svg+xml", "svg", int(math.Ceil(box.W)), int(math.Ceil(box.H))), box
}

var proseWord = regexp.MustCompile(`[A-Za-z]{3,}`)
var mathWords = map[string]bool{"sin": true, "cos": true, "tan": true, "cot": true, "sec": true, "csc": true, "log": true, "ln": true, "exp": true, "lim": true, "max": true, "min": true, "sup": true, "inf": true, "dim": true, "null": true, "range": true, "span": true, "rank": true, "det": true, "mod": true, "for": true, "and": true, "etc": true}

var svgColor = regexp.MustCompile(`#[0-9a-fA-F]{6}`)

func monochromeMath(spans []span, paths []vectorPath) bool {
	for _, s := range spans {
		if s.graphics.fill != "#000000" && s.graphics.fill != "#ffffff" {
			return false
		}
	}
	for _, p := range paths {
		for _, c := range svgColor.FindAllString(p.svg, -1) {
			if c != "#000000" && c != "#ffffff" {
				return false
			}
		}
	}
	return true
}

func mathLine(l *line) bool {
	if !l.math || l.mono {
		return l.role == "Formula"
	}
	// A prose continuation with many mathematical tokens is still prose.
	for _, word := range []string{"of ", "and ", "where ", "for ", "with ", "suppose ", "let ", "then ", "if ", "proof ", "thus ", "hence "} {
		if strings.HasPrefix(strings.ToLower(l.text), word) {
			return false
		}
	}
	mathChars, total := 0, 0
	for _, s := range l.spans {
		n := utf8.RuneCountInString(strings.TrimSpace(s.text))
		total += n
		if s.font != nil && s.font.math {
			mathChars += n
		}
	}
	if total == 0 {
		return false
	}
	for _, word := range proseWord.FindAllString(l.text, -1) {
		if !mathWords[strings.ToLower(word)] {
			return false
		}
	}
	return mathChars*2 >= total || strings.ContainsAny(l.text, "=+−×÷∑∫√≤≥∈→")
}

// Numerators, denominators and equation signs often use an ordinary text font.
func mathFragment(l *line) bool {
	if l.mono || len(l.text) > 180 {
		return false
	}
	for _, word := range proseWord.FindAllString(l.text, -1) {
		if !mathWords[strings.ToLower(word)] {
			return false
		}
	}
	for _, prefix := range []string{"of ", "and ", "for ", "if "} {
		if strings.HasPrefix(strings.ToLower(l.text), prefix) {
			return false
		}
	}
	return true
}

func (p *pdf) mathBlocks(pc *pageContent, lines []*line) []Block {
	var blocks []Block
	for j, l := range lines {
		if l.used || !mathLine(l) {
			continue
		}
		l.used = true
		group := append([]span(nil), l.spans...)
		box := l.box
		text := l.text
		for k := j + 1; k < len(lines); k++ {
			next := lines[k]
			if next.box.Y > box.Y+box.H+math.Max(l.size, 10)*1.6 {
				break
			}
			if next.used || !mathFragment(next) || next.box.X > box.X+box.W+l.size || box.X > next.box.X+next.box.W+l.size {
				continue
			}
			next.used = true
			group = append(group, next.spans...)
			box = union(box, next.box)
			text += " " + next.text
		}
		// A display can include a short prose annotation on a mathematical
		// baseline ("so that", "terms with higher ..."). Keep it with the
		// formula when the surrounding baselines already establish its region.
		for k, candidate := range lines {
			if candidate.used || !candidate.math || candidate.baseline < box.Y || candidate.baseline > box.Y+box.H || candidate.box.X > box.X+box.W+l.size*2 || candidate.box.X+candidate.box.W < box.X-l.size*2 {
				continue
			}
			words := 0
			letters := 0
			for _, word := range proseWord.FindAllString(candidate.text, -1) {
				if !mathWords[strings.ToLower(word)] {
					words++
					letters += len(word)
				}
			}
			if words == 0 || letters > 28 || !strings.ContainsAny(candidate.text, "=+−×÷∑∫√≤≥∈→") {
				continue
			}
			mathCount := 0
			annotationX := math.Inf(1)
			for _, s := range candidate.spans {
				if s.font != nil && s.font.math {
					mathCount += utf8.RuneCountInString(s.text)
				}
				for _, word := range proseWord.FindAllString(s.text, -1) {
					if !mathWords[strings.ToLower(word)] {
						annotationX = math.Min(annotationX, s.box.X)
					}
				}
			}
			if mathCount < 3 {
				continue
			}
			candidate.used = true
			group = append(group, candidate.spans...)
			box = union(box, candidate.box)
			text += " " + candidate.text
			// A right-hand annotation can wrap independently of the formula.
			if k+1 < len(lines) && annotationX > box.X+box.W*.45 {
				n := k + 1
				for n < len(lines) && lines[n].used {
					n++
				}
				if n == len(lines) {
					continue
				}
				next := lines[n]
				if !next.used && annotationContinuation(candidate, next) && math.Abs(next.box.X-annotationX) <= l.size && next.box.X+next.box.W <= box.X+box.W+l.size && next.baseline > candidate.baseline && next.baseline-candidate.baseline < l.size*2 && len(next.text) < 70 {
					next.used = true
					group = append(group, next.spans...)
					box = union(box, next.box)
					text += " " + next.text
				}
			}
		}
		// A baseline can mix prose with pieces of a multi-line formula.
		// Recover only mathematical spans inside the region, leaving prose in
		// the normal text flow. This catches fraction signs and raised powers.
		for _, candidate := range lines {
			if candidate.used || !intersects(candidate.box, expand(box, math.Max(l.size, 10)*.4)) {
				continue
			}
			kept := candidate.spans[:0]
			for _, s := range candidate.spans {
				fragment := &line{text: s.text, mono: s.mono}
				if contained(s.box, box, math.Max(l.size, 10)*.4) && mathFragment(fragment) {
					group = append(group, s)
					box = union(box, s.box)
					text += " " + s.text
				} else {
					kept = append(kept, s)
				}
			}
			if len(kept) == len(candidate.spans) {
				continue
			}
			candidate.spans = kept
			if len(kept) == 0 {
				candidate.used = true
			} else {
				candidate.box = kept[0].box
				for _, s := range kept[1:] {
					candidate.box = union(candidate.box, s.box)
				}
				finishLine(candidate)
			}
		}
		paths := []vectorPath{}
		for _, path := range pc.paths {
			if contained(path.box, box, l.size*.4) {
				paths = append(paths, path)
			}
		}
		asset, visualBox := p.positionedAsset(pc, group, paths, box, text)
		blocks = append(blocks, Block{Kind: "math", Text: text, Asset: asset, Alt: text, Box: visualBox, Representation: "positioned", Role: "formula", WidthEm: visualBox.W / l.size, Monochrome: monochromeMath(group, paths)})
	}
	if len(blocks) > 0 {
		p.warn("math-positioned", 0, "Equations preserve PDF glyph positions and paths. Their linear text is not semantic LaTeX or MathML.")
	}
	return blocks
}

func annotationContinuation(previous, next *line) bool {
	// Geometric proximity alone also matches a new sentence or heading.
	// Continue only unfinished prose into a short, lowercase-starting line.
	text := strings.TrimSpace(previous.text)
	if text == "" || strings.ContainsRune(".!?;:", rune(text[len(text)-1])) || next.mono || next.size > previous.size*1.1 {
		return false
	}
	first, _ := utf8.DecodeRuneInString(strings.TrimSpace(next.text))
	return unicode.IsLower(first) && len(proseWord.FindAllString(next.text, -1)) > 0
}

func (p *pdf) inlineMath(pc *pageContent, l *line) {
	// Preserve a contiguous math-font expression, including scripts, as one
	// baseline-aligned asset. Ordinary single variables remain selectable text.
	var runs []Run
	for j := 0; j < len(l.spans); {
		s := l.spans[j]
		end := j + 1
		if s.font != nil && s.font.math {
			for end < len(l.spans) {
				n := l.spans[end]
				if n.font == nil || !n.font.math || n.box.X-l.spans[end-1].box.X-l.spans[end-1].box.W > l.size*.8 {
					break
				}
				end++
			}
		}
		unmapped, visual := false, false
		box := s.box
		for k := j; k < end; k++ {
			v := l.spans[k]
			unmapped = unmapped || (v.font != nil && strings.Contains(v.text, "�"))
			box = union(box, v.box)
			visual = visual || v.script != "" || v.size > l.size*1.35
		}
		visual = visual || unmapped
		prefix := ""
		if j > 0 {
			prev := l.spans[j-1]
			if s.box.X-prev.box.X-prev.box.W > math.Max(1, l.size*.15) && !strings.HasSuffix(prev.text, " ") && !strings.HasPrefix(s.text, " ") {
				prefix = " "
			}
		}
		if visual && s.font != nil && (s.font.math || unmapped) {
			text := ""
			for _, v := range l.spans[j:end] {
				text += deLigature.Replace(v.text)
			}
			asset, box := p.positionedAsset(pc, l.spans[j:end], nil, box, text)
			if prefix != "" {
				runs = append(runs, Run{Text: prefix})
			}
			runs = append(runs, Run{Text: text, Asset: asset, Height: box.H / l.size, Depth: math.Max(0, (box.Y+box.H-l.baseline)/l.size), Monochrome: monochromeMath(l.spans[j:end], nil)})
		} else {
			for k := j; k < end; k++ {
				v := l.spans[k]
				space := ""
				if k == j {
					space = prefix
				}
				runs = append(runs, Run{Text: space + deLigature.Replace(v.text), Bold: v.bold, Italic: v.italic, Link: v.link, Script: v.script})
			}
		}
		j = end
	}
	l.runs = runs
}
