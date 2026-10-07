package truffle

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

// Engine speed on the jsdom trees of the parity dump (test-corpus/parity),
// parser excluded: go test -run TestEngineTimes -v (skipped without the dump).

type parityPage struct {
	Key   string `json:"key"`
	URL   string `json:"url"`
	Bytes int    `json:"bytes"`
}

func parityDir() string {
	return "../../test-corpus/parity"
}

func loadParity(t testing.TB) []parityPage {
	data, err := os.ReadFile(filepath.Join(parityDir(), "manifest.json"))
	if err != nil {
		t.Skip("no parity dump")
	}
	var pages []parityPage
	json.Unmarshal(data, &pages)
	return pages
}

func TestEngineTimes(t *testing.T) {
	if os.Getenv("TRUFFLE_ENGINE_TIMES") == "" {
		t.Skip("set TRUFFLE_ENGINE_TIMES=1")
	}
	pages := loadParity(t)
	var medians []float64
	type slow struct {
		key string
		ms  float64
	}
	var slowest []slow
	for _, p := range pages {
		raw, err := os.ReadFile(filepath.Join(parityDir(), "vdoc", p.Key+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var times []float64
		for r := 0; r < 6; r++ {
			doc, _ := ReadDocumentJSON(raw)
			t0 := time.Now()
			ExtractTree(doc, Options{URL: p.URL})
			if r > 0 {
				times = append(times, float64(time.Since(t0).Nanoseconds())/1e6)
			}
		}
		sort.Float64s(times)
		m := times[len(times)/2]
		medians = append(medians, m)
		slowest = append(slowest, slow{p.Key, m})
	}
	sort.Float64s(medians)
	sort.Slice(slowest, func(i, j int) bool { return slowest[i].ms > slowest[j].ms })
	sum := 0.0
	for _, m := range medians {
		sum += m
	}
	t.Logf("ExtractTree ms per page over %d pages: median %.3f p90 %.3f p95 %.3f mean %.3f max %.3f", len(medians), medians[len(medians)/2], medians[len(medians)*9/10], medians[len(medians)*95/100], sum/float64(len(medians)), medians[len(medians)-1])
	for _, s := range slowest[:10] {
		t.Logf("  %.2f ms %s", s.ms, s.key)
	}
}

func BenchmarkEngine(b *testing.B) {
	pages := loadParity(b)
	var raws [][]byte
	for _, p := range pages {
		raw, _ := os.ReadFile(filepath.Join(parityDir(), "vdoc", p.Key+".json"))
		raws = append(raws, raw)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for k, p := range pages {
			b.StopTimer()
			doc, _ := ReadDocumentJSON(raws[k])
			b.StartTimer()
			ExtractTree(doc, Options{URL: p.URL})
		}
	}
}

// BenchmarkEngineMedian: pages between 50 and 200 KB, the bulk of the corpus.
func BenchmarkEngineMedian(b *testing.B) {
	pages := loadParity(b)
	var raws [][]byte
	var urls []string
	for _, p := range pages {
		if p.Bytes < 50_000 || p.Bytes > 200_000 {
			continue
		}
		raw, _ := os.ReadFile(filepath.Join(parityDir(), "vdoc", p.Key+".json"))
		raws = append(raws, raw)
		urls = append(urls, p.URL)
	}
	docs := make([]*Document, len(raws))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		for k := range raws {
			docs[k], _ = ReadDocumentJSON(raws[k])
		}
		b.StartTimer()
		for k := range docs {
			ExtractTree(docs[k], Options{URL: urls[k]})
		}
	}
	b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N*len(docs))/1e6, "ms/page")
}

// BenchmarkPipeline: the whole pipeline on the raw HTML of every page (parse,
// tree, extraction, Markdown); -bench Pipeline/median for the 50 to 200 KB pages.
func BenchmarkPipeline(b *testing.B) {
	pages := loadParity(b)
	for _, set := range []struct {
		name     string
		min, max int
	}{{"all", 0, 1 << 30}, {"median", 50_000, 200_000}} {
		var htmls, urls []string
		for _, p := range pages {
			if p.Bytes < set.min || p.Bytes > set.max {
				continue
			}
			raw, _ := os.ReadFile(filepath.Join(parityDir(), "html", p.Key+".html"))
			htmls = append(htmls, string(raw))
			urls = append(urls, p.URL)
		}
		b.Run(set.name, func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				for k := range htmls {
					ExtractHTML(htmls[k], Options{URL: urls[k], Markdown: true})
				}
			}
			b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N*len(htmls))/1e6, "ms/page")
		})
	}
}
