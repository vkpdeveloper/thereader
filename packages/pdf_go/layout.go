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
var bulletLine = regexp.MustCompile(`^(?:[•●▪◦‣]|[-*]\s|\d+[.)]\s)`)
var deLigature = strings.NewReplacer("ﬁ", "fi", "ﬂ", "fl", "ﬀ", "ff", "ﬃ", "ffi", "ﬄ", "ffl", "\u00ad", "", "\u00a0", " ")

func cleanMargins(pages []*pageContent) {
	if len(pages) < 2 {
		return
	}
	counts := map[string]int{}
	bodySize := bodyFontSize(pages)
	key := func(pc *pageContent, s span) string {
		// A chapter title can occupy the top margin and differ only by a number.
		// Font prominence takes precedence over repetition; never discard it.
		if s.size > bodySize*1.1 {
			return ""
		}
		if s.box.Y > pc.page.Height*.08 && s.box.Y+s.box.H < pc.page.Height*.92 {
			return ""
		}
		t := strings.ToLower(strings.TrimSpace(s.text))
		if len(t) > 140 || len(t) == 0 {
			return ""
		}
		side := "top:"
		if s.box.Y > pc.page.Height/2 {
			side = "bottom:"
		}
		return side + marginDigits.ReplaceAllString(t, "#")
	}
	for _, pc := range pages {
		seen := map[string]bool{}
		for _, s := range pc.spans {
			k := key(pc, s)
			if k != "" && !seen[k] {
				counts[k]++
				seen[k] = true
			}
		}
	}
	threshold := max(2, (len(pages)+1)/2)
	for _, pc := range pages {
		out := pc.spans[:0]
		for _, s := range pc.spans {
			k := key(pc, s)
			if k != "" && (counts[k] >= threshold || pageNumber.MatchString(strings.TrimSpace(s.text))) {
				continue
			}
			out = append(out, s)
		}
		pc.spans = out
	}
}

func makeLines(spans []span) []*line {
	lines := []*line{}
	for _, s := range spans {
		if strings.TrimSpace(s.text) == "" {
			continue
		}
		var target *line
		for j := len(lines) - 1; j >= 0 && j >= len(lines)-6; j-- {
			l := lines[j]
			baseline := s.box.Y + s.box.H*.78
			other := l.box.Y + l.box.H*.78
			if math.Abs(baseline-other) < math.Max(2, math.Min(s.box.H, l.box.H)*.28) {
				target = l
				break
			}
		}
		if target == nil {
			target = &line{box: s.box}
			lines = append(lines, target)
		} else {
			target.box = union(target.box, s.box)
		}
		target.spans = append(target.spans, s)
	}
	for _, l := range lines {
		finishLine(l)
	}
	sort.SliceStable(lines, func(i, j int) bool {
		if math.Abs(lines[i].box.Y-lines[j].box.Y) > 2 {
			return lines[i].box.Y < lines[j].box.Y
		}
		return lines[i].box.X < lines[j].box.X
	})
	return lines
}
func finishLine(l *line) {
	sort.SliceStable(l.spans, func(i, j int) bool { return l.spans[i].box.X < l.spans[j].box.X })
	var text, cell strings.Builder
	l.mono = true
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
		if n := len(l.runs); n > 0 && l.runs[n-1].Bold == s.bold && l.runs[n-1].Italic == s.italic && l.runs[n-1].Link == s.link {
			l.runs[n-1].Text += space + t
		} else {
			l.runs = append(l.runs, Run{space + t, s.bold, s.italic, s.link})
		}
		l.size = math.Max(l.size, s.size)
		l.bold = l.bold && s.bold
		l.mono = l.mono && s.mono
		if s.role != "" && s.role != "Span" {
			l.role = s.role
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
	tables := detectTables(lines, pc.rules, bodySize)
	// Rulings used by tables are represented by semantic rows; decorative paths
	// and chart geometry on other pages remain SVG assets.
	p.vectorAsset(pc, tables)
	remaining := []*line{}
	for _, l := range lines {
		if !l.used {
			remaining = append(remaining, l)
		}
	}
	ordered := columnOrder(remaining, pc.page.Width)
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
	for _, b := range append(tables, pc.images...) {
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
	out := []Block{}
	for i := 0; i < len(lines); {
		l := lines[i]
		columns := len(l.cells)
		if columns < 2 || columns > 20 || l.mono {
			i++
			continue
		}
		end := i + 1
		for end < len(lines) {
			next := lines[end]
			prev := lines[end-1]
			if len(next.cells) != columns || next.box.Y-prev.box.Y > body*3 || next.box.Y-prev.box.Y < 0 {
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
	if len(candidates) < 3 || len(candidates)*4 < len(lines) {
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
			n := &line{spans: spans, box: spans[0].box}
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
