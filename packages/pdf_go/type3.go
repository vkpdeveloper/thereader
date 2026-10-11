package pdfextractor

// A deliberately restricted Type 3 glyph reader. Only path glyphs are accepted;
// bitmap, colored, text-containing and resource-dependent procedures fall back
// with an explicit warning. It cannot execute arbitrary PDF procedures.
func type3Outline(c *charstring, b []byte) error {
	l := lexer{b: b}
	a := array{}
	for l.pos < len(b) && l.err == nil {
		l.skip()
		if l.pos == len(b) {
			break
		}
		v := l.value(0)
		op, ok := v.(keyword)
		if !ok {
			if _, ok := v.(float64); !ok {
				return ErrInvalid
			}
			a = append(a, v)
			if len(a) > 6 {
				return ErrLimit
			}
			continue
		}
		c.ops++
		if c.ops > 100000 {
			return ErrLimit
		}
		var e error
		switch op {
		case "d0", "d1": // declared advance / bounding box
		case "m", "l":
			n, ok := nums(a, 2)
			if !ok {
				return ErrInvalid
			}
			if op == "m" {
				c.close()
				c.open = true
				e = c.point("M", n...)
			} else {
				e = c.point("L", n...)
			}
			c.x, c.y = n[0], n[1]
		case "c":
			n, ok := nums(a, 6)
			if !ok {
				return ErrInvalid
			}
			e = c.point("C", n...)
			c.x, c.y = n[4], n[5]
		case "v", "y":
			n, ok := nums(a, 4)
			if !ok {
				return ErrInvalid
			}
			v := []float64{c.x, c.y, n[0], n[1], n[2], n[3]}
			if op == "y" {
				v = []float64{n[0], n[1], n[2], n[3], n[2], n[3]}
			}
			e = c.point("C", v...)
			c.x, c.y = n[2], n[3]
		case "h", "f", "F":
			c.close()
		default:
			return ErrInvalid
		}
		if e != nil {
			return e
		}
		a = a[:0]
	}
	c.close()
	return l.err
}
