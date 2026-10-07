// Command evalcli is the `ours-go` engine of the eval harness
// (eval/scripts/eval.ts): it runs the Go port over a batch of pages in one
// process and times parse and extraction separately, exactly as the Dart
// port's tool/eval_cli.dart does. The harness summarizes the returned
// articles as it does the TypeScript engine's.
//
//	evalcli <manifest.json> <out.json> [--runs 5] [--slow-ms 5000]
//
// The manifest is [{id, path, url}] (decoded HTML files). Per page: one
// warm-up run whose article is returned, then --runs timed runs; a warm-up
// slower than --slow-ms becomes the only timing sample. As for the Chromium
// engines, a page without <base href> gets one with its URL.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"runtime"
	"time"

	truffle "github.com/vkpdeveloper/thereader/packages/truffle_go"
)

type entry struct {
	ID   string `json:"id"`
	Path string `json:"path"`
	URL  string `json:"url"`
}

type result struct {
	OK        bool            `json:"ok"`
	Error     string          `json:"error,omitempty"`
	Article   json.RawMessage `json:"article,omitempty"`
	ParseMs   []float64       `json:"parseMs"`
	ExtractMs []float64       `json:"extractMs"`
}

func main() {
	runs := flag.Int("runs", 5, "timed runs per page")
	slowMs := flag.Float64("slow-ms", 5000, "a warm-up slower than this is the only sample")
	flag.Parse()
	if flag.NArg() < 2 {
		fmt.Fprintln(os.Stderr, "usage: evalcli <manifest.json> <out.json> [--runs 5] [--slow-ms 5000]")
		os.Exit(64)
	}
	data, err := os.ReadFile(flag.Arg(0))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var manifest []entry
	if err := json.Unmarshal(data, &manifest); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	results := map[string]*result{}
	for _, e := range manifest {
		results[e.ID] = run(e, *runs, *slowMs)
	}
	out, _ := json.Marshal(map[string]any{
		"version": runtime.Version(),
		"mode":    "native",
		"results": results,
	})
	if err := os.WriteFile(flag.Arg(1), out, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// parser reuses one page's memory for the next.
var parser truffle.Parser

func run(e entry, runs int, slowMs float64) (res *result) {
	res = &result{ParseMs: []float64{}, ExtractMs: []float64{}}
	defer func() {
		if r := recover(); r != nil {
			res = &result{OK: false, Error: fmt.Sprint(r), ParseMs: []float64{}, ExtractMs: []float64{}}
		}
	}()
	raw, err := os.ReadFile(e.Path)
	if err != nil {
		return &result{OK: false, Error: err.Error(), ParseMs: []float64{}, ExtractMs: []float64{}}
	}
	html := string(raw)
	for i := 0; i <= runs; i++ {
		t0 := time.Now()
		doc := parser.ParseDocument(html)
		if doc.BaseHref == nil {
			url := e.URL
			doc.BaseHref = &url
		}
		t1 := time.Now()
		article := truffle.ExtractTree(doc, truffle.Options{URL: e.URL})
		t2 := time.Now()
		if i == 0 {
			if article == nil {
				res.Article = json.RawMessage("null")
			} else {
				res.Article = article.JSON("")
			}
		}
		slow := float64(t2.Sub(t0).Microseconds())/1000 > slowMs
		if i > 0 || slow {
			res.ParseMs = append(res.ParseMs, float64(t1.Sub(t0).Nanoseconds())/1e6)
			res.ExtractMs = append(res.ExtractMs, float64(t2.Sub(t1).Nanoseconds())/1e6)
		}
		if slow {
			break
		}
	}
	res.OK = true
	return res
}
