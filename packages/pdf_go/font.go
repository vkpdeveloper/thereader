package pdfextractor

import (
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

type font struct {
	base                              string
	bold, italic, mono, cid, vertical bool
	encoding                          [256]string
	unicode                           map[string]string
	lengths                           []int
	widths                            map[uint32]float64
	defaultWidth                      float64
}

func utf16String(b []byte) string {
	units := make([]uint16, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		units = append(units, binary.BigEndian.Uint16(b[i:i+2]))
	}
	return string(utf16.Decode(units))
}
func decodeTextString(b []byte) string {
	if len(b) >= 2 && b[0] == 254 && b[1] == 255 {
		return utf16String(b[2:])
	}
	if len(b) >= 2 && b[0] == 255 && b[1] == 254 {
		u := make([]uint16, 0, len(b)/2-1)
		for i := 2; i+1 < len(b); i += 2 {
			u = append(u, binary.LittleEndian.Uint16(b[i:i+2]))
		}
		return string(utf16.Decode(u))
	}
	if len(b) >= 3 && string(b[:3]) == "\xef\xbb\xbf" {
		return strings.ToValidUTF8(string(b[3:]), "�")
	}
	extra := []rune("•†‡…—–ƒ⁄‹›−‰„“”‘’‚™ﬁﬂŁŒŠŸŽıłœšž�€")
	var out strings.Builder
	for _, c := range b {
		if c >= 128 && int(c)-128 < len(extra) {
			out.WriteRune(extra[int(c)-128])
		} else {
			out.WriteRune(rune(c))
		}
	}
	return out.String()
}

func baseEncoding(kind string) [256]string {
	var e [256]string
	for i := 32; i < 127; i++ {
		e[i] = string(rune(i))
	}
	switch kind {
	case "WinAnsiEncoding":
		for i := 160; i < 256; i++ {
			e[i] = string(rune(i))
		}
		for i, r := range []rune("€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž��‘’“”•–—˜™š›œ�žŸ") {
			e[128+i] = string(r)
		}
	case "MacRomanEncoding":
		for i, r := range []rune("ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ") {
			if 128+i < 256 {
				e[128+i] = string(r)
			}
		}
	default:
		e[39] = "’"
		e[96] = "‘"
		for c, s := range map[int]string{161: "¡", 162: "¢", 163: "£", 164: "⁄", 165: "¥", 166: "ƒ", 167: "§", 168: "¤", 169: "'", 170: "“", 171: "«", 172: "‹", 173: "›", 174: "fi", 175: "fl", 177: "–", 178: "†", 179: "‡", 180: "·", 182: "¶", 183: "•", 184: "‚", 185: "„", 186: "”", 187: "»", 188: "…", 189: "‰", 191: "¿", 193: "`", 194: "´", 195: "ˆ", 196: "˜", 197: "¯", 198: "˘", 199: "˙", 200: "¨", 202: "˚", 203: "¸", 205: "˝", 206: "˛", 207: "ˇ", 208: "—", 225: "Æ", 227: "ª", 232: "Ł", 233: "Ø", 234: "Œ", 235: "º", 241: "æ", 245: "ı", 248: "ł", 249: "ø", 250: "œ", 251: "ß"} {
			e[c] = s
		}
	}
	return e
}

var glyphs = map[string]string{
	"space": " ", "nbspace": " ", "nonbreakingspace": " ", "hyphen": "-", "minus": "−", "endash": "–", "emdash": "—", "period": ".", "comma": ",", "colon": ":", "semicolon": ";", "exclam": "!", "question": "?", "quotedbl": "\"", "quotesingle": "'", "quoteleft": "‘", "quoteright": "’", "quotedblleft": "“", "quotedblright": "”", "ellipsis": "…", "bullet": "•", "slash": "/", "backslash": "\\", "parenleft": "(", "parenright": ")", "bracketleft": "[", "bracketright": "]", "braceleft": "{", "braceright": "}", "less": "<", "greater": ">", "equal": "=", "plus": "+", "underscore": "_", "asterisk": "*", "ampersand": "&", "percent": "%", "numbersign": "#", "at": "@", "dollar": "$", "bar": "|", "asciitilde": "~", "asciicircum": "^", "grave": "`", "fi": "fi", "fl": "fl", "ff": "ff", "ffi": "ffi", "ffl": "ffl", "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9", "Euro": "€", "sterling": "£", "copyright": "©", "registered": "®", "trademark": "™", "dagger": "†", "daggerdbl": "‡", "germandbls": "ß", "AE": "Æ", "ae": "æ", "OE": "Œ", "oe": "œ", "Oslash": "Ø", "oslash": "ø", "Lslash": "Ł", "lslash": "ł", "dotlessi": "ı", "multiply": "×", "divide": "÷", "plusminus": "±", "degree": "°", "mu": "µ", "paragraph": "¶", "section": "§",
}

func glyphName(s string) string {
	s = strings.SplitN(s, ".", 2)[0]
	if v, ok := glyphs[s]; ok {
		return v
	}
	if strings.Contains(s, "_") {
		var b strings.Builder
		for _, part := range strings.Split(s, "_") {
			b.WriteString(glyphName(part))
		}
		return b.String()
	}
	if len(s) == 1 {
		return s
	}
	if strings.HasPrefix(s, "uni") && len(s) > 3 && (len(s)-3)%4 == 0 {
		var u []uint16
		for i := 3; i < len(s); i += 4 {
			n, e := strconv.ParseUint(s[i:i+4], 16, 16)
			if e != nil {
				return "�"
			}
			u = append(u, uint16(n))
		}
		return string(utf16.Decode(u))
	}
	if strings.HasPrefix(s, "u") && len(s) >= 5 && len(s) <= 7 {
		n, e := strconv.ParseUint(s[1:], 16, 32)
		if e == nil && utf8.ValidRune(rune(n)) {
			return string(rune(n))
		}
	}
	for _, pair := range [][2]string{{"grave", "ÀÈÌÒÙàèìòù"}, {"acute", "ÁÉÍÓÚÝáéíóúý"}, {"circumflex", "ÂÊÎÔÛâêîôû"}, {"dieresis", "ÄËÏÖÜŸäëïöüÿ"}, {"tilde", "ÃÑÕãñõ"}, {"ring", "Åå"}, {"cedilla", "Çç"}, {"caron", "ŠŽšž"}} {
		if strings.HasSuffix(s, pair[0]) {
			base := strings.TrimSuffix(s, pair[0])
			letters := map[string]string{"grave": "AEIOUaeiou", "acute": "AEIOUYaeiouy", "circumflex": "AEIOUaeiou", "dieresis": "AEIOUYaeiouy", "tilde": "ANOano", "ring": "Aa", "cedilla": "Cc", "caron": "SZsz"}[pair[0]]
			if len(base) == 1 {
				j := strings.IndexByte(letters, base[0])
				if j >= 0 {
					return string([]rune(pair[1])[j])
				}
			}
		}
	}
	greek := map[string]string{"Alpha": "Α", "Beta": "Β", "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Sigma": "Σ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω", "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε", "theta": "θ", "lambda": "λ", "pi": "π", "rho": "ρ", "sigma": "σ", "tau": "τ", "phi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω"}
	if v, ok := greek[s]; ok {
		return v
	}
	return "�"
}

func (p *pdf) font(v any, page int) *font {
	r, indirect := v.(ref)
	if indirect {
		if f, ok := p.fonts[r]; ok {
			return f
		}
	}
	d := p.dict(v)
	f := &font{base: named(d["BaseFont"]), widths: map[uint32]float64{}, defaultWidth: 500}
	lower := strings.ToLower(f.base)
	f.bold = strings.Contains(lower, "bold") || strings.Contains(lower, "black") || strings.Contains(lower, "demi")
	f.italic = strings.Contains(lower, "italic") || strings.Contains(lower, "oblique")
	f.mono = strings.Contains(lower, "courier") || strings.Contains(lower, "mono") || strings.Contains(lower, "consolas")
	f.cid = named(d["Subtype"]) == "Type0"
	enc := p.resolve(d["Encoding"])
	kind := named(enc)
	f.vertical = strings.HasSuffix(kind, "-V")
	if f.vertical {
		p.warn("vertical-text", page, "Vertical writing is preserved but reading order needs review.")
	}
	if f.cid && kind != "Identity-H" && kind != "Identity-V" {
		p.warn("font-cmap", page, "Non-Identity CID encodings need review: "+kind)
	}
	ed := asDict(enc)
	if ed != nil {
		kind = named(ed["BaseEncoding"])
	}
	f.encoding = baseEncoding(kind)
	if f.mono {
		f.defaultWidth = 600
	}
	for i := 0; i < len(p.array(ed["Differences"])); {
		a := p.array(ed["Differences"])
		code := integer(a[i])
		i++
		for i < len(a) {
			n, ok := a[i].(name)
			if !ok {
				break
			}
			if code >= 0 && code < 256 {
				f.encoding[code] = glyphName(string(n))
			}
			code++
			i++
		}
	}
	fd := d
	if f.cid {
		a := p.array(d["DescendantFonts"])
		if len(a) > 0 {
			fd = p.dict(a[0])
		}
		f.defaultWidth = 1000
		if v, ok := fd["DW"]; ok {
			f.defaultWidth = number(p.resolve(v))
		}
		w := p.array(fd["W"])
		expanded := 0
		for i := 0; i < len(w); {
			if p.check() != nil {
				break
			}
			start := integer(w[i])
			i++
			if i == len(w) {
				break
			}
			if widths, ok := p.resolve(w[i]).(array); ok {
				i++
				expanded += len(widths)
				if expanded > 100000 {
					p.err = ErrLimit
					break
				}
				for j, v := range widths {
					f.widths[uint32(start+j)] = number(v)
				}
			} else {
				end := integer(w[i])
				i++
				if i == len(w) {
					break
				}
				width := number(w[i])
				i++
				if start < 0 || end < start || end-start > 65536 {
					p.err = ErrLimit
					break
				}
				expanded += end - start + 1
				if expanded > 100000 {
					p.err = ErrLimit
					break
				}
				for c := start; c <= end; c++ {
					f.widths[uint32(c)] = width
				}
			}
		}
	} else {
		first := integer(d["FirstChar"])
		for i, w := range p.array(d["Widths"]) {
			f.widths[uint32(first+i)] = number(w)
		}
	}
	descriptor := p.dict(fd["FontDescriptor"])
	flags := integer(descriptor["Flags"])
	f.mono = f.mono || flags&1 != 0
	f.italic = f.italic || flags&64 != 0
	if width := number(descriptor["MissingWidth"]); width > 0 {
		f.defaultWidth = width
	}
	if s, ok := p.resolve(d["ToUnicode"]).(*stream); ok {
		b, e := p.decode(s)
		if e != nil {
			if errors.Is(e, ErrLimit) {
				p.err = e
			}
			p.warn("font-unicode", page, e.Error())
		} else {
			f.unicode, f.lengths, e = parseCMap(b)
			if e != nil {
				if errors.Is(e, ErrLimit) {
					p.err = e
				}
				p.warn("font-unicode", page, e.Error())
			}
		}
	}
	if f.cid && len(f.unicode) == 0 {
		p.warn("missing-unicode", page, "CID font "+f.base+" has no usable ToUnicode map; unmapped glyphs are marked �.")
	}
	if strings.Contains(lower, "symbol") || strings.Contains(lower, "dingbat") {
		if len(f.unicode) == 0 {
			p.warn("symbol-font", page, "Symbol font "+f.base+" has no ToUnicode map; glyphs need review.")
		}
	}
	if indirect {
		p.fonts[r] = f
	}
	return f
}

func parseCMap(b []byte) (map[string]string, []int, error) {
	result := map[string]string{}
	lens := map[int]bool{}
	l := lexer{b: b}
	expanded := 0
	var prev any
	for l.pos < len(b) && l.err == nil {
		l.skip()
		if l.pos == len(b) {
			break
		}
		v := l.value(0)
		k, ok := v.(keyword)
		if !ok {
			prev = v
			continue
		}
		count := integer(prev)
		if count < 0 || count > 65536 {
			return nil, nil, ErrLimit
		}
		switch k {
		case "beginbfchar":
			expanded += count
			if expanded > 100000 {
				return nil, nil, ErrLimit
			}
			for i := 0; i < count && l.err == nil; i++ {
				src, ok := l.value(0).(literal)
				dest, ok2 := l.value(0).(literal)
				if !ok || !ok2 || len(src) < 1 || len(src) > 4 {
					return nil, nil, ErrInvalid
				}
				if len(dest) > 256 {
					return nil, nil, ErrLimit
				}
				result[string(src)] = utf16String([]byte(dest))
				lens[len(src)] = true
			}
		case "beginbfrange":
			for i := 0; i < count && l.err == nil; i++ {
				a, ok := l.value(0).(literal)
				z, ok2 := l.value(0).(literal)
				dest := l.value(0)
				if !ok || !ok2 || len(a) < 1 || len(a) > 4 || len(a) != len(z) {
					return nil, nil, ErrInvalid
				}
				start, end := codeValue(string(a)), codeValue(string(z))
				if end < start || end-start > 65536 {
					return nil, nil, ErrLimit
				}
				expanded += int(end-start) + 1
				if expanded > 100000 {
					return nil, nil, ErrLimit
				}
				lens[len(a)] = true
				for offset := uint32(0); offset <= end-start; offset++ {
					c := start + offset
					key := codeBytes(c, len(a))
					switch d := dest.(type) {
					case literal:
						if len(d) > 256 {
							return nil, nil, ErrLimit
						}
						dst := []byte(d)
						carry := int(c - start)
						for j := len(dst) - 1; j >= 0 && carry > 0; j-- {
							carry += int(dst[j])
							dst[j] = byte(carry)
							carry >>= 8
						}
						result[key] = utf16String(dst)
					case array:
						j := int(c - start)
						if j < len(d) {
							s, _ := d[j].(literal)
							if len(s) > 256 {
								return nil, nil, ErrLimit
							}
							result[key] = utf16String([]byte(s))
						}
					}
					if len(result) > 100000 {
						return nil, nil, ErrLimit
					}
				}
			}
		}
		prev = nil
	}
	lengths := []int{}
	for n := range lens {
		lengths = append(lengths, n)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(lengths)))
	return result, lengths, l.err
}
func codeValue(s string) uint32 {
	var n uint32
	for i := range s {
		n = n*256 + uint32(s[i])
	}
	return n
}
func codeBytes(n uint32, length int) string {
	b := make([]byte, length)
	for i := length - 1; i >= 0; i-- {
		b[i] = byte(n)
		n >>= 8
	}
	return string(b)
}

