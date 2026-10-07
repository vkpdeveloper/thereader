package truffle

// JavaScript regular expressions on Go's regexp package. The TypeScript
// engine's patterns are written for ECMAScript; `jsRegexp` rewrites the parts
// whose meaning differs in RE2 syntax so the same source matches the same text:
//
//   - `\s` and `\S` are JavaScript whitespace (Unicode spaces, U+FEFF, line
//     separators), not ASCII's; inside a class they become explicit ranges;
//   - `.` excludes all four line terminators (`\n`, `\r`, U+2028, U+2029);
//   - `\uXXXX` and `\u{X}` become `\x{...}`; flag `s` becomes an inline flag,
//     `g`, `y` and `u` are the caller's business;
//   - flag `i` without `u` is spelled out, character by character: JavaScript
//     then matches a character with those that uppercase to the same one, and
//     never an ASCII letter with a non-ASCII one, where RE2's `(?i)` folds `k`
//     with the Kelvin sign and `s` with `ſ`, inside `\w` and classes too. With
//     `u` it is RE2's Unicode folding;
//   - flag `m` is refused: RE2's `^` and `$` break lines at `\n` only.
//
// Lookaround and backreferences have no RE2 form: patterns that need them are
// hand-written in Go at their call sites, and jsRegexp panics on them so none
// slips through. `\b`, `\w` and `\d` are ASCII in both (no `u` flag needed).

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// jsSpaceRanges is the body of a character class matching JavaScript `\s`.
const jsSpaceRanges = `\t-\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// jsNonSpaceRanges is the body of a character class matching JavaScript `\S`.
const jsNonSpaceRanges = `\x00-\x08\x0e-\x1f!-\x{9f}\x{a1}-\x{167f}\x{1681}-\x{1fff}\x{200b}-\x{2027}\x{202a}-\x{202e}\x{2030}-\x{205e}\x{2060}-\x{2fff}\x{3001}-\x{fefe}\x{ff00}-\x{10ffff}`

// jsDot is JavaScript `.` without the `s` flag.
const jsDot = `[^\n\r\x{2028}\x{2029}]`

// jsRegexp compiles a JavaScript pattern source with JavaScript flags.
func jsRegexp(source, flags string) *regexp.Regexp {
	re, err := regexp.Compile(translateJS(source, flags))
	if err != nil {
		panic(fmt.Sprintf("jsRegexp(%q, %q): %v", source, flags, err))
	}
	return re
}

func translateJS(source, flags string) string {
	var out strings.Builder
	prefix := ""
	dotAll := false
	fold := strings.ContainsRune(flags, 'i') && !strings.ContainsRune(flags, 'u')
	for _, f := range flags {
		switch f {
		case 'i':
			if !fold {
				prefix += "i"
			}
		case 'm':
			panic("jsRegexp: flag m (RE2 breaks lines at \\n only) in " + source)
		case 's':
			dotAll = true
			prefix += "s"
		case 'g', 'y', 'u':
		default:
			panic("jsRegexp: unknown flag " + string(f))
		}
	}
	if prefix != "" {
		out.WriteString("(?" + prefix + ")")
	}
	inClass := false
	for i := 0; i < len(source); i++ {
		c := source[i]
		switch {
		case fold && c == '[':
			ranges, negated, next := parseJSClass(source, i)
			writeClass(&out, foldRanges(ranges), negated)
			i = next - 1
		case fold && c == '\\' && i+1 < len(source) && (source[i+1] == 'x' || source[i+1] == 'u' || isASCIILetter(source[i+1]) && !strings.ContainsRune("sSwWdDbBnrtfvp", rune(source[i+1]))):
			// An escape that stands for one character: that character, folded.
			r, n := jsClassAtom(source, i)
			writeClass(&out, foldRanges([]runeRange{{r, r}}), false)
			i += n - 1
		case fold && c >= 0x80 || fold && isASCIILetter(c):
			r, n := utf8.DecodeRuneInString(source[i:])
			if set := foldRanges([]runeRange{{r, r}}); len(set) == 1 && set[0].lo == set[0].hi {
				out.WriteString(source[i : i+n])
			} else {
				writeClass(&out, set, false)
			}
			i += n - 1
		case c == '\\':
			if i+1 >= len(source) {
				panic("jsRegexp: trailing backslash in " + source)
			}
			e := source[i+1]
			i++
			switch e {
			case 's':
				if inClass {
					out.WriteString(jsSpaceRanges)
				} else {
					out.WriteString("[" + jsSpaceRanges + "]")
				}
			case 'S':
				if inClass {
					out.WriteString(jsNonSpaceRanges)
				} else {
					out.WriteString("[" + jsNonSpaceRanges + "]")
				}
			case 'u':
				if i+1 < len(source) && source[i+1] == '{' {
					end := strings.IndexByte(source[i:], '}')
					out.WriteString(`\x{` + source[i+2:i+end] + `}`)
					i += end
				} else {
					out.WriteString(`\x{` + source[i+1:i+5] + `}`)
					i += 4
				}
			case 'x':
				out.WriteString(`\x{` + source[i+1:i+3] + `}`)
				i += 2
			case '/':
				out.WriteByte('/')
			case '0':
				out.WriteString(`\x00`)
			case 'b':
				if inClass {
					out.WriteString(`\x08`)
				} else {
					out.WriteString(`\b`)
				}
			case 'p', 'P':
				// \p{L} and friends: same syntax in RE2.
				end := strings.IndexByte(source[i:], '}')
				out.WriteString(source[i-1 : i+end+1])
				i += end
			case '1', '2', '3', '4', '5', '6', '7', '8', '9':
				panic("jsRegexp: backreference in " + source)
			case 'd', 'D', 'w', 'W', 'B', 'n', 'r', 't', 'f', 'v':
				out.WriteByte('\\')
				out.WriteByte(e)
			default:
				if e >= 0x80 || (e >= 'a' && e <= 'z') || (e >= 'A' && e <= 'Z') {
					// An identity escape of a letter: the letter itself.
					out.WriteByte(e)
				} else {
					out.WriteByte('\\')
					out.WriteByte(e)
				}
			}
		case inClass:
			switch c {
			case ']':
				inClass = false
				out.WriteByte(']')
			case '[':
				out.WriteString(`\[`)
			default:
				out.WriteByte(c)
			}
		case c == '[':
			inClass = true
			out.WriteByte('[')
			if i+1 < len(source) && source[i+1] == '^' {
				out.WriteByte('^')
				i++
			}
			// `[]` matches nothing and `[^]` anything in JavaScript.
			if i+1 < len(source) && source[i+1] == ']' {
				panic("jsRegexp: empty class in " + source)
			}
		case c == '.':
			if dotAll {
				out.WriteString(`(?s:.)`)
			} else {
				out.WriteString(jsDot)
			}
		case c == '(':
			if strings.HasPrefix(source[i:], "(?=") || strings.HasPrefix(source[i:], "(?!") || strings.HasPrefix(source[i:], "(?<=") || strings.HasPrefix(source[i:], "(?<!") {
				panic("jsRegexp: lookaround in " + source)
			}
			if strings.HasPrefix(source[i:], "(?<") {
				end := i + strings.IndexByte(source[i:], '>')
				out.WriteString("(?P<" + source[i+3:end+1])
				i = end
				continue
			}
			out.WriteByte('(')
		default:
			out.WriteByte(c)
		}
	}
	return out.String()
}

// ------------------------------------------------------------------ the i flag

type runeRange struct{ lo, hi rune }

var (
	jsSpaceSet = []runeRange{{'\t', '\r'}, {' ', ' '}, {0xa0, 0xa0}, {0x1680, 0x1680}, {0x2000, 0x200a}, {0x2028, 0x2029}, {0x202f, 0x202f}, {0x205f, 0x205f}, {0x3000, 0x3000}, {0xfeff, 0xfeff}}
	jsWordSet  = []runeRange{{'0', '9'}, {'A', 'Z'}, {'_', '_'}, {'a', 'z'}}
	jsDigitSet = []runeRange{{'0', '9'}}
)

func isASCIILetter(c byte) bool { return c|0x20 >= 'a' && c|0x20 <= 'z' }

// parseJSClass reads the class at source[i] ('['): its ranges, whether it
// is negated, and the offset after its ']'.
func parseJSClass(source string, i int) (ranges []runeRange, negated bool, next int) {
	i++
	if i < len(source) && source[i] == '^' {
		negated = true
		i++
	}
	if i < len(source) && source[i] == ']' {
		panic("jsRegexp: empty class in " + source)
	}
	for i < len(source) && source[i] != ']' {
		lo, set, n := jsClassItem(source, i)
		i += n
		if set != nil {
			ranges = append(ranges, set...)
			continue
		}
		if i+1 < len(source) && source[i] == '-' && source[i+1] != ']' {
			hi, set, n := jsClassItem(source, i+1)
			if set != nil {
				// [a-\s]: the dash is a character (Annex B).
				ranges = append(append(ranges, runeRange{lo, lo}, runeRange{'-', '-'}), set...)
			} else {
				if hi < lo {
					panic("jsRegexp: range out of order in " + source)
				}
				ranges = append(ranges, runeRange{lo, hi})
			}
			i += 1 + n
			continue
		}
		ranges = append(ranges, runeRange{lo, lo})
	}
	if i >= len(source) {
		panic("jsRegexp: unterminated class in " + source)
	}
	return ranges, negated, i + 1
}

// jsClassItem: a character, or the set of a class escape (\s, \w, \d and their complements).
func jsClassItem(source string, i int) (r rune, set []runeRange, n int) {
	if source[i] != '\\' {
		r, n = utf8.DecodeRuneInString(source[i:])
		return r, nil, n
	}
	switch source[i+1] {
	case 's':
		return 0, jsSpaceSet, 2
	case 'S':
		return 0, complementRanges(jsSpaceSet), 2
	case 'w':
		return 0, jsWordSet, 2
	case 'W':
		return 0, complementRanges(jsWordSet), 2
	case 'd':
		return 0, jsDigitSet, 2
	case 'D':
		return 0, complementRanges(jsDigitSet), 2
	case 'b':
		return '\b', nil, 2
	}
	r, n = jsClassAtom(source, i)
	return r, nil, n
}

// jsClassAtom: the character an escape at source[i] stands for, and its length.
func jsClassAtom(source string, i int) (rune, int) {
	hex := func(s string) rune {
		v, err := strconv.ParseUint(s, 16, 32)
		if err != nil {
			panic("jsRegexp: bad escape in " + source)
		}
		return rune(v)
	}
	switch e := source[i+1]; e {
	case 'n':
		return '\n', 2
	case 'r':
		return '\r', 2
	case 't':
		return '\t', 2
	case 'f':
		return '\f', 2
	case 'v':
		return '\v', 2
	case '0':
		return 0, 2
	case 'x':
		return hex(source[i+2 : i+4]), 4
	case 'u':
		if source[i+2] == '{' {
			end := i + strings.IndexByte(source[i:], '}')
			return hex(source[i+3 : end]), end + 1 - i
		}
		return hex(source[i+2 : i+6]), 6
	}
	r, n := utf8.DecodeRuneInString(source[i+1:])
	return r, n + 1
}

func mergeRanges(rs []runeRange) []runeRange {
	rs = append([]runeRange(nil), rs...)
	sort.Slice(rs, func(a, b int) bool { return rs[a].lo < rs[b].lo })
	var out []runeRange
	for _, r := range rs {
		if k := len(out) - 1; k >= 0 && r.lo <= out[k].hi+1 {
			out[k].hi = max(out[k].hi, r.hi)
			continue
		}
		out = append(out, r)
	}
	return out
}

func complementRanges(rs []runeRange) []runeRange {
	var out []runeRange
	next := rune(0)
	for _, r := range mergeRanges(rs) {
		if r.lo > next {
			out = append(out, runeRange{next, r.lo - 1})
		}
		next = r.hi + 1
	}
	if next <= unicode.MaxRune {
		out = append(out, runeRange{next, unicode.MaxRune})
	}
	return out
}

// foldRanges closes a set under JavaScript's i flag without u: a character
// matches every character with the same canonical form (jsCanon).
func foldRanges(rs []runeRange) []runeRange {
	rs = mergeRanges(rs)
	out := append([]runeRange(nil), rs...)
	for _, r := range rs {
		for _, cr := range unicode.CaseRanges {
			lo, hi := max(r.lo, rune(cr.Lo)), min(r.hi, rune(cr.Hi))
			for c := lo; c <= hi; c++ {
				canon := jsCanon(c)
				for f := unicode.SimpleFold(c); f != c; f = unicode.SimpleFold(f) {
					if jsCanon(f) == canon {
						out = append(out, runeRange{f, f})
					}
				}
			}
		}
	}
	return mergeRanges(out)
}

// jsCanon is the spec's Canonicalize without u: the uppercase form, unless
// it is several characters or would make a non-ASCII character ASCII.
func jsCanon(r rune) rune {
	switch {
	case r == 0xdf, r == 0x149, r == 0x1f0, r == 0x390, r == 0x3b0, r == 0x587,
		r >= 0x1e96 && r <= 0x1e9a, r >= 0x1f50 && r <= 0x1f56 && r%2 == 0,
		r >= 0x1f80 && r <= 0x1faf, r >= 0x1fb2 && r <= 0x1fb4, r == 0x1fb6, r == 0x1fb7, r == 0x1fbc,
		r >= 0x1fc2 && r <= 0x1fc4, r == 0x1fc6, r == 0x1fc7, r == 0x1fcc, r == 0x1fd2, r == 0x1fd3,
		r == 0x1fd6, r == 0x1fd7, r >= 0x1fe2 && r <= 0x1fe4, r == 0x1fe6, r == 0x1fe7,
		r >= 0x1ff2 && r <= 0x1ff4, r == 0x1ff6, r == 0x1ff7, r == 0x1ffc,
		r >= 0xfb00 && r <= 0xfb06, r >= 0xfb13 && r <= 0xfb17:
		// SpecialCasing: the uppercase form is several characters.
		return r
	}
	u := unicode.ToUpper(r)
	if r >= 0x80 && u < 0x80 {
		return r
	}
	return u
}

func writeClass(out *strings.Builder, rs []runeRange, negated bool) {
	if len(rs) == 0 {
		if negated {
			out.WriteString(`(?s:.)`)
		} else {
			out.WriteString(`[^\x00-\x{10ffff}]`)
		}
		return
	}
	out.WriteByte('[')
	if negated {
		out.WriteByte('^')
	}
	for _, r := range rs {
		fmt.Fprintf(out, `\x{%x}`, r.lo)
		if r.hi != r.lo {
			fmt.Fprintf(out, `-\x{%x}`, r.hi)
		}
	}
	out.WriteByte(']')
}

// literalGate is a cheap necessary condition for a costly case-insensitive
// pattern: every match contains one of the words. Words are lowercase ASCII
// (the i flag never folds an ASCII letter with a non-ASCII character, so a
// word with other letters is given by an ASCII part of it) and are searched
// without lowercasing the text: a bit per lowercased byte pair rules most
// positions out at once.
type literalGate struct {
	pairs   *[1 << 16 / 64]uint64
	byFirst [256][]string
}

func newLiteralGate(words ...string) *literalGate {
	g := &literalGate{pairs: new([1 << 16 / 64]uint64)}
	for _, w := range words {
		if len(w) < 2 || !isLowerASCII(w) {
			panic("literalGate: " + w)
		}
		k := uint16(w[0])<<8 | uint16(w[1])
		g.pairs[k>>6] |= 1 << (k & 63)
		g.byFirst[w[0]] = append(g.byFirst[w[0]], w)
	}
	return g
}

func (g *literalGate) open(text string) bool {
	for i := 0; i+1 < len(text); i++ {
		c := lowerByte[text[i]]
		k := uint16(c)<<8 | uint16(lowerByte[text[i+1]])
		if g.pairs[k>>6]&(1<<(k&63)) == 0 {
			continue
		}
		for _, w := range g.byFirst[c] {
			if hasPrefixFold(text[i:], w) {
				return true
			}
		}
	}
	return false
}

// prefixGate: every match starts with one of the words (lowercase; ASCII
// letters compare case-insensitively, other bytes exactly).
type prefixGate struct {
	byFirst [256][]string
}

func newPrefixGate(words ...string) *prefixGate {
	g := &prefixGate{}
	for _, w := range words {
		if w == "" || w != strings.ToLower(w) {
			panic("prefixGate: " + w)
		}
		g.byFirst[w[0]] = append(g.byFirst[w[0]], w)
	}
	return g
}

func (g *prefixGate) open(text string) bool {
	if text == "" {
		return false
	}
	for _, w := range g.byFirst[lowerByte[text[0]]] {
		if hasPrefixFold(text, w) {
			return true
		}
	}
	return false
}

// hasPrefixFold: s starts with w (lowercase), ASCII letters of s folded.
func hasPrefixFold(s, w string) bool {
	if len(s) < len(w) {
		return false
	}
	for j := 0; j < len(w); j++ {
		if lowerByte[s[j]] != w[j] {
			return false
		}
	}
	return true
}

func isLowerASCII(w string) bool {
	for j := 0; j < len(w); j++ {
		if w[j] >= 0x80 || w[j] >= 'A' && w[j] <= 'Z' {
			return false
		}
	}
	return true
}

var lowerByte = func() (t [256]byte) {
	for i := range t {
		t[i] = byte(i)
		if i >= 'A' && i <= 'Z' {
			t[i] = byte(i + 32)
		}
	}
	return t
}()

// wordAlternation is the pattern `\b(?:word|word…)\b` with the i flag: words
// of ASCII letters (`x?` and `(?:a|b)` expanded), compared ASCII
// case-insensitively, at ASCII word boundaries, as in JavaScript without u.
type wordAlternation struct {
	byFirst [256][]string
}

func newWordAlternation(source string) *wordAlternation {
	if !strings.HasPrefix(source, `\b(?:`) || !strings.HasSuffix(source, `)\b`) || closingParen(source, 2) != len(source)-3 {
		panic("wordAlternation: " + source)
	}
	w := &wordAlternation{}
	for _, word := range expandAlternation(source[5 : len(source)-3]) {
		word = strings.ToLower(word)
		for j := 0; j < len(word); j++ {
			if word[j] < 'a' || word[j] > 'z' {
				panic("wordAlternation: " + source)
			}
		}
		w.byFirst[word[0]] = append(w.byFirst[word[0]], word)
	}
	return w
}

func (w *wordAlternation) match(s string) bool {
	for i := 0; i < len(s); i++ {
		words := w.byFirst[lowerByte[s[i]]]
		if words == nil || i > 0 && isWordByte(s[i-1]) {
			continue
		}
		for _, word := range words {
			if end := i + len(word); hasPrefixFold(s[i:], word) && (end == len(s) || !isWordByte(s[end])) {
				return true
			}
		}
	}
	return false
}

// isWordByte: an ASCII word character (`\w` without u).
func isWordByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_'
}

// ------------------------------------------------------------------ class patterns

// classPattern matches the class/id patterns of the TypeScript engine. Most
// are alternations of literal words, optionally delimited:
// `(?:^|[\s_-])(?:footnotes|endnotes)(?:$|[\s_-])`. The engine tests every
// element's class and id against dozens of them, so the words are derived from
// the pattern source and matched with plain string search; a pattern that does
// not reduce falls back to the translated regexp.
type classPattern struct {
	re     *regexp.Regexp
	plan   *literalPlan
	source string
	// bit caches this pattern's result on each element (Node.patKnown, Node.patHit);
	// 0 for patterns past the 64th, which are not cached.
	bit uint64
}

var classPatterns int

func newClassPattern(source string) *classPattern {
	p := &classPattern{re: jsRegexp(source, ""), plan: parsePlan(source), source: source}
	if classPatterns < 64 {
		p.bit = 1 << classPatterns
		classPatterns++
	}
	return p
}

// matchEl is match(el.matchString), cached on the element: the scoring
// attempts and the converter test the same elements against the same
// patterns many times.
func (p *classPattern) matchEl(el *Node) bool {
	if el.patKnown&p.bit != 0 {
		return el.patHit&p.bit != 0
	}
	r := p.match(el.matchString)
	el.patKnown |= p.bit
	if r {
		el.patHit |= p.bit
	}
	return r
}

func (p *classPattern) match(s string) bool {
	if p.plan != nil {
		return p.plan.matches(s)
	}
	return p.re.MatchString(s)
}

type bound uint8

const (
	boundNone      bound = iota // anywhere
	boundSpace                  // (?:^|\s)word(?:\s|$)
	boundSpaceDash              // (?:^|[\s_-])word(?:$|[\s_-])
	boundWordEdge               // (?:\b|_)word(?:\b|_)
)

type literal struct {
	word       string
	start, end bool
}

type literalPlan struct {
	bound    bound
	words    []string
	literals []literal
	litIndex [128][]literal
	wordIdx  [128][]string
	// first: firstLit when a literal starts with the byte, firstWord when a word does.
	first [128]uint8
	// delim: the ASCII characters that delimit a word.
	delim [128]bool
	// pairs indexes the literals (all three bytes or longer) by a hash of their
	// first three bytes, with a bit per hash in pairMask: most positions of a
	// subject are rejected with one test, the rest try a literal or two.
	pairs    *[256][]literal
	pairMask [4]uint64
}

// pairHash hashes the first three bytes of a literal (two at the end of the subject).
func pairHash(a, b, c byte) uint8 { return uint8((uint32(a)*31+uint32(b))*31 + uint32(c)) }

const (
	firstLit  = 1
	firstWord = 2
)

var planPrefixes = []struct {
	prefix, suffix string
	bound          bound
}{
	{`(?:^|[\s_-])(?:`, `)(?:$|[\s_-])`, boundSpaceDash},
	{`(?:^|\s)(?:`, `)(?:\s|$)`, boundSpace},
	{`(?:\b|_)(?:`, `)(?:\b|_)`, boundWordEdge},
}

func parsePlan(source string) (plan *literalPlan) {
	defer func() {
		if recover() != nil {
			plan = nil
		}
	}()
	for _, p := range planPrefixes {
		if !strings.HasPrefix(source, p.prefix) {
			continue
		}
		closeAt := closingParen(source, len(p.prefix)-3)
		if !strings.HasPrefix(source[closeAt:], p.suffix) {
			return nil
		}
		words := expandAlternation(source[len(p.prefix):closeAt])
		rest := source[closeAt+len(p.suffix):]
		if words == nil || containsEmpty(words) {
			return nil
		}
		if rest == "" {
			return newPlan(p.bound, words, nil)
		}
		if rest[0] != '|' {
			return nil
		}
		literals := parseLiterals(rest[1:])
		if literals == nil {
			return nil
		}
		return newPlan(p.bound, words, literals)
	}
	const spacePrefix, spaceSuffix = `(?:^|\s)`, `(?:\s|$)`
	if strings.HasPrefix(source, spacePrefix) && strings.HasSuffix(source, spaceSuffix) {
		words := expandAlternation(source[len(spacePrefix) : len(source)-len(spaceSuffix)])
		if words == nil || containsEmpty(words) {
			return nil
		}
		return newPlan(boundSpace, words, nil)
	}
	literals := parseLiterals(source)
	if literals == nil {
		return nil
	}
	return newPlan(boundNone, nil, literals)
}

func containsEmpty(words []string) bool {
	for _, w := range words {
		if w == "" {
			return true
		}
	}
	return false
}

func newPlan(b bound, words []string, literals []literal) *literalPlan {
	p := &literalPlan{bound: b, words: words, literals: literals}
	if len(literals) > 0 {
		p.pairs = new([256][]literal)
		for _, l := range literals {
			if len(l.word) < 3 {
				p.pairs = nil
				p.pairMask = [4]uint64{}
				break
			}
			h := pairHash(l.word[0], l.word[1], l.word[2])
			p.pairs[h] = append(p.pairs[h], l)
			p.pairMask[h>>6] |= 1 << (h & 63)
		}
	}
	for _, l := range literals {
		c := l.word[0]
		if c >= 128 {
			panic("non-ASCII")
		}
		p.litIndex[c] = append(p.litIndex[c], l)
		p.first[c] |= firstLit
	}
	for _, w := range words {
		c := w[0]
		if c >= 128 {
			panic("non-ASCII")
		}
		p.wordIdx[c] = append(p.wordIdx[c], w)
		p.first[c] |= firstWord
	}
	for c := range p.delim {
		p.delim[c] = p.delimiter(rune(c))
	}
	return p
}

func closingParen(s string, open int) int {
	depth := 0
	for i := open; i < len(s); i++ {
		switch s[i] {
		case '\\':
			i++
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	panic("unbalanced")
}

// parseLiterals: top-level alternatives, each a literal with optional ^/$ anchors.
func parseLiterals(source string) []literal {
	var out []literal
	for _, alternative := range splitTopLevel(source) {
		body := alternative
		start := strings.HasPrefix(body, "^")
		if start {
			body = body[1:]
		}
		end := strings.HasSuffix(body, "$") && !strings.HasSuffix(body, `\$`)
		if end {
			body = body[:len(body)-1]
		}
		words := expandAlternation(body)
		if words == nil || containsEmpty(words) {
			return nil
		}
		for _, w := range words {
			out = append(out, literal{w, start, end})
		}
	}
	return out
}

func splitTopLevel(source string) []string {
	var out []string
	depth := 0
	from := 0
	for i := 0; i < len(source); i++ {
		switch source[i] {
		case '\\':
			i++
		case '(':
			depth++
		case ')':
			depth--
		case '|':
			if depth == 0 {
				out = append(out, source[from:i])
				from = i + 1
			}
		}
	}
	return append(out, source[from:])
}

// expandAlternation: every string an alternation of literals (with `x?`,
// `(?:a|b)` and `(?:...)?`) matches; nil for anything else.
func expandAlternation(source string) []string {
	var out []string
	for _, alternative := range splitTopLevel(source) {
		words := expandSequence(alternative)
		if words == nil {
			return nil
		}
		out = append(out, words...)
	}
	return out
}

func expandSequence(s string) []string {
	results := []string{""}
	i := 0
	for i < len(s) {
		c := s[i]
		var atom []string
		switch {
		case c == '(':
			if !strings.HasPrefix(s[i:], "(?:") {
				return nil
			}
			closeAt := closingParen(s, i)
			inner := expandAlternation(s[i+3 : closeAt])
			if inner == nil {
				return nil
			}
			atom = inner
			i = closeAt + 1
		case c == '\\':
			if i+1 >= len(s) {
				return nil
			}
			e := s[i+1]
			if !strings.ContainsRune(`.-/\$^|()[]{}*+?`, rune(e)) {
				return nil
			}
			atom = []string{string(e)}
			i += 2
		case strings.ContainsRune(`.^$[]{}*+|)`, rune(c)):
			return nil
		default:
			atom = []string{string(c)}
			i++
		}
		if i < len(s) && s[i] == '?' {
			atom = append([]string{""}, atom...)
			i++
		}
		next := make([]string, 0, len(results)*len(atom))
		for _, prefix := range results {
			for _, suffix := range atom {
				next = append(next, prefix+suffix)
			}
		}
		results = next
	}
	return results
}

func (p *literalPlan) matches(s string) bool {
	if len(p.literals) == 0 {
		return p.matchWords(s)
	}
	if p.pairs != nil {
		return p.matchPairs(s) || len(p.words) > 0 && p.matchWords(s)
	}
	n := len(s)
	for i := 0; i < n; i++ {
		c := s[i]
		if c >= 128 || p.first[c] == 0 {
			continue
		}
		if p.first[c]&firstLit != 0 {
			{
				for _, l := range p.litIndex[c] {
					if !strings.HasPrefix(s[i:], l.word) {
						continue
					}
					if l.start && i != 0 {
						continue
					}
					if l.end && i+len(l.word) != n {
						continue
					}
					return true
				}
			}
		}
		if p.first[c]&firstWord != 0 && p.before(s, i) {
			for _, w := range p.wordIdx[c] {
				end := i + len(w)
				if strings.HasPrefix(s[i:], w) && (end == n || p.delimiterAt(s, end)) {
					return true
				}
			}
		}
	}
	return false
}

// matchPairs: the literals, looked up by their first three bytes.
func (p *literalPlan) matchPairs(s string) bool {
	n := len(s)
	for i := 0; i+2 < n; i++ {
		h := pairHash(s[i], s[i+1], s[i+2])
		if p.pairMask[h>>6]&(1<<(h&63)) == 0 {
			continue
		}
		for _, l := range p.pairs[h] {
			if strings.HasPrefix(s[i:], l.word) && (!l.start || i == 0) && (!l.end || i+len(l.word) == n) {
				return true
			}
		}
	}
	return false
}

// matchWords: delimited words only, so only the starts of words are tried.
func (p *literalPlan) matchWords(s string) bool {
	n := len(s)
	for i := 0; i < n; {
		if c := s[i]; c < 128 && p.first[c] != 0 {
			for _, w := range p.wordIdx[c] {
				end := i + len(w)
				if strings.HasPrefix(s[i:], w) && (end == n || p.delimiterAt(s, end)) {
					return true
				}
			}
		}
		// The next word starts after the next delimiter.
		for i < n {
			c := s[i]
			if c < 0x80 {
				i++
				if p.delim[c] {
					break
				}
				continue
			}
			r, size := utf8.DecodeRuneInString(s[i:])
			i += size
			if p.delimiter(r) {
				break
			}
		}
	}
	return false
}

func (p *literalPlan) before(s string, i int) bool {
	if i == 0 {
		return true
	}
	// The character ending at i.
	if c := s[i-1]; c < 0x80 {
		return p.delim[c]
	}
	r, _ := utf8.DecodeLastRuneInString(s[:i])
	return p.delimiter(r)
}

func (p *literalPlan) delimiterAt(s string, i int) bool {
	if c := s[i]; c < 0x80 {
		return p.delim[c]
	}
	r, _ := utf8.DecodeRuneInString(s[i:])
	return p.delimiter(r)
}

func (p *literalPlan) delimiter(c rune) bool {
	switch p.bound {
	case boundSpace:
		return isJSSpace(c)
	case boundSpaceDash:
		return isJSSpace(c) || c == '_' || c == '-'
	case boundWordEdge:
		return c == '_' || !isWordChar(c)
	}
	return true
}

func isWordChar(c rune) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_'
}
