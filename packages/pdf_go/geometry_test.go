package pdfextractor

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestScriptsKeepTheirBaseline(t *testing.T) {
	d, e := Extract(simplePDF(`BT /F1 12 Tf 54 700 Td (x) Tj /F1 8 Tf 0 5 Td (2) Tj /F1 12 Tf 12 -5 Td ( + y) Tj ET`), Options{})
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(d.Markdown, "<sup>2</sup>") {
		t.Fatal(d.Markdown)
	}
	if _, e = json.Marshal(d); e != nil {
		t.Fatal(e)
	}
	// The small script row is also valid if it is isolated by column ordering.
	lines := makeLines([]span{{text: "2", size: 8, script: "sup", box: Rect{10, 10, 4, 8}}})
	if len(lines) != 1 || lines[0].size == 0 {
		t.Fatal("zero-sized script line")
	}
}

func TestMarginsDoNotDeleteEquationFragments(t *testing.T) {
	pages := []*pageContent{}
	for n := 1; n <= 4; n++ {
		pages = append(pages, &pageContent{page: Page{Height: 800}, spans: []span{
			{text: "Book ", size: 9, box: Rect{20, 8, 25, 9}},
			{text: "header", size: 9, box: Rect{45, 8, 35, 9}},
			{text: fmt.Sprint(n), size: 9, box: Rect{250, 775, 5, 9}},
			{text: "x", size: 10, box: Rect{30, 752, 5, 10}},
			{text: "2", size: 7, box: Rect{35, 749, 4, 7}},
			{text: strings.Repeat("Body ", 60), size: 10, box: Rect{20, 100, 400, 10}},
		}})
	}
	cleanMargins(pages)
	for _, pc := range pages {
		text := ""
		for _, s := range pc.spans {
			text += s.text
		}
		if strings.Contains(text, "header") || !strings.Contains(text, "x2") {
			t.Fatal(text)
		}
	}
}

func csNumber(n int) []byte {
	if n >= -107 && n <= 107 {
		return []byte{byte(n + 139)}
	}
	return []byte{28, byte(n >> 8), byte(n)}
}
func csArgs(nums ...int) []byte {
	var out []byte
	for _, n := range nums {
		out = append(out, csNumber(n)...)
	}
	return out
}
func TestCharstringsCurvesSubroutinesAndLimits(t *testing.T) {
	f := &outlineFont{}
	c := charstring{f: f, local: [][]byte{append(append(csArgs(100, 0, 0, 100, -100, 0), 8), 11)}}
	code := append(csArgs(10, 20), 21)
	code = append(code, csArgs(-107)...)
	code = append(code, 10, 14)
	if e := c.run(code, 0); e != nil || !strings.Contains(c.path.String(), "C110.000 20.000 110.000 120.000 10.000 120.000") {
		t.Fatalf("%v %s", e, c.path.String())
	}
	c = charstring{f: f, local: [][]byte{append(csArgs(-107), 10)}}
	if e := c.run(append(csArgs(-107), 10), 0); !errors.Is(e, ErrLimit) {
		t.Fatal("recursive subroutine", e)
	}
	// A truncated mask cannot turn binary hint bytes into new operators.
	c = charstring{f: f}
	if e := c.run(append(csArgs(1, 2), 19), 0); e == nil {
		t.Fatal("accepted truncated hint mask")
	}
	c = charstring{f: f}
	flex := append(csArgs(0, 0), 21)
	flex = append(flex, csArgs(10, 20, 30, 40, 50, 60, 70)...)
	flex = append(flex, 12, 34, 14)
	if e := c.run(flex, 0); e != nil || strings.Count(c.path.String(), "C") != 2 {
		t.Fatal(e, c.path.String())
	}
}

