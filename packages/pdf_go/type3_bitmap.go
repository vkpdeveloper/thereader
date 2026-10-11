package pdfextractor

import (
	"bytes"
	"compress/zlib"
)

// A stencil is painted in the current glyph color. Runs become rectangle
// paths, retaining exact pixels without depending on a platform image codec.
func type3Mask(c *charstring, l *lexer, ctm matrix) error {
	d := dict{}
	for n := 0; n < 32; n++ {
		v := l.value(0)
		if v == keyword("ID") {
			break
		}
		key, ok := v.(name)
		if !ok || l.err != nil {
			return ErrInvalid
		}
		d[string(key)] = l.value(0)
		if n == 31 {
			return ErrLimit
		}
	}
	get := func(short, long string) any {
		if v, ok := d[long]; ok {
			return v
		}
		return d[short]
	}
	w, h := integer(get("W", "Width")), integer(get("H", "Height"))
	mask, _ := get("IM", "ImageMask").(bool)
	if !mask || w < 1 || h < 1 || w > 65536/h {
		return ErrLimit
	}
	if b := get("BPC", "BitsPerComponent"); b != nil && integer(b) != 1 {
		return ErrInvalid
	}
	if get("DP", "DecodeParms") != nil {
		return ErrInvalid
	}
	paint := byte(0)
	if d := asArray(get("D", "Decode")); len(d) != 0 {
		if len(d) != 2 || number(d[0])+number(d[1]) != 1 {
			return ErrInvalid
		}
		if number(d[0]) == 1 {
			paint = 1
		} else if number(d[0]) != 0 {
			return ErrInvalid
		}
	}
	if l.pos >= len(l.b) || !white(l.b[l.pos]) {
		return ErrInvalid
	}
	if l.b[l.pos] == '\r' && l.pos+1 < len(l.b) && l.b[l.pos+1] == '\n' {
		l.pos++
	}
	l.pos++
	stride := (w + 7) / 8
	length := stride * h
	var bits []byte
	switch named(get("F", "Filter")) {
	case "":
		if length > len(l.b)-l.pos {
			return ErrInvalid
		}
		bits = l.b[l.pos : l.pos+length]
		l.pos += length
	case "Fl", "FlateDecode":
		raw := bytes.NewReader(l.b[l.pos:])
		r, e := zlib.NewReader(raw)
		if e != nil {
			return e
		}
		bits, e = boundedRead(r, length)
		r.Close()
		if e != nil {
			return e
		}
		l.pos = len(l.b) - raw.Len()
	default:
		return ErrInvalid
	}
	if len(bits) != length || l.word() != "EI" {
		return ErrInvalid
	}
	pixel := func(x, y int) bool { return bits[y*stride+x/8]>>uint(7-x%8)&1 == paint }
	for y := 0; y < h; y++ {
		for x := 0; x < w; {
			if !pixel(x, y) {
				x++
				continue
			}
			start := x
			for x < w && pixel(x, y) {
				x++
			}
			for j, pt := range [][2]float64{{float64(start) / float64(w), 1 - float64(y)/float64(h)}, {float64(x) / float64(w), 1 - float64(y)/float64(h)}, {float64(x) / float64(w), 1 - float64(y+1)/float64(h)}, {float64(start) / float64(w), 1 - float64(y+1)/float64(h)}} {
				a, b := ctm.point(pt[0], pt[1])
				op := "L"
				if j == 0 {
					op = "M"
				}
				if e := c.point(op, a, b); e != nil {
					return e
				}
			}
			c.path.WriteByte('Z')
		}
	}
	return nil
}
