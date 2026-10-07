package truffle

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	xhtml "golang.org/x/net/html"
)

// The parser is checked against golang.org/x/net/html (scripting disabled):
// both trees are written in one canonical text form — element names and
// namespaces, attributes in source order, text node boundaries and data,
// comments, doctypes — and must be identical on the parity corpus and the
// fixture pages. The html5lib tree-construction tests run when
// HTML5LIB_TESTS names their directory (git clone
// https://github.com/html5lib/html5lib-tests, at 9329e64 or before, when the
// tests moved to WPT; then HTML5LIB_TESTS=.../tree-construction).

// corpusDir holds the parity corpus pages: test-corpus/parity/html at the
// repository root (gitignored), or under $TRUFFLE_CORPUS when set.
var corpusDir = func() string {
	if root := os.Getenv("TRUFFLE_CORPUS"); root != "" {
		return filepath.Join(root, "parity", "html")
	}
	return "../../test-corpus/parity/html"
}()

// corpusPages returns the parity corpus and fixture pages, by name.
func corpusPages(t testing.TB) (names, pages []string) {
	for _, pattern := range []string{corpusDir + "/*.html", "../truffle/fixtures/pages/*.html"} {
		files, _ := filepath.Glob(pattern)
		for _, f := range files {
			b, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			names = append(names, f)
			pages = append(pages, string(b))
		}
	}
	return names, pages
}

// ------------------------------------------------------------------ canonical form

// x/net departs from the standard (and parse5, Chromium) in two ways the
// corpus shows: it decodes character references inside comments, and it
// turns "</>" into an empty comment, which splits the text around it. With
// xnetBugs set, the canonical forms neutralize exactly that: our comment
// data goes through x/net's own decoder, and on both sides empty comments
// are dropped and the texts they separated joined.
type canonOptions struct{ xnetBugs bool }

// canonItem is one node of the canonical form, before printing.
type canonItem struct {
	kind  NodeKind
	head  string // element or doctype line
	text  string // text or comment data
	kids  []canonItem
	clean bool // parent links are consistent
}

func canonNode(n *Node, o canonOptions) canonItem {
	it := canonItem{kind: n.Kind, text: n.text, clean: true}
	switch n.Kind {
	case ElementNode:
		var b strings.Builder
		b.WriteString("<" + nsName(n.ns) + n.Tag + ">")
		for _, a := range n.Attrs {
			fmt.Fprintf(&b, " %s=%q", a.Name, a.Value)
		}
		it.head = b.String()
	case CommentNode:
		if o.xnetBugs {
			it.text = xhtml.UnescapeString(n.text)
		}
	case DoctypeNode:
		var b strings.Builder
		fmt.Fprintf(&b, "<!DOCTYPE %q", n.text)
		for _, a := range n.Attrs {
			fmt.Fprintf(&b, " %s=%q", a.Name, a.Value)
		}
		b.WriteString(">")
		it.head = b.String()
	}
	for _, c := range n.Children {
		if c.Parent != n {
			it.clean = false
		}
		it.kids = append(it.kids, canonNode(c, o))
	}
	it.kids = normalizeKids(it.kids, o)
	return it
}

// canonNodeX builds x/net's canonical form. x/net keeps duplicate
// attributes, which the DOM drops (first wins): they are dropped here too.
func canonNodeX(n *xhtml.Node, o canonOptions) canonItem {
	it := canonItem{text: n.Data, clean: true}
	switch n.Type {
	case xhtml.ElementNode:
		it.kind = ElementNode
		ns := ""
		if n.Namespace != "" {
			ns = n.Namespace + " "
		}
		var b strings.Builder
		b.WriteString("<" + ns + n.Data + ">")
		seen := map[string]bool{}
		for _, a := range n.Attr {
			name := a.Key
			if a.Namespace != "" {
				name = a.Namespace + ":" + a.Key
			}
			if seen[name] {
				continue
			}
			seen[name] = true
			fmt.Fprintf(&b, " %s=%q", name, a.Val)
		}
		it.head = b.String()
	case xhtml.TextNode:
		it.kind = TextNode
	case xhtml.CommentNode:
		it.kind = CommentNode
	case xhtml.DoctypeNode:
		it.kind = DoctypeNode
		var b strings.Builder
		fmt.Fprintf(&b, "<!DOCTYPE %q", n.Data)
		for _, a := range n.Attr {
			fmt.Fprintf(&b, " %s=%q", a.Key, a.Val)
		}
		b.WriteString(">")
		it.head = b.String()
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		it.kids = append(it.kids, canonNodeX(c, o))
	}
	it.kids = normalizeKids(it.kids, o)
	return it
}

