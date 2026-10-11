package pdfextractor

import (
	"archive/zip"
	"bytes"
	"compress/zlib"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"testing"
)

// These byte-level fixtures exercise the parser independently of a PDF library.
func fixture(objects []string, trailer string) []byte {
	var b bytes.Buffer
	b.WriteString("%PDF-1.7\n")
	offsets := []int{0}
	for j, s := range objects {
		offsets = append(offsets, b.Len())
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", j+1, s)
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(offsets))
	for _, off := range offsets[1:] {
		fmt.Fprintf(&b, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R %s >>\nstartxref\n%d\n%%%%EOF\n", len(offsets), trailer, xref)
	return b.Bytes()
}
func streamObject(content string) string {
	return fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content)
}
func simplePDF(content string) []byte {
	return fixture([]string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> >>",
		"<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
		streamObject(content),
	}, "")
}
func TestTextOperatorsAndEscaping(t *testing.T) {
	b := simplePDF("BT /F1 12 Tf 1 0 0 1 54 700 Tm (Hello \\(world\\)!) Tj 0 -18 Td [(A) -350 (test)] TJ ET")
	d, e := Extract(b, Options{})
	if e != nil {
		t.Fatal(e)
	}
	for _, s := range []string{"Hello (world)!", "A test"} {
		if !strings.Contains(d.Markdown, s) {
			t.Fatalf("missing %q: %s", s, d.Markdown)
		}
	}
	if len(d.Pages) != 1 || d.Pages[0].Width != 612 || !d.Complete {
		t.Fatalf("unexpected document: %+v", d)
	}
}
func TestLexer(t *testing.T) {
	l := lexer{b: []byte(`[12 0 R /A#20B (one\n\050two\051\
three) <FEFF0041> << /Flag true /X null >>]`)}
	a := asArray(l.value(0))
	if l.err != nil {
		t.Fatal(l.err)
	}
	if a[0] != (ref{12, 0}) || named(a[1]) != "A B" || a[2] != (literal("one\n(two)three")) || textString(a[3]) != "A" {
		t.Fatalf("%#v", a)
	}
}
func TestUnicodeCMapAndActualText(t *testing.T) {
	cmap := `2 beginbfchar <0001> <00660069> <0002> <D83DDE80> endbfchar 1 beginbfrange <0003> <0005> [<0041> <0042> <0043>] endbfrange`
	m, l, e := parseCMap([]byte(cmap))
	if e != nil || m["\x00\x01"] != "fi" || m["\x00\x02"] != "🚀" || m["\x00\x05"] != "C" || len(l) != 1 || l[0] != 2 {
		t.Fatalf("%v %v %v", m, l, e)
	}
	d, e := Extract(simplePDF("BT /F1 12 Tf 54 700 Td /Span << /ActualText <FEFF0063006C00650061006E> >> BDC (junk) Tj EMC ET"), Options{})
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(d.Markdown, "clean") || strings.Contains(d.Markdown, "junk") {
		t.Fatal(d.Markdown)
	}
}
func TestLimitsAndMalformed(t *testing.T) {
	content := "BT /F1 12 Tf 54 700 Td (Hi) Tj ET"
	good := simplePDF(content)
	for name, opts := range map[string]Options{"input": {Limits: Limits{InputBytes: 32}}, "objects": {Limits: Limits{Objects: 2}}, "operations": {Limits: Limits{Operations: 2}}, "decode": {Limits: Limits{DecodedBytes: 4}}} {
		t.Run(name, func(t *testing.T) {
			if _, e := Extract(good, opts); !errors.Is(e, ErrLimit) {
				t.Fatalf("want limit, got %v", e)
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e := Extract(good, Options{Context: ctx}); !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
	badLength := bytes.Replace(good, []byte(fmt.Sprintf("/Length %d", len(content))), []byte("/Length -1"), 1)
	if bytes.Equal(badLength, good) {
		t.Fatal("negative stream length fixture was not changed")
	}
	for _, b := range [][]byte{nil, []byte("not PDF"), []byte("%PDF-1.7\nstartxref\n999999\n%%EOF"), badLength} {
		if _, e := Extract(b, Options{}); e == nil {
			t.Fatal("accepted malformed PDF")
		}
	}
	encrypted := fixture([]string{"<< /Type /Catalog /Pages 2 0 R >>"}, "/Encrypt 2 0 R")
	if _, e := Extract(encrypted, Options{}); !errors.Is(e, ErrEncrypted) {
		t.Fatal(e)
	}
}
func TestFiltersAndPrediction(t *testing.T) {
	raw := []byte{0, 10, 20, 30, 2, 5, 5, 5}
	var compressed bytes.Buffer
	w := zlib.NewWriter(&compressed)
	w.Write(raw)
	w.Close()
	p := &pdf{opts: Options{}.normalized(), decoded: map[*stream][]byte{}}
	s := &stream{dict: dict{"Filter": name("FlateDecode"), "DecodeParms": dict{"Predictor": float64(12), "Columns": float64(3)}}, raw: compressed.Bytes()}
	b, e := p.decode(s)
	if e != nil || !bytes.Equal(b, []byte{10, 20, 30, 15, 25, 35}) {
		t.Fatalf("%v %v", b, e)
	}
	if b, e = runLength([]byte{2, 'a', 'b', 'c', 254, 'x', 128}, 100); e != nil || string(b) != "abcxxx" {
		t.Fatalf("%q %v", b, e)
	}
	if _, e = runLength([]byte{129, 'x', 128}, 12); !errors.Is(e, ErrLimit) {
		t.Fatal(e)
	}
}
func TestObjectAndXrefStreams(t *testing.T) {
	// Page, catalog, page tree and font are packed in an ObjStm. xref is a stream.
	objects := []string{"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>", "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"}
	header, payload := "", ""
	for j, s := range objects {
		header += fmt.Sprintf("%d %d ", j+1, len(payload))
		payload += s + " "
	}
	packed := header + payload
	var b bytes.Buffer
	b.WriteString("%PDF-1.7\n")
	off5 := b.Len()
	fmt.Fprintf(&b, "5 0 obj\n%s\nendobj\n", streamObject("BT /F1 12 Tf 54 700 Td (Compressed objects) Tj ET"))
	off6 := b.Len()
	fmt.Fprintf(&b, "6 0 obj\n<< /Type /ObjStm /N 4 /First %d /Length %d >>\nstream\n%s\nendstream\nendobj\n", len(header), len(packed), packed)
	off7 := b.Len()
	x := make([]byte, 8*7)
	for id := 0; id < 8; id++ {
		row := x[id*7 : (id+1)*7]
		if id == 0 {
			binary.BigEndian.PutUint16(row[5:], 65535)
		} else if id < 5 {
			row[0] = 2
			binary.BigEndian.PutUint32(row[1:], 6)
			binary.BigEndian.PutUint16(row[5:], uint16(id-1))
		} else {
			row[0] = 1
			binary.BigEndian.PutUint32(row[1:], uint32(map[int]int{5: off5, 6: off6, 7: off7}[id]))
		}
	}
	fmt.Fprintf(&b, "7 0 obj\n<< /Type /XRef /Size 8 /Root 1 0 R /W [1 4 2] /Length %d >>\nstream\n", len(x))
	b.Write(x)
	fmt.Fprintf(&b, "\nendstream\nendobj\nstartxref\n%d\n%%%%EOF\n", off7)
	d, e := Extract(b.Bytes(), Options{})
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(d.Markdown, "Compressed objects") {
		t.Fatal(d.Markdown)
	}
}
func TestIncrementalRevision(t *testing.T) {
	b := simplePDF("BT /F1 12 Tf 54 700 Td (Old text) Tj ET")
	last := bytes.LastIndex(b, []byte("startxref"))
	scan := lexer{b: b, pos: last + 9}
	prev, err := strconv.Atoi(scan.word())
	if err != nil {
		t.Fatal(err)
	}
	offset := len(b)
	b = append(b, []byte("5 0 obj\n"+streamObject("BT /F1 12 Tf 54 700 Td (New text) Tj ET")+"\nendobj\n")...)
	xref := len(b)
	b = append(b, []byte(fmt.Sprintf("xref\n5 1\n%010d 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R /Prev %d >>\nstartxref\n%d\n%%%%EOF\n", offset, prev, xref))...)
	d, e := Extract(b, Options{})
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(d.Markdown, "Old text") || !strings.Contains(d.Markdown, "New text") {
		t.Fatal(d.Markdown)
	}
}
func TestStructuredReadingEdition(t *testing.T) {
	b, e := os.ReadFile("testdata/reading.pdf")
	if e != nil {
		t.Fatal(e)
	}
	d, e := Extract(b, Options{})
	if e != nil {
		t.Fatal(e)
	}
	if d.Title != "The Art of Reading" || d.Author != "The Reader benchmark authors" || d.Stats.Tables != 1 || d.Stats.Images != 1 {
		t.Fatalf("bad metadata or blocks: %+v", d.Stats)
	}
	var code *Block
	for j := range d.Pages[0].Blocks {
		v := &d.Pages[0].Blocks[j]
		if v.Kind == "code" {
			code = v
		}
	}
	if code == nil || code.Language != "go" || !strings.Contains(code.Text, "\n    fmt.Println") || !strings.HasSuffix(code.Text, "}") {
		t.Fatalf("bad code: %+v", code)
	}
	first, e := EPUB(d)
	if e != nil {
		t.Fatal(e)
	}
	second, e := EPUB(d)
	if e != nil || !bytes.Equal(first, second) {
		t.Fatal("EPUB is not deterministic")
	}
	z, e := zip.NewReader(bytes.NewReader(first), int64(len(first)))
	if e != nil {
		t.Fatal(e)
	}
	if z.File[0].Name != "mimetype" || z.File[0].Method != zip.Store || z.File[0].Flags&8 != 0 {
		t.Fatal("mimetype must be first, stored, with no descriptor")
	}
	files := map[string]string{}
	for _, f := range z.File {
		r, e := f.Open()
		if e != nil {
			t.Fatal(e)
		}
		v, e := io.ReadAll(r)
		r.Close()
		if e != nil {
			t.Fatal(e)
		}
		files[f.Name] = string(v)
	}
	for _, s := range []string{"<table>", `class="language-go"`, "    fmt.Println", `<img src="assets/`} {
		if !strings.Contains(files["OEBPS/page-1.xhtml"], s) {
			t.Fatalf("EPUB missing %s", s)
		}
	}
	if _, e = json.Marshal(d); e != nil {
		t.Fatal(e)
	}
}
func TestRenderEscapesUntrustedContent(t *testing.T) {
	d := &Document{Title: `<script>alert(1)</script>`, SHA256: "test", Language: "en", Pages: []Page{{Number: 1, Blocks: []Block{{Kind: "paragraph", Runs: []Run{{Text: `<img onerror="bad">`, Link: "javascript:alert(1)"}}}}}}}
	b, e := EPUB(d)
	if e != nil {
		t.Fatal(e)
	}
	z, _ := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	for _, f := range z.File {
		r, _ := f.Open()
		v, _ := io.ReadAll(r)
		r.Close()
		if strings.Contains(string(v), "<script>") || strings.Contains(string(v), "javascript:") {
			t.Fatal("unsafe markup in EPUB")
		}
	}
}

func TestMarginsProtectChapterTitles(t *testing.T) {
	pages := []*pageContent{}
	for n := 1; n <= 3; n++ {
		pages = append(pages, &pageContent{page: Page{Height: 792}, spans: []span{
			{text: fmt.Sprintf("Chapter %d", n), size: 24, box: Rect{54, 48, 160, 24}},
			{text: "Running book header", size: 9, box: Rect{54, 12, 150, 9}},
			{text: strings.Repeat("Body words ", 30), size: 11, box: Rect{54, 120, 400, 11}},
			{text: fmt.Sprintf("Page %d", n), size: 9, box: Rect{280, 765, 50, 9}},
		}})
	}
	cleanMargins(pages)
	for _, p := range pages {
		if len(p.spans) != 2 || !strings.HasPrefix(p.spans[0].text, "Chapter") {
			t.Fatal("lost a chapter title or kept running furniture")
		}
	}
}

func TestInlineImagePreservesFollowingText(t *testing.T) {
	content := "q 30 0 0 30 54 600 cm BI /W 1 /H 1 /BPC 8 /CS /RGB ID \xff\x00\x00 EI Q BT /F1 12 Tf 54 550 Td (After the image) Tj ET"
	d, e := Extract(simplePDF(content), Options{})
	if e != nil {
		t.Fatal(e)
	}
	if d.Stats.Images != 1 || !strings.Contains(d.Markdown, "After the image") {
		t.Fatalf("%+v %s", d.Stats, d.Markdown)
	}
}
func FuzzExtract(f *testing.F) {
	f.Add(simplePDF("BT /F1 12 Tf 54 700 Td (Hi) Tj ET"))
	f.Add([]byte("%PDF-1.7\nstartxref\n0\n%%EOF"))
	if b, e := os.ReadFile("testdata/reading.pdf"); e == nil {
		f.Add(b)
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		if len(b) > 1<<20 {
			t.Skip()
		}
		d, e := Extract(b, Options{Limits: Limits{InputBytes: 1 << 20, DecodedBytes: 2 << 20, Objects: 1000, Pages: 20, Operations: 20000, Spans: 10000, ImagePixels: 100000}})
		if e == nil {
			if _, e = json.Marshal(d); e != nil {
				t.Fatal(e)
			}
		}
	})
}

func TestTextMatrixScaleAndExpansionLimits(t *testing.T) {
	d, err := Extract(simplePDF("BT /F1 1 Tf 24 0 0 24 54 700 Tm (Chapter One) Tj /F1 12 Tf 1 0 0 1 54 650 Tm (A longer body paragraph establishes the normal reading size.) Tj ET"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if d.Pages[0].Blocks[0].Kind != "heading" {
		t.Fatalf("scaled heading: %+v", d.Pages[0].Blocks)
	}
	_, err = Extract(simplePDF(strings.Repeat("100000000 0 0 100000000 0 0 cm ", 8)), Options{})
	if !errors.Is(err, ErrLimit) {
		t.Fatalf("unbounded graphics transform: %v", err)
	}
	_, _, err = parseCMap([]byte("2 beginbfrange <0000> <FFFF> <0041> <0000> <FFFF> <0041> endbfrange"))
	if !errors.Is(err, ErrLimit) {
		t.Fatalf("overlapping CMap ranges: %v", err)
	}
}

func TestInlineImageDecodeFailureKeepsFollowingText(t *testing.T) {
	content := "BI /W 1 /H 1 /BPC 8 /CS /Unsupported ID x EI BT /F1 12 Tf 54 700 Td (Text after unsupported image) Tj ET"
	d, err := Extract(simplePDF(content), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if d.Complete || !strings.Contains(d.Markdown, "Text after unsupported image") {
		t.Fatalf("lost following content: %+v", d)
	}
}
func BenchmarkExtract(b *testing.B) {
	data, e := os.ReadFile("testdata/reading.pdf")
	if e != nil {
		b.Fatal(e)
	}
	b.SetBytes(int64(len(data)))
	b.ReportAllocs()
	for b.Loop() {
		if _, e := Extract(data, Options{}); e != nil {
			b.Fatal(e)
		}
	}
}
