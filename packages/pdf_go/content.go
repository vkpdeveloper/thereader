package pdfextractor

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

type matrix [6]float64

var identity = matrix{1, 0, 0, 1, 0, 0}

func (a matrix) valid() bool {
	for _, n := range a {
		if math.IsNaN(n) || math.IsInf(n, 0) || math.Abs(n) > 1e12 {
			return false
		}
	}
	return true
}

func (a matrix) mul(b matrix) matrix {
	return matrix{a[0]*b[0] + a[2]*b[1], a[1]*b[0] + a[3]*b[1], a[0]*b[2] + a[2]*b[3], a[1]*b[2] + a[3]*b[3], a[0]*b[4] + a[2]*b[5] + a[4], a[1]*b[4] + a[3]*b[5] + a[5]}
}
func (a matrix) point(x, y float64) (float64, float64) {
	return a[0]*x + a[2]*y + a[4], a[1]*x + a[3]*y + a[5]
}
func translation(x, y float64) matrix { return matrix{1, 0, 0, 1, x, y} }
func (a matrix) rect(x, y, w, h float64) Rect {
	x1, y1 := a.point(x, y)
	x2, y2 := x1, y1
	for _, pt := range [][2]float64{{x + w, y}, {x, y + h}, {x + w, y + h}} {
		xx, yy := a.point(pt[0], pt[1])
		x1 = math.Min(x1, xx)
		x2 = math.Max(x2, xx)
		y1 = math.Min(y1, yy)
		y2 = math.Max(y2, yy)
	}
	return Rect{x1, y1, x2 - x1, y2 - y1}
}
func union(a, b Rect) Rect {
	x := math.Min(a.X, b.X)
	y := math.Min(a.Y, b.Y)
	return Rect{x, y, math.Max(a.X+a.W, b.X+b.W) - x, math.Max(a.Y+a.H, b.Y+b.H) - y}
}
func intersects(a, b Rect) bool {
	return a.X < b.X+b.W && b.X < a.X+a.W && a.Y < b.Y+b.H && b.Y < a.Y+a.H
}

type span struct {
	text               string
	box                Rect
	size               float64
	bold, italic, mono bool
	link, role         string
	mcid               int
	baseline           float64
	script             string
	font               *font
	encoded            string
	graphics           graphics
}
type ruling struct{ x1, y1, x2, y2 float64 }
type vectorPath struct {
	svg string
	box Rect
}
type pageContent struct {
	page    Page
	spans   []span
	images  []Block
	rules   []ruling
	id      ref
	tags    map[int]string
	alt     map[int]string
	paths   []vectorPath
	pathBox Rect
	hasPath bool
}
type graphics struct {
	ctm, tm, tl                                      matrix
	font                                             *font
	size, charSpace, wordSpace, scale, leading, rise float64
	mode                                             int
	fill, stroke                                     string
	lineWidth                                        float64
}
type marked struct {
	role, actual, alt string
	artifact          bool
	start             int
	mcid              int
}
type interpreter struct {
	p                      *pdf
	page                   *pageContent
	g                      graphics
	stack                  []graphics
	marks                  []marked
	path                   strings.Builder
	pathBox                Rect
	hasPath                bool
	currentX, currentY     float64
	pathStartX, pathStartY float64
	resources              dict
	depth                  int
	active                 map[*stream]bool
}

