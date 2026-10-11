package pdfextractor

import (
	"encoding/binary"
	"fmt"
	"math"
)

// TrueType outline reader. Hinting bytecode is skipped, never executed. Simple
// and XY-positioned composite glyphs become quadratic SVG paths.
type trueTypeFont struct {
	glyf, loca, cmap []byte
	glyphs           int
	long             bool
	units            float64
}

func sfntTable(b []byte, want string) ([]byte, error) {
	if len(b) < 12 {
		return nil, ErrInvalid
	}
	n := int(binary.BigEndian.Uint16(b[4:]))
	if n > 4096 || n*16 > len(b)-12 {
		return nil, ErrInvalid
	}
	for j := 0; j < n; j++ {
		r := b[12+j*16:]
		if string(r[:4]) != want {
			continue
		}
		at, size := uint64(binary.BigEndian.Uint32(r[8:])), uint64(binary.BigEndian.Uint32(r[12:]))
		if at > uint64(len(b)) || size > uint64(len(b))-at {
			return nil, ErrInvalid
		}
		return b[at : at+size], nil
	}
	return nil, fmt.Errorf("missing font table %s", want)
}
func parseTrueType(b []byte) (*trueTypeFont, error) {
	head, e := sfntTable(b, "head")
	if e != nil || len(head) < 54 {
		return nil, ErrInvalid
	}
	maxp, e := sfntTable(b, "maxp")
	if e != nil || len(maxp) < 6 {
		return nil, ErrInvalid
	}
	f := &trueTypeFont{glyphs: int(binary.BigEndian.Uint16(maxp[4:])), long: binary.BigEndian.Uint16(head[50:]) == 1, units: float64(binary.BigEndian.Uint16(head[18:]))}
	if f.units < 16 || f.units > 16384 || f.glyphs < 1 {
		return nil, ErrInvalid
	}
	f.glyf, e = sfntTable(b, "glyf")
	if e != nil {
		return nil, e
	}
	f.loca, e = sfntTable(b, "loca")
	if e != nil {
		return nil, e
	}
	width := 2
	if f.long {
		width = 4
	}
	if len(f.loca) < (f.glyphs+1)*width {
		return nil, ErrInvalid
	}
	f.cmap, _ = sfntTable(b, "cmap")
	return f, nil
}
func (f *trueTypeFont) lookup(r rune) int {
	b := f.cmap
	if len(b) < 4 {
		return 0
	}
	n := int(binary.BigEndian.Uint16(b[2:]))
	if n*8 > len(b)-4 {
		return 0
	}
	for j := 0; j < n; j++ {
		at := int(binary.BigEndian.Uint32(b[4+j*8+4:]))
		if at < 0 || at+2 > len(b) {
			continue
		}
		sub := b[at:]
		switch binary.BigEndian.Uint16(sub) {
		case 4:
			if len(sub) < 16 || r > 65535 {
				continue
			}
			length := int(binary.BigEndian.Uint16(sub[2:]))
			if length > len(sub) || length < 16 {
				continue
			}
			sub = sub[:length]
			count := int(binary.BigEndian.Uint16(sub[6:])) / 2
			if count < 1 || count*8 > len(sub)-16 {
				continue
			}
			for k := 0; k < count; k++ {
				end := int(binary.BigEndian.Uint16(sub[14+k*2:]))
				start := int(binary.BigEndian.Uint16(sub[16+count*2+k*2:]))
				if int(r) < start || int(r) > end {
					continue
				}
				delta := int(int16(binary.BigEndian.Uint16(sub[16+count*4+k*2:])))
				roff := 16 + count*6 + k*2
				offset := int(binary.BigEndian.Uint16(sub[roff:]))
				gid := int(r)
				if offset > 0 {
					pos := roff + offset + 2*(int(r)-start)
					if pos < 0 || pos+2 > len(sub) {
						continue
					}
					gid = int(binary.BigEndian.Uint16(sub[pos:]))
					if gid == 0 {
						continue
					}
				}
				gid = (gid + delta) & 65535
				if gid > 0 && gid < f.glyphs {
					return gid
				}
			}
		case 12:
			if len(sub) < 16 {
				continue
			}
			count := uint64(binary.BigEndian.Uint32(sub[12:]))
			if count > uint64((len(sub)-16)/12) {
				continue
			}
			for k := 0; k < int(count); k++ {
				v := sub[16+k*12:]
				first, last := binary.BigEndian.Uint32(v), binary.BigEndian.Uint32(v[4:])
				if uint32(r) < first || uint32(r) > last {
					continue
				}
				gid := uint64(binary.BigEndian.Uint32(v[8:])) + uint64(uint32(r)-first)
				if gid > 0 && gid < uint64(f.glyphs) {
					return int(gid)
				}
			}
		}
	}
	return 0
}
func (f *trueTypeFont) data(gid int) ([]byte, error) {
	if gid < 0 || gid >= f.glyphs {
		return nil, ErrInvalid
	}
	off := func(n int) uint64 {
		if f.long {
			return uint64(binary.BigEndian.Uint32(f.loca[n*4:]))
		}
		return uint64(binary.BigEndian.Uint16(f.loca[n*2:])) * 2
	}
	a, z := off(gid), off(gid+1)
	if a > z || z > uint64(len(f.glyf)) {
		return nil, ErrInvalid
	}
	return f.glyf[a:z], nil
}

type ttPoint struct {
	x, y float64
	on   bool
}

