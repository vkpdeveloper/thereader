package pdfextractor

// Font outlines are interpreted locally from the embedded font program. This
// implements the CFF 1 and Type 2 formats (Adobe notes 5176 / 5177); it is not a
// PDF rendering dependency. Hints affect rasterization, not the vector outline.
import (
	"encoding/binary"
	"fmt"
	"math"
	"strconv"
	"strings"
)

type glyphOutline struct {
	path       string
	box        Rect
	hasBox     bool
	operations int
	err        error
}
type outlineFont struct {
	chars  [][]byte
	global [][]byte
	local  [][][]byte
	fd     []int
	codes  map[uint32]int
	names  map[string]int
	matrix matrix
	cache  map[int]glyphOutline
	type1  bool
	type3  bool
	ttf    *trueTypeFont
}

func cffIndex(b []byte, at int) ([][]byte, int, error) {
	if at < 0 || at+2 > len(b) {
		return nil, at, ErrInvalid
	}
	n := int(binary.BigEndian.Uint16(b[at:]))
	at += 2
	if n == 0 {
		return nil, at, nil
	}
	if at >= len(b) {
		return nil, at, ErrInvalid
	}
	width := int(b[at])
	at++
	if width < 1 || width > 4 || (n+1)*width > len(b)-at {
		return nil, at, ErrInvalid
	}
	offsets := make([]int, n+1)
	for i := range offsets {
		for j := 0; j < width; j++ {
			offsets[i] = offsets[i]*256 + int(b[at])
			at++
		}
	}
	if offsets[0] != 1 || offsets[n] < 1 || offsets[n]-1 > len(b)-at {
		return nil, at, ErrInvalid
	}
	out := make([][]byte, n)
	for i := range out {
		if offsets[i] < 1 || offsets[i] > offsets[i+1] || offsets[i+1] > offsets[n] {
			return nil, at, ErrInvalid
		}
		out[i] = b[at+offsets[i]-1 : at+offsets[i+1]-1]
	}
	return out, at + offsets[n] - 1, nil
}