func normalizeKids(kids []canonItem, o canonOptions) []canonItem {
	if !o.xnetBugs {
		return kids
	}
	out := kids[:0]
	for _, k := range kids {
		if k.kind == CommentNode && k.text == "" {
			continue
		}
		if k.kind == TextNode && len(out) > 0 && out[len(out)-1].kind == TextNode {
			out[len(out)-1].text += k.text
			continue
		}
		out = append(out, k)
	}
	return out
}

func writeCanonItem(b *strings.Builder, it canonItem, depth int) {
	b.WriteString(strings.Repeat("  ", depth))
	switch it.kind {
	case ElementNode, DoctypeNode:
		b.WriteString(it.head)
	case TextNode:
		fmt.Fprintf(b, "%q", it.text)
	case CommentNode:
		fmt.Fprintf(b, "<!-- %q -->", it.text)
	}
	if !it.clean {
		b.WriteString(" BROKEN PARENT LINK")
	}
	b.WriteString("\n")
	for _, k := range it.kids {
		writeCanonItem(b, k, depth+1)
	}
}

func nsName(ns uint8) string {
	switch ns {
	case nsSVG:
		return "svg "
	case nsMathML:
		return "math "
	}
	return ""
}

// canonical writes a parsed document in the canonical form.
func canonical(doc *Node, o canonOptions) string {
	var b strings.Builder
	for _, k := range canonNode(doc, o).kids {
		writeCanonItem(&b, k, 0)
	}
	return b.String()
}

func canonicalX(doc *xhtml.Node, o canonOptions) string {
	var b strings.Builder
	for _, k := range canonNodeX(doc, o).kids {
		writeCanonItem(&b, k, 0)
	}
	return b.String()
}

func parseXNet(src string) (*xhtml.Node, error) {
	return xhtml.ParseWithOptions(strings.NewReader(src), xhtml.ParseOptionEnableScripting(false))
}

// firstDiff shows where two canonical forms part.
func firstDiff(got, want string) string {
	g, w := strings.Split(got, "\n"), strings.Split(want, "\n")
	for i := 0; i < len(g) || i < len(w); i++ {
		var gl, wl string
		if i < len(g) {
			gl = g[i]
		}
		if i < len(w) {
			wl = w[i]
		}
		if gl != wl {
			lo := max(0, i-3)
			return fmt.Sprintf("line %d\n  context: %s\n  got:  %.300s\n  want: %.300s",
				i+1, strings.Join(w[lo:i], "\n           "), gl, wl)
		}
	}
	return ""
}

// ------------------------------------------------------------------ x/net parity

