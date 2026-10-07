package truffle

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

// The URL functions are checked against the TypeScript engine's answers
// (testdata/url/oracle.ts): committed cases (gen.ts), and the whole parity
// corpus when it and Bun are present.

// urlAnswers is what oracle.ts writes: resolve rows are [base, href,
// resolveUrl, resolveHttp, new URL(href, base).href], null where the
// TypeScript returns null or throws; url rows are [url, hostOf, canonicalUrl].
type urlAnswers struct {
	Resolve [][5]*string `json:"resolve"`
	URLs    [][3]string  `json:"urls"`
}

func readURLAnswers(t testing.TB, r io.Reader) *urlAnswers {
	t.Helper()
	var a urlAnswers
	if err := json.NewDecoder(r).Decode(&a); err != nil {
		t.Fatal(err)
	}
	return &a
}

func loadURLAnswers(t testing.TB, name string) *urlAnswers {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", "url", name))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	return readURLAnswers(t, z)
}

func urlShow(s *string) string {
	if s == nil {
		return "null"
	}
	return urlQuote(*s)
}

func urlQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func urlResult(s string, ok bool) *string {
	if !ok {
		return nil
	}
	return &s
}

func urlSame(a, b *string) bool {
	return (a == nil) == (b == nil) && (a == nil || *a == *b)
}

// checkURLAnswers compares every answer and returns the mismatches, logging
// the first few. The fast path must also agree with the full parser.
func checkURLAnswers(t *testing.T, a *urlAnswers, show int) (failed, total int) {
	t.Helper()
	report := func(format string, args ...any) {
		failed++
		if failed <= show {
			t.Errorf(format, args...)
		}
	}
	for _, row := range a.Resolve {
		base, href := *row[0], *row[1]
		total++
		if got := urlResult(resolveURL(href, base)); !urlSame(got, row[2]) {
			report("resolveURL(%s, %s) = %s, want %s", urlQuote(href), urlQuote(base), urlShow(got), urlShow(row[2]))
			continue
		}
		if got := urlResult(resolveHTTP(href, base)); !urlSame(got, row[3]) {
			report("resolveHTTP(%s, %s) = %s, want %s", urlQuote(href), urlQuote(base), urlShow(got), urlShow(row[3]))
			continue
		}
		if got := urlResult(parseURLHref(href, base)); !urlSame(got, row[4]) {
			report("parseURLHref(%s, %s) = %s, want %s", urlQuote(href), urlQuote(base), urlShow(got), urlShow(row[4]))
			continue
		}
		if e := wgCachedBase(base); e.fast != nil {
			if quick, ok := e.fast.resolve(href); ok {
				if u, ok := wgParse(href, e.url); !ok || u.href() != quick {
					report("fast path %s against %s = %s, parser disagrees", urlQuote(href), urlQuote(base), urlQuote(quick))
				}
			}
		}
	}
	for _, row := range a.URLs {
		total++
		if got := hostOf(row[0]); got != row[1] {
			report("hostOf(%s) = %s, want %s", urlQuote(row[0]), urlQuote(got), urlQuote(row[1]))
		}
		if got := CanonicalURL(row[0]); got != row[2] {
			report("CanonicalURL(%s) = %s, want %s", urlQuote(row[0]), urlQuote(got), urlQuote(row[2]))
		}
	}
	return failed, total
}

