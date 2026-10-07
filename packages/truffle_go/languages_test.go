package truffle

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// languageCases is the output of testdata/languages/reference.ts: what the
// TypeScript functions return. A null is "" here, as in the Go API.
type languageCases struct {
	Rules  int `json:"rules"`
	Detect []struct {
		Code  string  `json:"code"`
		Want  *string `json:"want"`
		Rules string  `json:"rules"`
		From  string  `json:"from"`
	} `json:"detect"`
	Class     [][2]*string `json:"class"`
	Normalize [][2]*string `json:"normalize"`
}

func str(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func loadLanguageCases(t testing.TB, data []byte) *languageCases {
	if bytes.HasPrefix(data, []byte{0x1f, 0x8b}) {
		r, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		var buf bytes.Buffer
		if _, err := buf.ReadFrom(r); err != nil {
			t.Fatal(err)
		}
		data = buf.Bytes()
	}
	var c languageCases
	if err := json.Unmarshal(data, &c); err != nil {
		t.Fatal(err)
	}
	return &c
}

func committedLanguageCases(t testing.TB) *languageCases {
	data, err := os.ReadFile("testdata/languages/cases.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	return loadLanguageCases(t, data)
}

// ruleMask is reference.ts's mask: which rules match the prepared code, as hex
// nibbles in RULES order.
func ruleMask(source string) string {
	t := newCodeIndex(jsTrim(jsHead(source, 5000)))
	defer t.release()
	var bits []bool
	for _, lang := range detector() {
		for _, r := range lang {
			bits = append(bits, r.test(t))
		}
	}
	var out strings.Builder
	for i := 0; i < len(bits); i += 4 {
		n := 0
		for b := 0; b < 4 && i+b < len(bits); b++ {
			if bits[i+b] {
				n |= 1 << b
			}
		}
		fmt.Fprintf(&out, "%x", n)
	}
	return out.String()
}

// ruleSources lists the rules in RULES order.
func ruleSources() []ruleSource {
	var out []ruleSource
	for _, l := range languageRules {
		out = append(out, l.rules...)
	}
	return out
}

func checkLanguageCases(t *testing.T, c *languageCases) {
	t.Helper()
	sources := ruleSources()
	if c.Rules != len(sources) {
		t.Fatalf("reference has %d rules, Go %d", c.Rules, len(sources))
	}
	failures := 0
	fail := func(format string, args ...any) {
		t.Helper()
		if failures++; failures <= 20 {
			t.Errorf(format, args...)
		}
	}
	for _, d := range c.Detect {
		if got := DetectLanguage(d.Code); got != str(d.Want) {
			fail("DetectLanguage(%.80q) = %q, want %q", d.Code, got, str(d.Want))
		}
		if got := ruleMask(d.Code); got != d.Rules {
			for i := range got {
				if got[i] != d.Rules[i] {
					var g, w int
					fmt.Sscanf(got[i:i+1], "%x", &g)
					fmt.Sscanf(d.Rules[i:i+1], "%x", &w)
					for b := 0; b < 4; b++ {
						if (g^w)&(1<<b) != 0 {
							src := sources[4*i+b]
							fail("rule /%s/%s on %.80q: Go %v, TypeScript %v", src.source, src.flags, d.Code, g&(1<<b) != 0, w&(1<<b) != 0)
						}
					}
				}
			}
		}
	}
	for _, p := range c.Class {
		if got := LanguageFromClass(str(p[0])); got != str(p[1]) {
			fail("LanguageFromClass(%q) = %q, want %q", str(p[0]), got, str(p[1]))
		}
	}
	for _, p := range c.Normalize {
		if got := NormalizeLanguage(str(p[0])); got != str(p[1]) {
			fail("NormalizeLanguage(%q) = %q, want %q", str(p[0]), got, str(p[1]))
		}
	}
	t.Logf("%d detect cases (%d rules each), %d classes, %d names; %d failures", len(c.Detect), len(sources), len(c.Class), len(c.Normalize), failures)
}

func TestLanguagesReference(t *testing.T) {
	checkLanguageCases(t, committedLanguageCases(t))
}

// TestLanguagesCorpus runs reference.ts over the whole test corpus (code
// blocks, class and language attributes) when the corpus and bun are there.
// The corpus is test-corpus/ at the repository root, or $TRUFFLE_CORPUS.
func TestLanguagesCorpus(t *testing.T) {
	corpus := os.Getenv("TRUFFLE_CORPUS")
	if corpus == "" {
		corpus = filepath.Join("..", "..", "test-corpus")
	}
	if _, err := os.Stat(filepath.Join(corpus, "parity", "ts")); err != nil {
		t.Skip("no test corpus at " + corpus)
	}
	bun, err := exec.LookPath("bun")
	if err != nil {
		home, _ := os.UserHomeDir()
		if bun = filepath.Join(home, ".bun", "bin", "bun"); !fileExists(bun) {
			t.Skip("bun not found")
		}
	}
	out, err := exec.Command(bun, "testdata/languages/reference.ts", "corpus", corpus).Output()
	if err != nil {
		t.Fatalf("reference.ts: %v", err)
	}
	checkLanguageCases(t, loadLanguageCases(t, out))
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// fullRegexp is a rule's pattern as one unanchored RE2 search with
// JavaScript's line starts and ends, built without compileBranch.
func fullRegexp(src ruleSource) *regexp.Regexp {
	multiline := strings.Contains(src.flags, "m")
	var alts []string
	for _, alt := range splitAlternatives(src.source) {
		if strings.Contains(src.flags, "i") {
			alt = foldASCII(alt)
		}
		if multiline && strings.HasPrefix(alt, "^") {
			alt = `(?:^|[\n\r\u2028\u2029])` + alt[1:]
		}
		if multiline && strings.HasSuffix(alt, "$") && !escaped(alt, len(alt)-1) {
			alt = alt[:len(alt)-1] + `(?:$|[\n\r\u2028\u2029])`
		}
		alts = append(alts, "(?:"+alt+")")
	}
	return jsRegexp(strings.Join(alts, "|"), "")
}

// TestLanguageRulesAgainstRegexp compares each rule's candidate search with
// its whole pattern on the reference cases and random variations of them.
func TestLanguageRulesAgainstRegexp(t *testing.T) {
	var rules []*detectRule
	var sources []ruleSource
	var full []*regexp.Regexp
	compiled := detector()
	i := 0
	for _, lang := range compiled {
		for _, r := range lang {
			src := ruleSources()[i]
			i++
			if r.match != nil {
				continue
			}
			rules, sources, full = append(rules, r), append(sources, src), append(full, fullRegexp(src))
		}
	}
	inputs := languageInputs(t)
	failures := 0
	for _, code := range inputs {
		code = jsTrim(jsHead(code, 5000))
		ct := newCodeIndex(code)
		for k, r := range rules {
			if got, want := r.test(ct), full[k].MatchString(code); got != want {
				if failures++; failures <= 20 {
					t.Errorf("rule /%s/%s on %.120q: %v, the whole pattern %v", sources[k].source, sources[k].flags, code, got, want)
				}
			}
		}
		ct.release()
	}
	t.Logf("%d inputs, %d rules", len(inputs), len(rules))
}

// languageInputs: the reference detection inputs and random variations with
// other line breaks, Unicode spaces and shuffled lines.
func languageInputs(t testing.TB) []string {
	c := committedLanguageCases(t)
	random := rand.New(rand.NewSource(1))
	spaces := []string{" ", "\t", "\u00a0", "\u3000", "\ufeff", "\v", "\f", "\u2003"}
	breaks := []string{"\n", "\r", "\r\n", "\u2028", "\u2029", "\n\n"}
	var out []string
	for _, d := range c.Detect {
		out = append(out, d.Code)
		lines := strings.Split(d.Code, "\n")
		for v := 0; v < 3; v++ {
			var b strings.Builder
			for i := range lines {
				line := lines[random.Intn(len(lines))]
				if v == 0 {
					line = lines[i]
				}
				if random.Intn(4) == 0 {
					line = spaces[random.Intn(len(spaces))] + line
				}
				if random.Intn(6) == 0 {
					if k := random.Intn(len(line) + 1); k < len(line) && line[k] < 0x80 {
						line = line[:k] + spaces[random.Intn(len(spaces))] + line[k:]
					}
				}
				if i > 0 {
					b.WriteString(breaks[random.Intn(len(breaks))])
				}
				b.WriteString(line)
			}
			out = append(out, b.String())
		}
	}
	return out
}

func TestJSHead(t *testing.T) {
	for _, c := range []struct {
		in    string
		units int
		want  string
	}{
		{"abc", 5, "abc"},
		{"abcdef", 3, "abc"},
		{"a\U0001F600b", 3, "a\U0001F600"},
		{"a\U0001F600b", 2, "a\uFFFD"},
		{"\u00e9\u00e9\u00e9", 2, "\u00e9\u00e9"},
	} {
		if got := jsHead(c.in, c.units); got != c.want {
			t.Errorf("jsHead(%q, %d) = %q, want %q", c.in, c.units, got, c.want)
		}
	}
}

// TestIsPrompt compares the hand-written prompt test with its pattern.
func TestIsPrompt(t *testing.T) {
	re := jsRegexp(`^\s*(?:[$%❯>]|PS [A-Z]:\\[^>]*>|[\w.-]+@[\w.-]+:[^$#]*[$#])\s`, "")
	lines := []string{"$ ls", "$", "$x", " \u00a0$\u3000x", "% make", "❯ npm", "❯", "> x", ">> x", "PS C:\\> dir", "PS C:\\Users\\me>x", "PS C:\\a>b> c", "PS c:\\> x",
		"me@host:~$ ls", "me@host:~$", "a@b:c#\td", "a@b: x $ y", "a@:x$ y", "@b:x$ y", "a@b x$ y", "a.b-c@d.e:/x/y# z", "user@host:~/a$b$ c", "  me@h:$ \r", "x\r$ y", "$\r"}
	for _, c := range committedLanguageCases(t).Detect {
		lines = append(lines, strings.Split(c.Code, "\n")...)
	}
	for _, line := range lines {
		if got, want := isPrompt(jsTrimStart(line)), re.MatchString(line); got != want {
			t.Errorf("isPrompt(%q) = %v, want %v", line, got, want)
		}
	}
}

func TestFoldASCII(t *testing.T) {
	re := jsRegexp(foldASCII(`\bSELECT\b[\s\S]+?\bFROM\b`), "")
	for in, want := range map[string]bool{"select a from b": true, "SeLeCt a FrOm b": true, "ſelect a from b": false, "select a ſrom b": false, "select\nfrom": true} {
		if got := re.MatchString(in); got != want {
			t.Errorf("%q: %v, want %v", in, got, want)
		}
	}
	if got := jsRegexp(foldASCII(`\u2028k`), "").MatchString("\u2028\u212a"); got {
		t.Error("the Kelvin sign matched k")
	}
}

// detectInputs are the reference detection inputs from the given origins.
func detectInputs(b *testing.B, from ...string) []string {
	var out []string
	for _, d := range committedLanguageCases(b).Detect {
		for _, f := range from {
			if d.From == f {
				out = append(out, d.Code)
			}
		}
	}
	if len(out) == 0 {
		b.Skip("no inputs")
	}
	return out
}

func benchmarkDetect(b *testing.B, inputs []string) {
	detector()
	n := 0
	for _, s := range inputs {
		n += len(s)
	}
	b.SetBytes(int64(n / len(inputs)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		DetectLanguage(inputs[i%len(inputs)])
	}
}

// BenchmarkDetectLanguage: corpus and fixture code blocks, one per op.
func BenchmarkDetectLanguage(b *testing.B) { benchmarkDetect(b, detectInputs(b, "corpus", "fixture")) }

// BenchmarkDetectLanguageLong: corpus blocks of one language joined past the
// 5000 units the detector reads.
func BenchmarkDetectLanguageLong(b *testing.B) { benchmarkDetect(b, detectInputs(b, "long")) }

// BenchmarkDetectLanguageSynthetic: mixed lines, other line breaks, edge cases
// (some 5000 units of one line repeated).
func BenchmarkDetectLanguageSynthetic(b *testing.B) {
	benchmarkDetect(b, detectInputs(b, "synthetic", "edge"))
}

func BenchmarkLanguageFromClass(b *testing.B) {
	var classes []string
	for _, p := range committedLanguageCases(b).Class {
		classes = append(classes, str(p[0]))
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		LanguageFromClass(classes[i%len(classes)])
	}
}