// A number consumes its first byte and any following bytes; DICT reals use
// nibble encoding, while charstring 255 values are signed 16.16 fixed point.
func cffNumber(b []byte, at *int, dictMode, type1 bool) (float64, error) {
	if *at >= len(b) {
		return 0, ErrInvalid
	}
	v := b[*at]
	*at++
	need := func(n int) bool { return n <= len(b)-*at }
	switch {
	case v >= 32 && v <= 246:
		return float64(int(v) - 139), nil
	case v >= 247 && v <= 254:
		if !need(1) {
			return 0, ErrInvalid
		}
		w := b[*at]
		*at++
		if v < 251 {
			return float64((int(v)-247)*256 + int(w) + 108), nil
		}
		return float64(-(int(v)-251)*256 - int(w) - 108), nil
	case v == 28:
		if !need(2) {
			return 0, ErrInvalid
		}
		n := int16(binary.BigEndian.Uint16(b[*at:]))
		*at += 2
		return float64(n), nil
	case v == 29 && dictMode || v == 255:
		if !need(4) {
			return 0, ErrInvalid
		}
		n := int32(binary.BigEndian.Uint32(b[*at:]))
		*at += 4
		if v == 255 && !type1 {
			return float64(n) / 65536, nil
		}
		return float64(n), nil
	case v == 30 && dictMode:
		var s strings.Builder
		for need(1) && s.Len() < 64 {
			w := b[*at]
			*at++
			for _, c := range []byte{w >> 4, w & 15} {
				switch {
				case c < 10:
					s.WriteByte('0' + c)
				case c == 10:
					s.WriteByte('.')
				case c == 11:
					s.WriteByte('E')
				case c == 12:
					s.WriteString("E-")
				case c == 14:
					s.WriteByte('-')
				case c == 15:
					n, e := strconv.ParseFloat(s.String(), 64)
					if e != nil || math.IsInf(n, 0) || math.IsNaN(n) {
						return 0, ErrInvalid
					}
					return n, nil
				default:
					return 0, ErrInvalid
				}
			}
		}
	}
	return 0, ErrInvalid
}
func cffDict(b []byte) (map[int][]float64, error) {
	d := map[int][]float64{}
	stack := []float64{}
	for at := 0; at < len(b); {
		v := b[at]
		if v >= 28 {
			n, e := cffNumber(b, &at, true, false)
			if e != nil {
				return nil, e
			}
			stack = append(stack, n)
			if len(stack) > 64 {
				return nil, ErrLimit
			}
			continue
		}
		at++
		op := int(v)
		if v == 12 {
			if at == len(b) {
				return nil, ErrInvalid
			}
			op = 1200 + int(b[at])
			at++
		}
		d[op] = append([]float64(nil), stack...)
		stack = stack[:0]
	}
	return d, nil
}
func cffInt(d map[int][]float64, k int) int {
	if len(d[k]) > 0 && math.Abs(d[k][0]) < 1<<30 {
		return int(d[k][0])
	}
	return 0
}
func parseCFF(b []byte) (*outlineFont, error) {
	if len(b) < 4 || b[0] != 1 || b[2] < 4 || int(b[2]) > len(b) {
		return nil, ErrInvalid
	}
	_, at, e := cffIndex(b, int(b[2]))
	if e != nil {
		return nil, e
	}
	top, next, e := cffIndex(b, at)
	if e != nil || len(top) != 1 {
		return nil, ErrInvalid
	}
	at = next
	_, at, e = cffIndex(b, at)
	if e != nil {
		return nil, e
	}
	global, _, e := cffIndex(b, at)
	if e != nil {
		return nil, e
	}
	d, e := cffDict(top[0])
	if e != nil {
		return nil, e
	}
	chars, _, e := cffIndex(b, cffInt(d, 17))
	if e != nil || len(chars) == 0 {
		return nil, ErrInvalid
	}
	f := &outlineFont{chars: chars, global: global, codes: map[uint32]int{}, matrix: matrix{.001, 0, 0, .001, 0, 0}, cache: map[int]glyphOutline{}, fd: make([]int, len(chars))}
	if m := d[1207]; len(m) == 6 {
		copy(f.matrix[:], m)
		if !f.matrix.valid() {
			return nil, ErrLimit
		}
	}
	local := func(d map[int][]float64) ([][]byte, error) {
		a := d[18]
		if len(a) != 2 {
			return nil, nil
		}
		if a[0] < 0 || a[1] < 0 || a[0] > float64(len(b)) || a[1] > float64(len(b)) {
			return nil, ErrInvalid
		}
		size, start := int(a[0]), int(a[1])
		if size > len(b)-start {
			return nil, ErrInvalid
		}
		priv, e := cffDict(b[start : start+size])
		if e != nil {
			return nil, e
		}
		off := cffInt(priv, 19)
		if off == 0 {
			return nil, nil
		}
		s, _, e := cffIndex(b, start+off)
		return s, e
	}
	if _, cid := d[1230]; cid {
		dicts, _, e := cffIndex(b, cffInt(d, 1236))
		if e != nil || len(dicts) == 0 || len(dicts) > 256 {
			return nil, ErrInvalid
		}
		for _, raw := range dicts {
			fd, e := cffDict(raw)
			if e != nil {
				return nil, e
			}
			if len(fd[1207]) > 0 {
				return nil, fmt.Errorf("CFF FD FontMatrix not supported")
			}
			sub, e := local(fd)
			if e != nil {
				return nil, e
			}
			f.local = append(f.local, sub)
		}
		at = cffInt(d, 1237)
		if at < 0 || at >= len(b) {
			return nil, ErrInvalid
		}
		format := b[at]
		at++
		switch format {
		case 0:
			if len(chars) > len(b)-at {
				return nil, ErrInvalid
			}
			for j := range f.fd {
				f.fd[j] = int(b[at+j])
			}
		case 3:
			if at+2 > len(b) {
				return nil, ErrInvalid
			}
			n := int(binary.BigEndian.Uint16(b[at:]))
			at += 2
			if n < 1 || n*3+2 > len(b)-at {
				return nil, ErrInvalid
			}
			for j := 0; j < n; j++ {
				start := int(binary.BigEndian.Uint16(b[at+j*3:]))
				end := int(binary.BigEndian.Uint16(b[at+(j+1)*3:]))
				fd := int(b[at+j*3+2])
				if start >= end || end > len(chars) || j == 0 && start != 0 || j == n-1 && end != len(chars) {
					return nil, ErrInvalid
				}
				for k := start; k < end; k++ {
					f.fd[k] = fd
				}
			}
		default:
			return nil, ErrInvalid
		}
		for _, fd := range f.fd {
			if fd >= len(f.local) {
				return nil, ErrInvalid
			}
		}
		at = cffInt(d, 15)
		if at < 3 || at >= len(b) {
			return nil, ErrInvalid
		}
		format = b[at]
		at++
		for gid := 1; gid < len(chars); {
			if at+2 > len(b) {
				return nil, ErrInvalid
			}
			first := int(binary.BigEndian.Uint16(b[at:]))
			at += 2
			n := 0
			switch format {
			case 0:
			case 1:
				if at >= len(b) {
					return nil, ErrInvalid
				}
				n = int(b[at])
				at++
			case 2:
				if at+2 > len(b) {
					return nil, ErrInvalid
				}
				n = int(binary.BigEndian.Uint16(b[at:]))
				at += 2
			default:
				return nil, ErrInvalid
			}
			if n >= len(chars)-gid || first+n > 65535 {
				return nil, ErrInvalid
			}
			for j := 0; j <= n; j++ {
				f.codes[uint32(first+j)] = gid
				gid++
			}
		}
	} else {
		sub, e := local(d)
		if e != nil {
			return nil, e
		}
		f.local = [][][]byte{sub}
		// Non-CID CFF encodings are deliberately not guessed as Unicode/GIDs.
		return nil, fmt.Errorf("name-keyed CFF outlines not supported")
	}
	return f, nil
}

