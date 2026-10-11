package pdfextractor

import (
	"math"
	"sort"
	"strings"
)

type tableLine struct {
	line  *line
	parts []*line
}

// Long rules delimit tables, not necessarily every row. Captions and prose
// bands separate tables; a large gap alone is not evidence of a new table.
func ruledTables(lines []*line, rules []ruling, body float64) []Block {
	type group struct {
		x1, x2 float64
		ys     []float64
	}
	var groups []group
	for _, r := range rules {
		x1, x2 := math.Min(r.x1, r.x2), math.Max(r.x1, r.x2)
		if math.Abs(r.y1-r.y2) > 1 || x2-x1 < body*10 {
			continue
		}
		at := -1
		for j, g := range groups {
			if math.Abs(g.x1-x1) < 2 && math.Abs(g.x2-x2) < 2 {
				at = j
				break
			}
		}
		if at < 0 {
			groups = append(groups, group{x1: x1, x2: x2})
			at = len(groups) - 1
		}
		groups[at].ys = append(groups[at].ys, r.y1)
	}
	var regions []Rect
	for _, g := range groups {
		sort.Float64s(g.ys)
		start := 0
		for end := 1; end <= len(g.ys); end++ {
			separate := end == len(g.ys)
			if !separate {
				prose := 0
				for _, l := range lines {
					if l.used || l.baseline <= g.ys[end-1] || l.baseline >= g.ys[end] {
						continue
					}
					text := strings.ToLower(l.text)
					if strings.HasPrefix(text, "table ") || strings.HasPrefix(text, "figure ") {
						separate = true
						break
					}
					if len(l.text) > 100 && len(l.cells) == 1 && l.box.W > (g.x2-g.x1)*.8 {
						prose++
					}
				}
				separate = separate || prose >= 2
			}
			if separate {
				if end-start >= 2 && g.ys[end-1]-g.ys[start] > body*1.8 {
					regions = append(regions, Rect{g.x1, g.ys[start], g.x2 - g.x1, g.ys[end-1] - g.ys[start]})
				}
				start = end
			}
		}
	}
	// An outer border wins over the shorter rules inside grouped rows.
	sort.SliceStable(regions, func(i, j int) bool { return regions[i].W*regions[i].H > regions[j].W*regions[j].H })
	var out []Block
	for _, region := range regions {
		if b, ok := buildRuledTable(lines, rules, region, body); ok {
			out = append(out, b)
		}
	}
	out = append(out, legacyRuledTables(lines, rules, body)...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Box.Y < out[j].Box.Y })
	return out
}

// Keep words and kerning spans together; split only actual gutters or rules.
func tableParts(l *line, region Rect, rules []ruling) []*line {
	var out []*line
	var part *line
	for _, s := range l.spans {
		if s.box.X < region.X-2 || s.box.X+s.box.W > region.X+region.W+2 {
			continue
		}
		split := part == nil
		if part != nil {
			prev := part.spans[len(part.spans)-1]
			split = s.box.X-prev.box.X-prev.box.W > math.Max(4, s.size*.75)
			for _, r := range rules {
				if math.Abs(r.x1-r.x2) < 1 && r.x1 > prev.box.X+prev.box.W && r.x1 < s.box.X && l.baseline >= math.Min(r.y1, r.y2) && l.baseline <= math.Max(r.y1, r.y2) {
					split = true
					break
				}
			}
		}
		if split {
			part = &line{box: s.box, baseline: l.baseline}
			out = append(out, part)
		} else {
			part.box = union(part.box, s.box)
		}
		part.spans = append(part.spans, s)
	}
	for _, p := range out {
		finishLine(p)
	}
	return out
}

func median(v []float64) float64 { sort.Float64s(v); return v[len(v)/2] }

