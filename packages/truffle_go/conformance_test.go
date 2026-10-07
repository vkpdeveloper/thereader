package truffle

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The conformance fixtures shared with the TypeScript and Dart engines
// (packages/truffle/fixtures): each page, parsed with this package's HTML
// parser and extracted with its manifest URL, must reproduce
// expected/<name>.json byte for byte (2-space JSON, as JSON.stringify writes
// it), and with Markdown on, expected/<name>.md.

const fixtures = "../truffle/fixtures/"

func fixtureManifest(t *testing.T) map[string]string {
	t.Helper()
	data, err := os.ReadFile(fixtures + "manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]string
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	return manifest
}

func TestEveryFixtureHasAManifestEntry(t *testing.T) {
	manifest := fixtureManifest(t)
	files, _ := filepath.Glob(fixtures + "pages/*.html")
	var pages, names []string
	for _, f := range files {
		pages = append(pages, strings.TrimSuffix(filepath.Base(f), ".html"))
	}
	for name := range manifest {
		names = append(names, name)
	}
	sort.Strings(pages)
	sort.Strings(names)
	if strings.Join(pages, ",") != strings.Join(names, ",") {
		t.Fatalf("pages %v, manifest %v", pages, names)
	}
}

func TestConformance(t *testing.T) {
	for name, url := range fixtureManifest(t) {
		t.Run(name, func(t *testing.T) {
			html, err := os.ReadFile(fixtures + "pages/" + name + ".html")
			if err != nil {
				t.Fatal(err)
			}
			want, err := os.ReadFile(fixtures + "expected/" + name + ".json")
			if err != nil {
				t.Fatal(err)
			}
			got := []byte("null\n")
			if a := ExtractHTML(string(html), Options{URL: url}); a != nil {
				got = append(a.JSON("  "), '\n')
			}
			if string(got) != string(want) {
				t.Errorf("JSON differs from expected/%s.json\n%s", name, firstLineDiff(string(want), string(got)))
			}
		})
	}
}

func TestConformanceMarkdown(t *testing.T) {
	for name, url := range fixtureManifest(t) {
		t.Run(name, func(t *testing.T) {
			html, err := os.ReadFile(fixtures + "pages/" + name + ".html")
			if err != nil {
				t.Fatal(err)
			}
			plain := ExtractHTML(string(html), Options{URL: url})
			article := ExtractHTML(string(html), Options{URL: url, Markdown: true})
			if plain == nil || article == nil {
				if plain != article {
					t.Fatal("markdown option changed whether there is an article")
				}
				return
			}
			if plain.Markdown != nil {
				t.Fatal("markdown present without the option")
			}
			md := *article.Markdown
			article.Markdown = nil
			// The option adds the field and changes nothing else.
			if string(article.JSON("")) != string(plain.JSON("")) {
				t.Fatal("markdown option changed the article")
			}
			want, err := os.ReadFile(fixtures + "expected/" + name + ".md")
			if err != nil {
				t.Fatal(err)
			}
			if md != string(want) {
				t.Errorf("Markdown differs from expected/%s.md\n%s", name, firstLineDiff(string(want), md))
			}
		})
	}
}

// Saved-article sync checks only the document's ends: compact JSON that
// starts with {"schema":1,"url": and ends with }.
func TestSerializationOrder(t *testing.T) {
	for name, url := range fixtureManifest(t) {
		html, _ := os.ReadFile(fixtures + "pages/" + name + ".html")
		a := ExtractHTML(string(html), Options{URL: url})
		if a == nil {
			continue
		}
		s := string(a.JSON(""))
		if !strings.HasPrefix(s, `{"schema":1,"url":`) || !strings.HasSuffix(s, "}") {
			t.Errorf("%s: %.40s", name, s)
		}
	}
}

// The model round-trips through JSON: what any engine wrote reads back to the same bytes.
func TestModelRoundTrip(t *testing.T) {
	files, _ := filepath.Glob(fixtures + "expected/*.json")
	for _, f := range files {
		data, _ := os.ReadFile(f)
		a, err := ParseArticleJSON(data)
		if err != nil {
			t.Fatal(f, err)
		}
		if a == nil {
			continue
		}
		if got := string(a.JSON("  ")) + "\n"; got != string(data) {
			t.Errorf("%s does not round-trip\n%s", f, firstLineDiff(string(data), got))
		}
	}
}

func firstLineDiff(want, got string) string {
	w := strings.Split(want, "\n")
	g := strings.Split(got, "\n")
	i := 0
	for i < len(w) && i < len(g) && w[i] == g[i] {
		i++
	}
	var b strings.Builder
	for k := max(0, i-3); k < i; k++ {
		b.WriteString("  " + w[k] + "\n")
	}
	for k := i; k < min(len(w), i+4); k++ {
		b.WriteString("- " + w[k] + "\n")
	}
	for k := i; k < min(len(g), i+4); k++ {
		b.WriteString("+ " + g[k] + "\n")
	}
	return b.String()
}
