// Command parity compares the Go engine with the TypeScript reference on the
// eval corpus dumped by `bun scripts/parity-dump.ts` (packages/truffle):
//
//	go run ./tools/parity engine     # Go ExtractTree on the jsdom trees vs TS: parser excluded
//	go run ./tools/parity pipeline   # Go ExtractHTML on the raw HTML vs TS on jsdom
//
// Flags: -ids key,key selects pages, -out dir writes the Go outputs and a
// unified-style first difference per page, -markdown=false leaves the
// Markdown field out of both sides.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	truffle "github.com/vkpdeveloper/thereader/packages/truffle_go"
)

type page struct {
	Key   string  `json:"key"`
	URL   string  `json:"url"`
	Bytes int     `json:"bytes"`
	TsMs  float64 `json:"tsMs"`
}

func main() {
	dir := flag.String("dir", "", "parity dump directory (default: <repo>/test-corpus/parity)")
	ids := flag.String("ids", "", "comma-separated page keys")
	out := flag.String("out", "", "directory for Go outputs and diffs")
	markdown := flag.Bool("markdown", true, "compare article.markdown too")
	flag.Parse()
	mode := flag.Arg(0)
	if mode != "engine" && mode != "pipeline" {
		fmt.Fprintln(os.Stderr, "usage: parity [flags] engine|pipeline")
		os.Exit(2)
	}
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
	if *ids != "" {
		want := map[string]bool{}
		for _, id := range strings.Split(*ids, ",") {
			want[id] = true
		}
		var kept []page
		for _, p := range pages {
			if want[p.Key] {
				kept = append(kept, p)
			}
		}
		pages = kept
	}
	if *out != "" {
		os.MkdirAll(*out, 0o755)
	}
	same, differ, failed := 0, 0, 0
	var differing []string
	start := time.Now()
	for _, p := range pages {
		expected, err := os.ReadFile(filepath.Join(*dir, "ts", p.Key+".json"))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		var article *truffle.Article
		func() {
			defer func() {
				if r := recover(); r != nil {
					fmt.Printf("PANIC %s: %v\n", p.Key, r)
					failed++
				}
			}()
			opts := truffle.Options{URL: p.URL, Markdown: *markdown}
			if mode == "engine" {
				vdoc, err := os.ReadFile(filepath.Join(*dir, "vdoc", p.Key+".json"))
				if err != nil {
					panic(err)
				}
				doc, err := truffle.ReadDocumentJSON(vdoc)
				if err != nil {
					panic(err)
				}
				article = truffle.ExtractTree(doc, opts)
			} else {
				html, err := os.ReadFile(filepath.Join(*dir, "html", p.Key+".html"))
				if err != nil {
					panic(err)
				}
				article = truffle.ExtractHTML(string(html), opts)
			}
		}()
		got := []byte("null\n")
		if article != nil {
			got = append(article.JSON("  "), '\n')
		}
		want := expected
		if !*markdown {
			want = withoutMarkdown(expected)
		}
		if bytes.Equal(got, want) {
			same++
			continue
		}
		differ++
		differing = append(differing, p.Key)
		if *out != "" {
			os.WriteFile(filepath.Join(*out, p.Key+".go.json"), got, 0o644)
			os.WriteFile(filepath.Join(*out, p.Key+".ts.json"), want, 0o644)
			os.WriteFile(filepath.Join(*out, p.Key+".diff"), []byte(firstDifference(string(want), string(got))), 0o644)
		}
	}
	sort.Strings(differing)
	for _, k := range differing {
		fmt.Println("DIFF", k)
	}
	fmt.Printf("%s: %d/%d identical, %d differ, %d failed (%.1fs)\n", mode, same, len(pages), differ, failed, time.Since(start).Seconds())
}

// withoutMarkdown drops the article's markdown key (the TS dump always has it).
func withoutMarkdown(data []byte) []byte {
	a, err := truffle.ParseArticleJSON(data)
	if err != nil || a == nil {
		return data
	}
	a.Markdown = nil
	return append(a.JSON("  "), '\n')
}

// firstDifference shows the lines around the first line that differs.
func firstDifference(want, got string) string {
	w := strings.Split(want, "\n")
	g := strings.Split(got, "\n")
	i := 0
	for i < len(w) && i < len(g) && w[i] == g[i] {
		i++
	}
	from := max(0, i-6)
	var b strings.Builder
	fmt.Fprintf(&b, "first difference at line %d\n", i+1)
	for k := from; k < i; k++ {
		fmt.Fprintf(&b, "  %s\n", w[k])
	}
	for k := i; k < min(len(w), i+8); k++ {
		fmt.Fprintf(&b, "- %s\n", w[k])
	}
	for k := i; k < min(len(g), i+8); k++ {
		fmt.Fprintf(&b, "+ %s\n", g[k])
	}
	return b.String()
}
