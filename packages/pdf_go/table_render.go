package pdfextractor

import (
	"fmt"
	"sort"
	"strings"
)

func complexTable(t *Table) bool {
	if t == nil {
		return false
	}
	if t.HeaderRows > 1 {
		return true
	}
	for _, c := range t.Cells {
		if c.RowSpan > 1 || c.ColSpan > 1 {
			return true
		}
	}
	return false
}

// HTML is the portable Markdown representation for spanning cells. Pipe tables
// cannot encode these relationships. EPUB uses the identical semantic markup.
func tableHTML(b Block, prefix string) string {
	t := b.Table
	if t == nil {
		t = &Table{Rows: len(b.Rows), HeaderRows: min(1, len(b.Rows))}
		for r, row := range b.Rows {
			t.Columns = max(t.Columns, len(row))
			for col, text := range row {
				t.Cells = append(t.Cells, TableCell{Row: r, Column: col, RowSpan: 1, ColSpan: 1, Text: text, Header: r == 0})
			}
		}
	}
	byRow := make(map[int][]TableCell)
	columnHeaders := make(map[int][]string)
	rowHeaders := make(map[int][]string)
	for _, c := range t.Cells {
		byRow[c.Row] = append(byRow[c.Row], c)
		if !c.Header || c.Text == "" {
			continue
		}
		id := fmt.Sprintf("%s-r%d-c%d", prefix, c.Row, c.Column)
		if c.Row < t.HeaderRows {
			for col := max(0, c.Column); col < min(t.Columns, c.Column+c.ColSpan); col++ {
				columnHeaders[col] = append(columnHeaders[col], id)
			}
		} else if c.Scope == "row" || c.Scope == "rowgroup" {
			for row := max(0, c.Row); row < min(t.Rows, c.Row+c.RowSpan); row++ {
				rowHeaders[row] = append(rowHeaders[row], id)
			}
		}
	}
	// A row-group header must live in a tbody covering that group, rather
	// than claiming every body row. Never split through another spanning cell.
	proposed := map[int]bool{}
	for _, c := range t.Cells {
		if c.Header && c.Scope == "rowgroup" {
			proposed[c.Row] = true
			proposed[c.Row+c.RowSpan] = true
		}
	}
	bodyCuts := map[int]bool{}
	activeEnd := t.HeaderRows
	for r := t.HeaderRows; r < t.Rows; r++ {
		if r > t.HeaderRows && proposed[r] && activeEnd <= r {
			bodyCuts[r] = true
		}
		for _, c := range byRow[r] {
			activeEnd = max(activeEnd, c.Row+c.RowSpan)
		}
	}
	var out strings.Builder
	out.WriteString("<table>\n")
	if t.HeaderRows > 0 {
		out.WriteString("<thead>\n")
	} else {
		out.WriteString("<tbody>\n")
	}
	for r := 0; r < t.Rows; r++ {
		if r == t.HeaderRows && r > 0 {
			out.WriteString("</thead>\n<tbody>\n")
		}
		if bodyCuts[r] {
			out.WriteString("</tbody>\n<tbody>\n")
		}
		out.WriteString("<tr>")
		cells := byRow[r]
		sort.SliceStable(cells, func(i, j int) bool { return cells[i].Column < cells[j].Column })
		for _, c := range cells {
			tag := "td"
			if c.Header {
				tag = "th"
			}
			out.WriteString("<" + tag)
			if c.RowSpan > 1 {
				fmt.Fprintf(&out, ` rowspan="%d"`, c.RowSpan)
			}
			if c.ColSpan > 1 {
				fmt.Fprintf(&out, ` colspan="%d"`, c.ColSpan)
			}
			if c.Header {
				fmt.Fprintf(&out, ` id="%s-r%d-c%d"`, xmlText(prefix), c.Row, c.Column)
				switch c.Scope {
				case "col", "colgroup", "row", "rowgroup":
					out.WriteString(` scope="` + c.Scope + `"`)
				}
			} else {
				var headers []string
				seen := map[string]bool{}
				add := func(ids []string) {
					for _, id := range ids {
						if !seen[id] {
							headers = append(headers, id)
							seen[id] = true
						}
					}
				}
				for col := max(0, c.Column); col < min(t.Columns, c.Column+c.ColSpan); col++ {
					add(columnHeaders[col])
				}
				for row := max(0, c.Row); row < min(t.Rows, c.Row+c.RowSpan); row++ {
					add(rowHeaders[row])
				}
				if len(headers) > 0 {
					out.WriteString(` headers="` + xmlText(strings.Join(headers, " ")) + `"`)
				}
			}
			out.WriteString(">" + htmlRuns(Block{Text: c.Text, Runs: c.Runs}) + "</" + tag + ">")
		}
		out.WriteString("</tr>\n")
	}
	if t.HeaderRows >= t.Rows && t.HeaderRows > 0 {
		out.WriteString("</thead>\n")
	} else {
		out.WriteString("</tbody>\n")
	}
	out.WriteString("</table>")
	return out.String()
}
