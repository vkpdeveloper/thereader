package truffle

// JavaScript semantics the TypeScript engine relies on where Go differs, so
// the port produces the same output for the same input. Strings are UTF-8 in
// Go and UTF-16 in JavaScript: wherever the engine compares a length with a
// constant or slices at a fixed offset, it counts UTF-16 code units (`u16len`),
// as `String.prototype.length` does. Offsets found by searching a string
// (`indexOf`) stay byte offsets, which slice the same text.

import (
	"math"
	"math/bits"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
	"unsafe"
)

// isJSSpace reports whether r is JavaScript `WhiteSpace` or `LineTerminator`:
// what `\s` and `trim()` match. Unlike Go's unicode.IsSpace, U+0085 is not
// whitespace and U+FEFF is.
func isJSSpace(r rune) bool {
	if r < 0x80 {
		return r == ' ' || (r >= 0x09 && r <= 0x0d)
	}
	return r == 0xa0 || r == 0x1680 || (r >= 0x2000 && r <= 0x200a) || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
}

// isHTMLSpace: `[\t\n\f\r ]`.
func isHTMLSpace(c byte) bool {
	return c == ' ' || c == '\n' || c == '\t' || c == '\r' || c == '\f'
}

// jsTrim is `String.prototype.trim`.
func jsTrim(s string) string {
	return jsTrimEnd(jsTrimStart(s))
}

// jsTrimStart is `String.prototype.trimStart`.
func jsTrimStart(s string) string {
	i := 0
	for i < len(s) {
		c := s[i]
		if c < 0x80 {
			if c == ' ' || (c >= 0x09 && c <= 0x0d) {
				i++
				continue
			}
			break
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if !isJSSpace(r) {
			break
		}
		i += size
	}
	return s[i:]
}

// jsTrimEnd is `String.prototype.trimEnd`.
func jsTrimEnd(s string) string {
	end := len(s)
	for end > 0 {
		c := s[end-1]
		if c < 0x80 {
			if c == ' ' || (c >= 0x09 && c <= 0x0d) {
				end--
				continue
			}
			break
		}
		r, size := utf8.DecodeLastRuneInString(s[:end])
		if !isJSSpace(r) {
			break
		}
		end -= size
	}
	return s[:end]
}

// isBlank: `s.trim().length === 0`.
func isBlank(s string) bool {
	for i := 0; i < len(s); {
		c := s[i]
		if c < 0x80 {
			if !(c == ' ' || (c >= 0x09 && c <= 0x0d)) {
				return false
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if !isJSSpace(r) {
			return false
		}
		i += size
	}
	return true
}

// u16len is `s.length`: UTF-16 code units.
func u16len(s string) int {
	// len(s) less one per lead byte of a 2-byte sequence and two per lead of a
	// 3- or 4-byte one (C0 and up, E0 and up), eight bytes at a time.
	n := len(s)
	i := 0
	for ; i+8 <= len(s); i += 8 {
		w := load64(s, i)
		if w&0x8080808080808080 == 0 {
			continue
		}
		c0 := w & (w << 1) & 0x8080808080808080
		e0 := c0 & (w << 2)
		n -= bits.OnesCount64(c0) + bits.OnesCount64(e0)
	}
	for ; i < len(s); i++ {
		if c := s[i]; c >= 0xe0 {
			n -= 2
		} else if c >= 0xc0 {
			n--
		}
	}
	return n
}

// load64 is the 8 bytes of s at i, little-endian (one load).
func load64(s string, i int) uint64 {
	s = s[i : i+8]
	return uint64(s[0]) | uint64(s[1])<<8 | uint64(s[2])<<16 | uint64(s[3])<<24 |
		uint64(s[4])<<32 | uint64(s[5])<<40 | uint64(s[6])<<48 | uint64(s[7])<<56
}

// u16offset converts a UTF-16 offset into a byte offset in s (clamped to len(s)).
// An offset inside a surrogate pair rounds up to the end of the character.
func u16offset(s string, units int) int {
	if units <= 0 {
		return 0
	}
	n := 0
	for i := 0; i < len(s); {
		if n >= units {
			return i
		}
		c := s[i]
		if c < 0x80 {
			n++
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
		i += size
	}
	return len(s)
}

// u16prefix is `s.slice(0, units)`.
func u16prefix(s string, units int) string {
	return s[:u16offset(s, units)]
}

// jsLower is `String.prototype.toLowerCase`: Go lowercases with simple case
// mappings; JavaScript also applies the language-independent special casings
// (`İ` becomes `i̇`, a word-final `Σ` becomes `ς`).
func jsLower(s string) string {
	ascii := true
	upper := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 0x80 {
			ascii = false
			break
		}
		if c >= 'A' && c <= 'Z' {
			upper = true
		}
	}
	if ascii {
		if !upper {
			return s
		}
		b := make([]byte, len(s))
		for i := 0; i < len(s); i++ {
			c := s[i]
			if c >= 'A' && c <= 'Z' {
				c += 32
			}
			b[i] = c
		}
		return bytesString(b)
	}
	if !strings.Contains(s, "İ") && !strings.Contains(s, "Σ") {
		return lowerRunes(s)
	}
	var out strings.Builder
	out.Grow(len(s) + 4)
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		switch r {
		case 0x130:
			out.WriteString("i̇")
		case 0x3a3:
			if finalSigma(s, i, i+size) {
				out.WriteRune('ς')
			} else {
				out.WriteRune('σ')
			}
		default:
			out.WriteRune(unicode.ToLower(r))
		}
		i += size
	}
	return out.String()
}

func lowerRunes(s string) string {
	changed := false
	for _, r := range s {
		if unicode.ToLower(r) != r {
			changed = true
			break
		}
	}
	if !changed {
		return s
	}
	var out strings.Builder
	out.Grow(len(s))
	for _, r := range s {
		out.WriteRune(unicode.ToLower(r))
	}
	return out.String()
}

// finalSigma is Unicode `Final_Sigma`: a cased letter before (case-ignorable
// characters skipped) and none after.
func finalSigma(s string, start, end int) bool {
	ignorable := func(r rune) bool {
		return r == '\'' || r == '.' || r == ':' || r == 0xad || r == 0x2019 || (r >= 0x300 && r <= 0x36f)
	}
	j := start
	found := false
	for j > 0 {
		r, size := utf8.DecodeLastRuneInString(s[:j])
		if ignorable(r) {
			j -= size
			continue
		}
		found = unicode.IsLetter(r)
		break
	}
	if !found {
		return false
	}
	for k := end; k < len(s); {
		r, size := utf8.DecodeRuneInString(s[k:])
		if ignorable(r) {
			k += size
			continue
		}
		return !unicode.IsLetter(r)
	}
	return true
}

// bytesString is string(b) without the copy, for a b nothing changes afterwards.
func bytesString(b []byte) string {
	return unsafe.String(unsafe.SliceData(b), len(b))
}

// asciiUpper uppercases ASCII letters (the engine only uppercases ASCII).
func asciiUpper(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - 32
		}
	}
	return bytesString(b)
}