func cffTestIndex(items ...[]byte) []byte {
	b := []byte{byte(len(items) >> 8), byte(len(items))}
	if len(items) == 0 {
		return b
	}
	b = append(b, 2)
	off := 1
	for _, item := range items {
		b = append(b, byte(off>>8), byte(off))
		off += len(item)
	}
	b = append(b, byte(off>>8), byte(off))
	for _, item := range items {
		b = append(b, item...)
	}
	return b
}
func cffTestInt(n int) []byte { return []byte{29, byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n)} }
func TestCFFCIDGlyphMapping(t *testing.T) {
	glyph := append(csArgs(0, 0), 21)
	glyph = append(glyph, csArgs(100, 0, 0, 100, -100, 0)...)
	glyph = append(glyph, 5, 14)
	chars := cffTestIndex([]byte{14}, glyph)
	// Fixed-width DICT numbers make the offset calculation independent of values.
	top := func(charset, charstrings, fdarray, fdselect int) []byte {
		d := append(csArgs(0, 0, 0), 12, 30)
		for _, v := range [][2]int{{charset, 15}, {charstrings, 17}, {fdarray, 1236}, {fdselect, 1237}} {
			d = append(d, cffTestInt(v[0])...)
			if v[1] > 1200 {
				d = append(d, 12, byte(v[1]-1200))
			} else {
				d = append(d, byte(v[1]))
			}
		}
		return d
	}
	header := []byte{1, 0, 4, 4}
	name := cffTestIndex([]byte("Test"))
	empty := cffTestIndex()
	start := len(header) + len(name) + len(cffTestIndex(top(0, 0, 0, 0))) + len(empty)*2
	charset := start + len(chars)
	fdarray := charset + 3
	fds := cffTestIndex([]byte{})
	fdselect := fdarray + len(fds)
	b := append(header, name...)
	b = append(b, cffTestIndex(top(charset, start, fdarray, fdselect))...)
	b = append(b, empty...)
	b = append(b, empty...)
	b = append(b, chars...)
	b = append(b, 0, 0, 42)
	b = append(b, fds...)
	b = append(b, 0, 0, 0)
	f, e := parseCFF(b)
	if e != nil {
		t.Fatal(e)
	}
	path, m, e := f.outline(42, "")
	if e != nil || m[0] != .001 || !strings.Contains(path, "L100.000 100.000") {
		t.Fatal(path, m, e)
	}
	if _, _, e = f.outline(1, ""); e == nil {
		t.Fatal("CID must not be assumed to equal GID")
	}
	for n := 0; n < len(b); n++ {
		_, _ = parseCFF(b[:n])
	}
}

func type1Encrypt(b []byte, seed uint16) []byte {
	out := make([]byte, len(b))
	for j, v := range b {
		out[j] = v ^ byte(seed>>8)
		seed = (uint16(out[j])+seed)*52845 + 22719
	}
	return out
}
func TestType1EncryptionAndFlexHintReplacement(t *testing.T) {
	glyph := append(csArgs(0, 500), 13)
	glyph = append(glyph, csArgs(0, 0)...)
	glyph = append(glyph, 21)
	glyph = append(glyph, csArgs(100, 0)...)
	glyph = append(glyph, 5, 14)
	encrypted := type1Encrypt(append([]byte{0, 0, 0, 0}, glyph...), 4330)
	clear := []byte("%!PS\n/FontMatrix [.001 0 0 .001 0 0] def\n/Encoding 256 array dup 65 /A put\ncurrentfile eexec\n")
	private := []byte(fmt.Sprintf("abcd/lenIV 4 def /Subrs 0 array /CharStrings 1 dict dup begin /A %d RD ", len(encrypted)))
	private = append(private, encrypted...)
	private = append(private, []byte(" ND end")...)
	data := type1Encrypt(private, 55665)
	data = append(clear, data...)
	f, names, e := parseType1(data, len(clear), len(data)-len(clear))
	if e != nil || names[65] != "A" {
		t.Fatal(e, names[65])
	}
	path, _, e := f.outline(65, "A")
	if e != nil || !strings.Contains(path, "L100.000 0.000") {
		t.Fatal(e, path)
	}
	pdfBytes := fixture([]string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> >>",
		"<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /ExampleMath /FontDescriptor 6 0 R >>",
		streamObject("BT /F1 12 Tf 50 150 Td (A) Tj ET"),
		"<< /Type /FontDescriptor /FontFile 7 0 R >>",
		fmt.Sprintf("<< /Length %d /Length1 8 0 R /Length2 9 0 R >>\nstream\n%s\nendstream", len(data), data),
		fmt.Sprint(len(clear)), fmt.Sprint(len(data) - len(clear)),
	}, "")
	doc, err := Extract(pdfBytes, Options{})
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range doc.Warnings {
		if w.Code == "font-outline" || w.Code == "font-encoding" {
			t.Fatal(w)
		}
	}
	if len(doc.Assets) != 1 {
		t.Fatal(doc.Stats)
	}
	// OtherSubr 3 returns the argument for the subsequent pop/callsubr.
	c := charstring{f: f}
	code := append(csArgs(8, 1, 3), 12, 16, 12, 17)
	if e = c.run(code, 0); e != nil || len(c.stack) != 1 || c.stack[0] != 8 {
		t.Fatal(e, c.stack)
	}
}

