package pdfextractor

import (
	"math"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

type line struct {
	spans      []span
	baseline   float64
	math       bool
	box        Rect
	size       float64
	bold, mono bool
	role       string
	cells      []string
	starts     []float64
	text       string
	runs       []Run
	used       bool
}

var pageNumber = regexp.MustCompile(`(?i)^(?:page\s+)?(?:\d+|[ivxlcdm]+)(?:\s*(?:of|/)\s*\d+)?$`)
var marginDigits = regexp.MustCompile(`\d+`)
var sectionNumber = regexp.MustCompile(`^(?:[A-Z]|\d+)(?:\.\d+){1,3}\s+\p{L}`)
var bulletLine = regexp.MustCompile(`^(?:[•●▪◦‣]|[-*]\s|\d+[.)]\s)`)
var deLigature = strings.NewReplacer("ﬁ", "fi", "ﬂ", "fl", "ﬀ", "ff", "ﬃ", "ffi", "ﬄ", "ffl", "\u00ad", "", "\u00a0", " ")

func spanBaseline(s span) float64 {
	if s.baseline != 0 {
		return s.baseline
	}
	return s.box.Y + s.box.H*.78
}

// Remove whole running lines, never character/kerning fragments. A number in
// an equation or a short word near a margin must not disappear in isolation.
func cleanMargins(pages []*pageContent) {
	if len(pages) < 2 {
		return
	}
	body := bodyFontSize(pages)
	grouped := make([][]*line, len(pages))
	counts := map[string]int{}
	key := func(pc *pageContent, l *line) string {
		if l.size > body*1.1 || (l.bold && l.size >= body*.98) || len(l.text) > 180 {
			return ""
		}
		side := "top:"
		if l.box.Y+l.box.H < pc.page.Height*.08 {
		} else if l.box.Y > pc.page.Height*.94 {
			side = "bottom:"
		} else {
			return ""
		}
		return side + marginDigits.ReplaceAllString(strings.ToLower(strings.TrimSpace(l.text)), "#")
	}
	for n, pc := range pages {
		grouped[n] = makeLines(pc.spans)
		seen := map[string]bool{}
		for _, l := range grouped[n] {
			if k := key(pc, l); k != "" && !seen[k] {
				counts[k]++
				seen[k] = true
			}
		}
	}
	type position struct {
		text string
		x, y float64
	}
	for n, pc := range pages {
		drop := map[position]bool{}
		for _, l := range grouped[n] {
			k := key(pc, l)
			if k != "" && (counts[k] >= max(2, min(6, (len(pages)+1)/2)) || pageNumber.MatchString(l.text)) {
				for _, s := range l.spans {
					drop[position{s.text, s.box.X, s.box.Y}] = true
				}
			}
		}
		kept := pc.spans[:0]
		for _, s := range pc.spans {
			if !drop[position{s.text, s.box.X, s.box.Y}] {
				kept = append(kept, s)
			}
		}
		pc.spans = kept
	}
}

func makeLines(spans []span) []*line {
	ordered := append([]span(nil), spans...)
	sort.SliceStable(ordered, func(i, j int) bool { return spanBaseline(ordered[i]) < spanBaseline(ordered[j]) })
	lines := []*line{}
	for _, s := range ordered {
		if strings.TrimSpace(s.text) == "" {
			continue
		}
		baseline := spanBaseline(s)
		var target *line
		if len(lines) > 0 {
			l := lines[len(lines)-1]
			if math.Abs(baseline-l.baseline) < math.Max(.6, math.Min(s.size, l.size)*.25) {
				target = l
			}
		}
		if target == nil {
			target = &line{box: s.box, baseline: baseline}
			lines = append(lines, target)
		} else {
			target.box = union(target.box, s.box)
		}
		target.size = math.Max(target.size, s.size)
		target.spans = append(target.spans, s)
	}
	// Attach smaller raised/lowered glyphs to the nearby baseline. Coordinates
	// remain intact so visual math can retain both scripts at the same x position.
	for i, l := range lines {
		kept := l.spans[:0]
		for _, s := range l.spans {
			var host *line
			best := math.Inf(1)
			accent := s.script == "" && strings.TrimFunc(s.text, func(r rune) bool { return unicode.IsMark(r) || unicode.IsSpace(r) }) == ""
			for j := max(0, i-4); j < min(len(lines), i+5); j++ {
				h := lines[j]
				dy := spanBaseline(s) - h.baseline
				if i == j || (!accent && h.size < s.size*1.18) || math.Abs(dy) > h.size*.72 || math.Abs(dy) < h.size*.12 {
					continue
				}
				dx := math.Max(h.box.X-s.box.X-s.box.W, s.box.X-h.box.X-h.box.W)
				if dx > h.size*.6 {
					continue
				}
				score := math.Abs(dy) + math.Max(0, dx)
				if score < best {
					host = h
					best = score
				}
			}
			if host != nil {
				s.script = "sup"
				if spanBaseline(s) > host.baseline {
					s.script = "sub"
				}
				host.spans = append(host.spans, s)
				host.box = union(host.box, s.box)
			} else {
				kept = append(kept, s)
			}
		}
		l.spans = kept
	}
	out := make([]*line, 0, len(lines))
	for _, l := range lines {
		if len(l.spans) > 0 {
			finishLine(l)
			out = append(out, l)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if math.Abs(out[i].baseline-out[j].baseline) > .5 {
			return out[i].baseline < out[j].baseline
		}
		return out[i].box.X < out[j].box.X
	})
	return out
}
func finishLine(l *line) {
	sort.SliceStable(l.spans, func(i, j int) bool { return l.spans[i].box.X < l.spans[j].box.X })
	var text, cell strings.Builder
	l.cells = nil
	l.starts = nil
	l.runs = nil
	l.text = ""
	weights := map[float64]int{}
	l.mono = true
	l.math = false
	l.bold = true
	for j, s := range l.spans {
		t := deLigature.Replace(s.text)
		gap := 0.0
		if j > 0 {
			prev := l.spans[j-1]
			gap = s.box.X - prev.box.X - prev.box.W
		}
		newCell := j == 0 || gap > math.Max(8, s.size*1.5)
		if newCell {
			if j > 0 {
				l.cells = append(l.cells, strings.TrimSpace(cell.String()))
				cell.Reset()
			}
			l.starts = append(l.starts, s.box.X)
		}
		space := ""
		if j > 0 && gap > math.Max(1, s.size*.15) && !strings.HasSuffix(text.String(), " ") && !strings.HasPrefix(t, " ") {
			space = " "
		}
		text.WriteString(space + t)
		cell.WriteString(space + t)
		if n := len(l.runs); n > 0 && l.runs[n-1].Bold == s.bold && l.runs[n-1].Italic == s.italic && l.runs[n-1].Link == s.link && l.runs[n-1].Script == s.script {
			l.runs[n-1].Text += space + t
		} else {
			l.runs = append(l.runs, Run{Text: space + t, Bold: s.bold, Italic: s.italic, Link: s.link, Script: s.script})
		}
		if s.script == "" {
			weights[math.Round(s.size*10)/10] += utf8.RuneCountInString(t)
		}
		l.math = l.math || (s.font != nil && s.font.math)
		l.bold = l.bold && s.bold
		l.mono = l.mono && s.mono
		if s.role != "" && s.role != "Span" {
			l.role = s.role
		}
	}
	if len(weights) == 0 {
		for _, s := range l.spans {
			l.size = math.Max(l.size, s.size)
		}
	}
	best := 0
	for size, weight := range weights {
		if weight > best || weight == best && size > l.size {
			l.size = size
			best = weight
		}
	}
	l.cells = append(l.cells, strings.TrimSpace(cell.String()))
	l.text = strings.TrimSpace(text.String())
	if l.mono {
		l.text = strings.TrimRight(text.String(), " \t\r\n")
	}
}

func (p *pdf) layout(pc *pageContent, bodySize float64) []Block {
	lines := makeLines(pc.spans)
	mathBlocks := p.mathBlocks(pc, lines)
	p.vectorAsset(pc, mathBlocks, lines)
	tables := detectTables(lines, pc.rules, bodySize)
	// Rulings used by tables are represented by semantic rows; decorative paths
	// and chart geometry on other pages remain SVG assets.

	remaining := []*line{}
	for _, l := range lines {
		if !l.used {

			remaining = append(remaining, l)
		}
	}
	ordered := columnOrder(remaining, pc.page.Width)
	for _, l := range ordered {
		if l.math {
			p.inlineMath(pc, l)
		}
	}
	blocks := []Block{}
	var current *Block
	var previous *line
	flush := func() {
		if current != nil {
			if current.Kind == "code" {
				current.Text = strings.TrimRight(current.Text, " \t\r\n")
			} else {
				current.Text = strings.TrimSpace(current.Text)
			}
			if current.Kind == "code" {
				current.Language = codeLanguage(current.Text)
			}
			blocks = append(blocks, *current)
			current = nil
		}
	}
	for _, l := range ordered {
		if l.text == "" {
			continue
		}
		kind, level, role := classifyLine(l, bodySize)
		gap := 0.0
		if previous != nil {
			gap = l.box.Y - previous.box.Y - previous.box.H
		}
		join := current != nil && current.Kind == kind && kind != "heading" && kind != "list" && current.Role == role && previous != nil && gap >= -2 && gap < math.Max(l.size*.8, 4) && math.Abs(l.box.X-previous.box.X) < math.Max(l.size*2, 24)
		if kind == "heading" && current != nil && previous != nil {
			join = current.Kind == "heading" && current.Level == level && gap >= -2 && gap < l.size*.8 && (math.Abs(l.box.X-previous.box.X) < l.size || math.Abs((l.box.X+l.box.W/2)-(previous.box.X+previous.box.W/2)) < l.size*2)
		}
		if kind == "code" {
			join = current != nil && current.Kind == "code" && gap >= -2 && gap < l.size*3
		}
		if join {
			separator := " "
			if kind == "code" {
				separator = "\n"
				if gap > l.size*.9 {
					separator = "\n\n"
				}
				indent := int(math.Round(math.Max(0, l.box.X-current.Box.X) / math.Max(1, l.size*.6)))
				separator += strings.Repeat(" ", min(indent, 80))
			} else if canDehyphenate(current.Text, l.text) || endsSoftHyphen(previous) {
				// A soft hyphen explicitly marks a discretionary break and was
				// removed during normalization. A visible hyphen could belong to
				// a compound word: keep it instead of guessing the author's word.
				separator = ""
			}
			current.Text += separator + l.text
			if len(l.runs) > 0 {
				runs := append([]Run(nil), l.runs...)
				runs[0].Text = separator + strings.TrimLeft(runs[0].Text, " ")
				current.Runs = append(current.Runs, runs...)
			}
			current.Box = union(current.Box, l.box)
		} else {
			flush()
			current = &Block{Kind: kind, Text: l.text, Runs: l.runs, Level: level, Role: role, Box: l.box}
		}
		previous = l
	}
	flush()
	// Tables and images are inserted near their original vertical position. Text
	// blocks keep column order; sorting the entire page by Y would interleave them.
	for _, b := range append(append(mathBlocks, tables...), pc.images...) {
		at := len(blocks)
		for j, t := range blocks {
			if t.Box.Y > b.Box.Y+b.Box.H*.25 {
				at = j
				break
			}
		}
		blocks = append(blocks, Block{})
		copy(blocks[at+1:], blocks[at:])
		blocks[at] = b
	}
	return blocks
}

func classifyLine(l *line, body float64) (string, int, string) {
	role := ""
	switch l.role {
	case "Formula":
		return "math", 0, "formula"
	case "Code":
		return "code", 0, ""
	case "H", "H1":
		return "heading", 1, ""
	case "H2", "H3", "H4", "H5", "H6":
		return "heading", int(l.role[1] - '0'), ""
	case "LI", "LBody":
		return "list", 0, ""
	case "Caption":
		role = "caption"
	case "Note":
		role = "footnote"
	case "Reference", "BibEntry":
		role = "reference"
	case "Index":
		role = "index"
	}
	if l.mono && utf8.RuneCountInString(l.text) > 0 {
		return "code", 0, role
	}
	if l.bold && l.size >= body*.8 && len(l.text) < 150 && sectionNumber.MatchString(l.text) {
		return "heading", 3, role
	}
	if len(l.text) < 200 && ((l.size >= body*1.18 && l.size-body >= 1) || (l.bold && len(l.text) < 80 && len(strings.Fields(l.text)) <= 10 && l.size >= body*.98 && !strings.HasSuffix(l.text, ".") && !strings.HasSuffix(l.text, ","))) {
		level := 2
		if l.size >= body*1.65 {
			level = 1
		} else if l.size < body*1.25 {
			level = 3
		}
		return "heading", level, role
	}
	if bulletLine.MatchString(l.text) {
		return "list", 0, role
	}
	if strings.HasPrefix(strings.ToLower(l.text), "figure ") || strings.HasPrefix(strings.ToLower(l.text), "table ") {
		if l.size < body*1.05 {
			role = "caption"
		}
	}
	if l.size < body*.82 && role == "" {
		role = "footnote"
	}
	return "paragraph", 0, role
}
func canDehyphenate(a, b string) bool {
	if !strings.HasSuffix(a, "-") || strings.HasSuffix(a, "--") || b == "" {
		return false
	}
	r, _ := utf8.DecodeRuneInString(b)
	before, _ := utf8.DecodeLastRuneInString(strings.TrimSuffix(a, "-"))
	return unicode.IsLower(r) && unicode.IsLetter(before)
}
func endsSoftHyphen(l *line) bool {
	return l != nil && len(l.spans) > 0 && strings.HasSuffix(strings.TrimSpace(l.spans[len(l.spans)-1].text), "\u00ad")
}

func detectTables(lines []*line, rules []ruling, body float64) []Block {
	out := ruledTables(lines, rules, body)
	for i := 0; i < len(lines); {
		l := lines[i]
		columns := len(l.cells)
		if l.used || columns < 2 || columns > 20 || l.mono || l.math {
			i++
			continue
		}
		end := i + 1
		for end < len(lines) {
			next := lines[end]
			prev := lines[end-1]
			if next.used || next.math || len(next.cells) != columns || next.box.Y-prev.box.Y > body*3 || next.box.Y-prev.box.Y < 0 {
				break
			}
			aligned := true
			for c := 0; c < columns; c++ {
				if math.Abs(next.starts[c]-l.starts[c]) > body*2 {
					aligned = false
				}
			}
			if !aligned {
				break
			}
			end++
		}
		box := l.box
		rows := [][]string{}
		long := false
		for j := i; j < end; j++ {
			box = union(box, lines[j].box)
			rows = append(rows, lines[j].cells)
			for _, c := range lines[j].cells {
				if len(c) > 100 {
					long = true
				}
			}
		}
		ruled := false
		for _, r := range rules {
			if math.Abs(r.y1-r.y2) < 1 && r.y1 >= box.Y-body*2 && r.y1 <= box.Y+box.H+body && math.Abs(r.x2-r.x1) >= box.W*.65 {
				ruled = true
				break
			}
		}
		tagged := l.role == "TH" || l.role == "TD"
		if end-i >= 2 && !long && (ruled || tagged || (end-i >= 3 && (columns >= 3 || l.bold))) {
			for j := i; j < end; j++ {
				lines[j].used = true
			}
			out = append(out, Block{Kind: "table", Rows: rows, Box: box})
			i = end
		} else {
			i++
		}
	}
	return out
}

func columnOrder(lines []*line, width float64) []*line {
	// A repeated wide gap inside many baselines is evidence of a column gutter.
	// Full-width titles split the page into bands before left-to-right ordering.
	var candidates []float64
	for _, l := range lines {
		for j := 1; j < len(l.spans); j++ {
			a, b := l.spans[j-1], l.spans[j]
			gap := b.box.X - a.box.X - a.box.W
			mid := (b.box.X + a.box.X + a.box.W) / 2
			if gap > width*.035 && mid > width*.3 && mid < width*.7 {
				candidates = append(candidates, mid)
			}
		}
	}
	// Sidebars can have a slightly offset baseline and occupy only a short
	// band on the page. They still need column order within that band.
	for i, l := range lines {
		if l.mono || l.box.W < width*.15 {
			continue
		}
		for j := i + 1; j < len(lines) && lines[j].baseline-l.baseline < l.size*.9; j++ {
			r := lines[j]
			if r.mono || r.box.W < width*.15 {
				continue
			}
			a, b := l, r
			if a.box.X > b.box.X {
				a, b = b, a
			}
			gap := b.box.X - a.box.X - a.box.W
			mid := (b.box.X + a.box.X + a.box.W) / 2
			if gap > width*.015 && mid > width*.3 && mid < width*.7 {
				candidates = append(candidates, mid)
			}
		}
	}
	if len(candidates) < 3 {
		return lines
	}
	sort.Float64s(candidates)
	cut := candidates[len(candidates)/2]
	var out, left, right []*line
	flush := func() { out = append(out, left...); out = append(out, right...); left = nil; right = nil }
	for _, l := range lines {
		ls, rs := []span{}, []span{}
		cross := false
		for _, s := range l.spans {
			if s.box.X < cut && s.box.X+s.box.W > cut {
				cross = true
			}
			if s.box.X < cut {
				ls = append(ls, s)
			} else {
				rs = append(rs, s)
			}
		}
		if cross {
			flush()
			out = append(out, l)
			continue
		}
		part := func(spans []span) *line {
			n := &line{spans: spans, box: spans[0].box, baseline: spanBaseline(spans[0])}
			for _, s := range spans[1:] {
				n.box = union(n.box, s.box)
			}
			finishLine(n)
			return n
		}
		if len(ls) > 0 {
			left = append(left, part(ls))
		}
		if len(rs) > 0 {
			right = append(right, part(rs))
		}
	}
	flush()
	return out
}

func codeLanguage(text string) string {
	t := strings.TrimSpace(text)
	switch {
	case strings.Contains(t, "package ") && (strings.Contains(t, "func ") || strings.Contains(t, "import ")):
		return "go"
	case strings.Contains(t, "def ") && strings.Contains(t, ":"):
		return "python"
	case strings.Contains(t, "#include") || strings.Contains(t, "std::"):
		return "cpp"
	case strings.Contains(t, "fn ") && (strings.Contains(t, "let ") || strings.Contains(t, "->")):
		return "rust"
	case strings.Contains(t, "interface ") || strings.Contains(t, ": string") || strings.Contains(t, ": number"):
		return "typescript"
	case strings.Contains(t, "const ") || strings.Contains(t, "function ") || strings.Contains(t, "console.log("):
		return "javascript"
	case strings.Contains(strings.ToUpper(t), "SELECT ") && strings.Contains(strings.ToUpper(t), " FROM "):
		return "sql"
	case strings.HasPrefix(t, "#!/bin/") || strings.HasPrefix(t, "$ "):
		return "bash"
	case strings.HasPrefix(t, "{\n") && strings.Contains(t, `":`):
		return "json"
	case strings.Contains(t, "<html") || strings.Contains(t, "<!DOCTYPE"):
		return "html"
	}
	return ""
}