// jsNumber is `Number(value)` for a string: strict, `”` is 0, `'12px'` is NaN.
func jsNumber(value string) float64 {
	s := jsTrim(value)
	if s == "" {
		return 0
	}
	if isDecimalLiteral(s) {
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			// Out of range: ParseFloat returns ±Inf with an error, as JavaScript does.
			return f
		}
		return f
	}
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			v := 0.0
			for i := 2; i < len(s); i++ {
				d := hexValue(s[i])
				if d < 0 || d >= base {
					return math.NaN()
				}
				v = v*float64(base) + float64(d)
			}
			return v
		}
	}
	switch s {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	return math.NaN()
}

// isDecimalLiteral: `^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$`.
func isDecimalLiteral(s string) bool {
	i := 0
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	digits := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
		digits++
	}
	if i < len(s) && s[i] == '.' {
		i++
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
			digits++
		}
	}
	if digits == 0 {
		return false
	}
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		i++
		if i < len(s) && (s[i] == '+' || s[i] == '-') {
			i++
		}
		exp := 0
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
			exp++
		}
		if exp == 0 {
			return false
		}
	}
	return i == len(s)
}

func hexValue(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	}
	return -1
}

// jsParseInt is `parseInt(value, 10)`: leading digits after optional
// whitespace and sign; NaN when there are none.
func jsParseInt(value string) float64 {
	s := jsTrimStart(value)
	negative := false
	if len(s) > 0 && (s[0] == '+' || s[0] == '-') {
		negative = s[0] == '-'
		s = s[1:]
	}
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == 0 {
		return math.NaN()
	}
	f, _ := strconv.ParseFloat(s[:i], 64)
	if negative {
		return -f
	}
	return f
}

// jsIsInteger is `Number.isInteger`.
func jsIsInteger(f float64) bool {
	return !math.IsInf(f, 0) && !math.IsNaN(f) && f == math.Trunc(f)
}

