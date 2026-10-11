package pdfextractor

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"fmt"
	"strings"
	"testing"
)

func namedCFFFixture() []byte {
	char := func(n int) []byte {
		b := append(csArgs(0, 0), 21)
		b = append(b, csArgs(n, 0)...)
		b = append(b, 5, 14)
		return b
	}
	chars := cffTestIndex([]byte{14}, char(100), char(200))
	index := cffTestIndex([]byte("Test"))
	custom := cffTestIndex([]byte("Omega"))
	empty := cffTestIndex()
	top := func(charset, encoding, program int) []byte {
		var d []byte
		for _, v := range [][2]int{{charset, 15}, {encoding, 16}, {program, 17}} {
			d = append(d, 29)
			d = binary.BigEndian.AppendUint32(d, uint32(v[0]))
			d = append(d, byte(v[1]))
		}
		return d
	}
	start := 4 + len(index) + len(cffTestIndex(top(0, 0, 0))) + len(custom) + len(empty)
	charset := []byte{0, 0, 34, 1, 135}              // .notdef, SID 34 (A), custom SID 391 (Omega).
	encoding := []byte{129, 1, 65, 1, 1, 90, 1, 135} // codes 65..66 plus supplemental 90 -> Omega.
	b := append([]byte{1, 0, 4, 4}, index...)
	b = append(b, cffTestIndex(top(start, start+len(charset), start+len(charset)+len(encoding)))...)
	b = append(b, custom...)
	b = append(b, empty...)
	b = append(b, charset...)
	b = append(b, encoding...)
	return append(b, chars...)
}

func TestNamedCFFCharsetEncodingAndPartialUnicode(t *testing.T) {
	b := namedCFFFixture()
	f, e := parseCFF(b)
	if e != nil {
		t.Fatal(e)
	}
	if f.names["A"] != 1 || f.names["Omega"] != 2 || f.codes[65] != 1 || f.codes[66] != 2 || f.codes[90] != 2 {
		t.Fatal(f.names, f.codes)
	}
	path, _, e := f.outline(65, "Omega")
	if e != nil || !strings.Contains(path, "L200.000 0.000") {
		t.Fatal(path, e)
	}
	for n := 0; n < len(b); n++ {
		_, _ = parseCFF(b[:n])
	}
	pdf := fixture([]string{
		"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> >>", "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Example /FirstChar 65 /LastChar 66 /Widths [500 500] /FontDescriptor 6 0 R /ToUnicode 8 0 R >>", streamObject("BT /F1 12 Tf 20 200 Td (AB) Tj ET"), "<< /Type /FontDescriptor /FontFile3 7 0 R >>", fmt.Sprintf("<< /Length %d /Subtype /Type1C >>\nstream\n%s\nendstream", len(b), b), streamObject("1 beginbfchar <41> <0041> endbfchar"),
	}, "")
	d, e := Extract(pdf, Options{})
	if e != nil || !strings.Contains(d.Markdown, "AΩ") {
		t.Fatal(d, e)
	}
}

func TestType3BitmapTransformDecodeAndBounds(t *testing.T) {
	for _, compressed := range []bool{false, true} {
		raw := []byte{0x80, 0x40}
		filter := ""
		if compressed {
			var b bytes.Buffer
			w := zlib.NewWriter(&b)
			w.Write(raw)
			w.Close()
			raw = b.Bytes()
			filter = "/F /Fl "
		}
		program := append([]byte("500 0 10 20 12 22 d1 q 2 0 0 2 10 20 cm BI /W 2 /H 2 /IM true /D [1 0] "+filter+"ID "), raw...)
		program = append(program, []byte("\nEI Q")...)
		c := charstring{f: &outlineFont{type3: true}}
		if e := type3Outline(&c, program); e != nil {
			t.Fatal(e)
		}
		if c.box != (Rect{10, 20, 2, 2}) || strings.Count(c.path.String(), "M") != 2 {
			t.Fatal(c.box, c.path.String())
		}
	}
	for _, bad := range []string{"Q", "BI /W 999999 /H 999999 /IM true ID x EI", "BI /W 2 /H 2 /IM true ID x"} {
		c := charstring{f: &outlineFont{type3: true}}
		if type3Outline(&c, []byte(bad)) == nil {
			t.Fatal("accepted invalid mask", bad)
		}
	}
}

func TestType3UnknownGlyphUsesInlineAssetAndFontMatrixAdvance(t *testing.T) {
	data := fixture([]string{
		"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> >>", "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type3 /FontMatrix [.01 0 0 .01 0 0] /FirstChar 65 /LastChar 65 /Widths [50] /Encoding << /Differences [65 /unknown] >> /CharProcs << /unknown 6 0 R >> >>",
		streamObject("BT /F1 10 Tf 20 200 Td (AA) Tj ET"), streamObject("50 0 0 0 50 50 d1 0 0 m 50 0 l 50 50 l h f"),
	}, "")
	d, e := Extract(data, Options{})
	if e != nil {
		t.Fatal(e)
	}
	if len(d.Assets) != 1 {
		t.Fatal(d.Stats, d.Warnings)
	}
	svg := string(d.Assets[0].Data)
	if !strings.Contains(svg, "20 100)") || !strings.Contains(svg, "25 100)") {
		t.Fatal(svg)
	}
	if d.Complete {
		t.Fatal("unknown Unicode must remain disclosed")
	}
}

func TestType3TransformDoesNotTransformStoredPointTwice(t *testing.T) {
	c := charstring{}
	e := type3Outline(&c, []byte("600 0 d0 2 0 0 2 10 20 cm 3 4 m 5 6 7 8 v f"))
	if e != nil || !strings.Contains(c.path.String(), "M16.000 28.000") || !strings.Contains(c.path.String(), "C16.000 28.000 20.000 32.000 24.000 36.000") {
		t.Fatal(e, c.path.String())
	}
}

func TestInlineMathPreservesUnknownGlyphAfterMappedSpan(t *testing.T) {
	data := fixture([]string{
		"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R /F2 7 0 R >> >> >>", "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type3 /BaseFont /CMMI10 /FontMatrix [.01 0 0 .01 0 0] /FirstChar 65 /LastChar 66 /Widths [50 50] /Encoding << /Differences [65 /A /unknown] >> /CharProcs << /A 6 0 R /unknown 6 0 R >> >>",
		streamObject("BT /F2 10 Tf 20 200 Td (Read ) Tj /F1 10 Tf (A) Tj (B) Tj /F2 10 Tf ( here.) Tj ET"), streamObject("50 0 0 0 50 50 d1 0 0 m 50 0 l 50 50 l h f"), "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	}, "")
	d, err := Extract(data, Options{})
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range d.Pages[0].Blocks {
		for _, run := range b.Runs {
			if run.Text == "A�" && run.Asset != "" {
				return
			}
		}
	}
	t.Fatal("grouped unknown glyph lost its visual fallback", d.Pages[0].Blocks)
}
