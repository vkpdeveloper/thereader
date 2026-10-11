package pdfextractor

import (
	"bytes"
	"fmt"
	"strconv"
)

type xentry struct{ typ, offset, gen int }
type pdf struct {
	data                               []byte
	opts                               Options
	xref                               map[int]xentry
	objects                            map[ref]any
	loading                            map[ref]bool
	decoded                            map[*stream][]byte
	objstreams                         map[int]bool
	trailer                            dict
	fonts                              map[ref]*font
	assetIDs                           map[*stream]string
	assetNames                         map[string]bool
	assetBytes, outlineBytes           int
	decodedSize, operations, spanCount int
	err                                error
	out                                *Document
	warned                             map[string]bool
}

func openPDF(data []byte, opts Options) (*pdf, error) {
	if len(data) > opts.Limits.InputBytes {
		return nil, ErrLimit
	}
	head := data
	if len(head) > 1024 {
		head = head[:1024]
	}
	if !bytes.Contains(head, []byte("%PDF-")) {
		return nil, fmt.Errorf("%w: missing PDF header", ErrInvalid)
	}
	p := &pdf{data: data, opts: opts, xref: map[int]xentry{}, objects: map[ref]any{}, loading: map[ref]bool{}, decoded: map[*stream][]byte{}, objstreams: map[int]bool{}, fonts: map[ref]*font{}, assetIDs: map[*stream]string{}, warned: map[string]bool{}, out: &Document{Engine: "PDF Extractor", Version: Version, Complete: true, Pages: []Page{}, Assets: []Asset{}, Outline: []Outline{}, Warnings: []Warning{}}}
	start := bytes.LastIndex(data, []byte("startxref"))
	if start < 0 {
		return nil, fmt.Errorf("%w: missing startxref", ErrInvalid)
	}
	l := lexer{b: data, pos: start + 9}
	off, e := strconv.Atoi(l.word())
	if e != nil {
		return nil, fmt.Errorf("%w: invalid xref offset", ErrInvalid)
	}
	if e = p.readXref(off, map[int]bool{}, 0); e != nil {
		return nil, e
	}
	if p.trailer["Encrypt"] != nil {
		return nil, ErrEncrypted
	}
	return p, nil
}

func (p *pdf) check() error {
	if p.err != nil {
		return p.err
	}
	if e := p.opts.Context.Err(); e != nil {
		p.err = e
	}
	return p.err
}
func (p *pdf) putXref(id int, e xentry) error {
	if id < 0 || id > p.opts.Limits.Objects*10 {
		return ErrLimit
	}
	if _, ok := p.xref[id]; !ok {
		p.xref[id] = e
	}
	if len(p.xref) > p.opts.Limits.Objects {
		return ErrLimit
	}
	return nil
}

func (p *pdf) readXref(off int, seen map[int]bool, depth int) error {
	if e := p.check(); e != nil {
		return e
	}
	if off < 0 || off >= len(p.data) || seen[off] {
		return fmt.Errorf("%w: cyclic or invalid xref", ErrInvalid)
	}
	if depth > 64 {
		return ErrLimit
	}
	seen[off] = true
	l := lexer{b: p.data, pos: off}
	var trailer dict
	if l.word() == "xref" {
		for {
			w := l.word()
			if w == "trailer" {
				trailer = asDict(l.value(0))
				break
			}
			first, e := strconv.Atoi(w)
			if e != nil {
				return fmt.Errorf("%w: invalid xref section", ErrInvalid)
			}
			count, e := strconv.Atoi(l.word())
			if e != nil || count < 0 || count > p.opts.Limits.Objects {
				return ErrLimit
			}
			for i := 0; i < count; i++ {
				pos, e1 := strconv.Atoi(l.word())
				gen, e2 := strconv.Atoi(l.word())
				flag := l.word()
				if e1 != nil || e2 != nil || (flag != "n" && flag != "f") {
					return fmt.Errorf("%w: invalid xref entry", ErrInvalid)
				}
				typ := 0
				if flag == "n" {
					typ = 1
				}
				if e = p.putXref(first+i, xentry{typ, pos, gen}); e != nil {
					return e
				}
			}
		}
	} else {
		_, v, e := p.indirect(off)
		if e != nil {
			return e
		}
		s, ok := v.(*stream)
		if !ok || named(s.dict["Type"]) != "XRef" {
			return fmt.Errorf("%w: expected xref stream", ErrInvalid)
		}
		trailer = s.dict
		b, e := p.decode(s)
		if e != nil {
			return e
		}
		w := asArray(trailer["W"])
		if len(w) != 3 {
			return fmt.Errorf("%w: invalid xref widths", ErrInvalid)
		}
		widths := []int{integer(w[0]), integer(w[1]), integer(w[2])}
		row := 0
		for _, n := range widths {
			if n < 0 || n > 8 {
				return ErrInvalid
			}
			row += n
		}
		if row == 0 {
			return ErrInvalid
		}
		indices := asArray(trailer["Index"])
		if len(indices) == 0 {
			indices = array{float64(0), trailer["Size"]}
		}
		if len(indices)%2 != 0 {
			return ErrInvalid
		}
		pos := 0
		for i := 0; i < len(indices); i += 2 {
			first, count := integer(indices[i]), integer(indices[i+1])
			if count < 0 || count > p.opts.Limits.Objects || count > (len(b)-pos)/row {
				return ErrInvalid
			}
			for j := 0; j < count; j++ {
				var fields [3]int
				for k, n := range widths {
					for z := 0; z < n; z++ {
						if fields[k] > (1 << 53) {
							return ErrLimit
						}
						fields[k] = fields[k]*256 + int(b[pos])
						pos++
					}
				}
				if widths[0] == 0 {
					fields[0] = 1
				}
				if e = p.putXref(first+j, xentry{fields[0], fields[1], fields[2]}); e != nil {
					return e
				}
			}
		}
	}
	if l.err != nil {
		return l.err
	}
	if trailer == nil {
		return ErrInvalid
	}
	if p.trailer == nil {
		p.trailer = trailer
	} else {
		for k, v := range trailer {
			if _, ok := p.trailer[k]; !ok {
				p.trailer[k] = v
			}
		}
	}
	// Hybrid reference streams supplement a classic table from the same revision.
	if v, ok := trailer["XRefStm"]; ok {
		if e := p.readXref(integer(v), seen, depth+1); e != nil {
			return e
		}
	}
	if v, ok := trailer["Prev"]; ok {
		return p.readXref(integer(v), seen, depth+1)
	}
	return nil
}

