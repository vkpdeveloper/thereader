// Copyright 2010 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

// The HTML tokenizer (HTML Standard 13.2.5), forked from golang.org/x/net/html
// (token.go) and reworked to scan the source string in place: names are
// interned (html_atom.go), text, comments and attribute values are substrings
// of the source unless a character reference or a NUL must be rewritten, and
// the token is a reused struct on the parser. Departures from x/net, all
// towards the standard (and Chromium, parse5): duplicate attributes are
// dropped (first wins), NUL becomes U+FFFD in names and attribute values,
// "</>" emits nothing, numeric references follow the standard to the letter
// (see html_entity.go), the doctype is tokenized by the standard's state
// machine, and the tree builder, not the tokenizer, switches to the raw text
// states, exactly where the standard says so.

package truffle

import (
	"strings"
	"unicode/utf8"
	"unsafe"
)

type tokenType uint8

const (
	eofToken tokenType = iota
	textToken
	startTagToken
	endTagToken
	commentToken
	doctypeToken
)

// token is the current token. It is reused: attrs is the tokenizer's scratch
// buffer, copied when an element is created.
type token struct {
	typ  tokenType
	atom atom
	// data is the tag name (lowercase), the text (character references
	// decoded) or the comment data.
	data        string
	attrs       []Attr
	selfClosing bool
}

// rawKind is the tokenizer state the tree builder asks for after inserting
// an element whose content is not markup.
type rawKind uint8

const (
	rawNone       rawKind = iota
	rawRCDATA             // title, textarea: character references are decoded
	rawRAWTEXT            // style, xmp, iframe, noembed, noframes
	rawScriptData         // script data, with its escape states
	rawPlaintext          // plaintext: everything up to the end of the input
)

// doctypeToken data, kept apart from token as only the initial mode reads it.
type doctypeData struct {
	name, publicID, systemID string
	hasPublic, hasSystem     bool
	forceQuirks              bool
}

const (
	ccSpace   = 1 << iota // \t \n \f \r and space
	ccNameEnd             // ends a tag name: space, '/', '>'
	ccAttrEnd             // ends an attribute name: space, '/', '>', '='
	ccAlpha               // ASCII letters
	ccAlnum               // ASCII letters and digits
	ccValEnd              // ends an unquoted attribute value: space, '>'
	ccUpper               // A-Z
)

var charClass = func() (t [256]uint8) {
	for _, c := range []byte(" \t\n\f\r") {
		t[c] |= ccSpace | ccNameEnd | ccAttrEnd | ccValEnd
	}
	t['/'] |= ccNameEnd | ccAttrEnd
	t['>'] |= ccNameEnd | ccAttrEnd | ccValEnd
	t['='] |= ccAttrEnd
	for c := 'a'; c <= 'z'; c++ {
		t[c] |= ccAlpha | ccAlnum
		t[c-'a'+'A'] |= ccAlpha | ccAlnum | ccUpper
	}
	for c := '0'; c <= '9'; c++ {
		t[c] |= ccAlnum
	}
	return
}()

func isSpace(c byte) bool { return charClass[c]&ccSpace != 0 }

// indexByteFrom is the index of the first c in s at or after i, or -1.
func indexByteFrom(s string, i int, c byte) int {
	if j := strings.IndexByte(s[i:], c); j >= 0 {
		return i + j
	}
	return -1
}

