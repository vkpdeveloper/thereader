// Command bench measures the Go port over the eval corpus
// (test-corpus/parity/, written by packages/truffle/scripts/parity-dump.ts):
// time and memory of every phase of the pipeline, per page.
//
//	go run ./tools/bench [-runs 11] [-ids key,key] [-json out.json]
//
// Per page: one warm-up run, then -runs timed runs; each phase is the median
// of its runs: parse (ParseHTML), tree (FromTree: the Document the engine
// runs on), extract (ExtractTree) and markdown (ArticleMarkdown). Total is
// the whole pipeline, HTML to article and Markdown. Memory is measured on a
// separate run with the garbage collector paused, so every byte the pipeline
// allocates for the page is counted: the heap a page needs.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sort"
	"strings"
	"syscall"
	"time"

	truffle "github.com/vkpdeveloper/thereader/packages/truffle_go"
)

type page struct {
	Key   string `json:"key"`
	URL   string `json:"url"`
	Bytes int    `json:"bytes"`
}

// Row is one page's result.
type Row struct {
	Key        string  `json:"key"`
	Bytes      int     `json:"bytes"`
	ParseMs    float64 `json:"parseMs"`
	TreeMs     float64 `json:"treeMs"`
	ExtractMs  float64 `json:"extractMs"`
	MarkdownMs float64 `json:"markdownMs"`
	TotalMs    float64 `json:"totalMs"`
	AllocBytes uint64  `json:"allocBytes"`
	Allocs     uint64  `json:"allocs"`
	Article    bool    `json:"article"`
}

