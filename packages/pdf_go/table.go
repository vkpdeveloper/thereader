package pdfextractor

import (
	"math"
	"sort"
	"strings"
)

// Repeated long rules define the whole table, including group labels and
// headers. Column boundaries come from the consensus of its populated rows.
// This avoids splitting one table every time a cell is blank or spans columns.
func legacyRuledTables(lines []*line, rules []ruling, body float64) []Block {
	type ruleGroup struct {
		x1, x2 float64
		ys     []float64
	}
	groups := []ruleGroup{}
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
			groups = append(groups, ruleGroup{x1, x2, nil})
			at = len(groups) - 1
		}
		groups[at].ys = append(groups[at].ys, r.y1)
	}
	out := []Block{}
	for _, g := range groups {
		sort.Float64s(g.ys)
		for first := 0; first < len(g.ys); {
			end := first + 1
			for end < len(g.ys) && g.ys[end]-g.ys[end-1] < body*14 {
				end++
			}
			top, bottom := g.ys[first], g.ys[end-1]
			first = end
			if bottom-top < body*1.8 {
				continue
			}
			region := Rect{g.x1, top, g.x2 - g.x1, bottom - top}
			rows := []*line{}
			sources := []*line{}
			freq := map[int]int{}
			for _, l := range lines {
				if l.used || l.mono || l.baseline < top || l.baseline > bottom+1 {
					continue
				}
				part := []span{}
				for _, s := range l.spans {
					if s.box.X >= region.X-2 && s.box.X+s.box.W <= region.X+region.W+2 {
						part = append(part, s)
					}
				}
				if len(part) == 0 {
					continue
				}
				row := &line{spans: part, box: part[0].box, baseline: l.baseline}
				for _, s := range part[1:] {
					row.box = union(row.box, s.box)
				}
				finishLine(row)
				rows = append(rows, row)
				sources = append(sources, l)
				if len(row.cells) >= 2 && len(row.cells) <= 20 {
					freq[len(row.cells)]++
				}
			}
			columns, count := 0, 0
			for n, f := range freq {
				if f > count || f == count && n > columns {
					columns, count = n, f
				}
			}
			if columns < 2 || count < 2 || len(rows) < 2 || count*3 < len(rows) {
				continue
			}
			starts := make([]float64, columns)
			for c := 0; c < columns; c++ {
				samples := []float64{}
				for _, l := range rows {
					if len(l.cells) == columns {
						samples = append(samples, l.starts[c])
					}
				}
				sort.Float64s(samples)
				starts[c] = samples[len(samples)/2]
			}
			// Choose gaps using the right edge of the preceding column, not just
			// start midpoints (a long row label must stay in the first column).
			boundaries := make([]float64, columns-1)
			for c := range boundaries {
				right := starts[c]
				for _, l := range rows {
					if len(l.cells) != columns {
						continue
					}
					for _, s := range l.spans {
						if s.box.X >= l.starts[c]-1 && s.box.X < l.starts[c+1]-1 {
							right = math.Max(right, math.Min(s.box.X+s.box.W, starts[c+1]-1))
						}
					}
				}
				boundaries[c] = right + (starts[c+1]-right)*.25
			}
			cells := [][]string{}
			for j, l := range rows {
				if len(l.cells) == 1 && len(l.text) > 100 {
					continue
				}
				row := make([]string, columns)
				last := make([]*span, columns)
				for _, s := range l.spans {
					c := sort.SearchFloat64s(boundaries, s.box.X+math.Min(s.box.W*.3, 2))
					t := deLigature.Replace(s.text)
					if last[c] != nil && s.box.X-last[c].box.X-last[c].box.W > math.Max(1, s.size*.15) && !strings.HasSuffix(row[c], " ") && !strings.HasPrefix(t, " ") {
						row[c] += " "
					}
					row[c] += t
					copySpan := s
					last[c] = &copySpan
				}
				for c := range row {
					row[c] = strings.TrimSpace(row[c])
				}
				cells = append(cells, row)
				src := sources[j]
				kept := src.spans[:0]
				for _, s := range src.spans {
					if s.box.X < region.X-2 || s.box.X+s.box.W > region.X+region.W+2 {
						kept = append(kept, s)
					}
				}
				src.spans = kept
				if len(kept) == 0 {
					src.used = true
				} else {
					src.box = kept[0].box
					for _, s := range kept[1:] {
						src.box = union(src.box, s.box)
					}
					finishLine(src)
				}
			}
			out = append(out, Block{Kind: "table", Rows: cells, Box: region})
		}
	}
	return out
}