func (i *interpreter) run(data []byte) error {
	if !i.g.ctm.valid() {
		return ErrLimit
	}
	l := lexer{b: data}
	args := make(array, 0, 12)
	for l.pos < len(data) && l.err == nil {
		l.skip()
		if l.pos == len(data) {
			break
		}
		v := l.value(0)
		op, ok := v.(keyword)
		if !ok {
			args = append(args, v)
			if len(args) > 10000 {
				return ErrLimit
			}
			continue
		}
		i.p.operations++
		if i.p.operations > i.p.opts.Limits.Operations {
			return ErrLimit
		}
		if i.p.operations%1024 == 0 {
			if e := i.p.check(); e != nil {
				return e
			}
		}
		if e := i.op(string(op), args, &l); e != nil {
			return e
		}
		args = args[:0]
	}
	return l.err
}
func nums(a array, n int) ([]float64, bool) {
	if len(a) != n {
		return nil, false
	}
	v := make([]float64, n)
	for i, x := range a {
		f, ok := x.(float64)
		if !ok || math.Abs(f) > 1e8 {
			return nil, false
		}
		v[i] = f
	}
	return v, true
}
func (i *interpreter) op(op string, a array, l *lexer) error {
	g := &i.g
	switch op {
	case "q":
		if len(i.stack) > 64 {
			return ErrLimit
		}
		i.stack = append(i.stack, *g)
	case "Q":
		if len(i.stack) > 0 {
			*g = i.stack[len(i.stack)-1]
			i.stack = i.stack[:len(i.stack)-1]
		}
	case "cm":
		if n, ok := nums(a, 6); ok {
			g.ctm = g.ctm.mul(matrix(n))
			if !g.ctm.valid() {
				return ErrLimit
			}
		}
	case "BT":
		g.tm = identity
		g.tl = identity
	case "ET":
	case "Tf":
		if len(a) == 2 {
			g.font = i.p.font(i.p.dict(i.resources["Font"])[named(a[0])], i.page.page.Number)
			g.size = number(a[1])
		}
	case "Tm":
		if n, ok := nums(a, 6); ok {
			g.tm = matrix(n)
			g.tl = g.tm
		}
	case "Td", "TD":
		if n, ok := nums(a, 2); ok {
			if op == "TD" {
				g.leading = -n[1]
			}
			g.tl = g.tl.mul(translation(n[0], n[1]))
			g.tm = g.tl
		}
	case "T*":
		g.tl = g.tl.mul(translation(0, -g.leading))
		g.tm = g.tl
	case "Tc", "Tw", "Tz", "TL", "Ts", "Tr":
		if len(a) == 1 {
			n := number(a[0])
			switch op {
			case "Tc":
				g.charSpace = n
			case "Tw":
				g.wordSpace = n
			case "Tz":
				g.scale = n / 100
			case "TL":
				g.leading = n
			case "Ts":
				g.rise = n
			case "Tr":
				g.mode = int(n)
			}
		}
	case "Tj":
		if len(a) == 1 {
			if s, ok := a[0].(literal); ok {
				return i.show(string(s))
			}
		}
	case "'", "\"":
		if op == "\"" && len(a) == 3 {
			g.wordSpace = number(a[0])
			g.charSpace = number(a[1])
		}
		g.tl = g.tl.mul(translation(0, -g.leading))
		g.tm = g.tl
		if len(a) > 0 {
			if s, ok := a[len(a)-1].(literal); ok {
				return i.show(string(s))
			}
		}
	case "TJ":
		if len(a) == 1 {
			for _, v := range asArray(a[0]) {
				if s, ok := v.(literal); ok {
					if e := i.show(string(s)); e != nil {
						return e
					}
				} else {
					g.tm = g.tm.mul(translation(-number(v)*g.size*g.scale/1000, 0))
				}
			}
		}
	case "Do":
		if len(a) == 1 {
			return i.xobject(named(a[0]))
		}
	case "BMC", "BDC":
		if len(i.marks) > 64 {
			return ErrLimit
		}
		m := marked{start: len(i.page.spans), mcid: -1}
		if len(a) > 0 {
			m.role = named(a[0])
			m.artifact = m.role == "Artifact"
		}
		if len(i.marks) > 0 {
			m.artifact = m.artifact || i.marks[len(i.marks)-1].artifact
		}
		if op == "BDC" && len(a) == 2 {
			v := a[1]
			if n, ok := v.(name); ok {
				v = i.p.dict(i.resources["Properties"])[string(n)]
			}
			d := i.p.dict(v)
			if c, ok := d["MCID"]; ok {
				m.mcid = integer(c)
				if role := i.page.tags[m.mcid]; role != "" {
					m.role = role
				}
				m.alt = i.page.alt[m.mcid]
			}
			m.actual = textString(d["ActualText"])
		}
		i.marks = append(i.marks, m)
	case "EMC":
		if len(i.marks) > 0 {
			m := i.marks[len(i.marks)-1]
			i.marks = i.marks[:len(i.marks)-1]
			if m.actual != "" && m.start < len(i.page.spans) {
				s := i.page.spans[m.start]
				for _, v := range i.page.spans[m.start+1:] {
					s.box = union(s.box, v.box)
				}
				s.text = m.actual
				i.page.spans = append(i.page.spans[:m.start], s)
			}
		}
	case "BI":
		return i.inlineImage(l)
	case "gs":
		if len(a) == 1 {
			d := i.p.dict(i.p.dict(i.resources["ExtGState"])[named(a[0])])
			if a := i.p.array(d["Font"]); len(a) == 2 {
				g.font = i.p.font(a[0], i.page.page.Number)
				g.size = number(a[1])
			}
			if d["SMask"] != nil && named(d["SMask"]) != "None" {
				i.p.warn("transparency", i.page.page.Number, "Graphics soft masks need visual review.")
			}
		}
	case "w":
		if len(a) == 1 {
			g.lineWidth = number(a[0])
		}
	case "g", "G":
		if len(a) == 1 {
			c := rgb(number(a[0]), number(a[0]), number(a[0]))
			if op == "g" {
				g.fill = c
			} else {
				g.stroke = c
			}
		}
	case "rg", "RG":
		if n, ok := nums(a, 3); ok {
			c := rgb(n[0], n[1], n[2])
			if op == "rg" {
				g.fill = c
			} else {
				g.stroke = c
			}
		}
	case "k", "K":
		if n, ok := nums(a, 4); ok {
			c := rgb((1-n[0])*(1-n[3]), (1-n[1])*(1-n[3]), (1-n[2])*(1-n[3]))
			if op == "k" {
				g.fill = c
			} else {
				g.stroke = c
			}
		}
	case "m", "l":
		if n, ok := nums(a, 2); ok {
			x, y := g.ctm.point(n[0], n[1])
			if op == "l" {
				i.page.rules = append(i.page.rules, ruling{i.currentX, i.currentY, x, y})
			} else {
				i.pathStartX, i.pathStartY = x, y
			}
			i.pointPath(x, y)
			i.path.WriteString(strings.ToUpper(op) + fnum(x) + " " + fnum(y) + " ")
			i.currentX, i.currentY = x, y
		}
	case "c":
		if n, ok := nums(a, 6); ok {
			i.path.WriteString("C")
			for j := 0; j < 6; j += 2 {
				x, y := g.ctm.point(n[j], n[j+1])
				i.pointPath(x, y)
				i.path.WriteString(fnum(x) + " " + fnum(y) + " ")
				i.currentX, i.currentY = x, y
			}
		}
	case "v", "y":
		if n, ok := nums(a, 4); ok {
			x1, y1 := g.ctm.point(n[0], n[1])
			x2, y2 := g.ctm.point(n[2], n[3])
			c1x, c1y, c2x, c2y := i.currentX, i.currentY, x1, y1
			if op == "y" {
				c1x, c1y, c2x, c2y = x1, y1, x2, y2
			}
			i.path.WriteString("C" + fnum(c1x) + " " + fnum(c1y) + " " + fnum(c2x) + " " + fnum(c2y) + " " + fnum(x2) + " " + fnum(y2) + " ")
			i.pointPath(x1, y1)
			i.pointPath(x2, y2)
			i.currentX, i.currentY = x2, y2
		}
	case "re":
		if n, ok := nums(a, 4); ok {
			pts := [][2]float64{{n[0], n[1]}, {n[0] + n[2], n[1]}, {n[0] + n[2], n[1] + n[3]}, {n[0], n[1] + n[3]}}
			var prev [2]float64
			for j, pt := range pts {
				x, y := g.ctm.point(pt[0], pt[1])
				i.pointPath(x, y)
				letter := "L"
				if j == 0 {
					letter = "M"
				} else {
					i.page.rules = append(i.page.rules, ruling{prev[0], prev[1], x, y})
				}
				i.path.WriteString(letter + fnum(x) + " " + fnum(y) + " ")
				prev = [2]float64{x, y}
			}
			x, y := g.ctm.point(n[0], n[1])
			i.page.rules = append(i.page.rules, ruling{prev[0], prev[1], x, y})
			i.path.WriteString("Z ")
		}
	case "h":
		i.path.WriteString("Z ")
		i.currentX, i.currentY = i.pathStartX, i.pathStartY
	case "S", "s", "f", "F", "f*", "B", "B*", "b", "b*":
		i.paint(op)
	case "n":
		i.path.Reset()
		i.hasPath = false
	case "W", "W*": // clipping is not applied to exported vector paths
		r := i.pathBox
		wholePage := i.hasPath && math.Abs(r.X) < 1 && math.Abs(r.Y) < 1 && math.Abs(r.W-i.page.page.Width) < 2 && math.Abs(r.H-i.page.page.Height) < 2
		if !wholePage {
			i.p.warn("clipping", i.page.page.Number, "A clipping path is present; exported graphics may extend outside it.")
		}
	case "sh":
		i.p.warn("shading", i.page.page.Number, "Gradient shading is not reconstructed.")
	case "CS", "cs", "SC", "SCN", "sc", "scn":
		i.p.warn("color-space", i.page.page.Number, "Custom graphics colors are approximated.")
	case "d", "J", "j", "M", "ri", "i", "BX", "EX", "MP", "DP": // styling/compatibility operators do not alter text
	default:
		i.p.warn("operator", i.page.page.Number, "Unrecognized content operator: "+op)
	}
	return nil
}
func (i *interpreter) show(s string) error {
	g := &i.g
	encoded := s
	if g.font == nil {
		g.font = i.p.font(nil, i.page.page.Number)
		i.p.warn("missing-font", i.page.page.Number, "Text without a font uses fallback positioning.")
	}
	if g.size == 0 {
		return nil
	}
	var text strings.Builder
	width := 0.0
	for len(s) > 0 {
		u, code, n := g.font.glyph(s)
		width += (g.font.width(code, u)*g.size/1000 + g.charSpace) * g.scale
		if n == 1 && s[0] == ' ' {
			width += g.wordSpace * g.scale
		}
		text.WriteString(u)
		s = s[n:]
	}
	str := text.String()
	transform := g.ctm.mul(g.tm)
	saved := *g
	box := transform.rect(0, g.rise-g.size*0.22, width, g.size)
	g.tm = g.tm.mul(translation(width, 0))
	if str == "" {
		return nil
	}
	role := ""
	mcid := -1
	artifact := false
	if len(i.marks) > 0 {
		m := i.marks[len(i.marks)-1]
		role, mcid, artifact = m.role, m.mcid, m.artifact
	}
	if artifact && !i.p.opts.KeepArtifacts {
		return nil
	}
	if strings.ContainsRune(str, '�') {
		i.p.warn("unmapped-glyph", i.page.page.Number, "Some glyphs could not be mapped to Unicode.")
	}
	if !finiteRect(box) {
		return ErrLimit
	}
	i.p.spanCount++
	if i.p.spanCount > i.p.opts.Limits.Spans {
		return ErrLimit
	}
	size := math.Abs(g.size) * math.Hypot(transform[2], transform[3])
	if size == 0 {
		return nil
	} // A singular transform has no visible text height.
	_, baseline := transform.point(0, g.rise)
	// A rotated side-margin stamp is publishing furniture, not a giant heading.
	if !i.p.opts.KeepArtifacts && math.Abs(transform[1]) > math.Abs(transform[0])*2 && (box.X+box.W < i.page.page.Width*.08 || box.X > i.page.page.Width*.92) {
		return nil
	}
	i.page.spans = append(i.page.spans, span{text: str, box: box, size: size, bold: g.font.bold, italic: g.font.italic, mono: g.font.mono, role: role, mcid: mcid, baseline: baseline, font: g.font, encoded: encoded, graphics: saved})
	return nil
}
func finiteRect(r Rect) bool {
	for _, n := range []float64{r.X, r.Y, r.W, r.H} {
		if math.IsNaN(n) || math.IsInf(n, 0) || math.Abs(n) > 1e9 {
			return false
		}
	}
	return true
}
func (i *interpreter) xobject(key string) error {
	s, ok := i.p.resolve(i.p.dict(i.resources["XObject"])[key]).(*stream)
	if !ok {
		return nil
	}
	if named(s.dict["Subtype"]) == "Image" {
		id, e := i.p.image(s, i.page.page.Number)
		if e != nil {
			if errors.Is(e, ErrLimit) {
				return e
			}
			i.p.warn("image", i.page.page.Number, e.Error())
			return nil
		}
		alt := "Image"
		if len(i.marks) > 0 && i.marks[len(i.marks)-1].alt != "" {
			alt = i.marks[len(i.marks)-1].alt
		}
		box := i.g.ctm.rect(0, 0, 1, 1)
		if !finiteRect(box) {
			return ErrLimit
		}
		i.page.images = append(i.page.images, Block{Kind: "image", Asset: id, Alt: alt, Box: box})
		return nil
	}
	if named(s.dict["Subtype"]) != "Form" {
		i.p.warn("xobject", i.page.page.Number, "Unsupported XObject subtype")
		return nil
	}
	if i.depth >= 32 || i.active[s] {
		return fmt.Errorf("%w: recursive form XObject", ErrInvalid)
	}
	b, e := i.p.decode(s)
	if e != nil {
		return e
	}
	child := *i
	child.depth++
	child.stack = nil
	child.marks = append([]marked(nil), i.marks...)
	child.path = strings.Builder{}
	child.hasPath = false
	if a := i.p.array(s.dict["Matrix"]); len(a) == 6 {
		var m matrix
		for j := range m {
			m[j] = number(a[j])
		}
		child.g.ctm = child.g.ctm.mul(m)
	}
	if d := i.p.dict(s.dict["Resources"]); d != nil {
		child.resources = d
	}
	i.active[s] = true
	defer delete(i.active, s)
	return child.run(b)
}

