package pdfextractor

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// A bounded T.4/T.6 decoder. A one bit in the result denotes a black pixel;
// the PDF BlackIs1 parameter is applied separately to the image samples.
type faxBits struct {
	data []byte
	at   int
}

func (b *faxBits) bit() (int, error) {
	if b.at/8 >= len(b.data) {
		return 0, ErrInvalid
	}
	v := int(b.data[b.at/8] >> uint(7-b.at%8) & 1)
	b.at++
	return v, nil
}
func (b *faxBits) eol() bool {
	old := b.at
	for n := 0; n < 128; n++ {
		v, e := b.bit()
		if e != nil {
			break
		}
		if v == 1 {
			if n >= 11 {
				return true
			}
			break
		}
	}
	b.at = old
	return false
}

type faxNode struct {
	next [2]int
	run  int
}

func faxTree(table string) []faxNode {
	nodes := []faxNode{{run: -1}}
	fields := strings.Fields(table + "\n" + faxSharedCodes)
	for i := 0; i < len(fields); i += 2 {
		at := 0
		for _, c := range fields[i] {
			bit := int(c - '0')
			if nodes[at].next[bit] == 0 {
				nodes[at].next[bit] = len(nodes)
				nodes = append(nodes, faxNode{run: -1})
			}
			at = nodes[at].next[bit]
		}
		nodes[at].run, _ = strconv.Atoi(fields[i+1])
	}
	return nodes
}

var faxTrees = [2][]faxNode{faxTree(faxWhiteCodes), faxTree(faxBlackCodes)}

func (b *faxBits) run(black, remaining int) (int, error) {
	total := 0
	for count := 0; count <= remaining/64+1; count++ {
		at := 0
		tree := faxTrees[black]
		for tree[at].run < 0 {
			v, e := b.bit()
			if e != nil {
				return 0, e
			}
			at = tree[at].next[v]
			if at == 0 {
				return 0, ErrInvalid
			}
		}
		n := tree[at].run
		if n > remaining-total {
			return 0, ErrInvalid
		}
		total += n
		if n < 64 {
			return total, nil
		}
	}
	return 0, ErrInvalid
}

