package pdfextractor

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

func type1Decrypt(b []byte, seed uint16, skip int) []byte {
	out := make([]byte, len(b))
	for j, c := range b {
		out[j] = c ^ byte(seed>>8)
		seed = (uint16(c)+seed)*52845 + 22719
	}
	if skip < 0 || skip > len(out) {
		return nil
	}
	return out[skip:]
}

var type1Encoding = regexp.MustCompile(`\bdup\s+(\d+)\s+/([^\s]+)\s+put\b`)
var type1LenIV = regexp.MustCompile(`/lenIV\s+(-?\d+)`)

// Only data declarations and length-delimited charstrings are read. No
// PostScript source is executed (including OtherSubrs procedures).
func parseType1(b []byte, length1, length2 int) (*outlineFont, [256]string, error) {
	names := [256]string{}
	if length1 <= 0 || length1 > len(b) || length2 < 0 || length2 > len(b)-length1 {
		return nil, names, ErrInvalid
	}
	clear := b[:length1]
	for _, m := range type1Encoding.FindAllSubmatch(clear, -1) {
		n, e := strconv.Atoi(string(m[1]))
		if e == nil && n >= 0 && n < 256 {
			names[n] = string(m[2])
		}
	}
	encrypted := b[length1 : length1+length2]
	// ASCII-hex eexec is legal. Whitespace is stripped only after confirming
	// the first four non-whitespace bytes are all hexadecimal digits.
	compact := bytes.Join(bytes.Fields(encrypted), nil)
	if len(compact) >= 4 {
		if _, e := hex.DecodeString(string(compact[:4])); e == nil {
			dst := make([]byte, len(compact)/2)
			n, e := hex.Decode(dst, compact)
			if e == nil {
				encrypted = dst[:n]
			}
		}
	}
	private := type1Decrypt(encrypted, 55665, 4)
	if len(private) == 0 {
		return nil, names, ErrInvalid
	}
	lenIV := 4
	header := private
	if at := bytes.Index(header, []byte("/Subrs")); at >= 0 {
		header = header[:at]
	}
	if m := type1LenIV.FindSubmatch(header); m != nil {
		lenIV, _ = strconv.Atoi(string(m[1]))
		if lenIV < -1 || lenIV > 32 {
			return nil, names, ErrInvalid
		}
	}
	f := &outlineFont{type1: true, names: map[string]int{}, codes: map[uint32]int{}, matrix: matrix{.001, 0, 0, .001, 0, 0}, cache: map[int]glyphOutline{}}
	if at := bytes.Index(clear, []byte("/FontMatrix")); at >= 0 {
		l := lexer{b: clear, pos: at + 11}
		a := asArray(l.value(0))
		if len(a) == 6 {
			for j := range f.matrix {
				f.matrix[j] = number(a[j])
			}
			if !f.matrix.valid() {
				return nil, names, ErrLimit
			}
		}
	}
	at := 0
	token := func() string {
		for at < len(private) && (private[at] <= 32) {
			at++
		}
		start := at
		for at < len(private) && private[at] > 32 {
			at++
		}
		return string(private[start:at])
	}
	decode := func(n int) ([]byte, error) {
		if n < 0 || n > len(private)-at-1 || at >= len(private) || private[at] > 32 {
			return nil, ErrInvalid
		}
		at++
		v := private[at : at+n]
		at += n
		if lenIV == -1 {
			return v, nil
		}
		if n < lenIV {
			return nil, ErrInvalid
		}
		return type1Decrypt(v, 4330, lenIV), nil
	}
	subrs := [][]byte{}
	inChars := false
	for at < len(private) {
		t := token()
		switch {
		case t == "/Subrs":
			n, e := strconv.Atoi(token())
			if e != nil || n < 0 || n > 65536 {
				return nil, names, ErrInvalid
			}
			subrs = make([][]byte, n)
		case t == "/CharStrings":
			inChars = true
		case !inChars && t == "dup" && len(subrs) > 0:
			idx, e := strconv.Atoi(token())
			if e != nil {
				continue
			}
			n, e := strconv.Atoi(token())
			if e != nil {
				continue
			}
			op := token()
			if op != "RD" && op != "-|" {
				continue
			}
			if idx < 0 || idx >= len(subrs) {
				return nil, names, ErrInvalid
			}
			v, e := decode(n)
			if e != nil {
				return nil, names, e
			}
			subrs[idx] = v
		case inChars && strings.HasPrefix(t, "/"):
			name := strings.TrimPrefix(t, "/")
			n, e := strconv.Atoi(token())
			if e != nil {
				continue
			}
			op := token()
			if op != "RD" && op != "-|" {
				continue
			}
			if len(f.chars) >= 65536 {
				return nil, names, ErrLimit
			}
			v, e := decode(n)
			if e != nil {
				return nil, names, e
			}
			f.names[name] = len(f.chars)
			f.chars = append(f.chars, v)
		}
	}
	if len(f.chars) == 0 {
		return nil, names, ErrInvalid
	}
	f.fd = make([]int, len(f.chars))
	f.local = [][][]byte{subrs}
	return f, names, nil
}