func TestHTMLMatchesXNet(t *testing.T) {
	names, pages := corpusPages(t)
	if len(pages) == 0 {
		t.Skip("no corpus pages")
	}
	exact, same, corpus, corpusSame := 0, 0, 0, 0
	for i, src := range pages {
		inCorpus := strings.HasPrefix(names[i], corpusDir)
		if inCorpus {
			corpus++
		}
		want, err := parseXNet(src)
		if err != nil {
			t.Errorf("%s: x/net: %v", names[i], err)
			continue
		}
		doc := parseHTML(src)
		if canonical(doc, canonOptions{}) == canonicalX(want, canonOptions{}) {
			exact++
			same++
			if inCorpus {
				corpusSame++
			}
			continue
		}
		o := canonOptions{xnetBugs: true}
		if got, w := canonical(doc, o), canonicalX(want, o); got != w {
			t.Errorf("%s: trees differ at %s", filepath.Base(names[i]), firstDiff(got, w))
			continue
		}
		same++
		if inCorpus {
			corpusSame++
		}
		if testing.Verbose() {
			t.Logf("%s: identical once x/net's comment decoding and \"</>\" comments are set aside", filepath.Base(names[i]))
		}
	}
	t.Logf("trees identical to x/net/html on %d/%d pages: %d/%d corpus, %d/%d fixtures (%d exactly, %d once x/net's two bugs are set aside)",
		same, len(pages), corpusSame, corpus, same-corpusSame, len(pages)-corpus, exact, same-exact)
}

// ------------------------------------------------------------------ unit cases

func TestHTMLParse(t *testing.T) {
	cases := []struct{ name, src, want string }{
		{"implied structure", `x`, `<html>|  <head>|  <body>|    "x"`},
		{"entities and CRLF", "<p title=\"a&amp;b &copy &notit;\">&amp; &nbsp;&#x1F600; &notin; &notit; &copy 2024 &#0; &#x110000;\r\nz\r</p>",
			`<html>|  <head>|  <body>|    <p> title="a&b © &notit;"|      "& \u00a0😀 ∉ ¬it; © 2024 � �\nz\n"`},
		{"numeric reference at the end of a text", `<p>&#9</p>`, `<html>|  <head>|  <body>|    <p>|      "\t"`},
		{"two-code-point entities", `&nLt;&NotEqualTilde;`, `<html>|  <head>|  <body>|    "≪⃒≂̸"`},
		{"legacy reference before = in attribute", `<a href="?a=1&copy=2&amp=3&ampx">`, `<html>|  <head>|  <body>|    <a> href="?a=1&copy=2&amp=3&ampx"`},
		{"duplicate attributes", `<div a=1 A=2 b=3 a=4>`, `<html>|  <head>|  <body>|    <div> a="1" b="3"`},
		{"case and foreign names", `<DIV CLASS=X><svg VIEWBOX="0 0 1 1" xlink:href=u><clippath/><foreignobject><p>x</svg><math definitionurl=d>`,
			`<html>|  <head>|  <body>|    <div> class="X"|      <svg svg> viewBox="0 0 1 1" xlink:href="u"|        <svg clipPath>|        <svg foreignObject>|          <p>|            "x"|            <math math> definitionURL="d"`},
		{"empty end tag", `a</>b`, `<html>|  <head>|  <body>|    "ab"`},
		{"comment splits text", `<p>a<!--x-->b`, `<html>|  <head>|  <body>|    <p>|      "a"|      <!-- "x" -->|      "b"`},
		{"ignored tag merges text", `<p>a</span>b`, `<html>|  <head>|  <body>|    <p>|      "ab"`},
		{"head noscript", "<head><noscript>  Enable <a href=/x>JS</a></noscript><meta name=d>",
			`<html>|  <head>|    <noscript>|      "  "|  <body>|    "Enable "|    <a> href="/x"|      "JS"|    <meta> name="d"`},
		{"body noscript is markup", `<p>a<noscript><div>n</div></noscript>b`,
			`<html>|  <head>|  <body>|    <p>|      "a"|      <noscript>|    <div>|      "n"|    "b"`},
		{"uppercase doctype is not quirks", `<!DOCTYPE HTML><p><table>`, `<!DOCTYPE "html">|<html>|  <head>|  <body>|    <p>|    <table>`},
		{"quirks keeps table in p", `<p><table>`, `<html>|  <head>|  <body>|    <p>|      <table>`},
		{"end p leaves foreign content", `<svg><g></p>x`, `<html>|  <head>|  <body>|    <svg svg>|      <svg g>|    <p>|    "x"`},
		{"raw text", `<title>a<b>&amp;</title><script>if(a<b)</script><style><!--</style>`,
			`<html>|  <head>|    <title>|      "a<b>&"|    <script>|      "if(a<b)"|    <style>|      "<!--"|  <body>`},
		{"script escapes", `<script><!--<script></script>x--></script>y`,
			`<html>|  <head>|    <script>|      "<!--<script></script>x-->"|  <body>|    "y"`},
		{"foster parenting", `<table>a<tr><td>b</table>`, `<html>|  <head>|  <body>|    "a"|    <table>|      <tbody>|        <tr>|          <td>|            "b"`},
		{"adoption agency", `<b>1<p>2</b>3`, `<html>|  <head>|  <body>|    <b>|      "1"|    <p>|      <b>|        "2"|      "3"`},
		{"template content", `<template><td>x</template>`, `<html>|  <head>|    <template>|      <td>|        "x"|  <body>`},
		{"pre newline", "<pre>\n\nx</pre>", `<html>|  <head>|  <body>|    <pre>|      "\nx"`},
		{"eof in tag drops it", `a<div class="x`, `<html>|  <head>|  <body>|    "a"`},
		{"comments", `<!--a--!><!--><!---><!--b--`, `<!-- "a" -->|<!-- "" -->|<!-- "" -->|<!-- "b" -->|<html>|  <head>|  <body>`},
		{"nul", "a\x00b<p x\x00=\x00>\x00</p><svg>\x00</svg>", "<html>|  <head>|  <body>|    \"ab\"|    <p> x�=\"�\"|    <svg svg>|      \"�\""},
		{"cdata", `<svg><![CDATA[a<b]]>c</svg><![CDATA[d]]>`, `<html>|  <head>|  <body>|    <svg svg>|      "a<bc"|    <!-- "[CDATA[d]]" -->`},
	}
	for _, c := range cases {
		got := strings.ReplaceAll(strings.TrimSuffix(canonical(parseHTML(c.src), canonOptions{}), "\n"), "\n", "|")
		want := c.want
		if got != want {
			t.Errorf("%s: %q\n got: %s\nwant: %s", c.name, c.src, got, want)
		}
	}
}

