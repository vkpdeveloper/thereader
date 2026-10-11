package pdfextractor

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var algorithmTitle = regexp.MustCompile(`(?i)^Algorithm\s+\d+[.:\s]`)
var algorithmStep = regexp.MustCompile(`^(\d{1,4}):\s*`)

// Numbered pseudocode inside a ruled algorithm is a code block, not a table.
// Both the caption and consecutive line numbers are required; ordinary ruled
// prose boxes and tables whose first column is numeric are left alone.
func algorithmBlocks(lines []*line, rules []ruling, body float64) []Block {
	var out []Block
	for start, title := range lines {
		if title.used || !algorithmTitle.MatchString(title.text) {
			continue
		}
		var ends []float64
		for _, r := range rules {
			if math.Abs(r.y1-r.y2) < 1 && r.y1 > title.baseline+body*4 && math.Min(r.x1, r.x2) <= title.box.X+body && math.Abs(r.x2-r.x1) >= title.box.W {
				ends = append(ends, r.y1)
			}
		}
		sort.Float64s(ends)
		for _, bottom := range ends {
			var selected []*line
			last, numbered := 0, 0
			valid := true
			for _, l := range lines[start+1:] {
				if l.baseline > bottom {
					break
				}
				if l.used {
					valid = false
					break
				}
				if m := algorithmStep.FindStringSubmatch(l.text); m != nil {
					n, _ := strconv.Atoi(m[1])
					if n != last+1 {
						valid = false
						break
					}
					last = n
					numbered++
				}
				selected = append(selected, l)
			}
			if !valid || numbered < 3 {
				continue
			}
			code := Block{Kind: "code", Language: "pseudocode", Role: "algorithm"}
			baseX := math.Inf(1)
			// Locate the first non-number glyph; indentation belongs after the
			// line number and remains meaningful for nested control flow.
			contentX := func(l *line) float64 {
				m := algorithmStep.FindString(l.text)
				if m == "" {
					return l.box.X
				}
				n := 0
				for _, s := range l.spans {
					n += len(s.text)
					if n >= len(strings.TrimSpace(m)) {
						if n == len(strings.TrimSpace(m)) {
							continue
						}
						return s.box.X
					}
				}
				return l.box.X
			}
			for _, l := range selected {
				if algorithmStep.MatchString(l.text) {
					baseX = math.Min(baseX, contentX(l))
				}
			}
			for j, l := range selected {
				text := l.text
				if m := algorithmStep.FindString(text); m != "" {
					indent := min(40, int(math.Round(math.Max(0, contentX(l)-baseX)/math.Max(1, l.size*.75))))
					text = strings.TrimSpace(m) + " " + strings.Repeat(" ", indent) + strings.TrimPrefix(text, m)
				}
				if j > 0 {
					code.Text += "\n"
					code.Box = union(code.Box, l.box)
				} else {
					code.Box = l.box
				}
				code.Text += text
				l.used = true
			}
			title.used = true
			out = append(out, Block{Kind: "paragraph", Text: title.text, Runs: title.runs, Role: "caption", Box: title.box}, code)
			break
		}
	}
	return out
}