type charstring struct {
	f          *outlineFont
	local      [][]byte
	stack      []float64
	x, y       float64
	stems, ops int
	path       strings.Builder
	open, done bool
	flex       bool
	flexPoints [][2]float64
	others     []float64
	box        Rect
	hasBox     bool
}

func (c *charstring) close() {
	if c.open {
		c.path.WriteByte('Z')
		c.open = false
	}
}
func (c *charstring) point(op string, v ...float64) error {
	c.ops++
	if c.ops > 100000 {
		return ErrLimit
	}
	for _, n := range v {
		if math.Abs(n) > 1e7 || math.IsNaN(n) || math.IsInf(n, 0) {
			return ErrLimit
		}
	}
	for j := 0; j+1 < len(v); j += 2 {
		r := Rect{v[j], v[j+1], 0, 0}
		if !c.hasBox {
			c.box = r
			c.hasBox = true
		} else {
			c.box = union(c.box, r)
		}
	}
	c.path.WriteString(op)
	for _, n := range v {
		c.path.WriteString(fnum(n))
		c.path.WriteByte(' ')
	}
	if c.path.Len() > 1<<20 {
		return ErrLimit
	}
	return nil
}
func (c *charstring) move(x, y float64) error {
	if c.flex {
		c.x += x
		c.y += y
		return nil
	}
	c.close()
	c.x += x
	c.y += y
	c.open = true
	return c.point("M", c.x, c.y)
}
func (c *charstring) line(x, y float64) error { c.x += x; c.y += y; return c.point("L", c.x, c.y) }
func (c *charstring) curve(v ...float64) error {
	x1, y1 := c.x+v[0], c.y+v[1]
	x2, y2 := x1+v[2], y1+v[3]
	c.x = x2 + v[4]
	c.y = y2 + v[5]
	return c.point("C", x1, y1, x2, y2, c.x, c.y)
}
func subrBias(n int) int {
	if n < 1240 {
		return 107
	}
	if n < 33900 {
		return 1131
	}
	return 32768
}
func (c *charstring) run(b []byte, depth int) error {
	if depth > 16 {
		return ErrLimit
	}
	for at := 0; at < len(b) && !c.done; {
		c.ops++
		if c.ops > 100000 {
			return ErrLimit
		}
		op := int(b[at])
		if op >= 32 || op == 28 {
			n, e := cffNumber(b, &at, false, c.f.type1)
			if e != nil {
				return e
			}
			c.stack = append(c.stack, n)
			if len(c.stack) > 96 {
				return ErrLimit
			}
			continue
		}
		at++
		if op == 12 {
			if at == len(b) {
				return ErrInvalid
			}
			op = 1200 + int(b[at])
			at++
		}
		a := c.stack
		n := len(a)
		var e error
		switch op {
		case 1, 3, 18, 23, 19, 20:
			c.stems += n / 2
			if c.stems > 96 {
				return ErrLimit
			}
			if op == 19 || op == 20 {
				at += (c.stems + 7) / 8
				if at > len(b) {
					return ErrInvalid
				}
			}
		case 4, 21, 22:
			want := 1
			if op == 21 {
				want = 2
			}
			if n == want+1 {
				a = a[1:]
				n--
			}
			if n != want {
				return ErrInvalid
			}
			if op == 4 {
				e = c.move(0, a[0])
			} else if op == 22 {
				e = c.move(a[0], 0)
			} else {
				e = c.move(a[0], a[1])
			}
		case 5:
			if n < 2 || n%2 != 0 {
				return ErrInvalid
			}
			for j := 0; j < n && e == nil; j += 2 {
				e = c.line(a[j], a[j+1])
			}
		case 6, 7:
			horizontal := op == 6
			for _, v := range a {
				if horizontal {
					e = c.line(v, 0)
				} else {
					e = c.line(0, v)
				}
				if e != nil {
					break
				}
				horizontal = !horizontal
			}
		case 8:
			if n < 6 || n%6 != 0 {
				return ErrInvalid
			}
			for j := 0; j < n && e == nil; j += 6 {
				e = c.curve(a[j : j+6]...)
			}
		case 24:
			if n < 8 || (n-2)%6 != 0 {
				return ErrInvalid
			}
			for j := 0; j < n-2 && e == nil; j += 6 {
				e = c.curve(a[j : j+6]...)
			}
			if e == nil {
				e = c.line(a[n-2], a[n-1])
			}
		case 25:
			if n < 8 || (n-6)%2 != 0 {
				return ErrInvalid
			}
			for j := 0; j < n-6 && e == nil; j += 2 {
				e = c.line(a[j], a[j+1])
			}
			if e == nil {
				e = c.curve(a[n-6:]...)
			}
		case 26, 27:
			if n < 4 || n%4 > 1 {
				return ErrInvalid
			}
			extra := 0.0
			if n%4 == 1 {
				extra = a[0]
				a = a[1:]
				n--
			}
			for j := 0; j < n && e == nil; j += 4 {
				if op == 26 {
					e = c.curve(extra, a[j], a[j+1], a[j+2], 0, a[j+3])
				} else {
					e = c.curve(a[j], extra, a[j+1], a[j+2], a[j+3], 0)
				}
				extra = 0
			}
		case 30, 31:
			if n < 4 || n%4 > 1 {
				return ErrInvalid
			}
			h := op == 31
			for j := 0; j+3 < n && e == nil; j += 4 {
				extra := 0.0
				if j+5 == n {
					extra = a[j+4]
				}
				if h {
					e = c.curve(a[j], 0, a[j+1], a[j+2], extra, a[j+3])
				} else {
					e = c.curve(0, a[j], a[j+1], a[j+2], a[j+3], extra)
				}
				h = !h
			}
		case 10, 29:
			if n < 1 {
				return ErrInvalid
			}
			idx := int(a[n-1])
			c.stack = c.stack[:n-1]
			sub := c.local
			if op == 29 {
				sub = c.f.global
			}
			if !c.f.type1 {
				idx += subrBias(len(sub))
			}
			if idx < 0 || idx >= len(sub) {
				return ErrInvalid
			}
			if e = c.run(sub[idx], depth+1); e != nil {
				return e
			}
			continue
		case 11:
			return nil
		case 14:
			if n > 1 {
				return fmt.Errorf("composite endchar not supported")
			}
			c.close()
			c.done = true
		case 1234:
			if n != 7 {
				return ErrInvalid
			}
			e = c.curve(a[0], 0, a[1], a[2], a[3], 0)
			if e == nil {
				e = c.curve(a[4], 0, a[5], -a[2], a[6], 0)
			}
		case 1235:
			if n != 13 {
				return ErrInvalid
			}
			e = c.curve(a[:6]...)
			if e == nil {
				e = c.curve(a[6:12]...)
			}
		case 1236:
			if n != 9 {
				return ErrInvalid
			}
			e = c.curve(a[0], a[1], a[2], a[3], a[4], 0)
			if e == nil {
				e = c.curve(a[5], 0, a[6], a[7], a[8], -a[1]-a[3]-a[7])
			}
		case 1237:
			if n != 11 {
				return ErrInvalid
			}
			dx, dy := 0.0, 0.0
			for j := 0; j < 10; j += 2 {
				dx += a[j]
				dy += a[j+1]
			}
			x, y := -dx, a[10]
			if math.Abs(dx) > math.Abs(dy) {
				x, y = a[10], -dy
			}
			e = c.curve(a[:6]...)
			if e == nil {
				e = c.curve(a[6], a[7], a[8], a[9], x, y)
			}
		case 1212: // div, also used by Type 1 fonts
			if n < 2 || a[n-1] == 0 {
				return ErrInvalid
			}
			c.stack[n-2] /= a[n-1]
			c.stack = c.stack[:n-1]
			continue
		case 9:
			if !c.f.type1 {
				return ErrInvalid
			}
			c.close()
		case 13:
			if !c.f.type1 || n != 2 {
				return ErrInvalid
			}
			c.x = a[0]
			c.y = 0
		case 1200, 1201, 1202:
			if !c.f.type1 {
				return ErrInvalid
			} // dotsection / stem3: hints only
		case 1207:
			if !c.f.type1 || n != 4 {
				return ErrInvalid
			}
			c.x = a[0]
			c.y = a[1]
		case 1216:
			if !c.f.type1 || n < 2 {
				return ErrInvalid
			}
			count, sub := int(a[n-2]), int(a[n-1])
			if count < 0 || count > n-2 {
				return ErrInvalid
			}
			args := a[n-2-count : n-2]
			c.others = nil
			switch sub {
			case 0:
				if count != 3 || len(c.flexPoints) != 7 || !c.flex {
					return ErrInvalid
				}
				v := c.flexPoints
				e = c.point("C", v[1][0], v[1][1], v[2][0], v[2][1], v[3][0], v[3][1])
				if e == nil {
					e = c.point("C", v[4][0], v[4][1], v[5][0], v[5][1], v[6][0], v[6][1])
				}
				c.flex = false
				c.others = []float64{args[1], args[2]}
			case 1:
				if count != 0 {
					return ErrInvalid
				}
				c.flex = true
				c.flexPoints = nil
			case 2:
				if count != 0 || !c.flex || len(c.flexPoints) >= 7 {
					return ErrInvalid
				}
				c.flexPoints = append(c.flexPoints, [2]float64{c.x, c.y})
			case 3:
				if count != 1 {
					return ErrInvalid
				}
				c.others = append(c.others, args[0])
			default:
				return fmt.Errorf("unsupported Type 1 OtherSubr %d", sub)
			}
			if e != nil {
				return e
			}
			c.stack = c.stack[:n-2-count]
			continue
		case 1217:
			if !c.f.type1 || len(c.others) == 0 {
				return ErrInvalid
			}
			c.stack = append(c.stack, c.others[0])
			c.others = c.others[1:]
			continue

		case 1233:
			if !c.f.type1 || n != 2 {
				return ErrInvalid
			}
			c.x = a[0]
			c.y = a[1]
		default:
			return fmt.Errorf("unsupported charstring operator %d", op)
		}
		if e != nil {
			return e
		}
		c.stack = c.stack[:0]
	}
	return nil
}
func (f *outlineFont) outline(code uint32, name string) (string, matrix, error) {
	gid, ok := f.codes[code]
	if f.type1 || f.type3 {
		gid, ok = f.names[name]
	}
	limit := len(f.chars)
	if f.ttf != nil {
		limit = f.ttf.glyphs
	}
	if !ok || gid < 0 || gid >= limit {
		return "", f.matrix, ErrInvalid
	}
	if v, ok := f.cache[gid]; ok {
		return v.path, f.matrix, v.err
	}
	if f.type3 {
		c := charstring{f: f}
		e := type3Outline(&c, f.chars[gid])
		v := glyphOutline{path: c.path.String(), box: c.box, hasBox: c.hasBox, operations: c.ops, err: e}
		f.cache[gid] = v
		return v.path, f.matrix, e
	}
	if f.ttf != nil {
		c := charstring{f: f}
		e := f.ttf.draw(&c, gid, identity, 0)
		v := glyphOutline{path: c.path.String(), box: c.box, hasBox: c.hasBox, operations: c.ops, err: e}
		f.cache[gid] = v
		return v.path, f.matrix, e
	}
	c := charstring{f: f, local: f.local[f.fd[gid]]}
	e := c.run(f.chars[gid], 0)
	c.close()
	if e == nil && !c.done {
		e = ErrInvalid
	}
	result := glyphOutline{path: c.path.String(), box: c.box, hasBox: c.hasBox, operations: c.ops, err: e}
	f.cache[gid] = result
	return result.path, f.matrix, e
}