// nextToken reads the next token into p.tok.
func (p *parser) nextToken() {
	t := &p.tok
	t.atom = 0
	t.selfClosing = false
	t.attrs = t.attrs[:0]
	if p.raw != rawNone {
		kind := p.raw
		p.raw = rawNone
		if p.readRawText(kind) {
			return
		}
	}
	src := p.src
	start := p.pos
	// pending is set once an ignored "</>" split the text: the text read so
	// far is then in p.pending.
	pending := false
	i := start
	for i < len(src) {
		i = indexByteFrom(src, i, '<')
		if i < 0 {
			i = len(src)
			break
		}
		if i+1 >= len(src) {
			i = len(src)
			break
		}
		c := src[i+1]
		if charClass[c]&ccAlpha == 0 && c != '!' && c != '?' {
			if c != '/' {
				i++
				continue
			}
			if i+2 >= len(src) {
				i = len(src)
				break
			}
			if src[i+2] == '>' {
				// "</>": a parse error that emits nothing; the text around it is one run.
				if !pending {
					pending = true
					p.pending = p.pending[:0]
				}
				p.pending = appendUnescaped(p.pending, src[start:i], false)
				i += 3
				start = i
				continue
			}
		}
		// Markup at i. Emit the text before it first.
		if i > start || pending {
			if p.emitText(start, i, pending) {
				p.pos = i
				return
			}
			pending = false
		}
		if p.readMarkup(i) {
			return
		}
		// The input ended inside a tag: the tag is dropped.
		break
	}
	if i > len(src) {
		i = len(src)
	}
	if i > start || pending {
		if p.emitText(start, i, pending) {
			p.pos = i
			return
		}
	}
	p.pos = len(src)
	t.typ = eofToken
	t.data = ""
}

// emitText sets p.tok to the text src[start:end] (after the pending text,
// if any) and reports whether it is non-empty.
func (p *parser) emitText(start, end int, pending bool) bool {
	var s string
	if pending {
		p.pending = appendUnescaped(p.pending, p.src[start:end], false)
		p.reserve(len(p.pending))
		at := len(p.tbuf)
		p.tbuf = append(p.tbuf, p.pending...)
		s = p.arenaString(at)
	} else {
		s = p.unescape(start, end, false)
	}
	if s == "" {
		return false
	}
	p.tok.typ = textToken
	p.tok.data = s
	return true
}

// readMarkup reads the tag, comment, doctype or CDATA section at src[i]
// ('<'). It reports false when the input ends inside a tag.
func (p *parser) readMarkup(i int) bool {
	src := p.src
	t := &p.tok
	c := src[i+1]
	switch {
	case charClass[c]&ccAlpha != 0:
		return p.readTag(i+1, false)
	case c == '/':
		if charClass[src[i+2]]&ccAlpha != 0 {
			return p.readTag(i+2, true)
		}
		// "</" followed by neither a letter nor ">": a bogus comment.
		p.bogusComment(i + 2)
		return true
	case c == '?':
		p.bogusComment(i + 1)
		return true
	}
	// "<!"
	j := i + 2
	if strings.HasPrefix(src[j:], "--") {
		p.readComment(j + 2)
		return true
	}
	if len(src)-j >= 7 && strings.EqualFold(src[j:j+7], "doctype") {
		p.readDoctype(j + 7)
		return true
	}
	if strings.HasPrefix(src[j:], "[CDATA[") && len(p.oe) > 0 && p.oe[len(p.oe)-1].ns != nsHTML {
		k := j + 7
		end := strings.Index(src[k:], "]]>")
		if end < 0 {
			p.pos = len(src)
			end = len(src)
		} else {
			end += k
			p.pos = end + 3
		}
		t.typ = textToken
		t.data = src[k:end]
		if t.data == "" {
			// An empty section is no token; read on.
			p.nextToken()
		}
		return true
	}
	p.bogusComment(j)
	return true
}

// bogusComment reads a comment whose data runs from src[i] to the next '>'.
func (p *parser) bogusComment(i int) {
	src := p.src
	end := strings.IndexByte(src[i:], '>')
	if end < 0 {
		end = len(src)
		p.pos = end
	} else {
		end += i
		p.pos = end + 1
	}
	p.setComment(src[i:end])
}

func (p *parser) setComment(s string) {
	if p.hasNUL {
		s = p.replaceNUL(s)
	}
	p.tok.typ = commentToken
	p.tok.data = s
}

