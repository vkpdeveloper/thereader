package truffle

// Markdown of an article, for consumers that render it themselves
// (markdown.ts). The output is GitHub Flavored Markdown (CommonMark plus pipe
// tables, task lists, strikethrough and `[^label]` footnotes), with `$…$` /
// `$$…$$` math as GitHub, remark-math and KaTeX read it and callouts as GitHub
// alerts (`> [!NOTE]`). It holds no raw HTML, so renderers that strip HTML
// lose nothing.
//
// Text is escaped wherever it could read as syntax, and emphasis that a
// CommonMark parser would not see as emphasis (a delimiter between a letter
// and punctuation, as in `x**(y)**`) is written as plain text, so every
// renderer shows the article's words and nothing else.
//
// The TypeScript engine tests single characters with regular expressions;
// here they are byte and rune checks with the same results. Where it reads one
// UTF-16 code unit (`charAt`), a character outside the BMP is a lone surrogate
// to it, which is never a letter or a space, and the checks below say so.

import (
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// ArticleMarkdown is the article as Markdown: the title as a level-1 heading, then the body.
func ArticleMarkdown(a *Article) string {
	parts := newMDWriter(a.Blocks).blockParts(a.Blocks, true)
	title := ""
	if a.Title != "" {
		title = mdHeading(1, mdEscapeText(a.Title, false, false))
	}
	return mdDocument(title, parts)
}

// BlocksMarkdown is body blocks as Markdown, ending with one newline (empty when nothing renders).
func BlocksMarkdown(blocks []Block) string {
	return mdDocument("", newMDWriter(blocks).blockParts(blocks, true))
}

// mdDocument joins the title and the rendered top-level blocks in one
// allocation: `title + '\n\n' + body + '\n'`, `title + '\n'` without a body.
func mdDocument(title string, parts []string) string {
	n := len(title) + 2
	body := false
	for _, p := range parts {
		if p != "" {
			n += len(p) + 2
			body = true
		}
	}
	if title == "" && !body {
		return ""
	}
	var b strings.Builder
	b.Grow(n)
	if title != "" {
		b.WriteString(title)
		b.WriteByte('\n')
		if body {
			b.WriteByte('\n')
		}
	}
	first := true
	for _, p := range parts {
		if p == "" {
			continue
		}
		if !first {
			b.WriteString("\n\n")
		}
		b.WriteString(p)
		first = false
	}
	if body {
		b.WriteByte('\n')
	}
	return b.String()
}

// ------------------------------------------------------------------ inline

const (
	mdBold   = 1
	mdItalic = 2
	mdStrike = 4
	mdLink   = 8
)

var mdMarkBits = [...]int{mdBold, mdItalic, mdStrike}

// mdNoChar stands for the empty string where the engine passes characters around.
const mdNoChar rune = -1

// mdAtom is one piece of a line: escaped text, a code span, an image, math, a footnote call or a break.
type mdAtom struct {
	md    string
	marks int
	href  string // "" when not a link
	// Source of a code span; isCode tells an empty code run from none.
	code   string
	isCode bool
}

// mdCharClass is CommonMark's character class for flanking: 0 whitespace or line edge, 1 punctuation, 2 anything else.
func mdCharClass(ch rune) int {
	if ch == mdNoChar || isJSSpace(ch) {
		return 0
	}
	if isPunctuationOrSymbol(ch) {
		return 1
	}
	return 2
}

func mdFirstChar(s string) rune {
	if s == "" {
		return mdNoChar
	}
	if s[0] < utf8.RuneSelf {
		return rune(s[0])
	}
	r, _ := utf8.DecodeRuneInString(s)
	return r
}

func mdLastChar(s string) rune {
	if s == "" {
		return mdNoChar
	}
	if c := s[len(s)-1]; c < utf8.RuneSelf {
		return rune(c)
	}
	r, _ := utf8.DecodeLastRuneInString(s)
	return r
}

// spans lays out marks over a run of atoms as properly nested delimiters: at
// each point the mark that lasts longest opens first, so `**a *b***` rather
// than crossed spans. before and after are the characters around the run.
//
// It appends to w.line, which an inline call renders into once. The engine
// tracks the first and last character each call writes, so as not to read a
// string it is still concatenating; here they are read back from the buffer,
// which gives the same characters.
func (w *mdWriter) spans(atoms []mdAtom, from, to, mask int, before, after rune) {
	start := len(w.line)
	for k := from; k < to; {
		atom := &atoms[k]
		open := atom.marks &^ mask
		link := mask&mdLink == 0 && atom.href != ""
		if open == 0 && !link {
			w.line = append(w.line, atom.md...)
			k++
			continue
		}
		mark := 0
		end := k
		if link {
			end = k + 1
			for end < to && atoms[end].href == atom.href {
				end++
			}
			mark = mdLink
		}
		for _, bit := range mdMarkBits {
			if open&bit == 0 {
				continue
			}
			e := k + 1
			for e < to && atoms[e].marks&bit != 0 {
				e++
			}
			if e > end {
				end = e
				mark = bit
			}
		}
		next := after
		if end < to {
			next = mdLeadingChar(&atoms[end], mask)
		}
		prev := before
		if len(w.line) > start {
			prev = mdLastRune(w.line[start:])
		}
		w.wrap(atoms, k, end, mask, mark, atom.href, prev, next)
		k = end
	}
}

// mdLeadingChar is the first character an atom puts down at this level: a delimiter (punctuation) when it opens a mark.
func mdLeadingChar(atom *mdAtom, mask int) rune {
	if atom.marks&^mask != 0 || (mask&mdLink == 0 && atom.href != "") {
		return '*'
	}
	return mdFirstChar(atom.md)
}

// wrap appends atoms from..to under one mark: `[…](href)`, `<href>` or a
// delimiter pair around the text, with whitespace at either end kept outside.
func (w *mdWriter) wrap(atoms []mdAtom, from, to, mask, mark int, href string, prev, next rune) {
	start := len(w.line)
	if mark == mdLink {
		w.spans(atoms, from, to, mask|mdLink, '[', ']')
	} else {
		w.spans(atoms, from, to, mask|mark, '*', '*')
	}
	inner := w.line[start:]
	if len(inner) == 0 {
		return
	}
	// The text is inner[lead:len(inner)-trail].
	lead, trail := 0, 0
	coreHead, coreTail := mdFirstRune(inner), mdLastRune(inner)
	if isJSSpace(coreHead) || isJSSpace(coreTail) {
		lead = mdLeadingSpace(inner)
		if lead == len(inner) {
			return
		}
		trail = mdTrailingSpace(inner)
		coreHead, coreTail = mdFirstRune(inner[lead:]), mdLastRune(inner[:len(inner)-trail])
	}
	if mark == mdLink {
		if string(inner[lead:len(inner)-trail]) == href && mdIsAutolink(href) {
			w.insert(start+lead, "<")
			w.insert(len(w.line)-trail, ">")
			return
		}
		w.insert(start+lead, "[")
		w.insert(len(w.line)-trail, "](", mdDestination(href), ")")
		return
	}
	delimiter := "~~"
	if mark == mdBold {
		delimiter = "**"
	} else if mark == mdItalic {
		delimiter = "*"
	}
	before, after := prev, next
	if lead > 0 {
		before = mdLastRune(inner[:lead])
	}
	if trail > 0 {
		after = mdFirstRune(inner[len(inner)-trail:])
	}
	p, q := mdCharClass(before), mdCharClass(after)
	// Left-flanking opener, right-flanking closer (CommonMark 6.2).
	opens := mdCharClass(coreHead) != 1 || p != 2
	closes := mdCharClass(coreTail) != 1 || q != 2
	if opens && closes {
		w.insert(start+lead, delimiter)
		w.insert(len(w.line)-trail, delimiter)
		return
	}
	// No parser would read these delimiters as emphasis here: keep the words without the mark.
	w.line = w.line[:start]
	w.spans(atoms, from, to, mask|mark, prev, next)
}

// insert puts strings into w.line at byte offset at.
func (w *mdWriter) insert(at int, parts ...string) {
	n := 0
	for _, s := range parts {
		n += len(s)
	}
	end := len(w.line)
	w.line = slices.Grow(w.line, n)[:end+n]
	copy(w.line[at+n:], w.line[at:end])
	for _, s := range parts {
		at += copy(w.line[at:], s)
	}
}

func mdFirstRune(b []byte) rune {
	if len(b) == 0 {
		return mdNoChar
	}
	if b[0] < utf8.RuneSelf {
		return rune(b[0])
	}
	r, _ := utf8.DecodeRune(b)
	return r
}

func mdLastRune(b []byte) rune {
	if len(b) == 0 {
		return mdNoChar
	}
	if c := b[len(b)-1]; c < utf8.RuneSelf {
		return rune(c)
	}
	r, _ := utf8.DecodeLastRune(b)
	return r
}

// mdLeadingSpace is how many bytes of whitespace (`/^\s+/`) b starts with.
func mdLeadingSpace(b []byte) int {
	i := 0
	for i < len(b) {
		r, size := rune(b[i]), 1
		if r >= utf8.RuneSelf {
			r, size = utf8.DecodeRune(b[i:])
		}
		if !isJSSpace(r) {
			break
		}
		i += size
	}
	return i
}

// mdTrailingSpace is how many bytes of whitespace (`/\s+$/`) b ends with.
func mdTrailingSpace(b []byte) int {
	end := len(b)
	for end > 0 {
		r, size := rune(b[end-1]), 1
		if r >= utf8.RuneSelf {
			r, size = utf8.DecodeLastRune(b[:end])
		}
		if !isJSSpace(r) {
			break
		}
		end -= size
	}
	return len(b) - end
}

// mdSpecial is 1 for the bytes of `/[\\`*_[\]<&~$]/`.
var mdSpecial = [256]uint8{'\\': 1, '`': 1, '*': 1, '_': 1, '[': 1, ']': 1, '<': 1, '&': 1, '~': 1, '$': 1}

// mdNextSpecial is the index of the first syntax character in text at or after
// i, or len(text). Most text has none, so it tests four bytes per branch.
func mdNextSpecial(text string, i int) int {
	for ; i+4 <= len(text); i += 4 {
		s := text[i : i+4]
		if mdSpecial[s[0]]|mdSpecial[s[1]]|mdSpecial[s[2]]|mdSpecial[s[3]] != 0 {
			break
		}
	}
	for i < len(text) && mdSpecial[text[i]] == 0 {
		i++
	}
	return i
}

// mdEscapeText backslash-escapes what Markdown would read as syntax inside a
// line. `_` between two letters stays bare (it cannot delimit emphasis
// there), `<` only before a tag or autolink, `&` only before an entity. A
// trailing `!` is escaped when something follows (it would turn a following
// link into an image). Outside links, a bare URL is left as written: GFM links
// it as it stands, and a backslash inside it would become part of the address.
func mdEscapeText(text string, followed, linked bool) string {
	var out string
	if !linked && (strings.Index(text, "://") > 0 || strings.Contains(text, "www.")) {
		var b strings.Builder
		b.Grow(len(text) + 8)
		last := 0
		for pos := 0; ; {
			start, end := mdURLLiteral(text, pos)
			if start < 0 {
				break
			}
			pos = end
			scheme := text[start] == 'h'
			if start > 0 {
				prev, _ := utf8.DecodeLastRuneInString(text[:start])
				var allowed bool
				if scheme {
					allowed = mdIsASCIILetter(prev)
				} else {
					allowed = isJSSpace(prev) || prev == '(' || prev == '*' || prev == '_' || prev == '~'
				}
				if allowed == scheme {
					continue
				}
			}
			url := mdLiteralExtent(text[start:end])
			b.WriteString(mdEscapeSyntax(text[last:start]))
			last = start + len(url)
			// A backslash right after the address would extend it: close it with `<…>`, or leave that character bare.
			if last < len(text) && mdAlwaysEscaped(text[last]) {
				if scheme {
					b.WriteByte('<')
					b.WriteString(url)
					b.WriteByte('>')
				} else {
					b.WriteString(url)
					b.WriteByte(text[last])
					last++
				}
			} else {
				b.WriteString(url)
			}
			pos = last
		}
		b.WriteString(mdEscapeSyntax(text[last:]))
		out = b.String()
	} else {
		out = mdEscapeSyntax(text)
	}
	if followed && len(out) > 0 && out[len(out)-1] == '!' {
		return out[:len(out)-1] + `\!`
	}
	return out
}

// mdAlwaysEscaped is the engine's `escapeSyntax(ch).length > 1` for a character on its own
// (`_` has no letters around it, `<` and `&` nothing after them).
func mdAlwaysEscaped(c byte) bool {
	return mdSpecial[c] != 0 && c != '<' && c != '&'
}

func mdEscapeSyntax(text string) string {
	var b strings.Builder
	start := 0
	for i := mdNextSpecial(text, 0); i < len(text); i = mdNextSpecial(text, i+1) {
		c := text[i]
		switch c {
		case '_':
			if mdWordBefore(text, i) && mdWordAt(text, i+1) {
				continue
			}
		case '<':
			if i+1 >= len(text) || !mdIsTagStart(text[i+1]) {
				continue
			}
		case '&':
			if !mdEntityAt(text, i) {
				continue
			}
		}
		if start == 0 {
			b.Grow(len(text) + 8)
		}
		b.WriteString(text[start:i])
		b.WriteByte('\\')
		b.WriteByte(c)
		start = i + 1
	}
	if start == 0 {
		return text
	}
	b.WriteString(text[start:])
	return b.String()
}

// mdWordBefore is `/[\p{L}\p{N}]/u.test(text.charAt(i - 1))`: one code unit,
// so the low half of a surrogate pair never counts.
func mdWordBefore(text string, i int) bool {
	if i <= 0 {
		return false
	}
	if c := text[i-1]; c < utf8.RuneSelf {
		return isLetterOrNumber(rune(c))
	}
	r, _ := utf8.DecodeLastRuneInString(text[:i])
	return r < 0x10000 && isLetterOrNumber(r)
}

// mdWordAt is `/[\p{L}\p{N}]/u.test(text.charAt(i))` (a high surrogate never counts).
func mdWordAt(text string, i int) bool {
	if i >= len(text) {
		return false
	}
	if c := text[i]; c < utf8.RuneSelf {
		return isLetterOrNumber(rune(c))
	}
	r, _ := utf8.DecodeRuneInString(text[i:])
	return r < 0x10000 && isLetterOrNumber(r)
}

// mdIsTagStart is `/[A-Za-z/!?]/`.
func mdIsTagStart(c byte) bool {
	return mdIsASCIILetter(rune(c)) || c == '/' || c == '!' || c == '?'
}

func mdIsASCIILetter(r rune) bool {
	return (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z')
}

func mdIsDigit(c byte) bool { return c >= '0' && c <= '9' }

func mdIsAlnum(c byte) bool { return mdIsDigit(c) || mdIsASCIILetter(rune(c)) }

func mdIsHex(c byte) bool { return hexValue(c) >= 0 }

// mdEntityAt: `/&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/y` at i.
func mdEntityAt(s string, i int) bool {
	if i >= len(s) || s[i] != '&' {
		return false
	}
	j := i + 1
	run := func(k int, ok func(byte) bool) int {
		n := 0
		for k+n < len(s) && ok(s[k+n]) {
			n++
		}
		return n
	}
	closes := func(k int) bool { return k < len(s) && s[k] == ';' }
	if j < len(s) && s[j] == '#' {
		if n := run(j+1, mdIsDigit); n >= 1 && n <= 7 && closes(j+1+n) {
			return true
		}
		if j+1 < len(s) && (s[j+1] == 'x' || s[j+1] == 'X') {
			n := run(j+2, mdIsHex)
			return n >= 1 && n <= 6 && closes(j+2+n)
		}
		return false
	}
	if j < len(s) && mdIsASCIILetter(rune(s[j])) {
		n := run(j+1, mdIsAlnum)
		return n >= 1 && n <= 31 && closes(j+1+n)
	}
	return false
}

// mdURLLiteral finds the next GFM autolink literal at or after pos:
// `/(?:https?:\/\/|www\.)[^\s<]+/g`. It returns -1 when there is none.
func mdURLLiteral(text string, pos int) (int, int) {
	for p := pos; p < len(text); p++ {
		c := text[p]
		if c != 'h' && c != 'w' {
			continue
		}
		rest := text[p:]
		var q int
		switch {
		case strings.HasPrefix(rest, "http://"):
			q = p + 7
		case strings.HasPrefix(rest, "https://"):
			q = p + 8
		case strings.HasPrefix(rest, "www."):
			q = p + 4
		default:
			continue
		}
		end := q
		for end < len(text) {
			c := text[end]
			if c < utf8.RuneSelf {
				if c == '<' || isJSSpace(rune(c)) {
					break
				}
				end++
				continue
			}
			r, size := utf8.DecodeRuneInString(text[end:])
			if isJSSpace(r) {
				break
			}
			end += size
		}
		if end > q {
			return p, end
		}
	}
	return -1, -1
}

// mdURLTrailing is `/[?!.,:;*_~'"\]]/`.
func mdURLTrailing(c byte) bool {
	switch c {
	case '?', '!', '.', ',', ':', ';', '*', '_', '~', '\'', '"', ']':
		return true
	}
	return false
}

// mdLiteralExtent is the part of a URL-like run GFM links: trailing punctuation and an unmatched `)` stay outside.
func mdLiteralExtent(url string) string {
	opens := strings.Count(url, "(")
	closes := strings.Count(url, ")")
	end := len(url)
	for end > 0 {
		c := url[end-1]
		if mdURLTrailing(c) {
			end--
		} else if c == ')' && opens < closes {
			end--
			closes--
		} else {
			break
		}
	}
	return url[:end]
}

// mdLongestRun is the longest run of the byte c (`/`+/g`, `/~+/g`).
func mdLongestRun(text string, c byte) int {
	longest, run := 0, 0
	for i := 0; i < len(text); i++ {
		if text[i] == c {
			run++
			if run > longest {
				longest = run
			}
		} else {
			run = 0
		}
	}
	return longest
}

func mdCodeSpan(text string) string {
	n := 1
	if strings.IndexByte(text, '`') >= 0 {
		n = mdLongestRun(text, '`') + 1
	}
	fence := strings.Repeat("`", n)
	// One space each side is stripped by the parser, so pad when the code starts or ends with a backtick or a space.
	pad := ""
	if text != "" {
		first, last := text[0], text[len(text)-1]
		if first == '`' || last == '`' || (first == ' ' && last == ' ' && !isBlank(text)) {
			pad = " "
		}
	}
	return fence + pad + text + pad + fence
}

func mdMathSpan(tex string, cell bool) string {
	flat := jsTrim(collapseJSSpace(tex))
	// A table cell ends at `|`, and `\|` stays as written inside math: spell the bars as commands.
	if cell && strings.IndexByte(flat, '|') >= 0 {
		flat = strings.ReplaceAll(flat, `\|`, `\Vert `)
		flat = strings.ReplaceAll(flat, "|", `\vert `)
		flat = jsTrim(mdCollapseSpaces(flat))
	}
	if strings.IndexByte(flat, '$') < 0 {
		return "$" + flat + "$"
	}
	return "$$" + flat + "$$"
}

// mdCollapseSpaces is `s.replace(/ {2,}/g, ' ')`.
func mdCollapseSpaces(s string) string {
	if !strings.Contains(s, "  ") {
		return s
	}
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == ' ' && i > 0 && s[i-1] == ' ' {
			continue
		}
		b = append(b, s[i])
	}
	return bytesString(b)
}

// What a byte of an address means to mdDestination (0 nothing).
const (
	mdDestBracket = 1 + iota // control, space, `<`, `>`
	mdDestOpen
	mdDestClose
	mdDestEscape // `\`, `&`
)

var mdDestClass = func() (t [256]uint8) {
	for c := 0; c <= ' '; c++ {
		t[c] = mdDestBracket
	}
	t['<'], t['>'] = mdDestBracket, mdDestBracket
	t['('], t[')'] = mdDestOpen, mdDestClose
	t['\\'], t['&'] = mdDestEscape, mdDestEscape
	return t
}()

// mdDestination is a link or image destination: bare, or in `<…>` when it holds spaces, angle brackets or unbalanced parentheses.
func mdDestination(url string) string {
	// One pass over the address decides everything; most need nothing.
	depth := 0
	bracket := false
	escape := false
	for i := 0; i < len(url); i++ {
		// Most bytes of an address mean nothing here: skip them four at a time.
		for ; i+4 <= len(url); i += 4 {
			s := url[i : i+4]
			if mdDestClass[s[0]]|mdDestClass[s[1]]|mdDestClass[s[2]]|mdDestClass[s[3]] != 0 {
				break
			}
		}
		if i == len(url) {
			break
		}
		switch mdDestClass[url[i]] {
		case 0:
		case mdDestBracket:
			bracket = true
		case mdDestOpen:
			depth++
		case mdDestClose:
			depth--
			if depth < 0 {
				bracket = true
			}
		case mdDestEscape:
			escape = true
		}
	}
	out := url
	if escape {
		out = strings.ReplaceAll(out, `\`, `\\`)
		if strings.IndexByte(out, '&') >= 0 {
			var b strings.Builder
			b.Grow(len(out) + 4)
			start := 0
			for i := 0; i < len(out); i++ {
				if out[i] == '&' && mdEntityAt(out, i) {
					b.WriteString(out[start:i])
					b.WriteString(`\&`)
					start = i + 1
				}
			}
			b.WriteString(out[start:])
			out = b.String()
		}
	}
	if !bracket && depth == 0 {
		return out
	}
	var b strings.Builder
	b.Grow(len(out) + 4)
	b.WriteByte('<')
	for i := 0; i < len(out); i++ {
		if c := out[i]; c == '<' || c == '>' {
			b.WriteByte('\\')
		}
		b.WriteByte(out[i])
	}
	b.WriteByte('>')
	return b.String()
}

// mdImage writes a figure image or, with no href, an inline image.
func mdImage(src, alt, href string) string {
	md := "![" + mdEscapeText(jsTrim(collapseJSSpace(alt)), false, false) + "](" + mdDestination(src) + ")"
	if href == "" {
		return md
	}
	return "[" + md + "](" + mdDestination(href) + ")"
}

// mdIsAutolink is `/^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/`: such a URL can be written as `<url>`.
func mdIsAutolink(url string) bool {
	if url == "" || !mdIsASCIILetter(rune(url[0])) {
		return false
	}
	i := 1
	for i < len(url) && (mdIsAlnum(url[i]) || url[i] == '+' || url[i] == '.' || url[i] == '-') {
		i++
	}
	if i-1 < 1 || i-1 > 31 || i >= len(url) || url[i] != ':' {
		return false
	}
	for _, r := range url[i+1:] {
		if r == '<' || r == '>' || isJSSpace(r) {
			return false
		}
	}
	return true
}

// mdBareLink is `<url>` when the URL is a valid autolink, else a link labeled with the URL.
func mdBareLink(url string) string {
	if mdIsAutolink(url) {
		return "<" + url + ">"
	}
	return "[" + mdEscapeText(url, false, false) + "](" + mdDestination(url) + ")"
}

// ------------------------------------------------------------------ line starts

// mdSpaceOrEnd is `(?=\s|$)` at i.
func mdSpaceOrEnd(s string, i int) bool {
	if i >= len(s) {
		return true
	}
	if c := s[i]; c < utf8.RuneSelf {
		return isJSSpace(rune(c))
	}
	r, _ := utf8.DecodeRuneInString(s[i:])
	return isJSSpace(r)
}

// mdLineStartEscape is where a backslash keeps a line from starting a heading,
// quote, list or setext underline, or -1 when it needs none:
// `/^(?:#{1,6}(?=\s|$)|>|[-+](?=\s|$)|(?:-[ \t]*)+$|=+[ \t]*$)/` escapes the
// first character, `/^(\d{1,9})([.)])(?=\s|$)/` the delimiter after the number.
func mdLineStartEscape(line string) int {
	if line == "" {
		return -1
	}
	switch c := line[0]; c {
	case '>':
		return 0
	case '#':
		n := 1
		for n < len(line) && line[n] == '#' {
			n++
		}
		if n <= 6 && mdSpaceOrEnd(line, n) {
			return 0
		}
	case '+':
		if mdSpaceOrEnd(line, 1) {
			return 0
		}
	case '-':
		if mdSpaceOrEnd(line, 1) {
			return 0
		}
		for i := 1; i < len(line); i++ {
			if c := line[i]; c != '-' && c != ' ' && c != '\t' {
				return -1
			}
		}
		return 0
	case '=':
		i := 1
		for i < len(line) && line[i] == '=' {
			i++
		}
		for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
			i++
		}
		if i == len(line) {
			return 0
		}
	default:
		if !mdIsDigit(c) {
			return -1
		}
		n := 1
		for n < len(line) && mdIsDigit(line[n]) {
			n++
		}
		if n <= 9 && n < len(line) && (line[n] == '.' || line[n] == ')') && mdSpaceOrEnd(line, n+1) {
			return n
		}
	}
	return -1
}

// mdEscapeLineStart escapes a line that would otherwise start a heading, quote, list or setext underline.
func mdEscapeLineStart(line string) string {
	at := mdLineStartEscape(line)
	if at < 0 {
		return line
	}
	return line[:at] + `\` + line[at:]
}

func mdEscapeLines(text string) string {
	if strings.IndexByte(text, '\n') < 0 {
		return mdEscapeLineStart(text)
	}
	var b []byte
	for start := 0; ; {
		end := strings.IndexByte(text[start:], '\n')
		if end < 0 {
			end = len(text)
		} else {
			end += start
		}
		line := text[start:end]
		if at := mdLineStartEscape(line); at >= 0 {
			if b == nil {
				b = make([]byte, 0, len(text)+8)
				b = append(b, text[:start]...)
			}
			b = append(b, line[:at]...)
			b = append(b, '\\')
			b = append(b, line[at:]...)
		} else if b != nil {
			b = append(b, line...)
		}
		if end == len(text) {
			break
		}
		if b != nil {
			b = append(b, '\n')
		}
		start = end + 1
	}
	if b == nil {
		return text
	}
	return bytesString(b)
}

// ------------------------------------------------------------------ blocks

func mdHeading(level int, text string) string {
	// A trailing `#` run after a space would be read as a closing sequence: `/(^|\s)(#+)$/`.
	r := len(text)
	for r > 0 && text[r-1] == '#' {
		r--
	}
	var hashes string
	if level >= 1 && level <= 6 {
		hashes = "######"[:level]
	} else {
		hashes = strings.Repeat("#", level)
	}
	if r == len(text) || (r > 0 && !isJSSpace(mdLastChar(text[:r]))) {
		return hashes + " " + text
	}
	return hashes + " " + text[:r] + `\` + text[r:]
}

// mdIsSetextUnderline is `/^(?:-+|=+)[ \t]*(?:\n|$)/`.
func mdIsSetextUnderline(s string) bool {
	if s == "" || (s[0] != '-' && s[0] != '=') {
		return false
	}
	i := 1
	for i < len(s) && s[i] == s[0] {
		i++
	}
	for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	return i == len(s) || s[i] == '\n'
}

// mdAfterLine is line, then content on the next line, or after a blank line where it would underline line into a heading.
func mdAfterLine(line, content string) string {
	if content == "" {
		return line
	}
	if mdIsSetextUnderline(content) {
		return line + "\n\n" + content
	}
	return line + "\n" + content
}

// mdWriteIndented is the engine's `indent(text, first, rest)` written into b,
// less the first prefix, which the caller writes: every following line that
// is not empty starts with rest.
func mdWriteIndented(b *strings.Builder, text, rest string) {
	for start := 0; ; {
		end := strings.IndexByte(text[start:], '\n')
		if end < 0 {
			b.WriteString(text[start:])
			break
		}
		b.WriteString(text[start : start+end])
		start += end + 1
		b.WriteByte('\n')
		if start < len(text) && text[start] != '\n' {
			b.WriteString(rest)
		}
	}
}

func mdQuote(text string) string {
	var b strings.Builder
	b.Grow(len(text) + 2 + strings.Count(text, "\n")*2)
	for start := 0; ; {
		end := strings.IndexByte(text[start:], '\n')
		if end < 0 {
			end = len(text)
		} else {
			end += start
		}
		if end == start {
			b.WriteByte('>')
		} else {
			b.WriteString("> ")
			b.WriteString(text[start:end])
		}
		if end == len(text) {
			break
		}
		b.WriteByte('\n')
		start = end + 1
	}
	return b.String()
}

// mdAlertName is the GitHub alert for a callout variant (`ALERT[variant]`).
func mdAlertName(variant string) string {
	switch variant {
	case "note", "info":
		return "NOTE"
	case "tip":
		return "TIP"
	case "warning":
		return "WARNING"
	case "danger":
		return "CAUTION"
	}
	return "undefined" // as the engine writes a variant the model does not define
}

// mdWriter renders blocks, tracking footnote labels and calls.
type mdWriter struct {
	// Footnote id → label written in `[^label]`.
	notes map[string]string
	// Footnote ids with a `[^label]` call written so far.
	called map[string]bool
	// Footnote ids written as plain text (no call yet) by the latest pass over the footnotes.
	uncalled []string
	// Reused by every inline call (they never nest): its atoms and the line spans lays them out on.
	atoms []mdAtom
	line  []byte
}

func newMDWriter(blocks []Block) *mdWriter {
	w := &mdWriter{}
	var used map[string]bool
	var visit func(list []Block)
	visit = func(list []Block) {
		for _, block := range list {
			switch b := block.(type) {
			case *Footnotes:
				if w.notes == nil {
					w.notes = make(map[string]string, len(b.Items))
					w.called = make(map[string]bool, len(b.Items))
					used = make(map[string]bool, len(b.Items))
				}
				for _, item := range b.Items {
					if _, ok := w.notes[item.ID]; ok {
						continue
					}
					label := mdClean(item.Label)
					if label == "" || used[label] {
						label = mdClean(item.ID)
					}
					if label == "" {
						label = "note"
					}
					if used[label] {
						n := 2
						for used[label+"-"+strconv.Itoa(n)] {
							n++
						}
						label += "-" + strconv.Itoa(n)
					}
					used[label] = true
					w.notes[item.ID] = label
				}
			case *List:
				for _, item := range b.Items {
					visit(item.Blocks)
				}
			case *Quote:
				visit(b.Blocks)
			case *Details:
				visit(b.Blocks)
			case *Callout:
				visit(b.Blocks)
			case *DefinitionList:
				for _, item := range b.Items {
					visit(item.Details)
				}
			}
		}
	}
	visit(blocks)
	return w
}

// mdClean replaces each run of characters outside `[A-Za-z0-9_-]` with `-` and drops the dashes at both ends.
func mdClean(label string) string {
	b := make([]byte, 0, len(label))
	replaced := false
	for i := 0; i < len(label); i++ {
		c := label[i]
		if mdIsAlnum(c) || c == '_' || c == '-' {
			b = append(b, c)
			replaced = false
		} else if !replaced {
			b = append(b, '-')
			replaced = true
		}
	}
	return strings.Trim(string(b), "-")
}

// inline renders inline content. line writes breaks as spaces (headings,
// table cells, terms); mask is the marks already applied around it.
func (w *mdWriter) inline(content []Inline, line bool, mask int, cell bool) string {
	if len(content) == 1 {
		if only, ok := content[0].(*TextRun); ok && only.Marks == nil && only.Href == "" {
			return mdEscapeText(only.Text, false, false)
		}
	}
	atoms := w.atoms[:0]
	for i, node := range content {
		switch n := node.(type) {
		case *TextRun:
			marks := 0
			code := false
			for _, m := range n.Marks {
				switch m {
				case MarkBold:
					marks |= mdBold
				case MarkItalic:
					marks |= mdItalic
				case MarkStrike:
					marks |= mdStrike
				case MarkCode, MarkKbd:
					code = true
				}
			}
			if code && len(atoms) > 0 {
				if last := &atoms[len(atoms)-1]; last.isCode && last.marks == marks && last.href == n.Href {
					// Neighbouring code spans would run their backticks together: one span holds both.
					last.code += n.Text
					last.md = mdCodeSpan(last.code)
					continue
				}
			}
			if code {
				atoms = append(atoms, mdAtom{md: mdCodeSpan(n.Text), marks: marks, href: n.Href, code: n.Text, isCode: true})
			} else {
				atoms = append(atoms, mdAtom{md: mdEscapeText(n.Text, i < len(content)-1, n.Href != ""), marks: marks, href: n.Href})
			}
		case *LineBreak:
			md := "\\\n"
			if line {
				md = " "
			}
			atoms = append(atoms, mdAtom{md: md})
		case *InlineImage:
			atoms = append(atoms, mdAtom{md: mdImage(n.Src, n.Alt, "")})
		case *InlineMath:
			var md string
			if n.Tex != "" && !isBlank(n.Tex) {
				md = mdMathSpan(n.Tex, cell)
			} else {
				md = mdEscapeText(n.Text, false, false)
			}
			atoms = append(atoms, mdAtom{md: md})
		case *FootnoteRef:
			var md string
			if label, ok := w.notes[n.ID]; ok {
				w.called[n.ID] = true
				md = "[^" + label + "]"
			} else {
				md = mdEscapeText(n.Label, false, false)
			}
			atoms = append(atoms, mdAtom{md: md})
		}
	}
	w.atoms = atoms
	if len(atoms) == 1 && atoms[0].marks&^mask == 0 && atoms[0].href == "" {
		return atoms[0].md // nothing to lay out
	}
	edge := mdNoChar
	if mask != 0 {
		edge = '*'
	}
	w.line = w.line[:0]
	w.spans(atoms, 0, len(atoms), mask, edge, edge)
	return string(w.line)
}

func (w *mdWriter) paragraph(content []Inline) string {
	md := w.inline(content, false, 0, false)
	// A line of only no-break or ideographic spaces is not blank to a parser: it would be an empty-looking paragraph.
	if md == "" || (isJSSpace(mdFirstChar(md)) && isBlank(md)) {
		return ""
	}
	return mdEscapeLines(md)
}

// strong is a bold line (definition terms, summaries, callout titles).
func (w *mdWriter) strong(content []Inline) string {
	text := jsTrim(w.inline(content, true, mdBold, false))
	if text == "" {
		return ""
	}
	return mdEscapeLineStart("**" + text + "**")
}

// blocks joins blocks by separator.
func (w *mdWriter) blocks(blocks []Block, separator string) string {
	if len(blocks) == 1 {
		return w.block(blocks[0]) // what blockParts writes for a lone block, list or not
	}
	return mdJoin(w.blockParts(blocks, false), separator)
}

// blockParts renders each block ("" for one that writes nothing). At the top
// level footnotes are written last: a note nothing calls is invisible as a GFM
// definition, so it becomes plain text instead.
func (w *mdWriter) blockParts(blocks []Block, top bool) []string {
	parts := make([]string, len(blocks))
	var deferred []int
	var previous *List
	alternate := false
	for i, block := range blocks {
		var md string
		list, isList := block.(*List)
		if isList {
			// Two lists in a row would merge: the second switches its marker (`-` / `*`, `.` / `)`).
			alternate = previous != nil && previous.Ordered == list.Ordered && !alternate
			md = w.list(list, alternate)
		} else if _, isNotes := block.(*Footnotes); top && isNotes {
			deferred = append(deferred, i)
		} else {
			md = w.block(block)
		}
		parts[i] = md
		if md != "" || (len(deferred) > 0 && deferred[len(deferred)-1] == i) {
			previous = list // nil unless a list
		}
	}
	if len(deferred) > 0 {
		w.uncalled = w.uncalled[:0]
		for _, i := range deferred {
			parts[i] = w.footnotes(blocks[i].(*Footnotes))
		}
		// A note written as text before a later note called it: write them again now that every call is known.
		for _, id := range w.uncalled {
			if w.called[id] {
				for _, i := range deferred {
					parts[i] = w.footnotes(blocks[i].(*Footnotes))
				}
				break
			}
		}
	}
	return parts
}

// mdJoin joins the non-empty parts with separator.
func mdJoin(parts []string, separator string) string {
	n, count := 0, 0
	var only string
	for _, p := range parts {
		if p != "" {
			n += len(p)
			count++
			only = p
		}
	}
	switch count {
	case 0:
		return ""
	case 1:
		return only
	}
	var b strings.Builder
	b.Grow(n + (count-1)*len(separator))
	first := true
	for _, p := range parts {
		if p == "" {
			continue
		}
		if !first {
			b.WriteString(separator)
		}
		b.WriteString(p)
		first = false
	}
	return b.String()
}

func (w *mdWriter) block(block Block) string {
	switch b := block.(type) {
	case *Heading:
		text := w.inline(b.Content, true, 0, false)
		if text == "" {
			return ""
		}
		return mdHeading(b.Level, text)
	case *Paragraph:
		return w.paragraph(b.Content)
	case *List:
		return w.list(b, false)
	case *Quote:
		inner := w.blocks(b.Blocks, "\n\n")
		if b.Cite != nil {
			if cite := w.inline(b.Cite, false, 0, false); cite != "" {
				if inner != "" {
					inner += "\n\n— " + cite
				} else {
					inner = "— " + cite
				}
			}
		}
		if inner == "" {
			return ""
		}
		return mdQuote(inner)
	case *Code:
		return mdCodeBlock(b)
	case *Figure:
		parts := make([]string, 0, len(b.Images)+2)
		for _, img := range b.Images {
			parts = append(parts, mdImage(img.Src, img.Alt, img.Href))
		}
		if b.Caption != nil {
			parts = append(parts, w.paragraph(b.Caption))
		}
		if b.Credit != nil {
			parts = append(parts, w.paragraph(b.Credit))
		}
		return mdJoin(parts, "\n\n")
	case *Video:
		return w.media(b.Title, b.URL, b.Poster, b.Caption)
	case *Audio:
		return w.media(b.Title, b.URL, "", b.Caption)
	case *Embed:
		source := mdBareLink(b.URL)
		if b.Author != "" {
			source = mdEscapeText(b.Author, false, false) + ", " + source
		}
		inner := w.blocks(b.Blocks, "\n\n")
		if inner == "" {
			return mdEscapeLineStart(source)
		}
		return mdQuote(inner + "\n\n— " + source)
	case *Table:
		return w.table(b)
	case *Rule:
		return "---"
	case *MathBlock:
		if b.Tex != "" {
			if tex := jsTrimEnd(mdMathEdgeLines(b.Tex)); !isBlank(tex) {
				return "$$\n" + tex + "\n$$"
			}
		}
		return mdEscapeLines(mdEscapeText(b.Text, false, false))
	case *DefinitionList:
		parts := make([]string, 0, len(b.Items))
		for _, item := range b.Items {
			term := w.strong(item.Term)
			details := w.blocks(item.Details, "\n\n")
			if term != "" && details != "" {
				parts = append(parts, term+"\n\n"+details)
			} else {
				parts = append(parts, term+details)
			}
		}
		return mdJoin(parts, "\n\n")
	case *Details:
		summary := w.strong(b.Summary)
		inner := w.blocks(b.Blocks, "\n\n")
		if summary != "" && inner != "" {
			return summary + "\n\n" + inner
		}
		return summary + inner
	case *Callout:
		title := ""
		if b.Title != nil {
			title = w.strong(b.Title)
		}
		inner := w.blocks(b.Blocks, "\n\n")
		if title != "" {
			if inner != "" {
				inner = title + "\n\n" + inner
			} else {
				inner = title
			}
		}
		if b.Variant != "" {
			return mdQuote(mdAfterLine("[!"+mdAlertName(b.Variant)+"]", inner))
		}
		if inner == "" {
			return ""
		}
		return mdQuote(inner)
	case *Footnotes:
		return w.footnotes(b)
	}
	return ""
}

// media writes a video (with a poster, as a linked image) or an audio block.
func (w *mdWriter) media(title, url, poster string, caption []Inline) string {
	if title != "" {
		title = mdEscapeText(title, false, false)
	}
	var md string
	switch {
	case poster != "":
		md = "[![" + title + "](" + mdDestination(poster) + ")](" + mdDestination(url) + ")"
	case title != "":
		md = "[" + title + "](" + mdDestination(url) + ")"
	default:
		md = mdBareLink(url)
	}
	if caption != nil {
		if c := w.paragraph(caption); c != "" {
			return md + "\n\n" + c
		}
	}
	return md
}

// mdMathEdgeLines removes `/^\s*\n|\n\s*$/g`: blank lines before and after a display formula.
func mdMathEdgeLines(tex string) string {
	start := 0
	// `^\s*\n` reaches the last newline of the leading whitespace.
	lead := len(tex) - len(jsTrimStart(tex))
	if nl := strings.LastIndexByte(tex[:lead], '\n'); nl >= 0 {
		start = nl + 1
	}
	// `\n\s*$` starts at the first newline of the trailing whitespace after that.
	from := len(jsTrimEnd(tex))
	if from < start {
		from = start
	}
	end := len(tex)
	if nl := strings.IndexByte(tex[from:], '\n'); nl >= 0 {
		end = from + nl
	}
	return tex[start:end]
}

func (w *mdWriter) list(l *List, alternate bool) string {
	// Tight unless an item holds blocks that need a blank line between them.
	tight := true
	for _, item := range l.Items {
		blocks := item.Blocks
		if len(blocks) <= 1 {
			continue
		}
		_, paragraph := blocks[0].(*Paragraph)
		nested, isList := blocks[1].(*List)
		// Only a bullet list or one starting at 1 may interrupt a paragraph.
		if len(blocks) != 2 || !paragraph || !isList ||
			!((!nested.Ordered || nested.Start == nil || *nested.Start == 1) && len(nested.Items) > 0 && len(nested.Items[0].Blocks) > 0) {
			tight = false
			break
		}
	}
	start := 1
	if l.Start != nil && *l.Start >= 0 && *l.Start <= 999_999_999-len(l.Items) {
		start = *l.Start
	}
	separator := "\n\n"
	if tight {
		separator = "\n"
	}
	// Items are rendered first (in order, as footnote calls are counted), then written once.
	contents := make([]string, len(l.Items))
	size := 0
	for i, item := range l.Items {
		content := w.blocks(item.Blocks, separator)
		if item.Checked != nil {
			box := "[ ]"
			if *item.Checked {
				box = "[x]"
			}
			_, paragraph := mdFirstBlock(item.Blocks).(*Paragraph)
			if paragraph && content != "" {
				content = box + " " + content
			} else {
				content = mdAfterLine(box, content)
			}
		}
		contents[i] = content
		// A marker and its space take at most 11 bytes (start+i < 999_999_999), as does the indent of a further line.
		size += len(separator) + 11 + len(content) + strings.Count(content, "\n")*11
	}
	var b strings.Builder
	b.Grow(size)
	var digits [20]byte
	for i, content := range contents {
		if i > 0 {
			b.WriteString(separator)
		}
		indent := "  "
		switch {
		case l.Ordered:
			delimiter := byte('.')
			if alternate {
				delimiter = ')'
			}
			marker := append(strconv.AppendInt(digits[:0], int64(start+i), 10), delimiter)
			b.Write(marker)
			indent = mdSpaces(len(marker) + 1)
		case alternate:
			b.WriteByte('*')
		default:
			b.WriteByte('-')
		}
		if content != "" {
			b.WriteByte(' ')
			mdWriteIndented(&b, content, indent)
		}
	}
	return b.String()
}

func mdFirstBlock(blocks []Block) Block {
	if len(blocks) == 0 {
		return nil
	}
	return blocks[0]
}

// mdSpaces is `' '.repeat(n)` without allocating for list markers of usual widths.
func mdSpaces(n int) string {
	const spaces = "                "
	if n <= len(spaces) {
		return spaces[:n]
	}
	return strings.Repeat(" ", n)
}

// mdCell is a grid position: JavaScript's sparse arrays tell a hole (unset)
// from an empty string, and the row length counts holes.
type mdCell struct {
	text string
	set  bool
}

func (w *mdWriter) table(t *Table) string {
	// Lay the cells on a grid: spanned positions stay empty, as GFM tables have no spans.
	grid := make([][]mdCell, len(t.Rows))
	var align []string
	width := 0
	for r, row := range t.Rows {
		c := 0
		for _, cell := range row.Cells {
			for c < len(grid[r]) && grid[r][c].set {
				c++
			}
			text := w.inline(cell.Content, true, 0, true)
			if strings.IndexByte(text, '|') >= 0 {
				text = strings.ReplaceAll(text, "|", `\|`)
			}
			colspan := min(max(cell.Colspan, 1), 1000) // absent (0) is 1
			rowspan := min(max(cell.Rowspan, 1), len(t.Rows)-r)
			if r == 0 && cell.Align != "" {
				for len(align) <= c {
					align = append(align, "")
				}
				align[c] = cell.Align
			}
			for dr := 0; dr < rowspan; dr++ {
				target := grid[r+dr]
				if n := c + colspan; n > len(target) {
					target = append(target, make([]mdCell, n-len(target))...)
				}
				for dc := 0; dc < colspan; dc++ {
					target[c+dc] = mdCell{set: true}
				}
				if dr == 0 {
					target[c].text = text
				}
				grid[r+dr] = target
			}
			c += colspan
		}
		if len(grid[r]) > width {
			width = len(grid[r])
		}
	}
	if width == 0 {
		return ""
	}
	var header []mdCell
	if t.HeaderRows > 0 {
		header = grid[0]
	}
	size := (len(grid) + 2) * (width*3 + 2)
	for _, row := range grid {
		for _, cell := range row {
			size += len(cell.text)
		}
	}
	var b strings.Builder
	b.Grow(size)
	line := func(cells []mdCell) {
		b.WriteByte('|')
		for c := 0; c < width; c++ {
			if c < len(cells) && cells[c].text != "" {
				b.WriteByte(' ')
				b.WriteString(cells[c].text)
				b.WriteString(" |")
			} else {
				b.WriteString("  |")
			}
		}
	}
	line(header)
	b.WriteString("\n|")
	for c := 0; c < width; c++ {
		a := ""
		if c < len(align) {
			a = align[c]
		}
		switch a {
		case "center":
			b.WriteString(" :-: |")
		case "right":
			b.WriteString(" --: |")
		case "left":
			b.WriteString(" :-- |")
		default:
			b.WriteString(" --- |")
		}
	}
	first := 0
	if len(header) > 0 {
		first = 1
	}
	for r := first; r < len(grid); r++ {
		b.WriteByte('\n')
		line(grid[r])
	}
	md := b.String()
	if t.Caption != nil {
		if caption := w.paragraph(t.Caption); caption != "" {
			return caption + "\n\n" + md
		}
	}
	return md
}

// footnotes writes each note as a GFM definition when something calls it, else as text after its label.
func (w *mdWriter) footnotes(block *Footnotes) string {
	// Notes are rendered first (in order, as calls are counted), then written once.
	type note struct {
		label, content string // label: the call's, or the note's own as escaped text
		called         bool
		paragraph      bool
	}
	notes := make([]note, len(block.Items))
	size := 0
	for i, item := range block.Items {
		n := &notes[i]
		n.content = w.blocks(item.Blocks, "\n\n")
		if w.called[item.ID] {
			n.label, n.called = w.notes[item.ID], true
			size += strings.Count(n.content, "\n") * 4
		} else {
			w.uncalled = append(w.uncalled, item.ID)
			n.label = mdEscapeText("["+item.Label+"]", false, false)
			_, n.paragraph = mdFirstBlock(item.Blocks).(*Paragraph)
		}
		size += len(n.label) + len(n.content) + 8
	}
	var b strings.Builder
	b.Grow(size)
	for i, n := range notes {
		if i > 0 {
			b.WriteString("\n\n")
		}
		switch {
		case n.called:
			b.WriteString("[^")
			b.WriteString(n.label)
			b.WriteString("]:")
			if n.content != "" {
				b.WriteByte(' ')
				mdWriteIndented(&b, n.content, "    ")
			}
			continue
		case n.content == "":
			b.WriteString(n.label)
			continue
		case n.paragraph:
			b.WriteString(n.label)
			b.WriteByte(' ')
		default:
			b.WriteString(n.label)
			b.WriteString("\n\n")
		}
		b.WriteString(n.content)
	}
	return b.String()
}

func mdCodeBlock(block *Code) string {
	info := block.Language
	if block.Title != nil {
		if title := jsTrim(collapseJSSpace(*block.Title)); title != "" {
			if info == "" {
				info = "text"
			}
			var b strings.Builder
			b.Grow(len(info) + len(title) + 12)
			b.WriteString(info)
			b.WriteString(` title="`)
			for i := 0; i < len(title); i++ {
				if c := title[i]; c == '\\' || c == '"' {
					b.WriteByte('\\')
				}
				b.WriteByte(title[i])
			}
			b.WriteByte('"')
			info = b.String()
		}
	}
	// Backtick fences cannot carry a backtick in their info string; tildes can.
	fenceChar := byte('`')
	if strings.IndexByte(info, '`') >= 0 {
		fenceChar = '~'
	}
	fence := strings.Repeat(string(fenceChar), max(3, mdLongestRun(block.Code, fenceChar)+1))
	code := block.Code
	newline := ""
	if code != "" && code[len(code)-1] != '\n' {
		newline = "\n"
	}
	return fence + info + "\n" + code + newline + fence
}