// jsNumberString is `String(number)` (Number::toString, radix 10).
func jsNumberString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	sign := ""
	if f < 0 {
		sign = "-"
		f = -f
	}
	// Shortest round-trip digits and the decimal exponent, then ECMAScript's layout.
	e := strconv.FormatFloat(f, 'e', -1, 64) // d.ddde±XX
	mant, expPart, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	exp, _ := strconv.Atoi(expPart)
	k := len(digits)
	n := exp + 1
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	expSign := "+"
	if n-1 < 0 {
		expSign = "-"
	}
	expAbs := n - 1
	if expAbs < 0 {
		expAbs = -expAbs
	}
	if k == 1 {
		return sign + digits + "e" + expSign + strconv.Itoa(expAbs)
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + expSign + strconv.Itoa(expAbs)
}

// jsDecodeURIComponent is `decodeURIComponent`; ok is false where JavaScript
// throws a `URIError`.
func jsDecodeURIComponent(s string) (string, bool) {
	if strings.IndexByte(s, '%') < 0 {
		return s, true
	}
	byteAt := func(k int) int {
		if k+2 >= len(s) || s[k] != '%' {
			return -1
		}
		hi := hexValue(s[k+1])
		lo := hexValue(s[k+2])
		if hi < 0 || lo < 0 {
			return -1
		}
		return hi*16 + lo
	}
	var out strings.Builder
	out.Grow(len(s))
	i := 0
	for i < len(s) {
		c := s[i]
		if c != '%' {
			out.WriteByte(c)
			i++
			continue
		}
		b := byteAt(i)
		if b < 0 {
			return "", false
		}
		i += 3
		if b < 0x80 {
			out.WriteByte(byte(b))
			continue
		}
		var n, cp, min int
		switch {
		case b&0xe0 == 0xc0:
			n, cp, min = 1, b&0x1f, 0x80
		case b&0xf0 == 0xe0:
			n, cp, min = 2, b&0x0f, 0x800
		case b&0xf8 == 0xf0:
			n, cp, min = 3, b&0x07, 0x10000
		default:
			return "", false
		}
		for k := 0; k < n; k++ {
			if i >= len(s) {
				return "", false
			}
			next := byteAt(i)
			if next < 0 || next&0xc0 != 0x80 {
				return "", false
			}
			cp = cp<<6 | next&0x3f
			i += 3
		}
		if cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) {
			return "", false
		}
		out.WriteRune(rune(cp))
	}
	return out.String(), true
}

// collapseHTMLSpace is `s.replace(/[\t\n\f\r ]+/g, ' ')`.
func collapseHTMLSpace(s string) string {
	n := len(s)
	i := 0
	// Eight bytes at a time while there is no control character and no space
	// before a space (ordinary text): the byte loop finds the exact place.
	for ; i+8 <= n; i += 8 {
		w := load64(s, i)
		if (w-0x2020202020202020)&^w&0x8080808080808080 != 0 {
			break // a byte below 0x20
		}
		z := w ^ 0x2020202020202020
		sp := ^(((z & 0x7f7f7f7f7f7f7f7f) + 0x7f7f7f7f7f7f7f7f) | z) & 0x8080808080808080
		if sp&(sp>>8) != 0 || sp>>63 != 0 && i+8 < n && isHTMLSpace(s[i+8]) {
			break
		}
	}
	for ; i < n; i++ {
		c := s[i]
		if c == ' ' {
			if i+1 < n && isHTMLSpace(s[i+1]) {
				break
			}
		} else if c == '\n' || c == '\t' || c == '\r' || c == '\f' {
			break
		}
	}
	if i == n {
		return s
	}
	b := make([]byte, 0, n)
	b = append(b, s[:i]...)
	for i < n {
		c := s[i]
		if isHTMLSpace(c) {
			b = append(b, ' ')
			i++
			for i < n && isHTMLSpace(s[i]) {
				i++
			}
			continue
		}
		b = append(b, c)
		i++
	}
	return bytesString(b)
}

// collapse is `text.replace(/[\t\n\f\r ]+/g, ' ').trim()` (tree.ts).
func collapse(text string) string {
	return jsTrim(collapseHTMLSpace(text))
}

