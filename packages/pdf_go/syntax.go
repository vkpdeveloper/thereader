package pdfextractor

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"math"
	"strconv"
)

type name string
type literal string
type keyword string
type ref struct{ id, gen int }
type dict map[string]any
type array []any
type stream struct {
	dict dict
	raw  []byte
}

type lexer struct {
	b     []byte
	pos   int
	err   error
	nodes int
}

func white(b byte) bool     { return b == 0 || b == 9 || b == 10 || b == 12 || b == 13 || b == 32 }
func delimiter(b byte) bool { return white(b) || bytes.IndexByte([]byte("()<>[]{}/%"), b) >= 0 }
func (l *lexer) fail(s string) {
	if l.err == nil {
		l.err = fmt.Errorf("%w at byte %d: %s", ErrInvalid, l.pos, s)
	}
}
func (l *lexer) skip() {
	for l.pos < len(l.b) {
		if white(l.b[l.pos]) {
			l.pos++
			continue
		}
		if l.b[l.pos] == '%' {
			for l.pos < len(l.b) && l.b[l.pos] != '\n' && l.b[l.pos] != '\r' {
				l.pos++
			}
			continue
		}
		break
	}
}
func (l *lexer) word() string {
	l.skip()
	start := l.pos
	for l.pos < len(l.b) && !delimiter(l.b[l.pos]) {
		l.pos++
	}
	return string(l.b[start:l.pos])
}
func (l *lexer) value(depth int) any {
	if l.err != nil {
		return nil
	}
	l.nodes++
	if depth > 64 || l.nodes > 2000000 {
		l.err = ErrLimit
		return nil
	}
	l.skip()
	if l.pos >= len(l.b) {
		l.fail("unexpected EOF")
		return nil
	}
	switch l.b[l.pos] {
	case '/':
		l.pos++
		start := l.pos
		for l.pos < len(l.b) && !delimiter(l.b[l.pos]) {
			l.pos++
		}
		b := l.b[start:l.pos]
		if !bytes.ContainsRune(b, '#') {
			return name(b)
		}
		out := make([]byte, 0, len(b))
		for i := 0; i < len(b); i++ {
			if b[i] == '#' && i+2 < len(b) {
				var v [1]byte
				if _, e := hex.Decode(v[:], b[i+1:i+3]); e == nil {
					out = append(out, v[0])
					i += 2
					continue
				}
			}
			out = append(out, b[i])
		}
		return name(out)
	case '(':
		l.pos++
		nesting := 1
		out := make([]byte, 0, 64)
		for l.pos < len(l.b) {
			c := l.b[l.pos]
			l.pos++
			if c == '\\' {
				if l.pos == len(l.b) {
					break
				}
				c = l.b[l.pos]
				l.pos++
				switch c {
				case 'n':
					c = '\n'
				case 'r':
					c = '\r'
				case 't':
					c = '\t'
				case 'b':
					c = '\b'
				case 'f':
					c = '\f'
				case '\r':
					if l.pos < len(l.b) && l.b[l.pos] == '\n' {
						l.pos++
					}
					continue
				case '\n':
					continue
				default:
					if c >= '0' && c <= '7' {
						v := int(c - '0')
						for i := 0; i < 2 && l.pos < len(l.b) && l.b[l.pos] >= '0' && l.b[l.pos] <= '7'; i++ {
							v = v*8 + int(l.b[l.pos]-'0')
							l.pos++
						}
						c = byte(v)
					}
				}
			} else if c == '(' {
				nesting++
				if nesting > 64 {
					l.err = ErrLimit
					return nil
				}
			} else if c == ')' {
				nesting--
				if nesting == 0 {
					return literal(out)
				}
			} else if c == '\r' {
				if l.pos < len(l.b) && l.b[l.pos] == '\n' {
					l.pos++
				}
				c = '\n'
			}
			out = append(out, c)
		}
		l.fail("unterminated string")
	case '<':
		l.pos++
		if l.pos < len(l.b) && l.b[l.pos] == '<' {
			l.pos++
			d := dict{}
			for l.err == nil {
				l.skip()
				if l.pos+1 < len(l.b) && l.b[l.pos] == '>' && l.b[l.pos+1] == '>' {
					l.pos += 2
					return d
				}
				k, ok := l.value(depth + 1).(name)
				if !ok {
					l.fail("dictionary key is not a name")
					break
				}
				d[string(k)] = l.value(depth + 1)
				if len(d) > 50000 {
					l.err = ErrLimit
				}
			}
		} else {
			h := make([]byte, 0, 64)
			for l.pos < len(l.b) && l.b[l.pos] != '>' {
				if !white(l.b[l.pos]) {
					h = append(h, l.b[l.pos])
				}
				l.pos++
			}
			if l.pos == len(l.b) {
				l.fail("unterminated hex string")
				return nil
			}
			l.pos++
			if len(h)%2 != 0 {
				h = append(h, '0')
			}
			out := make([]byte, len(h)/2)
			if _, e := hex.Decode(out, h); e != nil {
				l.fail("invalid hex string")
				return nil
			}
			return literal(out)
		}
	case '[':
		l.pos++
		a := array{}
		for l.err == nil {
			l.skip()
			if l.pos < len(l.b) && l.b[l.pos] == ']' {
				l.pos++
				return a
			}
			a = append(a, l.value(depth+1))
			if len(a) > 200000 {
				l.err = ErrLimit
			}
		}
	default:
		w := l.word()
		if w == "" {
			l.fail("unexpected delimiter")
			return nil
		}
		switch w {
		case "true":
			return true
		case "false":
			return false
		case "null":
			return nil
		}
		numeric := (w[0] >= '0' && w[0] <= '9') || w[0] == '+' || w[0] == '-' || w[0] == '.'
		if !numeric {
			return keyword(w)
		}
		if v, e := strconv.ParseFloat(w, 64); e == nil {
			if math.IsInf(v, 0) || math.IsNaN(v) || math.Abs(v) > 1e15 {
				l.fail("invalid number")
				return nil
			}
			if v >= 0 && v == math.Trunc(v) {
				saved := l.pos
				w2 := l.word()
				g, e := strconv.Atoi(w2)
				if e == nil && g >= 0 && g <= 65535 && l.word() == "R" {
					return ref{int(v), g}
				}
				l.pos = saved
			}
			return v
		}
		return keyword(w)
	}
	return nil
}

func number(v any) float64    { n, _ := v.(float64); return n }
func integer(v any) int       { return int(number(v)) }
func named(v any) string      { s, _ := v.(name); return string(s) }
func textString(v any) string { s, _ := v.(literal); return decodeTextString([]byte(s)) }
func asDict(v any) dict {
	if s, ok := v.(*stream); ok {
		return s.dict
	}
	d, _ := v.(dict)
	return d
}
func asArray(v any) array { a, _ := v.(array); return a }
