package pdfextractor

import (
	"bytes"
	"compress/zlib"
	"encoding/ascii85"
	"encoding/hex"
	"fmt"
	"io"
)

func boundedRead(r io.Reader, limit int) ([]byte, error) {
	if limit < 0 {
		return nil, ErrLimit
	}
	b, e := io.ReadAll(io.LimitReader(r, int64(limit)+1))
	if len(b) > limit {
		return nil, ErrLimit
	}
	return b, e
}
func (p *pdf) decode(s *stream) ([]byte, error) {
	if b, ok := p.decoded[s]; ok {
		return b, nil
	}
	b, terminal, e := p.decodeFilters(s, true)
	if e != nil {
		return nil, e
	}
	if terminal != "" {
		return nil, fmt.Errorf("unsupported stream filter %s", terminal)
	}
	p.decoded[s] = b
	return b, nil
}
func (p *pdf) decodeFilters(s *stream, all bool) ([]byte, string, error) {
	filters := p.array(s.dict["Filter"])
	if n, ok := p.resolve(s.dict["Filter"]).(name); ok {
		filters = array{n}
	}
	params := p.array(s.dict["DecodeParms"])
	if d := p.dict(s.dict["DecodeParms"]); d != nil {
		params = array{d}
	}
	b := s.raw
	for i, f := range filters {
		if e := p.check(); e != nil {
			return nil, "", e
		}
		kind := named(p.resolve(f))
		var d dict
		if i < len(params) {
			d = p.dict(params[i])
		}
		limit := p.opts.Limits.DecodedBytes - p.decodedSize
		var err error
		switch kind {
		case "FlateDecode", "Fl":
			r, e := zlib.NewReader(bytes.NewReader(b))
			if e != nil {
				return nil, "", e
			}
			b, err = boundedRead(r, limit)
			r.Close()
		case "ASCII85Decode", "A85":
			b = bytes.TrimSpace(b)
			b = bytes.TrimSuffix(b, []byte("~>"))
			b, err = boundedRead(ascii85.NewDecoder(bytes.NewReader(b)), limit)
		case "ASCIIHexDecode", "AHx":
			h := make([]byte, 0, len(b))
			for _, c := range b {
				if c == '>' {
					break
				}
				if !white(c) {
					h = append(h, c)
				}
			}
			if len(h)%2 != 0 {
				h = append(h, '0')
			}
			if len(h)/2 > limit {
				return nil, "", ErrLimit
			}
			b = make([]byte, len(h)/2)
			_, err = hex.Decode(b, h)
		case "RunLengthDecode", "RL":
			b, err = runLength(b, limit)
		case "LZWDecode", "LZW":
			early := 1
			if v, ok := d["EarlyChange"]; ok {
				early = integer(v)
			}
			if early != 0 && early != 1 {
				return nil, "", ErrInvalid
			}
			b, err = lzwDecode(b, limit, early)
		case "DCTDecode", "DCT", "JPXDecode", "CCITTFaxDecode", "CCF", "JBIG2Decode":
			if i != len(filters)-1 {
				return nil, "", fmt.Errorf("unsupported image filter chain")
			}
			return b, kind, nil
		default:
			return nil, "", fmt.Errorf("unsupported stream filter %s", kind)
		}
		if err != nil {
			return nil, "", err
		}
		if kind == "FlateDecode" || kind == "Fl" || kind == "LZWDecode" || kind == "LZW" {
			b, err = predict(b, d, limit)
			if err != nil {
				return nil, "", err
			}
		}
		p.decodedSize += len(b)
		if p.decodedSize > p.opts.Limits.DecodedBytes {
			return nil, "", ErrLimit
		}
	}
	if len(filters) == 0 {
		p.decodedSize += len(b)
		if p.decodedSize > p.opts.Limits.DecodedBytes {
			return nil, "", ErrLimit
		}
	}
	return b, "", nil
}