// readComment reads a comment whose data starts at src[i], after "<!--".
// The comment ends at the first "-->" or "--!>"; "<!-->" and "<!--->" are
// empty comments; at the end of the input, a trailing "-", "--" or "--!" is
// not data (13.2.5.43-52: the other comment states only report errors).
func (p *parser) readComment(i int) {
	src := p.src
	rest := src[i:]
	if strings.HasPrefix(rest, ">") {
		p.pos = i + 1
		p.setComment("")
		return
	}
	if strings.HasPrefix(rest, "->") {
		p.pos = i + 2
		p.setComment("")
		return
	}
	for k := 0; ; {
		j := strings.Index(rest[k:], "--")
		if j < 0 {
			break
		}
		k += j
		if k+2 < len(rest) {
			switch rest[k+2] {
			case '>':
				p.pos = i + k + 3
				p.setComment(rest[:k])
				return
			case '!':
				if k+3 < len(rest) && rest[k+3] == '>' {
					p.pos = i + k + 4
					p.setComment(rest[:k])
					return
				}
			}
		}
		k++
	}
	p.pos = len(src)
	switch {
	case strings.HasSuffix(rest, "--!"):
		rest = rest[:len(rest)-3]
	case strings.HasSuffix(rest, "--"):
		rest = rest[:len(rest)-2]
	case strings.HasSuffix(rest, "-"):
		rest = rest[:len(rest)-1]
	}
	p.setComment(rest)
}

// readDoctype tokenizes a doctype whose text starts at src[i], after
// "<!DOCTYPE", with the DOCTYPE states of 13.2.5.53-68.
func (p *parser) readDoctype(i int) {
	src := p.src
	end := strings.IndexByte(src[i:], '>')
	eof := end < 0
	if eof {
		end = len(src)
		p.pos = end
	} else {
		end += i
		p.pos = end + 1
	}
	s := src[i:end]
	if p.hasNUL {
		s = p.replaceNUL(s)
	}
	d := &p.doctype
	*d = doctypeData{}
	p.tok.typ = doctypeToken
	k := skipSpace(s, 0)
	if k == len(s) {
		// Missing name.
		d.forceQuirks = true
		return
	}
	n := k
	for n < len(s) && !isSpace(s[n]) {
		n++
	}
	d.name = p.lowerName(s[k:n])
	k = skipSpace(s, n)
	if k == len(s) {
		d.forceQuirks = eof
		return
	}
	var system bool
	switch {
	case len(s)-k >= 6 && strings.EqualFold(s[k:k+6], "public"):
	case len(s)-k >= 6 && strings.EqualFold(s[k:k+6], "system"):
		system = true
	default:
		d.forceQuirks = true
		return
	}
	k += 6
	for {
		k = skipSpace(s, k)
		if k == len(s) || s[k] != '"' && s[k] != '\'' {
			// A missing identifier or a missing quote.
			d.forceQuirks = true
			return
		}
		q := s[k]
		e := strings.IndexByte(s[k+1:], q)
		if e < 0 {
			// '>' (or the end of the input) inside the identifier.
			e = len(s) - k - 1
			d.forceQuirks = true
		}
		id := s[k+1 : k+1+e]
		k += e + 2
		if system {
			d.systemID, d.hasSystem = id, true
			// Anything after the system identifier is bogus, but not quirky.
			if skipSpace(s, k) >= len(s) && eof {
				d.forceQuirks = true
			}
			return
		}
		d.publicID, d.hasPublic = id, true
		if d.forceQuirks {
			return
		}
		if skipSpace(s, k) >= len(s) {
			// No system identifier after the public one is fine.
			d.forceQuirks = eof
			return
		}
		system = true
	}
}

func skipSpace(s string, i int) int {
	for i < len(s) && isSpace(s[i]) {
		i++
	}
	return i
}