// TestHTMLSharedText checks that texts and attribute values needing no
// decoding are substrings of the source (no copies).
func TestHTMLSharedText(t *testing.T) {
	allocs := testing.AllocsPerRun(10, func() {
		parseHTML(`<!doctype html><html><head><title>T</title></head><body><div class="a" id=b><p>Some text</p><p>More text</p></div></body></html>`)
	})
	if allocs > 8 {
		t.Errorf("%v allocations for a small page", allocs)
	}
}

// ------------------------------------------------------------------ html5lib

type html5libCase struct {
	file, data, want string
	fragment         bool
	scripting        bool
}

func readHTML5LibCases(path string) ([]html5libCase, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(string(raw), "\n")
	var cases []html5libCase
	for i := 0; i < len(lines); {
		if lines[i] != "#data" {
			i++
			continue
		}
		c := html5libCase{file: filepath.Base(path)}
		var data, doc []string
		for i++; i < len(lines) && lines[i] != "#errors"; i++ {
			data = append(data, lines[i])
		}
		for ; i < len(lines) && lines[i] != "#document"; i++ {
			switch lines[i] {
			case "#document-fragment":
				c.fragment = true
			case "#script-on":
				c.scripting = true
			}
		}
		for i++; i < len(lines) && lines[i] != "#data"; i++ {
			doc = append(doc, lines[i])
		}
		for len(doc) > 0 && doc[len(doc)-1] == "" {
			doc = doc[:len(doc)-1]
		}
		c.data = strings.Join(data, "\n")
		c.want = strings.Join(doc, "\n")
		cases = append(cases, c)
	}
	return cases, nil
}