// collapseJSSpace is `s.replace(/\s+/g, ' ')`.
func collapseJSSpace(s string) string {
	n := len(s)
	i := 0
	for i < n {
		c := s[i]
		if c < 0x80 {
			if c == ' ' {
				if i+1 < n && s[i+1] < 0x80 && (s[i+1] == ' ' || (s[i+1] >= 0x09 && s[i+1] <= 0x0d)) {
					break
				}
				if i+1 < n && s[i+1] >= 0x80 {
					r, _ := utf8.DecodeRuneInString(s[i+1:])
					if isJSSpace(r) {
						break
					}
				}
			} else if c >= 0x09 && c <= 0x0d {
				break
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if isJSSpace(r) {
			break
		}
		i += size
	}
	if i == n {
		return s
	}
	var out strings.Builder
	out.Grow(n)
	out.WriteString(s[:i])
	space := false
	for i < n {
		r, size := utf8.DecodeRuneInString(s[i:])
		if isJSSpace(r) {
			if !space {
				out.WriteByte(' ')
				space = true
			}
		} else {
			out.WriteString(s[i : i+size])
			space = false
		}
		i += size
	}
	return out.String()
}

// splitJSSpace is `s.split(/\s+/)`.
func splitJSSpace(s string) []string {
	var out []string
	start := 0
	i := 0
	for i < len(s) {
		r, size := utf8.DecodeRuneInString(s[i:])
		if isJSSpace(r) {
			out = append(out, s[start:i])
			i += size
			for i < len(s) {
				r2, size2 := utf8.DecodeRuneInString(s[i:])
				if !isJSSpace(r2) {
					break
				}
				i += size2
			}
			start = i
			continue
		}
		i += size
	}
	return append(out, s[start:])
}

// hasToken: the whitespace-separated (`\s+`) tokens of s include token.
func hasToken(s, token string) bool {
	if !strings.Contains(s, token) {
		return false
	}
	for _, t := range splitJSSpace(s) {
		if t == token {
			return true
		}
	}
	return false
}

// isLetterOrNumber is `/[\p{L}\p{N}]/u` for one code point.
func isLetterOrNumber(r rune) bool {
	if r < 0x80 {
		return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
	}
	return unicode.IsLetter(r) || unicode.IsNumber(r)
}

// isPunctuationOrSymbol is `/[\p{P}\p{S}]/u` for one code point.
func isPunctuationOrSymbol(r rune) bool {
	if r < 0x80 {
		return (r >= 0x21 && r <= 0x2f) || (r >= 0x3a && r <= 0x40) || (r >= 0x5b && r <= 0x60) || (r >= 0x7b && r <= 0x7e)
	}
	return unicode.IsPunct(r) || unicode.IsSymbol(r)
}

// lettersAndNumbers is `s.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0)`.
func lettersAndNumbers(s string) []string {
	var out []string
	start := -1
	for i := 0; i < len(s); {
		r, size := rune(s[i]), 1
		if r >= 0x80 {
			r, size = utf8.DecodeRuneInString(s[i:])
		}
		if isLetterOrNumber(r) {
			if start < 0 {
				start = i
			}
		} else if start >= 0 {
			out = append(out, s[start:i])
			start = -1
		}
		i += size
	}
	if start >= 0 {
		out = append(out, s[start:])
	}
	return out
}

// comparable is `value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()`.
func comparable(value string) string {
	lower := jsLower(value)
	var out []byte
	space := false
	clean := true
	for i := 0; i < len(lower); {
		r, size := rune(lower[i]), 1
		if r >= 0x80 {
			r, size = utf8.DecodeRuneInString(lower[i:])
		}
		if isLetterOrNumber(r) {
			if out != nil {
				out = append(out, lower[i:i+size]...)
			}
			space = false
		} else {
			if clean {
				clean = false
				out = append(make([]byte, 0, len(lower)), lower[:i]...)
			}
			if !space {
				out = append(out, ' ')
				space = true
			}
		}
		i += size
	}
	if clean {
		return lower
	}
	// trim(): the separator runs are single spaces; the letters kept never are JS whitespace.
	return jsTrim(string(out))
}

// jsonQuote writes s as JSON.stringify does: `"`, `\`, and control characters
// escaped; everything else (U+2028/9, `<`, `&`, non-ASCII) as is.
func jsonQuote(b []byte, s string) []byte {
	b = append(b, '"')
	start := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 0x20 && c != '"' && c != '\\' {
			continue
		}
		b = append(b, s[start:i]...)
		switch c {
		case '"':
			b = append(b, '\\', '"')
		case '\\':
			b = append(b, '\\', '\\')
		case '\b':
			b = append(b, '\\', 'b')
		case '\f':
			b = append(b, '\\', 'f')
		case '\n':
			b = append(b, '\\', 'n')
		case '\r':
			b = append(b, '\\', 'r')
		case '\t':
			b = append(b, '\\', 't')
		default:
			const hex = "0123456789abcdef"
			b = append(b, '\\', 'u', '0', '0', hex[c>>4], hex[c&0xf])
		}
		start = i + 1
	}
	b = append(b, s[start:]...)
	return append(b, '"')
}