// readTag tokenizes the tag whose name starts at src[i] (13.2.5.8-40). It
// reports false when the input ends inside the tag, which drops the tag.
func (p *parser) readTag(i int, end bool) bool {
	src := p.src
	t := &p.tok
	// Tag name.
	start := i
	upper := false
	for ; i < len(src); i++ {
		if cc := charClass[src[i]]; cc&(ccNameEnd|ccUpper) != 0 {
			if cc&ccNameEnd != 0 {
				break
			}
			upper = true
		}
	}
	if i >= len(src) {
		p.pos = len(src)
		return false
	}
	t.atom, t.data = p.intern(start, i, upper)
	if end {
		t.typ = endTagToken
	} else {
		t.typ = startTagToken
	}
	// Attributes.
	for {
		for i < len(src) && charClass[src[i]]&ccSpace != 0 {
			i++
		}
		if i >= len(src) {
			p.pos = len(src)
			return false
		}
		c := src[i]
		if c == '>' {
			i++
			break
		}
		if c == '/' {
			if i+1 < len(src) && src[i+1] == '>' {
				t.selfClosing = true
				i += 2
				break
			}
			i++
			continue
		}
		// Attribute name: its first character may be '=' (13.2.5.32).
		ks := i
		upper := 'A' <= c && c <= 'Z'
		for i++; i < len(src); i++ {
			if cc := charClass[src[i]]; cc&(ccAttrEnd|ccUpper) != 0 {
				if cc&ccAttrEnd != 0 {
					break
				}
				upper = true
			}
		}
		ke := i
		for i < len(src) && charClass[src[i]]&ccSpace != 0 {
			i++
		}
		if i >= len(src) {
			p.pos = len(src)
			return false
		}
		vs, ve := i, i
		if src[i] == '=' {
			i++
			for i < len(src) && charClass[src[i]]&ccSpace != 0 {
				i++
			}
			if i >= len(src) {
				p.pos = len(src)
				return false
			}
			switch q := src[i]; q {
			case '"', '\'':
				vs = i + 1
				ve = indexByteFrom(src, vs, q)
				if ve < 0 {
					p.pos = len(src)
					return false
				}
				i = ve + 1
			case '>':
				// Missing value: the '>' ends the tag.
			default:
				vs = i
				for i < len(src) && charClass[src[i]]&ccValEnd == 0 {
					i++
				}
				if i >= len(src) {
					p.pos = len(src)
					return false
				}
				ve = i
			}
		}
		if end {
			continue
		}
		_, key := p.intern(ks, ke, upper)
		dup := false
		for k := range t.attrs {
			if t.attrs[k].Name == key {
				dup = true
				break
			}
		}
		if dup {
			continue
		}
		val := src[vs:ve]
		if val != "" {
			val = p.unescape(vs, ve, true)
			if p.hasNUL {
				val = p.replaceNUL(val)
			}
		}
		t.attrs = append(t.attrs, Attr{key, val})
	}
	p.pos = i
	return true
}

// intern returns the atom and the name for src[start:end], a tag or
// attribute name: the static name when interned, else the source substring
// (lowercased in the arena when it has capitals or NULs).
func (p *parser) intern(start, end int, upper bool) (atom, string) {
	name := p.src[start:end]
	if upper || p.hasNUL {
		name = p.lowerName(name)
		if a := findAtom(nameWord(name), name); a != 0 {
			return a, atomNames[a]
		}
		return 0, name
	}
	var w uint64
	if n := end - start; start+8 <= len(p.src) {
		// Read the word from the source, past the name's end, and mask.
		w = load8(p.src[start:])
		if n < 8 {
			w &= 1<<(8*n) - 1
		}
	} else {
		w = nameWord(name)
	}
	if a := findAtom(w, name); a != 0 {
		return a, atomNames[a]
	}
	return 0, name
}

// readRawText reads the content of a raw text element into p.tok as a text
// token, and reports whether it is non-empty. The end tag itself is left for
// the next token.
func (p *parser) readRawText(kind rawKind) bool {
	src := p.src
	start := p.pos
	var end int
	switch kind {
	case rawPlaintext:
		end = len(src)
	case rawScriptData:
		end = p.scanScript(start)
	default:
		end = len(src)
		for i := start; ; {
			j := strings.Index(src[i:], "</")
			if j < 0 {
				break
			}
			i += j
			if p.rawEndTagAt(i + 2) {
				end = i
				break
			}
			i += 2
		}
	}
	p.pos = end
	if end == start {
		return false
	}
	s := src[start:end]
	if kind == rawRCDATA {
		s = p.unescape(start, end, false)
	}
	if p.hasNUL {
		s = p.replaceNUL(s)
	}
	p.tok.typ = textToken
	p.tok.data = s
	return true
}

