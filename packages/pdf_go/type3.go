package pdfextractor

// Type 3 path and monochrome bitmap glyphs use bounded PDF drawing operators.
// Colored, text-containing and resource-dependent procedures report a warning.
func type3Outline(c *charstring, b []byte) error {
	l := lexer{b: b}
	a := array{}
	ctm := identity
	var stack []matrix
	point := func(op string, coords ...float64) error {
		coords = append([]float64(nil), coords...)
		for j := 0; j+1 < len(coords); j += 2 {
			coords[j], coords[j+1] = ctm.point(coords[j], coords[j+1])
		}
		return c.point(op, coords...)
	}
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
		case "q":
			if len(stack) >= 32 {
				return ErrLimit
			}
			stack = append(stack, ctm)
		case "Q":
			if len(stack) == 0 {
				return ErrInvalid
			}
			ctm = stack[len(stack)-1]
			stack = stack[:len(stack)-1]
		case "cm":
			n, ok := nums(a, 6)
			if !ok {
				return ErrInvalid
			}
			m := matrix{}
			copy(m[:], n)
			ctm = ctm.mul(m)
			if !ctm.valid() {
				return ErrLimit
			}
		case "BI":
			e = type3Mask(c, &l, ctm)
		case "m", "l":
			n, ok := nums(a, 2)
			if !ok {
				return ErrInvalid
			}
			if op == "m" {
				c.close()
				c.open = true
				e = point("M", n...)
			} else {
				e = point("L", n...)
			}
			c.x, c.y = n[0], n[1]
		case "c":
			n, ok := nums(a, 6)
			if !ok {
				return ErrInvalid
			}
			e = point("C", n...)
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
			e = point("C", v...)
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