func TestTrueTypeQuadraticsAndComposites(t *testing.T) {
	// A triangle: on-curve points (0,0), (100,0), (100,100).
	glyph := []byte{0, 1, 0, 0, 0, 0, 0, 100, 0, 100, 0, 2, 0, 0, 0x31, 0x33, 0x35, 100, 100}
	composite := []byte{255, 255, 0, 0, 0, 0, 0, 100, 0, 100, 0, 3, 0, 0, 0, 20, 0, 30}
	data := append(append([]byte(nil), glyph...), composite...)
	loca := make([]byte, 12)
	binary.BigEndian.PutUint32(loca[4:], uint32(len(glyph)))
	binary.BigEndian.PutUint32(loca[8:], uint32(len(data)))
	f := trueTypeFont{glyf: data, loca: loca, glyphs: 2, long: true, units: 1000}
	c := charstring{}
	if e := f.draw(&c, 1, identity, 0); e != nil || !strings.Contains(c.path.String(), "M20.000 30.000 L120.000 30.000 L120.000 130.000") {
		t.Fatal(e, c.path.String())
	}
	// A composite referring to itself terminates with a resource error.
	f.glyf[len(glyph)+13] = 1
	c = charstring{}
	if e := f.draw(&c, 1, identity, 0); !errors.Is(e, ErrLimit) {
		t.Fatal(e)
	}
}

func TestType3MathProducesSafePositionedAsset(t *testing.T) {
	b := fixture([]string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> >>",
		"<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type3 /BaseFont /ExampleMath /FontMatrix [.001 0 0 .001 0 0] /FirstChar 65 /LastChar 65 /Widths [500] /Encoding << /Differences [65 /A] >> /CharProcs << /A 6 0 R >> >>",
		streamObject("BT /F1 12 Tf 50 150 Td (AA) Tj ET"),
		streamObject("500 0 0 0 500 700 d1 0 0 m 250 700 l 500 0 l h f"),
	}, "")
	d, e := Extract(b, Options{})
	if e != nil {
		t.Fatal(e)
	}
	if d.Stats.Math != 1 || len(d.Assets) != 1 || !strings.Contains(string(d.Assets[0].Data), "<use href=") {
		t.Fatal(d.Stats)
	}
	if !strings.Contains(pageHTML(d.Pages[0]), `class="math-display"`) {
		t.Fatal("missing math renderer")
	}
	if _, e = Extract(b, Options{Limits: Limits{AssetBytes: 32}}); !errors.Is(e, ErrLimit) {
		t.Fatal("asset budget", e)
	}
	if matrixSVG(matrix{.010382247, 0, 0, -.006955, 20, 30}) == "matrix(0.010 0.000 0.000 -0.007 20.000 30.000)" {
		t.Fatal("font matrix precision lost")
	}
}

func TestMathClassifiesGeometryWithoutSwallowingProse(t *testing.T) {
	f := &font{math: true}
	for _, text := range []string{"Suppose x + y = z.", "of (x, y, z).", "The sum x + y."} {
		l := &line{math: true, text: text, spans: []span{{text: text, font: f}}}
		if mathLine(l) {
			t.Fatal("prose became display math", text)
		}
	}
	l := &line{math: true, text: "2 + 3 = x", spans: []span{{text: "2 + 3 = "}, {text: "x", font: f}}}
	if !mathLine(l) {
		t.Fatal("lost numeric formula")
	}
	lines := makeLines([]span{{text: "T", size: 10, baseline: 100, box: Rect{20, 92, 7, 10}, font: f}, {text: "̃", size: 10, baseline: 96, box: Rect{20, 88, 7, 10}, font: f}})
	if len(lines) != 1 || len(lines[0].spans) != 2 {
		t.Fatal("accent detached from its base", len(lines))
	}
}

func TestCropBoxIsClippedToPhysicalPage(t *testing.T) {
	b := fixture([]string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] /CropBox [20 0 280 304] /Resources << /Font << /F1 4 0 R >> >> >>",
		"<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		streamObject("BT /F1 12 Tf 50 150 Td (A visible line) Tj ET"),
	}, "")
	d, e := Extract(b, Options{})
	if e != nil {
		t.Fatal(e)
	}
	if d.Pages[0].Width != 260 || d.Pages[0].Height != 300 || d.Pages[0].Blocks[0].Box.X != 30 {
		t.Fatal(d.Pages[0])
	}
	b = simplePDF("BT /F1 12 Tf 0 0 0 0 0 0 Tm (No height) Tj ET")
	d, e = Extract(b, Options{})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = json.Marshal(d); e != nil {
		t.Fatal(e)
	}
}