// foreignAttrPrefix: attributes a foreign element puts in a namespace, as
// html5lib dumps them ("xlink href").
var foreignAttrPrefix = map[string]string{
	"xlink:actuate": "xlink actuate", "xlink:arcrole": "xlink arcrole", "xlink:href": "xlink href",
	"xlink:role": "xlink role", "xlink:show": "xlink show", "xlink:title": "xlink title",
	"xlink:type": "xlink type", "xml:lang": "xml lang", "xml:space": "xml space",
	"xmlns": "xmlns xmlns", "xmlns:xlink": "xmlns xlink",
}

func dumpHTML5Lib(b *strings.Builder, n *Node, depth int) {
	indent := "| " + strings.Repeat("  ", depth)
	switch n.Kind {
	case ElementNode:
		fmt.Fprintf(b, "%s<%s%s>\n", indent, nsName(n.ns), n.Tag)
		var attrs []string
		for _, a := range n.Attrs {
			name := a.Name
			if n.ns != nsHTML && foreignAttrPrefix[name] != "" {
				name = foreignAttrPrefix[name]
			}
			attrs = append(attrs, fmt.Sprintf("%s=\"%s\"", name, a.Value))
		}
		sort.Strings(attrs)
		for _, a := range attrs {
			fmt.Fprintf(b, "%s  %s\n", indent, a)
		}
		if n.ns == nsHTML && n.Tag == "template" {
			fmt.Fprintf(b, "%s  content\n", indent)
			depth++
		}
	case TextNode:
		fmt.Fprintf(b, "%s\"%s\"\n", indent, n.text)
	case CommentNode:
		fmt.Fprintf(b, "%s<!-- %s -->\n", indent, n.text)
	case DoctypeNode:
		public, _ := n.attr("public")
		system, _ := n.attr("system")
		if public != "" || system != "" {
			fmt.Fprintf(b, "%s<!DOCTYPE %s \"%s\" \"%s\">\n", indent, n.text, public, system)
		} else {
			fmt.Fprintf(b, "%s<!DOCTYPE %s>\n", indent, n.text)
		}
	}
	for _, c := range n.Children {
		dumpHTML5Lib(b, c, depth+1)
	}
}

func dumpHTML5LibX(b *strings.Builder, n *xhtml.Node, depth int) {
	indent := "| " + strings.Repeat("  ", depth)
	switch n.Type {
	case xhtml.ElementNode:
		ns := ""
		if n.Namespace != "" {
			ns = n.Namespace + " "
		}
		fmt.Fprintf(b, "%s<%s%s>\n", indent, ns, n.Data)
		var attrs []string
		seen := map[string]bool{}
		for _, a := range n.Attr {
			name := a.Key
			if a.Namespace != "" {
				name = a.Namespace + " " + a.Key
			}
			if seen[name] {
				continue
			}
			seen[name] = true
			attrs = append(attrs, fmt.Sprintf("%s=\"%s\"", name, a.Val))
		}
		sort.Strings(attrs)
		for _, a := range attrs {
			fmt.Fprintf(b, "%s  %s\n", indent, a)
		}
		if n.Namespace == "" && n.Data == "template" {
			fmt.Fprintf(b, "%s  content\n", indent)
			depth++
		}
	case xhtml.TextNode:
		fmt.Fprintf(b, "%s\"%s\"\n", indent, n.Data)
	case xhtml.CommentNode:
		fmt.Fprintf(b, "%s<!-- %s -->\n", indent, n.Data)
	case xhtml.DoctypeNode:
		var public, system string
		for _, a := range n.Attr {
			switch a.Key {
			case "public":
				public = a.Val
			case "system":
				system = a.Val
			}
		}
		if public != "" || system != "" {
			fmt.Fprintf(b, "%s<!DOCTYPE %s \"%s\" \"%s\">\n", indent, n.Data, public, system)
		} else {
			fmt.Fprintf(b, "%s<!DOCTYPE %s>\n", indent, n.Data)
		}
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		dumpHTML5LibX(b, c, depth+1)
	}
}