func main() {
	dir := flag.String("dir", "", "parity dump directory (default: <repo>/test-corpus/parity)")
	runs := flag.Int("runs", 11, "timed runs per page")
	ids := flag.String("ids", "", "comma-separated page keys")
	jsonOut := flag.String("json", "", "write per-page rows and the environment as JSON")
	flag.Parse()
	if *dir == "" {
		wd, _ := os.Getwd()
		for d := wd; d != "/"; d = filepath.Dir(d) {
			if _, err := os.Stat(filepath.Join(d, "test-corpus", "parity", "manifest.json")); err == nil {
				*dir = filepath.Join(d, "test-corpus", "parity")
				break
			}
		}
	}
	data, err := os.ReadFile(filepath.Join(*dir, "manifest.json"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var pages []page
	if err := json.Unmarshal(data, &pages); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	want := map[string]bool{}
	for _, id := range strings.Split(*ids, ",") {
		if id != "" {
			want[id] = true
		}
	}

	var rows []Row
	for _, p := range pages {
		if len(want) > 0 && !want[p.Key] {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(*dir, "html", p.Key+".html"))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		rows = append(rows, measure(p, string(raw), *runs))
	}

	var usage syscall.Rusage
	syscall.Getrusage(syscall.RUSAGE_SELF, &usage)
	maxRSS := usage.Maxrss * 1024 // kilobytes on Linux

	if *jsonOut != "" {
		out, _ := json.MarshalIndent(map[string]any{
			"engine":     "go",
			"version":    runtime.Version(),
			"cpu":        cpuModel(),
			"cores":      runtime.NumCPU(),
			"runs":       *runs,
			"maxRss":     maxRSS,
			"rows":       rows,
			"ranAt":      time.Now().UTC().Format(time.RFC3339),
			"gomaxprocs": runtime.GOMAXPROCS(0),
		}, "", " ")
		if err := os.WriteFile(*jsonOut, out, 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	report(rows, *runs, maxRSS)
}

// parser reuses one tree's memory for the next, as ExtractHTML and a batch would.
var parser truffle.Parser

func measure(p page, html string, runs int) Row {
	opts := truffle.Options{URL: p.URL}
	var parse, tree, extract, markdown, total []float64
	var article *truffle.Article
	for r := 0; r <= runs; r++ {
		t0 := time.Now()
		dom := parser.ParseHTML(html)
		t1 := time.Now()
		doc := truffle.FromTree(dom)
		t2 := time.Now()
		article = truffle.ExtractTree(doc, opts)
		t3 := time.Now()
		if article != nil {
			truffle.ArticleMarkdown(article)
		}
		t4 := time.Now()
		if r == 0 {
			continue
		}
		parse = append(parse, ms(t1.Sub(t0)))
		tree = append(tree, ms(t2.Sub(t1)))
		extract = append(extract, ms(t3.Sub(t2)))
		markdown = append(markdown, ms(t4.Sub(t3)))
		total = append(total, ms(t4.Sub(t0)))
	}

	// Memory: everything one page allocates, the garbage collector paused.
	runtime.GC()
	old := debug.SetGCPercent(-1)
	var m0, m1 runtime.MemStats
	runtime.ReadMemStats(&m0)
	// A fresh parse: what one page needs (the timed runs reuse the tree memory).
	a := truffle.ExtractTree(truffle.FromTree(truffle.ParseHTML(html)), truffle.Options{URL: p.URL, Markdown: true})
	runtime.ReadMemStats(&m1)
	runtime.KeepAlive(a)
	debug.SetGCPercent(old)

	return Row{
		Key:        p.Key,
		Bytes:      len(html),
		ParseMs:    median(parse),
		TreeMs:     median(tree),
		ExtractMs:  median(extract),
		MarkdownMs: median(markdown),
		TotalMs:    median(total),
		AllocBytes: m1.TotalAlloc - m0.TotalAlloc,
		Allocs:     m1.Mallocs - m0.Mallocs,
		Article:    article != nil,
	}
}

func ms(d time.Duration) float64 { return float64(d.Nanoseconds()) / 1e6 }

func median(v []float64) float64 {
	if len(v) == 0 {
		return 0
	}
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

func percentile(v []float64, q float64) float64 {
	if len(v) == 0 {
		return 0
	}
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	i := int(q*float64(len(s))+0.999999) - 1
	return s[max(0, min(i, len(s)-1))]
}

func mean(v []float64) float64 {
	sum := 0.0
	for _, x := range v {
		sum += x
	}
	return sum / float64(len(v))
}

func column(rows []Row, f func(Row) float64) []float64 {
	out := make([]float64, len(rows))
	for i, r := range rows {
		out[i] = f(r)
	}
	return out
}

func report(rows []Row, runs int, maxRSS int64) {
	fmt.Printf("Go %s, %s x%d, %d pages, %d timed runs per page\n\n", runtime.Version(), cpuModel(), runtime.NumCPU(), len(rows), runs)
	fmt.Println("| ms per page | median | p90 | p95 | mean | max |")
	fmt.Println("| --- | ---: | ---: | ---: | ---: | ---: |")
	line := func(label string, v []float64) {
		fmt.Printf("| %s | %.3f | %.3f | %.3f | %.3f | %.3f |\n", label, median(v), percentile(v, 0.9), percentile(v, 0.95), mean(v), percentile(v, 1))
	}
	line("parse (ParseHTML)", column(rows, func(r Row) float64 { return r.ParseMs }))
	line("tree (FromTree)", column(rows, func(r Row) float64 { return r.TreeMs }))
	line("extract (ExtractTree)", column(rows, func(r Row) float64 { return r.ExtractMs }))
	line("markdown (ArticleMarkdown)", column(rows, func(r Row) float64 { return r.MarkdownMs }))
	line("total", column(rows, func(r Row) float64 { return r.TotalMs }))
	mb := column(rows, func(r Row) float64 { return float64(r.AllocBytes) / (1 << 20) })
	fmt.Printf("\n| heap allocated per page (MB) | %.2f | %.2f | %.2f | %.2f | %.2f |\n", median(mb), percentile(mb, 0.9), percentile(mb, 0.95), mean(mb), percentile(mb, 1))
	under1 := 0
	under5 := 0
	for _, r := range rows {
		if r.TotalMs < 1 {
			under1++
		}
		if r.AllocBytes < 5<<20 {
			under5++
		}
	}
	fmt.Printf("\npages under 1 ms total: %d/%d; under 5 MB allocated: %d/%d; process max RSS %.1f MB\n", under1, len(rows), under5, len(rows), float64(maxRSS)/(1<<20))
}

func cpuModel() string {
	data, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		return runtime.GOARCH
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "model name") {
			if _, v, ok := strings.Cut(line, ":"); ok {
				return strings.TrimSpace(v)
			}
		}
	}
	return runtime.GOARCH
}