func (f *font) glyph(s string) (string, uint32, int) {
	for _, n := range f.lengths {
		if n <= len(s) {
			if u, ok := f.unicode[s[:n]]; ok {
				return u, codeValue(s[:n]), n
			}
		}
	}
	n := 1
	if f.cid {
		n = 2
	}
	if n > len(s) {
		n = len(s)
	}
	code := codeValue(s[:n])
	if f.cid {
		return "�", code, n
	}
	u := f.encoding[byte(code)]
	if u == "" {
		u = "�"
	}
	return u, code, n
}
func (f *font) width(code uint32, text string) float64 {
	if n, ok := f.widths[code]; ok {
		return n
	}
	if f.mono || f.cid {
		return f.defaultWidth
	}
	// Base-14 fonts may omit Widths. These metrics are only positioning hints;
	// character recovery always uses character codes and ToUnicode.
	if len(text) == 1 {
		switch {
		case text == " ":
			return 278
		case strings.Contains("ilI.,'!:;|", text):
			return 250
		case strings.Contains("mwMW@", text):
			return 800
		case text[0] >= 'A' && text[0] <= 'Z':
			return 667
		}
	}
	return f.defaultWidth
}

func (f *font) String() string { return fmt.Sprintf("%s (CID %v)", f.base, f.cid) }