// TestURLExamples spells out a few behaviours the data-driven tests cover,
// with the answers the TypeScript engine gives under Bun.
func TestURLExamples(t *testing.T) {
	const base = "https://example.com/x/y"
	null := "\x00null"
	for _, c := range []struct {
		name string
		got  func() (string, bool)
		want string
	}{
		{"whitespace", func() (string, bool) { return resolveURL(" /a b\n", base) }, "https://example.com/a%20b"},
		{"hidden scheme", func() (string, bool) { return resolveURL("\x01javascript:alert(1)", base) }, null},
		{"split scheme", func() (string, bool) { return resolveURL("java\tscript:alert(1)", base) }, null},
		{"data as written", func() (string, bool) { return resolveURL("DATA:image/png;base64,AA", base) }, "DATA:image/png;base64,AA"},
		{"mailto", func() (string, bool) { return resolveURL("mailto:a@b.c", base) }, "mailto:a@b.c"},
		{"mailto is not http", func() (string, bool) { return resolveHTTP("mailto:a@b.c", base) }, null},
		{"scheme-relative", func() (string, bool) { return resolveURL("//player.twitch.tv/?channel=abc", base) }, "https://player.twitch.tv/?channel=abc"},
		{"dot segments", func() (string, bool) { return resolveURL("../../../a/./b/../c", base) }, "https://example.com/a/c"},
		{"non-ASCII path", func() (string, bool) { return resolveURL("/wiki/東京", base) }, "https://example.com/wiki/%E6%9D%B1%E4%BA%AC"},
		{"WebKit userinfo slash", func() (string, bool) { return parseURLHref("foo://u@h?x", base) }, "foo://u@h/?x"},
		{"IPv4 forms", func() (string, bool) { return parseURLHref("http://0x7f.1/", base) }, "http://127.0.0.1/"},
		{"IPv6", func() (string, bool) { return parseURLHref("http://[::ffff:1.2.3.4]:80/", base) }, "http://[::ffff:102:304]/"},
		{"IDNA", func() (string, bool) { return parseURLHref("http://faß.de/", base) }, "http://xn--fa-hia.de/"},
		{"caret in path", func() (string, bool) { return parseURLHref("/^", base) }, "https://example.com/%5E"},
		{"invalid base", func() (string, bool) { return parseURLHref("x", "not a url") }, null},
		{"userinfo is not the host", func() (string, bool) { return hostOf("https://evil.com:x@www.nytimes.com/story"), true }, "nytimes.com"},
		{"tracking parameters", func() (string, bool) { return CanonicalURL("https://x.com/a?utm_source=1&b=2&REF=3#f"), true }, "https://x.com/a?b=2"},
	} {
		got, ok := c.got()
		if !ok {
			got = null
		}
		if got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestURLCases(t *testing.T) {
	a := loadURLAnswers(t, "cases.json.gz")
	failed, total := checkURLAnswers(t, a, 50)
	t.Logf("%d of %d cases agree with the TypeScript engine (%d resolutions, %d URLs)", total-failed, total, len(a.Resolve), len(a.URLs))
}

// urlIDNAMismatches is how many of the web-platform-tests IDNA hosts the
// approximation of the UTS #46 tables resolves differently from Bun: 126
// need NFC beyond Hangul (a letter and a combining mark), the rest
// compatibility mappings that take tables (squared CJK, Kangxi radicals).
const urlIDNAMismatches = 133

func TestURLIDNA(t *testing.T) {
	a := loadURLAnswers(t, "idna.json.gz")
	failed := 0
	for _, row := range a.Resolve {
		base, href := *row[0], *row[1]
		if got := urlResult(parseURLHref(href, base)); !urlSame(got, row[4]) {
			failed++
			if testing.Verbose() {
				t.Logf("parseURLHref(%s) = %s, want %s", urlQuote(href), urlShow(got), urlShow(row[4]))
			}
		}
	}
	t.Logf("%d of %d IDNA hosts agree with the TypeScript engine", len(a.Resolve)-failed, len(a.Resolve))
	if failed > urlIDNAMismatches {
		t.Errorf("%d IDNA hosts disagree, more than the %d known", failed, urlIDNAMismatches)
	}
}

// urlCorpusDir is test-corpus/parity: $TRUFFLE_CORPUS/parity, or the
// repository's test-corpus. Empty when absent.
func urlCorpusDir() string {
	root := os.Getenv("TRUFFLE_CORPUS")
	if root == "" {
		root = filepath.Join("..", "..", "test-corpus")
	}
	dir := filepath.Join(root, "parity")
	if _, err := os.Stat(filepath.Join(dir, "manifest.json")); err != nil {
		return ""
	}
	return dir
}

func urlBun() string {
	if path, err := exec.LookPath("bun"); err == nil {
		return path
	}
	if home, err := os.UserHomeDir(); err == nil {
		if path := filepath.Join(home, ".bun", "bin", "bun"); urlFileExists(path) {
			return path
		}
	}
	return ""
}

func urlFileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// TestURLCorpus runs every URL attribute value of the parity corpus through
// the TypeScript engine (Bun) and the Go port.
func TestURLCorpus(t *testing.T) {
	dir := urlCorpusDir()
	if dir == "" {
		t.Skip("no test-corpus/parity (set TRUFFLE_CORPUS)")
	}
	bun := urlBun()
	if bun == "" {
		t.Skip("no bun")
	}
	cmd := exec.Command(bun, filepath.Join("testdata", "url", "oracle.ts"), "--corpus", dir)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("oracle: %v\n%s", err, stderr.String())
	}
	a := readURLAnswers(t, bytes.NewReader(out))
	failed, total := checkURLAnswers(t, a, 50)
	t.Logf("%d of %d corpus cases agree with the TypeScript engine (%d resolutions, %d URLs)", total-failed, total, len(a.Resolve), len(a.URLs))

	// The benchmark's Go collection finds the same values.
	_, pairs := urlCorpusPairs(t, dir)
	want := map[[2]string]bool{}
	for _, row := range a.Resolve {
		want[[2]string{*row[0], *row[1]}] = true
	}
	got := map[[2]string]bool{}
	for _, p := range pairs {
		got[p] = true
	}
	missing := 0
	for p := range want {
		if !got[p] {
			missing++
		}
	}
	if missing > 0 || len(got) != len(want) {
		t.Errorf("Go corpus collection: %d values, %d of the TypeScript collection's %d missing", len(got), missing, len(want))
	}
}

// urlCorpusPairs collects [base, value] pairs as testdata/url/corpus.ts does.
func urlCorpusPairs(t testing.TB, dir string) (pages []string, pairs [][2]string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest []struct{ Key, URL string }
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	urlAttrs := map[string]bool{}
	for _, name := range strings.Fields("href src srcset poster cite action background longdesc data formaction manifest icon xlink:href imagesrcset") {
		urlAttrs[name] = true
	}
	dataAttr := func(name string) bool {
		if !strings.HasPrefix(name, "data-") {
			return false
		}
		for _, suffix := range []string{"src", "url", "href", "srcset", "permalink", "uri"} {
			if len(name) >= len("data-")+len(suffix) && strings.HasSuffix(name, suffix) {
				return true
			}
		}
		return false
	}
	metaKey := func(k string) bool {
		k = wgASCIILower(k)
		for _, w := range []string{"url", "image", "video", "audio", "player", "thumbnail"} {
			if strings.Contains(k, w) {
				return true
			}
		}
		return false
	}
	ldKeys := map[string]bool{}
	for _, k := range strings.Fields("url image thumbnailurl @id contenturl embedurl logo sameas mainentityofpage") {
		ldKeys[k] = true
	}
	seen := map[[2]string]bool{}
	for _, page := range manifest {
		pages = append(pages, page.URL)
		add := func(value string) {
			p := [2]string{page.URL, value}
			if !seen[p] {
				seen[p] = true
				pairs = append(pairs, p)
			}
		}
		data, err := os.ReadFile(filepath.Join(dir, "vdoc", page.Key+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var doc struct {
			Root     any      `json:"root"`
			JSONLd   []string `json:"jsonLd"`
			BaseHref *string  `json:"baseHref"`
		}
		if err := json.Unmarshal(data, &doc); err != nil {
			t.Fatal(err)
		}
		if doc.BaseHref != nil {
			add(*doc.BaseHref)
		}
		var visit func(node any)
		visit = func(node any) {
			el, ok := node.(map[string]any)
			if !ok {
				return
			}
			attrs, _ := el["a"].(map[string]any)
			for name, v := range attrs {
				value, _ := v.(string)
				lower := jsLower(name)
				if !urlAttrs[lower] && !dataAttr(lower) {
					continue
				}
				add(value)
				if strings.HasSuffix(lower, "srcset") {
					for _, u := range urlSrcsetURLs(value) {
						add(u)
					}
				}
			}
			if el["t"] == "meta" {
				k := ""
				for _, name := range []string{"property", "name", "itemprop"} {
					if v, ok := attrs[name].(string); ok {
						k = v
						break
					}
				}
				if content, ok := attrs["content"].(string); ok && metaKey(k) {
					add(content)
				}
			}
			children, _ := el["c"].([]any)
			for _, child := range children {
				visit(child)
			}
		}
		visit(doc.Root)
		var ld func(value any, key string)
		ld = func(value any, key string) {
			switch v := value.(type) {
			case string:
				if ldKeys[wgASCIILower(key)] {
					add(v)
				}
			case []any:
				for _, x := range v {
					ld(x, key)
				}
			case map[string]any:
				for k, x := range v {
					ld(x, k)
				}
			}
		}
		for _, raw := range doc.JSONLd {
			var v any
			if json.Unmarshal([]byte(raw), &v) == nil {
				ld(v, "")
			}
		}
	}
	return pages, pairs
}

// urlSrcsetURLs is corpus.ts `srcsetUrls`: the candidate URLs media.ts
// `parseSrcset` resolves.
func urlSrcsetURLs(value string) []string {
	var urls []string
	space := func(i int) (bool, int) {
		r, size := rune(value[i]), 1
		if r >= 0x80 {
			r, size = utf8.DecodeRuneInString(value[i:])
		}
		return isJSSpace(r), size
	}
	i, n := 0, len(value)
	for i < n {
		for i < n {
			if value[i] == ',' {
				i++
				continue
			}
			if sp, size := space(i); sp {
				i += size
				continue
			}
			break
		}
		if i >= n {
			break
		}
		start := i
		for i < n {
			sp, size := space(i)
			if sp {
				break
			}
			i += size
		}
		url := value[start:i]
		if strings.HasSuffix(url, ",") {
			// The candidate cannot start with a comma: only trailing ones go.
			url = strings.TrimRight(url, ",")
		} else {
			for i < n && value[i] != ',' {
				i++
			}
		}
		urls = append(urls, url)
	}
	return urls
}

// TestResolveURLConcurrent resolves against alternating bases from several
// goroutines: the base cache is shared.
func TestResolveURLConcurrent(t *testing.T) {
	bases := []string{"https://a.example/x/y", "http://b.example:8080/", "https://c.example/p?q#f"}
	want := []string{"https://a.example/x/z/w", "http://b.example:8080/z/w", "https://c.example/z/w"}
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 2000; i++ {
				k := (g + i) % len(bases)
				if got, ok := resolveURL("z/w", bases[k]); !ok || got != want[k] {
					t.Errorf("resolveURL(z/w, %s) = %q, %v", bases[k], got, ok)
					return
				}
			}
		}(g)
	}
	wg.Wait()
}

var urlBenchPairs struct {
	once  sync.Once
	pairs [][2]string
}

// BenchmarkResolveURL resolves the corpus's URL attribute values, page by
// page (the committed cases when the corpus is absent).
func BenchmarkResolveURL(b *testing.B) {
	urlBenchPairs.once.Do(func() {
		var pairs [][2]string
		if dir := urlCorpusDir(); dir != "" {
			_, pairs = urlCorpusPairs(b, dir)
		} else {
			for _, row := range loadURLAnswers(b, "cases.json.gz").Resolve {
				pairs = append(pairs, [2]string{*row[0], *row[1]})
			}
		}
		// In one block, in order, as a page's attribute values lie after parsing
		// (decoded JSON scatters them over the heap). Bases stay shared.
		var arena strings.Builder
		for _, p := range pairs {
			arena.WriteString(p[1])
		}
		all, at := arena.String(), 0
		for i, p := range pairs {
			pairs[i][1] = all[at : at+len(p[1])]
			at += len(p[1])
		}
		urlBenchPairs.pairs = pairs
	})
	pairs := urlBenchPairs.pairs
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		p := pairs[i%len(pairs)]
		resolveURL(p[1], p[0])
	}
}
