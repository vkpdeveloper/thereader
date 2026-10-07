package truffle

// jsonParse is JSON.parse for the engine's purposes (JSON-LD, frame
// content): objects become map[string]any (a repeated key keeps its last
// value), arrays []any, numbers float64 (out of range is ±Inf, as in
// JavaScript), strings string, true/false bool and null nil. It accepts and
// rejects what JSON.parse does, which encoding/json does not quite (1e400),
// and skips reflection: pages ship JSON-LD by the tens of kilobytes.

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

type jsonParser struct {
	s   string
	i   int
	err bool
}

func jsonParse(text string) (any, bool) {
	p := &jsonParser{s: text}
	p.space()
	v := p.value(0)
	p.space()
	if p.err || p.i != len(p.s) {
		return nil, false
	}
	return v, true
}

func (p *jsonParser) space() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *jsonParser) fail() any {
	p.err = true
	return nil
}

func (p *jsonParser) value(depth int) any {
	if p.err || p.i >= len(p.s) || depth > 10000 {
		return p.fail()
	}
	switch c := p.s[p.i]; {
	case c == '{':
		p.i++
		obj := map[string]any{}
		p.space()
		if p.i < len(p.s) && p.s[p.i] == '}' {
			p.i++
			return obj
		}
		for {
			p.space()
			if p.i >= len(p.s) || p.s[p.i] != '"' {
				return p.fail()
			}
			key, ok := p.str()
			if !ok {
				return p.fail()
			}
			p.space()
			if p.i >= len(p.s) || p.s[p.i] != ':' {
				return p.fail()
			}
			p.i++
			p.space()
			v := p.value(depth + 1)
			if p.err {
				return nil
			}
			obj[key] = v
			p.space()
			if p.i >= len(p.s) {
				return p.fail()
			}
			if p.s[p.i] == ',' {
				p.i++
				continue
			}
			if p.s[p.i] == '}' {
				p.i++
				return obj
			}
			return p.fail()
		}
	case c == '[':
		p.i++
		arr := []any{}
		p.space()
		if p.i < len(p.s) && p.s[p.i] == ']' {
			p.i++
			return arr
		}
		for {
			p.space()
			v := p.value(depth + 1)
			if p.err {
				return nil
			}
			arr = append(arr, v)
			p.space()
			if p.i >= len(p.s) {
				return p.fail()
			}
			if p.s[p.i] == ',' {
				p.i++
				continue
			}
			if p.s[p.i] == ']' {
				p.i++
				return arr
			}
			return p.fail()
		}
	case c == '"':
		s, ok := p.str()
		if !ok {
			return p.fail()
		}
		return s
	case c == 't':
		if strings.HasPrefix(p.s[p.i:], "true") {
			p.i += 4
			return true
		}
	case c == 'f':
		if strings.HasPrefix(p.s[p.i:], "false") {
			p.i += 5
			return false
		}
	case c == 'n':
		if strings.HasPrefix(p.s[p.i:], "null") {
			p.i += 4
			return nil
		}
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	}
	return p.fail()
}

// number: -?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?
func (p *jsonParser) number() any {
	start := p.i
	if p.s[p.i] == '-' {
		p.i++
	}
	digits := func() int {
		n := 0
		for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
			p.i++
			n++
		}
		return n
	}
	if p.i < len(p.s) && p.s[p.i] == '0' {
		p.i++
	} else if digits() == 0 {
		return p.fail()
	}
	if p.i < len(p.s) && p.s[p.i] == '.' {
		p.i++
		if digits() == 0 {
			return p.fail()
		}
	}
	if p.i < len(p.s) && (p.s[p.i] == 'e' || p.s[p.i] == 'E') {
		p.i++
		if p.i < len(p.s) && (p.s[p.i] == '+' || p.s[p.i] == '-') {
			p.i++
		}
		if digits() == 0 {
			return p.fail()
		}
	}
	f, err := strconv.ParseFloat(p.s[start:p.i], 64)
	if err != nil && !math.IsInf(f, 0) {
		return p.fail()
	}
	return f
}

// str reads a string at p.i (an opening quote); raw control characters are an error, as in JSON.parse.
func (p *jsonParser) str() (string, bool) {
	p.i++
	start := p.i
	// Fast path: no escapes.
	for p.i < len(p.s) {
		c := p.s[p.i]
		if c == '"' {
			s := p.s[start:p.i]
			p.i++
			return s, true
		}
		if c == '\\' {
			break
		}
		if c < 0x20 {
			return "", false
		}
		p.i++
	}
	var b strings.Builder
	b.WriteString(p.s[start:p.i])
	for p.i < len(p.s) {
		c := p.s[p.i]
		switch {
		case c == '"':
			p.i++
			return b.String(), true
		case c < 0x20:
			return "", false
		case c != '\\':
			b.WriteByte(c)
			p.i++
			continue
		}
		if p.i+1 >= len(p.s) {
			return "", false
		}
		e := p.s[p.i+1]
		p.i += 2
		switch e {
		case '"', '\\', '/':
			b.WriteByte(e)
		case 'b':
			b.WriteByte('\b')
		case 'f':
			b.WriteByte('\f')
		case 'n':
			b.WriteByte('\n')
		case 'r':
			b.WriteByte('\r')
		case 't':
			b.WriteByte('\t')
		case 'u':
			r, ok := p.hex4()
			if !ok {
				return "", false
			}
			if utf16.IsSurrogate(r) && r < 0xdc00 && strings.HasPrefix(p.s[p.i:], `\u`) {
				save := p.i
				p.i += 2
				if r2, ok := p.hex4(); ok && r2 >= 0xdc00 && r2 <= 0xdfff {
					b.WriteRune(utf16.DecodeRune(r, r2))
					continue
				}
				p.i = save
			}
			if utf16.IsSurrogate(r) {
				// A lone surrogate has no UTF-8 form.
				r = utf8.RuneError
			}
			b.WriteRune(r)
		default:
			return "", false
		}
	}
	return "", false
}

func (p *jsonParser) hex4() (rune, bool) {
	if p.i+4 > len(p.s) {
		return 0, false
	}
	var r rune
	for k := 0; k < 4; k++ {
		d := hexValue(p.s[p.i+k])
		if d < 0 {
			return 0, false
		}
		r = r<<4 | rune(d)
	}
	p.i += 4
	return r, true
}
