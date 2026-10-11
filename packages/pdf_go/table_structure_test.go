package pdfextractor

import (
	"encoding/xml"
	"io"
	"strings"
	"testing"
)

func tableSpan(text string, x, y, w float64) span {
	return span{text: text, size: 10, baseline: y, box: Rect{x, y - 8, w, 10}}
}

func TestRuledTableColumnGroupsAndCenteredRowLabels(t *testing.T) {
	s := []span{tableSpan("Measurements", 130, 30, 120), tableSpan("Group", 20, 48, 25), tableSpan("Trial", 75, 48, 22), tableSpan("Before", 140, 48, 30), tableSpan("After", 210, 48, 25), tableSpan("First", 20, 85, 28), tableSpan("Second group", 20, 145, 45)}
	for row, y := range []float64{65, 85, 105, 125, 145, 165} {
		s = append(s, tableSpan("t", 75, y, 8), tableSpan("1.0", 145, y, 15), tableSpan("2.0", 215, y, 15))
		_ = row
	}
	rules := []ruling{{20, 15, 260, 15}, {130, 35, 250, 35}, {20, 55, 260, 55}, {20, 115, 260, 115}, {20, 175, 260, 175}}
	b := ruledTables(makeLines(s), rules, 10)
	if len(b) != 1 || b[0].Table == nil {
		t.Fatalf("missing semantic table: %+v", b)
	}
	table := b[0].Table
	if table.Rows != 8 || table.Columns != 4 || table.HeaderRows != 2 {
		t.Fatalf("dimensions: %+v", table)
	}
	for text, want := range map[string][4]int{"Measurements": {0, 2, 1, 2}, "First": {2, 0, 3, 1}, "Second group": {5, 0, 3, 1}} {
		found := false
		for _, c := range table.Cells {
			if c.Text == text {
				found = true
				if got := [4]int{c.Row, c.Column, c.RowSpan, c.ColSpan}; got != want {
					t.Fatalf("%s: %v want %v", text, got, want)
				}
			}
		}
		if !found {
			t.Fatal("missing", text)
		}
	}
	markup := tableHTML(b[0], "p1-table1")
	if strings.Count(markup, "<tbody>") != 2 {
		t.Fatal("missing body row groups", markup)
	}
	for _, want := range []string{`colspan="2"`, `rowspan="3"`, `scope="rowgroup"`, `headers="p1-table1-r0-c2 p1-table1-r1-c2 p1-table1-r2-c0"`} {
		if !strings.Contains(markup, want) {
			t.Fatalf("missing %s in %s", want, markup)
		}
	}
	d := xml.NewDecoder(strings.NewReader(markup))
	for {
		_, e := d.Token()
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
	}
}

func TestWrappedHeadersAndRightAlignedNumbers(t *testing.T) {
	s := []span{tableSpan("Model", 20, 38, 30), tableSpan("Count", 140, 38, 30), tableSpan("Input Tokens", 200, 32, 70), tableSpan("Average", 212, 44, 40)}
	for _, y := range []float64{65, 85, 105} {
		s = append(s, tableSpan("model", 20, y, 35), tableSpan("2", 163, y, 5), tableSpan("13.4", 249, y, 20))
	}
	b := ruledTables(makeLines(s), []ruling{{20, 20, 280, 20}, {20, 52, 280, 52}, {20, 115, 280, 115}}, 10)
	if len(b) != 1 || b[0].Table == nil || b[0].Table.HeaderRows != 1 || b[0].Rows[0][2] != "Input Tokens Average" {
		t.Fatalf("%+v", b)
	}
	if b[0].Rows[0][1] != "Count" {
		t.Fatal(b[0].Rows)
	}
}

func TestAlgorithmPreservesStepsAndDoesNotBecomeTable(t *testing.T) {
	s := []span{tableSpan("Algorithm 2 Count values", 20, 30, 140), tableSpan("Require: values", 20, 48, 90), tableSpan("1:", 20, 65, 10), tableSpan("for each value", 40, 65, 80), tableSpan("2:", 20, 80, 10), tableSpan("count += value", 55, 80, 90), tableSpan("3:", 20, 95, 10), tableSpan("return count", 40, 95, 75)}
	ls := makeLines(s)
	rules := []ruling{{20, 15, 300, 15}, {20, 36, 300, 36}, {20, 105, 300, 105}}
	b := algorithmBlocks(ls, rules, 10)
	if len(b) != 2 || b[1].Kind != "code" || b[1].Language != "pseudocode" || !strings.Contains(b[1].Text, "2:   count += value") {
		t.Fatalf("%+v", b)
	}
	if tables := detectTables(ls, rules, 10); len(tables) != 0 {
		t.Fatal(tables)
	}
	// A caption alone must not consume prose or an ordinary numeric table.
	s[4].text = "one value"
	ls = makeLines(s)
	if b := algorithmBlocks(ls, rules, 10); len(b) != 0 {
		t.Fatal(b)
	}
}