func (i *interpreter) pointPath(x, y float64) {
	r := Rect{x, y, 0, 0}
	if !i.hasPath {
		i.pathBox = r
		i.hasPath = true
	} else {
		i.pathBox = union(i.pathBox, r)
	}
}
func (i *interpreter) paint(op string) {
	if len(i.marks) > 0 && i.marks[len(i.marks)-1].artifact && !i.p.opts.KeepArtifacts {
		i.path.Reset()
		i.hasPath = false
		return
	}
	if i.hasPath {
		fill, stroke := "none", "none"
		if op != "S" && op != "s" {
			fill = i.g.fill
		}
		if strings.ContainsAny(op, "SsBb") {
			stroke = i.g.stroke
		}
		close := ""
		if op == "s" || strings.HasPrefix(op, "b") {
			close = " Z"
		}
		rule := "nonzero"
		if strings.Contains(op, "*") {
			rule = "evenodd"
		}
		// Page backgrounds and thin separators do not belong in a reflowable book.
		background := fill == "#ffffff" && i.pathBox.W >= i.page.page.Width*.95 && i.pathBox.H >= i.page.page.Height*.95
		if !background && (i.pathBox.W > .05 || i.pathBox.H > .05) {
			i.page.paths = append(i.page.paths, vectorPath{`<path d="` + i.path.String() + close + `" fill="` + fill + `" stroke="` + stroke + `" stroke-width="` + fnum(math.Abs(i.g.lineWidth)) + `" fill-rule="` + rule + `"/>`, i.pathBox})
		}
		if !i.page.hasPath {
			i.page.pathBox = i.pathBox
			i.page.hasPath = true
		} else {
			i.page.pathBox = union(i.page.pathBox, i.pathBox)
		}
	}
	i.path.Reset()
	i.hasPath = false
}
func fnum(n float64) string { return strconv.FormatFloat(n, 'f', 3, 64) }
func rgb(r, g, b float64) string {
	c := func(v float64) int { return int(math.Max(0, math.Min(1, v))*255 + 0.5) }
	return fmt.Sprintf("#%02x%02x%02x", c(r), c(g), c(b))
}