// mode returns vertical displacement, or 10 (horizontal), 20 (pass).
func (b *faxBits) mode() (int, error) {
	code := 0
	for n := 1; n <= 7; n++ {
		v, e := b.bit()
		if e != nil {
			return 0, e
		}
		code = code*2 + v
		switch {
		case n == 1 && code == 1:
			return 0, nil
		case n == 3:
			switch code {
			case 1:
				return 10, nil
			case 2:
				return -1, nil
			case 3:
				return 1, nil
			}
		case n == 4 && code == 1:
			return 20, nil
		case n == 6:
			switch code {
			case 2:
				return -2, nil
			case 3:
				return 2, nil
			}
		case n == 7:
			switch code {
			case 2:
				return -3, nil
			case 3:
				return 3, nil
			case 1:
				return 0, fmt.Errorf("unsupported CCITT extension mode")
			}
		}
	}
	return 0, ErrInvalid
}
func faxBlack(row []byte, start, end int) {
	for start < end && start%8 != 0 {
		row[start/8] |= 1 << uint(7-start%8)
		start++
	}
	for start+8 <= end {
		row[start/8] = 255
		start += 8
	}
	for start < end {
		row[start/8] |= 1 << uint(7-start%8)
		start++
	}
}
func decodeFax(data []byte, w, h, k int, eol, align bool, limit int, check func() error) ([]byte, error) {
	if w < 1 || h < 1 || w > 1<<24 || (w+7)/8 > limit/h {
		return nil, ErrLimit
	}
	stride := (w + 7) / 8
	// Two fixed-capacity transition rows, including sentinels. Bound working
	// memory as well as the packed output before allocating from PDF widths.
	if w+2 > (limit-stride*h)/16 {
		return nil, ErrLimit
	}
	out := make([]byte, stride*h)
	bits := faxBits{data: data}
	reference := make([]int, 2, w+2)
	reference[0], reference[1] = w, w
	current := make([]int, 0, w+2)
	for y := 0; y < h; y++ {
		if check != nil {
			if e := check(); e != nil {
				return nil, e
			}
		}
		oneD := k == 0
		if k >= 0 {
			hasEOL := bits.eol()
			if !hasEOL && align {
				bits.at = (bits.at + 7) / 8 * 8
				hasEOL = bits.eol()
			}
			if eol && !hasEOL {
				return nil, fmt.Errorf("%w: CCITT EOL", ErrInvalid)
			}
			if k > 0 {
				tag, e := bits.bit()
				if e != nil {
					return nil, e
				}
				oneD = tag == 1
			}
		} else if align {
			bits.at = (bits.at + 7) / 8 * 8
		}
		row := out[y*stride : (y+1)*stride]
		a0, black := 0, 0
		initial := true
		current = current[:0]
		for steps := 0; a0 < w; steps++ {
			if steps > 2*w+2 {
				return nil, ErrInvalid
			}
			if steps%256 == 0 && check != nil {
				if e := check(); e != nil {
					return nil, e
				}
			}
			if oneD {
				run, e := bits.run(black, w-a0)
				if e != nil {
					return nil, e
				}
				if run == 0 && steps != 0 {
					return nil, ErrInvalid
				}
				if black == 1 {
					faxBlack(row, a0, a0+run)
				}
				a0 += run
				current = append(current, a0)
				black ^= 1
				continue
			}
			mode, e := bits.mode()
			if e != nil {
				return nil, e
			}
			if mode == 10 {
				first, e := bits.run(black, w-a0)
				if e != nil {
					return nil, e
				}
				second, e := bits.run(black^1, w-a0-first)
				if e != nil {
					return nil, e
				}
				if first+second == 0 || (first == 0 && !initial) || (second == 0 && a0+first < w) {
					return nil, ErrInvalid
				}
				if black == 1 {
					faxBlack(row, a0, a0+first)
				} else {
					faxBlack(row, a0+first, a0+first+second)
				}
				current = append(current, a0+first, a0+first+second)
				a0 += first + second
			} else {
				threshold := a0 + 1
				if initial {
					threshold = 0
				}
				j := sort.SearchInts(reference, threshold)
				if j%2 != black {
					j++
				}
				b1 := w
				if j < len(reference) {
					b1 = reference[j]
				}
				end := b1 + mode
				if mode == 20 {
					end = w
					if j+1 < len(reference) {
						end = reference[j+1]
					}
				}
				if end < a0 || end > w || (end == a0 && !initial) {
					return nil, ErrInvalid
				}
				if black == 1 {
					faxBlack(row, a0, end)
				}
				a0 = end
				if mode != 20 {
					current = append(current, a0)
					black ^= 1
				}
			}
			initial = false
		}
		// Exactly one transition at width is followed by a sentinel of opposite
		// parity. Zero-length terminal runs are irrelevant to the next scanline.
		for len(current) > 0 && current[len(current)-1] == w {
			current = current[:len(current)-1]
		}
		current = append(current, w, w)
		reference, current = current, reference[:0]
	}
	return out, nil
}
func (p *pdf) faxImage(s *stream, b []byte, w, h int) ([]byte, error) {
	params := p.array(s.dict["DecodeParms"])
	d := p.dict(s.dict["DecodeParms"])
	if len(params) > 0 {
		d = p.dict(params[len(params)-1])
	}
	columns := 1728
	if v, ok := d["Columns"]; ok {
		columns = integer(p.resolve(v))
	}
	rows := integer(p.resolve(d["Rows"]))
	if columns != w || (rows != 0 && rows != h) {
		return nil, fmt.Errorf("%w: CCITT dimensions", ErrInvalid)
	}
	eol, _ := p.resolve(d["EndOfLine"]).(bool)
	align, _ := p.resolve(d["EncodedByteAlign"]).(bool)
	b, e := decodeFax(b, w, h, integer(p.resolve(d["K"])), eol, align, p.opts.Limits.DecodedBytes-p.decodedSize, p.check)
	if e != nil {
		return nil, e
	}
	p.decodedSize += len(b) + 16*(w+2)
	blackIs1, _ := p.resolve(d["BlackIs1"]).(bool)
	if !blackIs1 {
		for i := range b {
			b[i] = ^b[i]
		}
	}
	return b, nil
}