func TestHTML5Lib(t *testing.T) {
	dir := os.Getenv("HTML5LIB_TESTS")
	if dir == "" {
		t.Skip("HTML5LIB_TESTS is not set")
	}
	files, err := filepath.Glob(filepath.Join(dir, "*.dat"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no .dat files in %s", dir)
	}
	var total, pass, passX, skipped int
	for _, file := range files {
		cases, err := readHTML5LibCases(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range cases {
			// parseHTML parses documents with scripting disabled.
			if c.fragment || c.scripting {
				skipped++
				continue
			}
			total++
			got := func() (s string) {
				defer func() {
					if r := recover(); r != nil {
						s = fmt.Sprint("panic: ", r)
					}
				}()
				var b strings.Builder
				for _, n := range parseHTML(c.data).Children {
					dumpHTML5Lib(&b, n, 0)
				}
				return strings.TrimSuffix(b.String(), "\n")
			}()
			gotX := func() (s string) {
				defer func() {
					if r := recover(); r != nil {
						s = fmt.Sprint("panic: ", r)
					}
				}()
				doc, err := parseXNet(c.data)
				if err != nil {
					return err.Error()
				}
				var b strings.Builder
				for n := doc.FirstChild; n != nil; n = n.NextSibling {
					dumpHTML5LibX(&b, n, 0)
				}
				return strings.TrimSuffix(b.String(), "\n")
			}()
			if gotX == c.want {
				passX++
			}
			if got == c.want {
				pass++
				continue
			}
			if gotX == c.want {
				t.Errorf("%s: %q: x/net passes, parseHTML does not\n got:\n%s\nwant:\n%s", c.file, c.data, got, c.want)
			} else if testing.Verbose() {
				t.Logf("%s: %q: both fail\n got:\n%s\n x/net:\n%s\nwant:\n%s", c.file, c.data, got, gotX, c.want)
			}
		}
	}
	t.Logf("html5lib tree-construction, documents with scripting off: parseHTML %d/%d, x/net/html %d/%d (%d fragment or scripting-on cases skipped)",
		pass, total, passX, total, skipped)
}

// ------------------------------------------------------------------ benchmarks

var benchPages struct {
	once  sync.Once
	pages []string
	bytes int64
}

func loadBenchPages(b *testing.B) []string {
	benchPages.once.Do(func() {
		files, _ := filepath.Glob(corpusDir + "/*.html")
		for _, f := range files {
			data, err := os.ReadFile(f)
			if err != nil {
				b.Fatal(err)
			}
			benchPages.pages = append(benchPages.pages, string(data))
			benchPages.bytes += int64(len(data))
		}
	})
	if len(benchPages.pages) == 0 {
		b.Skip("no corpus pages")
	}
	return benchPages.pages
}

// benchCorpus parses every corpus page per iteration and reports, besides
// the totals, the median, p90, p95 and mean of the per-page mean times.
func benchCorpus(b *testing.B, parse func(string)) {
	pages := loadBenchPages(b)
	perPage := make([]time.Duration, len(pages))
	b.SetBytes(benchPages.bytes)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for k, src := range pages {
			start := time.Now()
			parse(src)
			perPage[k] += time.Since(start)
		}
	}
	b.StopTimer()
	ms := make([]float64, len(pages))
	sum := 0.0
	for k, d := range perPage {
		ms[k] = float64(d) / float64(b.N) / 1e6
		sum += ms[k]
	}
	sort.Float64s(ms)
	b.ReportMetric(ms[len(ms)/2], "median-ms/page")
	b.ReportMetric(ms[len(ms)*90/100], "p90-ms/page")
	b.ReportMetric(ms[len(ms)*95/100], "p95-ms/page")
	b.ReportMetric(sum/float64(len(ms)), "mean-ms/page")
}

func BenchmarkHTMLParse(b *testing.B) {
	benchCorpus(b, func(src string) { parseHTML(src) })
}

func BenchmarkHTMLParseXNet(b *testing.B) {
	benchCorpus(b, func(src string) {
		if _, err := parseXNet(src); err != nil {
			b.Fatal(err)
		}
	})
}