func (p *pdf) pageLinks(pc *pageContent, d dict, base matrix) {
	for _, v := range p.array(d["Annots"]) {
		a := p.dict(v)
		if named(a["Subtype"]) != "Link" {
			if named(a["Subtype"]) != "" {
				p.warn("annotation", pc.page.Number, "Non-link annotation: "+named(a["Subtype"]))
			}
			continue
		}
		action := p.dict(a["A"])
		url := textString(action["URI"])
		if !safeLink(url) {
			continue
		}
		r := p.array(a["Rect"])
		if len(r) != 4 {
			continue
		}
		box := base.rect(number(r[0]), number(r[1]), number(r[2])-number(r[0]), number(r[3])-number(r[1]))
		for j := range pc.spans {
			if intersects(pc.spans[j].box, box) {
				pc.spans[j].link = url
			}
		}
	}
}
func safeLink(s string) bool {
	lower := strings.ToLower(strings.TrimSpace(s))
	return strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "mailto:")
}

func deduplicateSpans(spans []span) []span {
	// Overprinted text is a common bold/shadow technique. It must not duplicate
	// the words in reading output. Compare adjacent position-sorted spans.
	sort.SliceStable(spans, func(i, j int) bool {
		if spans[i].box.Y != spans[j].box.Y {
			return spans[i].box.Y < spans[j].box.Y
		}
		return spans[i].box.X < spans[j].box.X
	})
	out := spans[:0]
	for _, s := range spans {
		duplicate := false
		for j := len(out) - 1; j >= 0 && j >= len(out)-12; j-- {
			t := out[j]
			if math.Abs(t.box.Y-s.box.Y) < 1 && math.Abs(t.box.X-s.box.X) < 1 && s.text == t.text {
				duplicate = true
				break
			}
		}
		if !duplicate && utf8.ValidString(s.text) {
			out = append(out, s)
		}
	}
	return out
}