func buildRuledTable(lines []*line, rules []ruling, region Rect, body float64) (Block, bool) {
	var rows []tableLine
	headerEnd := region.Y
	for _, r := range rules {
		if math.Abs(r.y1-r.y2) < 1 && r.y1 > region.Y+body*.7 && r.y1 < region.Y+region.H-1 && math.Min(r.x1, r.x2) <= region.X+2 && math.Max(r.x1, r.x2) >= region.X+region.W-2 {
			if headerEnd == region.Y || r.y1 < headerEnd {
				headerEnd = r.y1
			}
		}
	}
	freq := map[int]int{}
	for _, l := range lines {
		if l.used || l.baseline < region.Y || l.baseline > region.Y+region.H+1 {
			continue
		}
		parts := tableParts(l, region, rules)
		if len(parts) == 0 {
			continue
		}
		rows = append(rows, tableLine{l, parts})
		if l.baseline > headerEnd && len(parts) >= 2 && len(parts) <= 64 {
			freq[len(parts)]++
		}
	}
	columns, count := 0, 0
	for n, f := range freq {
		if f > count || f == count && n > columns {
			columns, count = n, f
		}
	}
	if columns < 2 || count < 2 || len(rows) < 3 {
		return Block{}, false
	}
	// Page header/footer rules can enclose an entire two-column article.
	// Continuous prose in most columns is not tabular evidence. Require a
	// real internal row grid before consuming such a region as a table.
	if columns <= 3 && len(rows) >= 8 {
		prose, total := 0, 0
		for _, r := range rows {
			for _, part := range r.parts {
				total++
				if len(strings.Fields(part.text)) >= 6 && len(part.text) > 35 {
					prose++
				}
			}
		}
		rowRules := 0
		for _, rule := range rules {
			if math.Abs(rule.y1-rule.y2) < 1 && rule.y1 > region.Y+body && rule.y1 < region.Y+region.H-body && math.Min(rule.x1, rule.x2) <= region.X+2 && math.Max(rule.x1, rule.x2) >= region.X+region.W-2 {
				rowRules++
			}
		}
		if prose*2 > total && rowRules < 3 {
			return Block{}, false
		}
	}
	left, right := make([]float64, columns), make([]float64, columns)
	for c := 0; c < columns; c++ {
		var a, b []float64
		for _, r := range rows {
			if r.line.baseline > headerEnd && len(r.parts) == columns {
				a = append(a, r.parts[c].box.X)
				b = append(b, r.parts[c].box.X+r.parts[c].box.W)
			}
		}
		left[c], right[c] = median(a), median(b)
	}
	// Sparse outer columns contain vertically centered row-group labels.
	type extra struct {
		left, right float64
		n           int
	}
	var extras []extra
	for _, r := range rows {
		if r.line.baseline <= headerEnd {
			continue
		}
		for _, part := range r.parts {
			a, b := part.box.X, part.box.X+part.box.W
			if b >= left[0]-body*.4 && a <= right[len(right)-1]+body*.4 {
				continue
			}
			at := -1
			for j, e := range extras {
				if math.Abs(a-e.left) < body*.5 || math.Abs((a+b-e.left-e.right)/2) < body {
					at = j
					break
				}
			}
			if at < 0 {
				extras = append(extras, extra{a, b, 1})
			} else {
				e := &extras[at]
				e.left = (e.left*float64(e.n) + a) / float64(e.n+1)
				e.right = (e.right*float64(e.n) + b) / float64(e.n+1)
				e.n++
			}
		}
	}
	for _, e := range extras {
		if e.n >= 2 {
			left = append(left, e.left)
			right = append(right, e.right)
		}
	}
	type column struct{ left, right float64 }
	cols := make([]column, len(left))
	for c := range cols {
		cols[c] = column{left[c], right[c]}
	}
	sort.Slice(cols, func(i, j int) bool { return cols[i].left < cols[j].left })
	if len(cols) > 64 {
		return Block{}, false
	}
	bound := make([]float64, len(cols)+1)
	bound[0] = region.X
	bound[len(cols)] = region.X + region.W
	for c := 1; c < len(cols); c++ {
		bound[c] = (cols[c-1].right + cols[c].left) / 2
	}
	for c := 1; c < len(bound); c++ {
		if bound[c] <= bound[c-1] {
			return Block{}, false
		}
	}
	columnAt := func(box Rect) int {
		best, overlap := 0, -1.0
		for c := range cols {
			n := math.Max(0, math.Min(box.X+box.W, bound[c+1])-math.Max(box.X, bound[c]))
			if n > overlap {
				best, overlap = c, n
			}
		}
		return best
	}
	// A wrapped heading occupies one ruled band, even when its lines have
	// different baselines from adjacent column labels.
	var headerCuts []float64
	for _, rule := range rules {
		if math.Abs(rule.y1-rule.y2) < 1 && rule.y1 > region.Y+1 && rule.y1 < headerEnd-1 && math.Abs(rule.x2-rule.x1) > body*3 {
			headerCuts = append(headerCuts, rule.y1)
		}
	}
	sort.Float64s(headerCuts)
	cuts := headerCuts[:0]
	for _, y := range headerCuts {
		if len(cuts) == 0 || y-cuts[len(cuts)-1] > 2 {
			cuts = append(cuts, y)
		}
	}
	headerCuts = cuts
	headerBaselines := make([][]float64, len(headerCuts)+1)
	for _, r := range rows {
		if r.line.baseline < headerEnd {
			band := sort.SearchFloat64s(headerCuts, r.line.baseline)
			headerBaselines[band] = append(headerBaselines[band], r.line.baseline)
		}
	}
	var ys []float64
	for _, band := range headerBaselines {
		if len(band) > 0 {
			ys = append(ys, median(band))
		}
	}
	headerRows := len(ys)
	for _, r := range rows {
		if r.line.baseline < headerEnd {
			continue
		}
		if len(r.parts) >= max(2, columns-2) {
			ys = append(ys, r.line.baseline)
		}
	}
	if len(ys)-headerRows < 2 {
		return Block{}, false
	}
	for _, r := range rows {
		if len(r.parts) != 1 || r.line.baseline < headerEnd || len(r.parts[0].text) > 100 {
			continue
		}
		part := r.parts[0]
		if part.box.X+part.box.W/2 < region.X+region.W*.3 {
			continue
		}
		top, bottom := tableBand(rules, region, r.line.baseline, region.X+region.W/2)
		present := false
		for _, y := range ys {
			present = present || y > top && y < bottom
		}
		if !present && bottom-top < body*3 {
			ys = append(ys, r.line.baseline)
		}
	}
	sort.Float64s(ys)
	if len(ys)*len(cols) > 100000 {
		return Block{}, false
	}
	t := &Table{Rows: len(ys), Columns: len(cols), HeaderRows: headerRows}
	partsByCell := map[[2]int][]span{}
	cellIndex := map[[2]int]int{}
	for _, r := range rows {
		for _, part := range r.parts {
			row, dy := 0, math.Inf(1)
			for j, y := range ys {
				if d := math.Abs(y - r.line.baseline); d < dy {
					row, dy = j, d
				}
			}
			col := columnAt(part.box)
			cs := 1
			if row < headerRows {
				// A short underline describes a column group even if its heading
				// is narrower than the space occupied by the leaf columns.
				for _, rule := range rules {
					a, b := math.Min(rule.x1, rule.x2), math.Max(rule.x1, rule.x2)
					if math.Abs(rule.y1-rule.y2) > 1 || rule.y1 <= r.line.baseline || rule.y1-r.line.baseline > body || b-a >= region.W*.9 || part.box.X < a-body || part.box.X+part.box.W > b+body {
						continue
					}
					first, last := -1, -1
					for c, v := range cols {
						center := (v.left + v.right) / 2
						if center >= a-1 && center <= b+1 {
							if first < 0 {
								first = c
							}
							last = c
						}
					}
					if first >= 0 {
						col, cs = first, last-first+1
						break
					}
				}
			} else if len(r.parts) == 1 && len(part.text) <= 100 && part.box.X+part.box.W/2 >= region.X+region.W*.3 {
				top, bottom := tableBand(rules, region, r.line.baseline, region.X+region.W/2)
				n := 0
				for _, y := range ys {
					if y > top && y < bottom {
						n++
					}
				}
				if n == 1 && bottom-top < body*3 {
					col, cs = 0, len(cols)
				}
			}
			key := [2]int{row, col}
			for _, s := range part.spans {
				// Scripts were already attached to this baseline by makeLines.
				// Regrouping a cell must not detach a raised marker and prepend it.
				s.baseline = r.line.baseline
				partsByCell[key] = append(partsByCell[key], s)
			}
			if at, found := cellIndex[key]; found {
				c := &t.Cells[at]
				c.ColSpan = max(c.ColSpan, cs)
				c.Box = union(c.Box, part.box)
			} else {
				cellIndex[key] = len(t.Cells)
				t.Cells = append(t.Cells, TableCell{Row: row, Column: col, RowSpan: 1, ColSpan: cs, Box: part.box})
			}
		}
	}
	// A leaf label centered above two leading stub columns describes both.
	// Do not stretch labels over empty metric columns elsewhere in the table.
	if headerRows > 0 && len(cols) > columns {
		for j := range t.Cells {
			c := &t.Cells[j]
			if c.Row != headerRows-1 || c.Column != 1 || c.ColSpan != 1 {
				continue
			}
			empty := true
			for _, other := range t.Cells {
				if other.Row == c.Row && other.Column == 0 {
					empty = false
					break
				}
			}
			if empty && c.Box.X < bound[1] && c.Box.X+c.Box.W > bound[1] {
				c.Column = 0
				c.ColSpan = 2
				partsByCell[[2]int{c.Row, 0}] = partsByCell[[2]int{c.Row, 1}]
			}
		}
	}
	byColumn := make([][]int, len(cols))
	for j, c := range t.Cells {
		if c.Row >= headerRows {
			for col := c.Column; col < min(len(cols), c.Column+c.ColSpan); col++ {
				byColumn[col] = append(byColumn[col], j)
			}
		}
	}
	for j := range t.Cells {
		c := &t.Cells[j]
		spans := partsByCell[[2]int{c.Row, c.Column}]
		for _, l := range makeLines(spans) {
			if c.Text != "" {
				c.Text += " "
				c.Runs = append(c.Runs, Run{Text: " "})
			}
			c.Text += l.text
			c.Runs = append(c.Runs, l.runs...)
		}
		if c.Row < headerRows {
			c.Header = true
			c.Scope = "col"
			if c.ColSpan > 1 {
				c.Scope = "colgroup"
			}
			continue
		}
		if len(byColumn[c.Column])*2 > len(ys)-headerRows {
			continue
		}
		// Merge only through otherwise empty rows, supported by a centered
		// label and separators. Ordinary absent cells must remain empty.
		baseline := spanBaseline(spans[0])
		top, bottom := tableBand(rules, region, baseline, (cols[c.Column].left+cols[c.Column].right)/2)
		first, last := -1, -1
		for r, y := range ys {
			if r >= headerRows && y > top && y < bottom {
				if first < 0 {
					first = r
				}
				last = r
			}
		}
		if first < 0 || last-first < 1 || math.Abs(baseline-(ys[first]+ys[last])/2) > math.Max(body, (bottom-top)*.12) {
			continue
		}
		occupied := false
		for _, k := range byColumn[c.Column] {
			other := t.Cells[k]
			if k != j && other.Row <= last && other.Row+other.RowSpan > first && other.Column <= c.Column && other.Column+other.ColSpan > c.Column {
				occupied = true
				break
			}
		}
		if !occupied {
			c.Row = first
			c.RowSpan = last - first + 1
			if c.Column == 0 {
				c.Header = true
				c.Scope = "rowgroup"
			}
		}
	}
	// Conflicting geometric guesses must not produce malformed HTML.
	used := make([]bool, t.Rows*t.Columns)
	for _, c := range t.Cells {
		for r := c.Row; r < c.Row+c.RowSpan; r++ {
			for col := c.Column; col < c.Column+c.ColSpan; col++ {
				at := r*t.Columns + col
				if at < 0 || at >= len(used) || col >= t.Columns || used[at] {
					return Block{}, false
				}
				used[at] = true
			}
		}
	}
	textRows := make([][]string, t.Rows)
	for r := range textRows {
		textRows[r] = make([]string, t.Columns)
		for c := range textRows[r] {
			if !used[r*t.Columns+c] {
				t.Cells = append(t.Cells, TableCell{Row: r, Column: c, RowSpan: 1, ColSpan: 1, Header: r < headerRows})
			}
		}
	}
	for _, c := range t.Cells {
		textRows[c.Row][c.Column] = c.Text
	}
	sort.SliceStable(t.Cells, func(i, j int) bool {
		a, b := t.Cells[i], t.Cells[j]
		if a.Row != b.Row {
			return a.Row < b.Row
		}
		return a.Column < b.Column
	})
	for _, r := range rows {
		l := r.line
		kept := l.spans[:0]
		for _, s := range l.spans {
			if s.box.X < region.X-2 || s.box.X+s.box.W > region.X+region.W+2 {
				kept = append(kept, s)
			}
		}
		l.spans = kept
		if len(kept) == 0 {
			l.used = true
		} else {
			l.box = kept[0].box
			for _, s := range kept[1:] {
				l.box = union(l.box, s.box)
			}
			finishLine(l)
		}
	}
	return Block{Kind: "table", Rows: textRows, Table: t, Box: region}, true
}

func tableBand(rules []ruling, region Rect, y, x float64) (float64, float64) {
	top, bottom := region.Y, region.Y+region.H
	for _, r := range rules {
		if math.Abs(r.y1-r.y2) > 1 || x < math.Min(r.x1, r.x2)-1 || x > math.Max(r.x1, r.x2)+1 {
			continue
		}
		if r.y1 < y && r.y1 > top {
			top = r.y1
		}
		if r.y1 > y && r.y1 < bottom {
			bottom = r.y1
		}
	}
	return top, bottom
}
