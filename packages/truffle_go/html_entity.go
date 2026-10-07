package truffle

import "strings"

// Character references (HTML Standard 13.2.5.72-80), decoded against the
// static table in html_entity_table.go.
//
// Two departures of golang.org/x/net/html are not copied: it leaves "&#9" at
// the end of a text unconverted (it wants at least three bytes after "&#"),
// and its code point accumulator overflows on long digit runs; here, as in
// the standard, any digit run is a reference and values past U+10FFFF
// saturate to U+FFFD. It also lacks &nLt; and &nGt;, whose replacements are
// wider than their names.

// win1252 replaces the C1 controls a numeric reference names, as legacy
// pages meant them (13.2.5.80). Zero entries are left as they are.
var win1252 = [32]rune{
	0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
	0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017D, 0,
	0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
	0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178,
}

// entityHash is FNV-1a over the exact bytes (entity names are case-sensitive).
func entityHash(s string) uint32 {
	h := uint32(2166136261)
	for i := 0; i < len(s); i++ {
		h = (h ^ uint32(s[i])) * 16777619
	}
	return h
}

// lookupEntity returns the replacement text of the entity named name (as
// written after '&', with its ';' if it has one).
func lookupEntity(name string) (string, bool) {
	for i := entityHash(name) & (entityTableSize - 1); ; i = (i + 1) & (entityTableSize - 1) {
		k := entityTable[i]
		if k == 0 {
			return "", false
		}
		e := &entityList[k-1]
		if int(e.nameLen) == len(name) && entityNameBlob[e.nameOff:int(e.nameOff)+len(name)] == name {
			return entityValueBlob[e.valueOff : int(e.valueOff)+int(e.valueLen)], true
		}
	}
}

// appendUnescaped appends s to b with its character references decoded.
// inAttr applies the attribute value rule: a legacy reference without ';'
// followed by '=' or an alphanumeric is left as it is.
func appendUnescaped(b []byte, s string, inAttr bool) []byte {
	for {
		i := strings.IndexByte(s, '&')
		if i < 0 {
			return append(b, s...)
		}
		b = append(b, s[:i]...)
		s = s[i:]
		n, r, text := charRef(s, inAttr)
		switch {
		case n == 0:
			b = append(b, '&')
			s = s[1:]
			continue
		case text != "":
			b = append(b, text...)
		default:
			b = appendRune(b, r)
		}
		s = s[n:]
	}
}

// charRef decodes the character reference at the start of s (s[0] == '&').
// It returns the bytes consumed (0 when s does not start with a reference)
// and the replacement, as a rune or, for named references, a string.
func charRef(s string, inAttr bool) (n int, r rune, text string) {
	if len(s) < 2 {
		return 0, 0, ""
	}
	if s[1] == '#' {
		i := 2
		hex := i < len(s) && s[i]|0x20 == 'x'
		if hex {
			i++
		}
		start := i
		v := uint32(0)
		for ; i < len(s); i++ {
			c := s[i]
			var d uint32
			switch {
			case '0' <= c && c <= '9':
				d = uint32(c - '0')
			case hex && 'a' <= c|0x20 && c|0x20 <= 'f':
				d = uint32(c|0x20-'a') + 10
			default:
				goto done
			}
			if hex {
				v = v<<4 | d
			} else {
				v = v*10 + d
			}
			if v > 0x10FFFF {
				v = 0x110000
			}
		}
	done:
		if i == start {
			// No digits: "&#" or "&#x" is text.
			return 0, 0, ""
		}
		if i < len(s) && s[i] == ';' {
			i++
		}
		switch {
		case v == 0 || v > 0x10FFFF || 0xD800 <= v && v <= 0xDFFF:
			v = 0xFFFD
		case 0x80 <= v && v <= 0x9F:
			if w := win1252[v-0x80]; w != 0 {
				v = uint32(w)
			}
		}
		return i, rune(v), ""
	}
	// Named reference: the longest name in the table matching the input.
	// Names are alphanumeric runs; those with ';' must match the whole run,
	// the legacy ones without ';' (at most 6 bytes) may match a prefix.
	j := 1
	for j < len(s) && j <= entityMaxLen && charClass[s[j]]&ccAlnum != 0 {
		j++
	}
	run := j - 1
	if run == 0 {
		return 0, 0, ""
	}
	if j < len(s) && s[j] == ';' && run < entityMaxLen {
		if v, ok := lookupEntity(s[1 : j+1]); ok {
			return j + 1, 0, v
		}
	}
	for k := min(run, 6); k >= 2; k-- {
		v, ok := lookupEntity(s[1 : 1+k])
		if !ok {
			continue
		}
		if inAttr && (k < run || 1+k < len(s) && s[1+k] == '=') {
			return 0, 0, ""
		}
		return 1 + k, 0, v
	}
	return 0, 0, ""
}