// rawEndTagAt reports whether src[i:] (after "</") is the name of the raw
// text element followed by a character that ends a tag name.
func (p *parser) rawEndTagAt(i int) bool {
	src, name := p.src, p.rawName
	if len(src)-i <= len(name) {
		return false
	}
	for k := 0; k < len(name); k++ {
		if lowerASCII(src[i+k]) != name[k] {
			return false
		}
	}
	return charClass[src[i+len(name)]]&ccNameEnd != 0
}

// scanScript returns the end of the script data starting at src[i]
// (13.2.5.15-31): the position of the "</script" that ends it, or the end of
// the input. The states that only emit characters are folded away.
func (p *parser) scanScript(i int) int {
	src := p.src
	n := len(src)
	var c byte
	// next reads one character; it reports false at the end of the input.
	next := func() bool {
		if i >= n {
			return false
		}
		c = src[i]
		i++
		return true
	}

scriptData:
	{
		j := strings.IndexByte(src[i:], '<')
		if j < 0 {
			return n
		}
		i += j + 1
	}
	// Script data less-than sign state.
	if !next() {
		return n
	}
	switch c {
	case '/':
		if p.rawEndTagAt(i) {
			return i - 2
		}
		goto scriptData
	case '!':
		if !next() {
			return n
		}
		if c != '-' {
			i--
			goto scriptData
		}
		if !next() {
			return n
		}
		if c != '-' {
			i--
			goto scriptData
		}
		goto escapedDashDash
	}
	i--
	goto scriptData

escaped:
	if !next() {
		return n
	}
	switch c {
	case '-':
		goto escapedDash
	case '<':
		goto escapedLessThan
	}
	goto escaped

escapedDash:
	if !next() {
		return n
	}
	switch c {
	case '-':
		goto escapedDashDash
	case '<':
		goto escapedLessThan
	}
	goto escaped

escapedDashDash:
	if !next() {
		return n
	}
	switch c {
	case '-':
		goto escapedDashDash
	case '<':
		goto escapedLessThan
	case '>':
		goto scriptData
	}
	goto escaped

escapedLessThan:
	if !next() {
		return n
	}
	if c == '/' {
		if p.rawEndTagAt(i) {
			return i - 2
		}
		goto escaped
	}
	if charClass[c]&ccAlpha == 0 {
		i--
		goto escaped
	}
	// Script data double escape start state: "<script" and a delimiter.
	i--
	if n-i > 6 && strings.EqualFold(src[i:i+6], "script") && charClass[src[i+6]]&ccNameEnd != 0 {
		i += 7
		goto doubleEscaped
	}
	goto escaped

doubleEscaped:
	if !next() {
		return n
	}
	switch c {
	case '-':
		goto doubleEscapedDash
	case '<':
		goto doubleEscapedLessThan
	}
	goto doubleEscaped

doubleEscapedDash:
	if !next() {
		return n
	}
	switch c {
	case '-':
		goto doubleEscapedDashDash
	case '<':
		goto doubleEscapedLessThan
	}
	goto doubleEscaped

doubleEscapedDashDash:
	if !next() {
		return n
	}
	switch c {
	case '-':
		goto doubleEscapedDashDash
	case '<':
		goto doubleEscapedLessThan
	case '>':
		goto scriptData
	}
	goto doubleEscaped

doubleEscapedLessThan:
	if !next() {
		return n
	}
	if c != '/' {
		i--
		goto doubleEscaped
	}
	// Script data double escape end state.
	if n-i > 6 && strings.EqualFold(src[i:i+6], "script") && charClass[src[i+6]]&ccNameEnd != 0 {
		i += 7
		goto escaped
	}
	goto doubleEscaped
}