func TestTableKeepsSuperscriptAfterItsNumber(t *testing.T) {
	spans := []span{tableSpan("Model", 20, 30, 30), tableSpan("Score", 140, 30, 30)}
	for _, y := range []float64{50, 70, 90} {
		spans = append(spans, tableSpan("Example", 20, y, 40), tableSpan("69.00", 140, y, 25))
		star := tableSpan("*", 166, y-4, 4)
		star.size = 7
		star.script = "sup"
		spans = append(spans, star)
	}
	b := ruledTables(makeLines(spans), []ruling{{20, 15, 200, 15}, {20, 37, 200, 37}, {20, 100, 200, 100}}, 10)
	if len(b) != 1 {
		t.Fatal(b)
	}
	for _, row := range b[0].Rows[1:] {
		if row[1] != "69.00*" {
			t.Fatal(row)
		}
	}
}

func TestDisplayMathIncludesShortAnnotationButLeavesProse(t *testing.T) {
	mf := &font{math: true}
	first := tableSpan("x + y", 40, 30, 120)
	first.font = mf
	middle := tableSpan("= z", 40, 40, 35)
	middle.font = mf
	last := tableSpan("x", 40, 50, 10)
	last.font = mf
	prose := tableSpan("The next paragraph explains the result.", 20, 100, 230)
	other := tableSpan("a=b", 400, 40, 30)
	other.font = mf
	lines := makeLines([]span{first, middle, tableSpan("so that", 100, 40, 35), last, prose})
	lines = append(lines, makeLines([]span{other, tableSpan("unrelated", 440, 40, 50)})...)
	p := &pdf{opts: (Options{}).normalized(), out: &Document{}, warned: map[string]bool{}}
	blocks := p.mathBlocks(&pageContent{page: Page{Number: 1}}, lines)
	if len(blocks) != 1 || !strings.Contains(blocks[0].Text, "so that") {
		t.Fatal(blocks)
	}
	for _, l := range lines {
		if (strings.Contains(l.text, "paragraph") || strings.Contains(l.text, "unrelated")) && l.used {
			t.Fatal("consumed surrounding prose")
		}
	}
}

func TestPageBorderRulesDoNotTurnColumnsIntoTable(t *testing.T) {
	var spans []span
	for y := 40.0; y < 220; y += 14 {
		spans = append(spans, tableSpan("This is ordinary flowing prose from the left column.", 20, y, 210), tableSpan("This is ordinary flowing prose from the right column.", 260, y, 210))
	}
	lines := makeLines(spans)
	blocks := ruledTables(lines, []ruling{{20, 20, 480, 20}, {20, 240, 480, 240}}, 10)
	if len(blocks) != 0 {
		t.Fatal("page borders classified as a table", blocks)
	}
	for _, l := range lines {
		if l.used {
			t.Fatal("consumed prose")
		}
	}
}

func TestMathAnnotationContinuationDoesNotConsumeNewSentence(t *testing.T) {
	for _, tc := range []struct {
		annotation, next string
		consumed         bool
	}{{"terms with higher", "powers of dx.", true}, {"terms with higher", "New sentence.", false}, {"all done.", "another paragraph", false}} {
		mf := &font{math: true}
		first, middle, last := tableSpan("x + y", 40, 30, 100), tableSpan("= z", 40, 40, 35), tableSpan("x", 40, 55, 10)
		first.font, middle.font, last.font = mf, mf, mf
		lines := makeLines([]span{first, middle, tableSpan(tc.annotation, 120, 40, 75), tableSpan(tc.next, 120, 48, 65), last})
		p := &pdf{opts: (Options{}).normalized(), out: &Document{}, warned: map[string]bool{}}
		p.mathBlocks(&pageContent{page: Page{Number: 1}}, lines)
		for _, l := range lines {
			if l.text == tc.next && l.used != tc.consumed {
				t.Fatalf("%q after %q consumed=%v", tc.next, tc.annotation, l.used)
			}
		}
	}
}