func runLength(b []byte, limit int) ([]byte, error) {
	out := []byte{}
	for i := 0; i < len(b); {
		n := int(b[i])
		i++
		if n == 128 {
			return out, nil
		}
		count := n + 1
		if n > 128 {
			count = 257 - n
		}
		if count > limit-len(out) {
			return nil, ErrLimit
		}
		if n < 128 {
			if count > len(b)-i {
				return nil, ErrInvalid
			}
			out = append(out, b[i:i+count]...)
			i += count
		} else {
			if i == len(b) {
				return nil, ErrInvalid
			}
			for j := 0; j < count; j++ {
				out = append(out, b[i])
			}
			i++
		}
	}
	return nil, fmt.Errorf("%w: unterminated RunLength stream", ErrInvalid)
}

// PDF LZW has a configurable early-change bit unlike compress/lzw's dialect.
func lzwDecode(b []byte, limit, early int) ([]byte, error) {
	var table [4096][]byte
	for i := 0; i < 256; i++ {
		table[i] = []byte{byte(i)}
	}
	bits, next, pos := 9, 258, 0
	out := []byte{}
	var previous []byte
	for pos+bits <= len(b)*8 {
		code := 0
		for j := 0; j < bits; j++ {
			code = code*2 + int((b[pos/8]>>uint(7-pos%8))&1)
			pos++
		}
		if code == 256 {
			bits, next, previous = 9, 258, nil
			continue
		}
		if code == 257 {
			return out, nil
		}
		var entry []byte
		if code < next {
			entry = table[code]
		} else if code == next && len(previous) > 0 {
			entry = append(append([]byte{}, previous...), previous[0])
		} else {
			return nil, ErrInvalid
		}
		if len(entry) == 0 {
			return nil, ErrInvalid
		}
		if len(entry) > limit-len(out) {
			return nil, ErrLimit
		}
		out = append(out, entry...)
		if len(previous) > 0 && next < 4096 {
			table[next] = append(append([]byte{}, previous...), entry[0])
			next++
			if bits < 12 && next+early == 1<<bits {
				bits++
			}
		}
		previous = entry
	}
	return nil, fmt.Errorf("%w: truncated LZW stream", ErrInvalid)
}

func predict(b []byte, d dict, limit int) ([]byte, error) {
	pred := integer(d["Predictor"])
	if pred <= 1 {
		return b, nil
	}
	colors, cols, bits := integer(d["Colors"]), integer(d["Columns"]), integer(d["BitsPerComponent"])
	if colors == 0 {
		colors = 1
	}
	if cols == 0 {
		cols = 1
	}
	if bits == 0 {
		bits = 8
	}
	if colors < 1 || colors > 32 || cols < 1 || cols > 1000000 || bits < 1 || bits > 16 {
		return nil, ErrLimit
	}
	row := (colors*cols*bits + 7) / 8
	bpp := (colors*bits + 7) / 8
	if row > limit {
		return nil, ErrLimit
	}
	if pred == 2 {
		if bits != 8 {
			return nil, fmt.Errorf("unsupported TIFF predictor bit depth %d", bits)
		}
		if len(b)%row != 0 {
			return nil, ErrInvalid
		}
		for y := 0; y < len(b); y += row {
			for x := colors; x < row; x++ {
				b[y+x] += b[y+x-colors]
			}
		}
		return b, nil
	}
	if pred < 10 || pred > 15 || len(b)%(row+1) != 0 {
		return nil, fmt.Errorf("%w: invalid predictor", ErrInvalid)
	}
	out := make([]byte, len(b)/(row+1)*row)
	for y, pos := 0, 0; pos < len(b); y, pos = y+row, pos+row+1 {
		f := b[pos]
		if f > 4 {
			return nil, ErrInvalid
		}
		for x := 0; x < row; x++ {
			v := b[pos+1+x]
			var a, c, u byte
			if x >= bpp {
				a = out[y+x-bpp]
			}
			if y > 0 {
				u = out[y-row+x]
				if x >= bpp {
					c = out[y-row+x-bpp]
				}
			}
			switch f {
			case 1:
				v += a
			case 2:
				v += u
			case 3:
				v += byte((int(a) + int(u)) / 2)
			case 4:
				v += paeth(a, u, c)
			}
			out[y+x] = v
		}
	}
	return out, nil
}
func paeth(a, b, c byte) byte {
	p := int(a) + int(b) - int(c)
	x, y, z := absInt(p-int(a)), absInt(p-int(b)), absInt(p-int(c))
	if x <= y && x <= z {
		return a
	}
	if y <= z {
		return b
	}
	return c
}
func absInt(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