// ------------------------------------------------------------------ strings

// reserve makes room for n more bytes in the text arena. Strings handed out
// point into the arena and its bytes are never written again, so a full
// chunk is left behind, not grown.
func (p *parser) reserve(n int) {
	if cap(p.tbuf)-len(p.tbuf) >= n {
		return
	}
	size := 8 << 10
	if n > size/4 {
		size = n
	}
	p.tbuf = make([]byte, 0, size)
}

// arenaString returns the arena bytes from start as a string.
func (p *parser) arenaString(start int) string {
	b := p.tbuf[start:]
	if len(b) == 0 {
		return ""
	}
	return unsafe.String(&b[0], len(b))
}

// unescape decodes the character references in src[start:end]; the source
// substring itself is returned when it has none.
func (p *parser) unescape(start, end int, inAttr bool) string {
	s := p.src[start:end]
	if !p.ampIn(start, end) {
		return s
	}
	p.reserve(len(s) + len(s)/4 + 8)
	at := len(p.tbuf)
	p.tbuf = appendUnescaped(p.tbuf, s, inAttr)
	return p.arenaString(at)
}

// ampIn reports whether src[start:end] holds an '&'. Spans are asked about
// in source order, so the position of the next '&' is cached: a page is
// searched for '&' once overall, not once per text and attribute value.
func (p *parser) ampIn(start, end int) bool {
	if p.ampAt < start || start < p.ampFrom {
		p.ampFrom = start
		if j := strings.IndexByte(p.src[start:], '&'); j >= 0 {
			p.ampAt = start + j
		} else {
			p.ampAt = len(p.src)
		}
	}
	return p.ampAt < end
}

// replaceNUL replaces NUL characters with U+FFFD.
func (p *parser) replaceNUL(s string) string {
	if strings.IndexByte(s, 0) < 0 {
		return s
	}
	p.reserve(len(s) * 3)
	start := len(p.tbuf)
	for i := 0; i < len(s); i++ {
		if s[i] == 0 {
			p.tbuf = append(p.tbuf, "�"...)
		} else {
			p.tbuf = append(p.tbuf, s[i])
		}
	}
	return p.arenaString(start)
}

// lowerName returns a tag or attribute name ASCII-lowercased, with NUL as
// U+FFFD; an already clean name is returned as is.
func (p *parser) lowerName(s string) string {
	clean := true
	for i := 0; i < len(s); i++ {
		if c := s[i]; 'A' <= c && c <= 'Z' || c == 0 {
			clean = false
			break
		}
	}
	if clean {
		return s
	}
	p.reserve(len(s) * 3)
	start := len(p.tbuf)
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == 0:
			p.tbuf = append(p.tbuf, "�"...)
		default:
			p.tbuf = append(p.tbuf, lowerASCII(c))
		}
	}
	return p.arenaString(start)
}

// concat joins two texts, appending in place when a is the newest arena
// string (adjacent text tokens merging into one DOM text node).
func (p *parser) concat(a, b string) string {
	if b == "" {
		return a
	}
	if len(a) > 0 && len(p.tbuf) >= len(a) && cap(p.tbuf)-len(p.tbuf) >= len(b) &&
		unsafe.StringData(a) == &p.tbuf[len(p.tbuf)-len(a)] {
		start := len(p.tbuf) - len(a)
		p.tbuf = append(p.tbuf, b...)
		return p.arenaString(start)
	}
	p.reserve(len(a) + len(b))
	start := len(p.tbuf)
	p.tbuf = append(p.tbuf, a...)
	p.tbuf = append(p.tbuf, b...)
	return p.arenaString(start)
}

// appendRune appends r UTF-8 encoded.
func appendRune(b []byte, r rune) []byte {
	if r < utf8.RuneSelf {
		return append(b, byte(r))
	}
	return utf8.AppendRune(b, r)
}