func (p *pdf) indirect(off int) (ref, any, error) {
	if off < 0 || off >= len(p.data) {
		return ref{}, nil, ErrInvalid
	}
	l := lexer{b: p.data, pos: off}
	id, e := strconv.Atoi(l.word())
	gen, e2 := strconv.Atoi(l.word())
	if e != nil || e2 != nil || l.word() != "obj" {
		return ref{}, nil, fmt.Errorf("%w: invalid object at %d", ErrInvalid, off)
	}
	r := ref{id, gen}
	v := l.value(0)
	if l.err != nil {
		return r, nil, l.err
	}
	l.skip()
	if d, ok := v.(dict); ok && l.word() == "stream" {
		if l.pos < len(l.b) && l.b[l.pos] == '\r' {
			l.pos++
		}
		if l.pos < len(l.b) && l.b[l.pos] == '\n' {
			l.pos++
		} else if l.pos == 0 || l.b[l.pos-1] != '\r' {
			return r, nil, fmt.Errorf("%w: stream newline", ErrInvalid)
		}
		nv := p.resolve(d["Length"])
		n, ok := nv.(float64)
		if !ok || n < 0 || n != float64(int(n)) || n > float64(len(p.data)-l.pos) {
			return r, nil, fmt.Errorf("%w: invalid stream length", ErrInvalid)
		}
		raw := l.b[l.pos : l.pos+int(n)]
		l.pos += int(n)
		if l.word() != "endstream" {
			return r, nil, fmt.Errorf("%w: missing endstream", ErrInvalid)
		}
		v = &stream{d, raw}
	}
	return r, v, nil
}

func (p *pdf) resolve(v any) any {
	for i := 0; i < 64; i++ {
		r, ok := v.(ref)
		if !ok {
			return v
		}
		v = p.get(r)
		if p.err != nil {
			return nil
		}
	}
	p.err = fmt.Errorf("%w: reference cycle", ErrInvalid)
	return nil
}
func (p *pdf) get(r ref) any {
	if v, ok := p.objects[r]; ok {
		return v
	}
	if p.loading[r] {
		p.err = fmt.Errorf("%w: object cycle", ErrInvalid)
		return nil
	}
	if p.err != nil {
		return nil
	}
	p.loading[r] = true
	defer delete(p.loading, r)
	e, ok := p.xref[r.id]
	if !ok || e.typ == 0 {
		return nil
	}
	if e.typ == 1 {
		if r.gen != e.gen {
			return nil
		}
		actual, v, err := p.indirect(e.offset)
		if err != nil {
			p.err = err
			return nil
		}
		if actual != r {
			p.err = fmt.Errorf("%w: object identity mismatch", ErrInvalid)
			return nil
		}
		p.objects[r] = v
		return v
	}
	if e.typ != 2 || r.gen != 0 {
		p.err = fmt.Errorf("%w: xref entry type", ErrInvalid)
		return nil
	}
	if !p.objstreams[e.offset] {
		p.objstreams[e.offset] = true
		s, ok := p.get(ref{e.offset, 0}).(*stream)
		if !ok {
			p.err = ErrInvalid
			return nil
		}
		b, err := p.decode(s)
		if err != nil {
			p.err = err
			return nil
		}
		n, first := integer(s.dict["N"]), integer(s.dict["First"])
		if named(s.dict["Type"]) != "ObjStm" || n < 0 || n > p.opts.Limits.Objects || first < 0 || first > len(b) {
			p.err = ErrInvalid
			return nil
		}
		l := lexer{b: b[:first]}
		pairs := make([][2]int, n)
		for i := range pairs {
			id, e1 := strconv.Atoi(l.word())
			pos, e2 := strconv.Atoi(l.word())
			if e1 != nil || e2 != nil || pos < 0 || pos >= len(b)-first {
				p.err = ErrInvalid
				return nil
			}
			pairs[i] = [2]int{id, pos}
		}
		for i, pair := range pairs {
			x, exists := p.xref[pair[0]]
			if !exists || x.typ != 2 || x.offset != e.offset || x.gen != i {
				continue
			}
			parser := lexer{b: b, pos: first + pair[1]}
			obj := parser.value(0)
			if parser.err != nil {
				p.err = parser.err
				return nil
			}
			p.objects[ref{pair[0], 0}] = obj
		}
	}
	return p.objects[r]
}

func (p *pdf) dict(v any) dict   { return asDict(p.resolve(v)) }
func (p *pdf) array(v any) array { return asArray(p.resolve(v)) }