func (p *pdf) fontProgram(f *font, page int) *outlineFont {
	if f.programRead {
		return f.program
	}
	f.programRead = true
	var err error
	if named(f.source["Subtype"]) == "Type3" {
		prog := &outlineFont{type3: true, names: map[string]int{}, codes: map[uint32]int{}, matrix: matrix{.001, 0, 0, .001, 0, 0}, cache: map[int]glyphOutline{}}
		if a := p.array(f.source["FontMatrix"]); len(a) == 6 {
			for j := range prog.matrix {
				prog.matrix[j] = number(a[j])
			}
		}
		chars := p.dict(f.source["CharProcs"])
		keys := []string{}
		for name := range chars {
			keys = append(keys, name)
		}
		sort.Strings(keys)
		for _, name := range keys {
			s, ok := p.resolve(chars[name]).(*stream)
			if !ok {
				continue
			}
			b, e := p.decode(s)
			if e != nil {
				err = e
				break
			}
			prog.names[name] = len(prog.chars)
			prog.chars = append(prog.chars, b)
		}
		if err == nil && len(prog.chars) > 0 {
			f.program = prog
		} else if err == nil {
			err = ErrInvalid
		}
	} else if s, ok := p.resolve(f.descriptor["FontFile3"]).(*stream); ok {
		data, e := p.decode(s)
		err = e
		if e == nil {
			f.program, err = parseCFF(data)
		}
	} else if s, ok := p.resolve(f.descriptor["FontFile2"]).(*stream); ok {
		data, e := p.decode(s)
		err = e
		if e == nil {
			var tt *trueTypeFont
			tt, err = parseTrueType(data)
			if err == nil {
				prog := &outlineFont{ttf: tt, codes: map[uint32]int{}, matrix: matrix{1 / tt.units, 0, 0, 1 / tt.units, 0, 0}, cache: map[int]glyphOutline{}}
				if f.cid {
					if s, ok := p.resolve(f.gidMap).(*stream); ok {
						v, e := p.decode(s)
						err = e
						if e == nil {
							if len(v) > 131072 {
								err = ErrLimit
							} else {
								for j := 0; j+1 < len(v); j += 2 {
									gid := int(binary.BigEndian.Uint16(v[j:]))
									if gid < tt.glyphs {
										prog.codes[uint32(j/2)] = gid
									}
								}
							}
						}
					} else {
						for j := 0; j < tt.glyphs; j++ {
							prog.codes[uint32(j)] = j
						}
					}
				} else {
					for code := 0; code < 256; code++ {
						u, _, _ := f.glyph(string([]byte{byte(code)}))
						r, _ := utf8.DecodeRuneInString(u)
						gid := tt.lookup(r)
						if gid == 0 {
							gid = tt.lookup(rune(code + 0xf000))
						}
						if gid > 0 {
							prog.codes[uint32(code)] = gid
						}
					}
				}
				if err == nil {
					f.program = prog
				}
			}
		}
	} else if s, ok := p.resolve(f.descriptor["FontFile"]).(*stream); ok {
		data, e := p.decode(s)
		err = e
		if e == nil {
			var names [256]string
			f.program, names, err = parseType1(data, integer(p.resolve(s.dict["Length1"])), integer(p.resolve(s.dict["Length2"])))
			if err == nil {
				byUnicode := map[string]string{}
				keys := []string{}
				for key := range f.program.names {
					keys = append(keys, key)
				}
				sort.Strings(keys)
				for _, key := range keys {
					u := glyphName(key)
					if u != "�" && u != "" {
						byUnicode[u] = key
					}
				}
				for code := range f.names {
					if f.names[code] == "" {
						f.names[code] = names[code]
					}
					if f.names[code] == "" {
						u, _, _ := f.glyph(string([]byte{byte(code)}))
						f.names[code] = byUnicode[u]
					}
				}
			}
		}
	} else {
		err = fmt.Errorf("no supported embedded CFF/Type 1 program")
	}
	if err != nil {
		if errors.Is(err, ErrLimit) {
			p.err = err
		}
		p.warn("font-outline", page, "Positioned graphics use Unicode fallback for "+f.base+": "+err.Error())
	}
	return f.program
}