func FuzzFontPrograms(f *testing.F) {
	f.Add([]byte{1, 0, 4, 4, 0, 0})
	f.Add([]byte{139, 139, 21, 239, 139, 5, 14})
	f.Fuzz(func(t *testing.T, b []byte) {
		if len(b) > 65536 {
			t.Skip()
		}
		_, _ = parseCFF(b)
		_, _ = parseTrueType(b)
		_, _, _ = parseType1(b, len(b)/3, len(b)-len(b)/3)
		c := charstring{f: &outlineFont{}}
		_ = c.run(b, 0)
		c = charstring{f: &outlineFont{type1: true}}
		_ = c.run(b, 0)
		c = charstring{}
		_ = type3Outline(&c, b)
	})
}

func TestRuledTableRetainsBlankCellsAndWholeHeader(t *testing.T) {
	var spans []span
	rows := [][]string{{"Tool", "Read-only", "Arguments"}, {"read_file", "yes", "path"}, {"write_file", "", "path, content"}, {"bash", "no", "command"}}
	for row, cells := range rows {
		for col, text := range cells {
			if text == "" {
				continue
			}
			x := float64(20 + col*100)
			baseline := float64(50 + row*15)
			spans = append(spans, span{text: text, size: 10, baseline: baseline, box: Rect{x, baseline - 8, float64(len(text)) * 5, 10}})
		}
	}
	lines := makeLines(spans)
	tables := ruledTables(lines, []ruling{{20, 35, 320, 35}, {20, 55, 320, 55}, {20, 102, 320, 102}}, 10)
	if len(tables) != 1 || len(tables[0].Rows) != 4 || tables[0].Rows[0][1] != "Read-only" || tables[0].Rows[2][1] != "" || tables[0].Rows[2][2] != "path, content" {
		t.Fatalf("%+v", tables)
	}
}

func TestNumberedSmallHeadingAndWrappedTitle(t *testing.T) {
	l := &line{bold: true, size: 8.5, text: "C.1.2 Behavior Encoding"}
	kind, level, _ := classifyLine(l, 10)
	if kind != "heading" || level != 3 {
		t.Fatal(kind, level)
	}
	pc := &pageContent{page: Page{Number: 1, Width: 600, Height: 800}, spans: []span{
		{text: "A Wrapped", size: 20, role: "H1", baseline: 40, box: Rect{200, 24, 200, 20}},
		{text: "Document Title", size: 20, role: "H1", baseline: 65, box: Rect{170, 49, 260, 20}},
	}}
	p := &pdf{opts: Options{}.normalized(), out: &Document{}, warned: map[string]bool{}}
	blocks := p.layout(pc, 10)
	if len(blocks) != 1 || blocks[0].Text != "A Wrapped Document Title" {
		t.Fatal(blocks)
	}
	pc.spans[0].box.X = 56
	pc.spans[0].box.W = 400
	pc.spans[1].box.X = 56
	pc.spans[1].box.W = 177
	blocks = p.layout(pc, 10)
	if len(blocks) != 1 {
		t.Fatal("left-aligned wrapped title", blocks)
	}
}

func TestUnresolvedEmbeddedEncodingIsReported(t *testing.T) {
	b := fixture([]string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> >>",
		"<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Custom /FontDescriptor 6 0 R >>",
		streamObject("BT /F1 12 Tf 50 150 Td (ABC) Tj ET"),
		"<< /Type /FontDescriptor /FontFile3 7 0 R >>",
		"<< /Subtype /Type1C /Length 7 >>\nstream\ninvalid\nendstream",
	}, "")
	d, e := Extract(b, Options{})
	if e != nil {
		t.Fatal(e)
	}
	found := false
	for _, w := range d.Warnings {
		found = found || w.Code == "font-encoding"
	}
	if d.Complete || !found {
		t.Fatal(d.Warnings)
	}
}

func TestRemovedMathSpansDoNotLeaveStaleLineTraits(t *testing.T) {
	l := &line{math: true, spans: []span{{text: "Prose", size: 12, box: Rect{10, 20, 30, 12}}}}
	finishLine(l)
	if l.math {
		t.Fatal("stale math classification")
	}
}