func (f *trueTypeFont) draw(c *charstring, gid int, m matrix, depth int) error {
	c.ops++
	if depth > 16 || c.ops > 10000 {
		return ErrLimit
	}
	b, e := f.data(gid)
	if e != nil {
		return e
	}
	if len(b) == 0 {
		return nil
	}
	if len(b) < 10 {
		return ErrInvalid
	}
	contours := int(int16(binary.BigEndian.Uint16(b)))
	at := 10
	u16 := func() (int, error) {
		if at+2 > len(b) {
			return 0, ErrInvalid
		}
		n := int(binary.BigEndian.Uint16(b[at:]))
		at += 2
		return n, nil
	}
	if contours < 0 {
		for {
			flags, e := u16()
			if e != nil {
				return e
			}
			child, e := u16()
			if e != nil {
				return e
			}
			var x, y int
			if flags&1 != 0 {
				x, e = u16()
				if e != nil {
					return e
				}
				y, e = u16()
				if e != nil {
					return e
				}
				x = int(int16(x))
				y = int(int16(y))
			} else {
				if at+2 > len(b) {
					return ErrInvalid
				}
				x, y = int(int8(b[at])), int(int8(b[at+1]))
				at += 2
			}
			if flags&2 == 0 {
				return fmt.Errorf("point-matched composite font glyph needs review")
			}
			cm := matrix{1, 0, 0, 1, float64(x), float64(y)}
			scale := func() (float64, error) { n, e := u16(); return float64(int16(n)) / 16384, e }
			switch {
			case flags&8 != 0:
				cm[0], e = scale()
				cm[3] = cm[0]
			case flags&64 != 0:
				cm[0], e = scale()
				if e == nil {
					cm[3], e = scale()
				}
			case flags&128 != 0:
				for j := 0; j < 4 && e == nil; j++ {
					cm[j], e = scale()
				}
			}
			if e != nil {
				return e
			}
			if flags&0x800 != 0 {
				cm[4], cm[5] = cm[0]*float64(x)+cm[2]*float64(y), cm[1]*float64(x)+cm[3]*float64(y)
			}
			if e = f.draw(c, child, m.mul(cm), depth+1); e != nil {
				return e
			}
			if flags&32 == 0 {
				return nil
			}
		}
	}
	if contours == 0 {
		return nil
	}
	if contours > 4096 {
		return ErrLimit
	}
	ends := make([]int, contours)
	for j := range ends {
		n, e := u16()
		if e != nil {
			return e
		}
		if j > 0 && n <= ends[j-1] {
			return ErrInvalid
		}
		ends[j] = n
	}
	count := 0
	if contours > 0 {
		count = ends[contours-1] + 1
	}
	if count > 20000 {
		return ErrLimit
	}
	ins, e := u16()
	if e != nil || ins > len(b)-at {
		return ErrInvalid
	}
	at += ins
	flags := make([]byte, 0, count)
	for len(flags) < count {
		if at >= len(b) {
			return ErrInvalid
		}
		v := b[at]
		at++
		repeat := 1
		if v&8 != 0 {
			if at >= len(b) {
				return ErrInvalid
			}
			repeat += int(b[at])
			at++
		}
		if repeat > count-len(flags) {
			return ErrInvalid
		}
		for j := 0; j < repeat; j++ {
			flags = append(flags, v)
		}
	}
	points := make([]ttPoint, count)
	for axis := 0; axis < 2; axis++ {
		pos := 0
		short, same := byte(2), byte(16)
		if axis == 1 {
			short, same = 4, 32
		}
		for j, flag := range flags {
			delta := 0
			if flag&short != 0 {
				if at >= len(b) {
					return ErrInvalid
				}
				delta = int(b[at])
				at++
				if flag&same == 0 {
					delta = -delta
				}
			} else if flag&same == 0 {
				n, e := u16()
				if e != nil {
					return e
				}
				delta = int(int16(n))
			}
			pos += delta
			if math.Abs(float64(pos)) > 1e7 {
				return ErrLimit
			}
			if axis == 0 {
				points[j].x = float64(pos)
			} else {
				points[j].y = float64(pos)
			}
			points[j].on = flag&1 != 0
		}
	}
	command := func(op string, v ...ttPoint) error {
		coords := []float64{}
		for _, pt := range v {
			x, y := m.point(pt.x, pt.y)
			coords = append(coords, x, y)
		}
		return c.point(op, coords...)
	}
	mid := func(a, b ttPoint) ttPoint { return ttPoint{(a.x + b.x) / 2, (a.y + b.y) / 2, true} }
	first := 0
	for _, end := range ends {
		segment := points[first : end+1]
		first = end + 1
		a, z := segment[0], segment[len(segment)-1]
		start := a
		if a.on {
			segment = segment[1:]
		} else if z.on {
			start = z
			segment = segment[:len(segment)-1]
		} else {
			start = mid(z, a)
		}
		if e = command("M", start); e != nil {
			return e
		}
		var control *ttPoint
		for _, pt := range segment {
			if pt.on {
				if control != nil {
					e = command("Q", *control, pt)
					control = nil
				} else {
					e = command("L", pt)
				}
			} else {
				if control != nil {
					e = command("Q", *control, mid(*control, pt))
				}
				copyPoint := pt
				control = &copyPoint
			}
			if e != nil {
				return e
			}
		}
		if control != nil {
			if e = command("Q", *control, start); e != nil {
				return e
			}
		}
		c.path.WriteByte('Z')
	}
	return nil
}
