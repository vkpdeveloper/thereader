package truffle

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Markdown export, against the TypeScript reference's goldens
// (packages/truffle/test/markdown.test.ts writes them): fixtures/markdown/cases.json
// holds blocksMarkdown cases, fixtures/expected/<name>.md is article.markdown for
// each conformance page, and the parity corpus holds the engine's articles with
// markdown: true.

const mdFixtures = "../truffle/fixtures/"

func TestMarkdownCases(t *testing.T) {
	data, err := os.ReadFile(mdFixtures + "markdown/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string          `json:"name"`
		Blocks   json.RawMessage `json:"blocks"`
		Markdown string          `json:"markdown"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			mdExpectBlocks(t, c.Blocks, c.Markdown)
		})
	}
}

// TestMarkdownJSSemantics holds cases where JavaScript and Go read text
// differently (UTF-16 code units, `\s`, sparse arrays); the expected Markdown
// is what the TypeScript engine writes for each.
func TestMarkdownJSSemantics(t *testing.T) {
	cases := []struct{ name, blocks, want string }{
		{"underscore beside astral letters", `[{"type":"paragraph","content":[{"type":"text","text":"𝐀_𝐀 a_b é_é"}]}]`, "𝐀\\_𝐀 a_b é_é\n"},
		{"emphasis on an astral symbol between letters", `[{"type":"paragraph","content":[{"type":"text","text":"x"},{"type":"text","text":"🙂","marks":["bold"]},{"type":"text","text":"y"}]}]`, "x🙂y\n"},
		{"U+0085 is not whitespace", `[{"type":"paragraph","content":[{"type":"text","text":"a"},{"type":"text","text":"\u0085b","marks":["italic"]}]}]`, "a*\u0085b*\n"},
		{"U+FEFF is whitespace", `[{"type":"paragraph","content":[{"type":"text","text":"a"},{"type":"text","text":"\ufeffb","marks":["bold"]}]}]`, "a\ufeff**b**\n"},
		{"ideographic spaces make no paragraph", `[{"type":"paragraph","content":[{"type":"text","text":"\u3000\u3000"}]},{"type":"paragraph","content":[{"type":"text","text":"x"}]}]`, "x\n"},
		{"bare URLs before syntax characters", `[{"type":"paragraph","content":[{"type":"text","text":"see https://ex.com/a_b* and www.x.y_z~ or (www.q.r)"}]}]`, "see <https://ex.com/a_b>\\* and www.x.y_z~ or (www.q.r)\n"},
		{"link text, autolink and destination", `[{"type":"paragraph","content":[{"type":"text","text":"https://ex.com/a","href":"https://ex.com/a"},{"type":"text","text":" and "},{"type":"text","text":" sp ace ","href":"https://ex.com/a b(c","marks":["bold"]}]}]`, "<https://ex.com/a> and  [**sp ace**](<https://ex.com/a b(c>) \n"},
		{"table spans leave holes", `[{"type":"table","headerRows":1,"rows":[{"cells":[{"content":[{"type":"text","text":"a|b"}],"colspan":2,"align":"center"},{"content":[{"type":"text","text":"c"}],"rowspan":2}]},{"cells":[{"content":[{"type":"text","text":"d"}]}]},{"cells":[{"content":[{"type":"math","tex":"x \\| y | z","text":"x"}]},{"content":[{"type":"text","text":"e"}],"colspan":3}]}]}]`, "| a\\|b |  | c |  |\n| :-: | --- | --- | --- |\n| d |  |  |  |\n| $x \\Vert y \\vert z$ | e |  |  |\n"},
		{"a note written again once a later note calls it", `[{"type":"paragraph","content":[{"type":"text","text":"Body"},{"type":"ref","id":"b","label":"2"}]},{"type":"footnotes","items":[{"id":"a","label":"1","blocks":[{"type":"paragraph","content":[{"type":"text","text":"alpha"}]}]},{"id":"b","label":"2","blocks":[{"type":"paragraph","content":[{"type":"text","text":"beta"},{"type":"ref","id":"a","label":"1"}]}]},{"id":"c","label":"x y","blocks":[{"type":"paragraph","content":[{"type":"text","text":"never called"}]}]}]}]`, "Body[^2]\n\n[^1]: alpha\n\n[^2]: beta[^1]\n\n\\[x y\\] never called\n"},
		{"lists in a row switch markers", `[{"type":"list","ordered":false,"items":[{"blocks":[{"type":"paragraph","content":[{"type":"text","text":"a"}]}]}]},{"type":"list","ordered":false,"items":[{"blocks":[{"type":"paragraph","content":[{"type":"text","text":"b"}]}]}]},{"type":"list","ordered":true,"start":9,"items":[{"blocks":[{"type":"paragraph","content":[{"type":"text","text":"c"}]}]},{"blocks":[{"type":"paragraph","content":[{"type":"text","text":"d"}]},{"type":"code","code":"x","language":null}]}]},{"type":"list","ordered":true,"items":[{"blocks":[]},{"blocks":[{"type":"rule"}],"checked":true}]}]`, "- a\n\n* b\n\n9. c\n\n10. d\n\n    ```\n    x\n    ```\n\n1)\n2) [x]\n\n   ---\n"},
		{"display math loses blank edge lines", `[{"type":"math","tex":"\n  \n x = 1 \n\n  ","text":"x=1"}]`, "$$\n x = 1\n$$\n"},
		{"line starts and a heading closing sequence", `[{"type":"heading","level":2,"content":[{"type":"text","text":"Section #"}]},{"type":"paragraph","content":[{"type":"text","text":"# no"},{"type":"break"},{"type":"text","text":"1. no"},{"type":"break"},{"type":"text","text":"+ no"},{"type":"break"},{"type":"text","text":"==="}]}]`, "## Section \\#\n\n\\# no\\\n1\\. no\\\n\\+ no\\\n\\===\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			mdExpectBlocks(t, []byte(c.blocks), c.want)
		})
	}
}

func mdExpectBlocks(t *testing.T, data []byte, want string) {
	t.Helper()
	blocks, err := ParseBlocksJSON(data)
	if err != nil {
		t.Fatal(err)
	}
	if got := BlocksMarkdown(blocks); got != want {
		t.Errorf("BlocksMarkdown differs:\n%s", mdDiff(want, got))
	}
}

func TestMarkdownConformanceFixtures(t *testing.T) {
	paths, err := filepath.Glob(mdFixtures + "expected/*.json")
	if err != nil || len(paths) == 0 {
		t.Fatalf("no expected fixtures: %v", err)
	}
	for _, path := range paths {
		name := strings.TrimSuffix(filepath.Base(path), ".json")
		t.Run(name, func(t *testing.T) {
			article := mdReadArticle(t, path)
			want, err := os.ReadFile(strings.TrimSuffix(path, ".json") + ".md")
			if err != nil {
				t.Fatal(err)
			}
			if got := ArticleMarkdown(article); got != string(want) {
				t.Errorf("ArticleMarkdown differs:\n%s", mdDiff(string(want), got))
			}
		})
	}
}

func TestMarkdownEmpty(t *testing.T) {
	if got := BlocksMarkdown(nil); got != "" {
		t.Errorf("BlocksMarkdown(nil) = %q", got)
	}
	if got := BlocksMarkdown([]Block{&Paragraph{Content: []Inline{&TextRun{Text: " "}}}}); got != "" {
		t.Errorf("blank paragraph = %q", got)
	}
	a := &Article{Blocks: []Block{&Paragraph{Content: []Inline{&TextRun{Text: "Body."}}}}}
	if got := ArticleMarkdown(a); got != "Body.\n" {
		t.Errorf("untitled article = %q", got)
	}
	if got := ArticleMarkdown(&Article{Title: "T #"}); got != "# T \\#\n" {
		t.Errorf("title only = %q", got)
	}
}

// TestMarkdownCorpus recomputes the Markdown of every article the TypeScript
// engine wrote with markdown: true (test-corpus/parity/ts, written by
// packages/truffle/scripts/parity-dump.ts).
func TestMarkdownCorpus(t *testing.T) {
	corpus := mdLoadCorpus(t)
	if corpus == nil {
		t.Skip("test-corpus/parity/ts not found (TRUFFLE_CORPUS names the test-corpus directory)")
	}
	matched := 0
	for i, a := range corpus.articles {
		if got := ArticleMarkdown(a); got == corpus.want[i] {
			matched++
		} else {
			t.Errorf("%s: ArticleMarkdown differs:\n%s", corpus.names[i], mdDiff(corpus.want[i], got))
		}
	}
	t.Logf("corpus: %d/%d byte-identical (%d pages with no article)", matched, len(corpus.articles), corpus.empty)
}

// BenchmarkArticleMarkdown renders every corpus article in turn, b.N times in
// all, each page's share in a row (as after its extraction, with the article
// in cache), and reports the median and 95th percentile of the per-page times.
func BenchmarkArticleMarkdown(b *testing.B) {
	corpus := mdLoadCorpus(b)
	if corpus == nil {
		b.Skip("test-corpus/parity/ts not found (TRUFFLE_CORPUS names the test-corpus directory)")
	}
	pages := corpus.articles
	var perPage []float64
	b.ReportAllocs()
	b.ResetTimer()
	for j, a := range pages {
		runs := b.N / len(pages)
		if j < b.N%len(pages) {
			runs++
		}
		if runs == 0 {
			continue
		}
		start := time.Now()
		for range runs {
			ArticleMarkdown(a)
		}
		perPage = append(perPage, float64(time.Since(start).Nanoseconds())/float64(runs))
	}
	b.StopTimer()
	sort.Float64s(perPage)
	b.ReportMetric(mdPercentile(perPage, 50), "median-ns/page")
	b.ReportMetric(mdPercentile(perPage, 95), "p95-ns/page")
}

// TestMarkdownAllocations logs the allocations per page over the corpus (run with -v).
func TestMarkdownAllocations(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	corpus := mdLoadCorpus(t)
	if corpus == nil {
		t.Skip("test-corpus/parity/ts not found")
	}
	var allocs, bytes []float64
	for _, a := range corpus.articles {
		allocs = append(allocs, testing.AllocsPerRun(3, func() { ArticleMarkdown(a) }))
		var before, after runtime.MemStats
		runtime.ReadMemStats(&before)
		ArticleMarkdown(a)
		runtime.ReadMemStats(&after)
		bytes = append(bytes, float64(after.TotalAlloc-before.TotalAlloc))
	}
	sort.Float64s(allocs)
	sort.Float64s(bytes)
	t.Logf("allocs/page: median %.0f, p95 %.0f, max %.0f; bytes/page: median %.0f, p95 %.0f, max %.0f",
		mdPercentile(allocs, 50), mdPercentile(allocs, 95), allocs[len(allocs)-1],
		mdPercentile(bytes, 50), mdPercentile(bytes, 95), bytes[len(bytes)-1])
}

func mdPercentile(sorted []float64, p int) float64 {
	if len(sorted) == 0 {
		return 0
	}
	return sorted[min(len(sorted)-1, len(sorted)*p/100)]
}

// mdCorpus is the parity corpus read once: the TypeScript articles without
// their markdown field, and that field as the expected output.
type mdCorpus struct {
	articles []*Article
	names    []string
	want     []string
	empty    int // pages with no article (`null`)
}

var (
	mdCorpusOnce   sync.Once
	mdCorpusCached *mdCorpus
	mdCorpusErr    error
)

// mdLoadCorpus reads test-corpus/parity/ts/*.json (nil when absent), found by
// walking up from the package directory; TRUFFLE_CORPUS overrides the
// test-corpus directory.
func mdLoadCorpus(tb testing.TB) *mdCorpus {
	tb.Helper()
	mdCorpusOnce.Do(func() {
		dir := mdFindCorpus()
		if dir == "" {
			return
		}
		paths, err := filepath.Glob(filepath.Join(dir, "parity", "ts", "*.json"))
		if err != nil || len(paths) == 0 {
			return
		}
		sort.Strings(paths)
		c := &mdCorpus{}
		for _, path := range paths {
			data, err := os.ReadFile(path)
			if err != nil {
				mdCorpusErr = err
				return
			}
			a, err := ParseArticleJSON(data)
			if err != nil {
				mdCorpusErr = err
				return
			}
			if a == nil {
				c.empty++
				continue
			}
			name := strings.TrimSuffix(filepath.Base(path), ".json")
			if a.Markdown == nil {
				mdCorpusErr = &os.PathError{Op: "read markdown field", Path: path, Err: os.ErrNotExist}
				return
			}
			c.want = append(c.want, *a.Markdown)
			a.Markdown = nil // recomputed, never read back
			c.articles = append(c.articles, a)
			c.names = append(c.names, name)
		}
		mdCorpusCached = c
	})
	if mdCorpusErr != nil {
		tb.Fatal(mdCorpusErr)
	}
	return mdCorpusCached
}

func mdFindCorpus() string {
	if dir := os.Getenv("TRUFFLE_CORPUS"); dir != "" {
		return dir
	}
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	for {
		candidate := filepath.Join(dir, "test-corpus")
		if info, err := os.Stat(filepath.Join(candidate, "parity", "ts")); err == nil && info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func mdReadArticle(tb testing.TB, path string) *Article {
	tb.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		tb.Fatal(err)
	}
	a, err := ParseArticleJSON(data)
	if err != nil {
		tb.Fatalf("%s: %v", path, err)
	}
	return a
}

// mdDiff shows the first differing line of two outputs.
func mdDiff(want, got string) string {
	w := strings.Split(want, "\n")
	g := strings.Split(got, "\n")
	for i := 0; i < len(w) || i < len(g); i++ {
		var wl, gl string
		if i < len(w) {
			wl = w[i]
		}
		if i < len(g) {
			gl = g[i]
		}
		if wl != gl || i >= len(w) || i >= len(g) {
			return "line " + strconv.Itoa(i+1) + ":\n  want " + mdDiffLine(wl, i < len(w)) + "\n  got  " + mdDiffLine(gl, i < len(g))
		}
	}
	return "(no line differs)"
}

func mdDiffLine(line string, present bool) string {
	if !present {
		return "(end)"
	}
	return strconv.Quote(line)
}
