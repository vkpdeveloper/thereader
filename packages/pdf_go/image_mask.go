package pdfextractor

import (
	"bytes"
	"fmt"
	"image/color"
	"image/jpeg"
)

// Soft-mask samples are grayscale, independent of the base image's color space.
// Decode is applied once, by softMask, after optional spatial interpolation.
func (p *pdf) maskSamples(s *stream, w, h int) ([]byte, error) {
	bits := integer(p.resolve(s.dict["BitsPerComponent"]))
	if bits != 1 && bits != 2 && bits != 4 && bits != 8 && bits != 16 {
		return nil, fmt.Errorf("unsupported soft mask bit depth %d", bits)
	}
	b, kind, e := p.decodeFilters(s, false)
	if e != nil {
		return nil, e
	}
	if kind == "CCITTFaxDecode" || kind == "CCF" {
		b, e = p.faxImage(s, b, w, h)
		if e != nil {
			return nil, e
		}
		kind = ""
	}
	if kind == "DCTDecode" || kind == "DCT" {
		if w > (p.opts.Limits.DecodedBytes-p.decodedSize)/8/h {
			return nil, ErrLimit
		}
		cfg, e := jpeg.DecodeConfig(bytes.NewReader(b))
		if e != nil {
			return nil, e
		}
		if cfg.Width != w || cfg.Height != h {
			return nil, ErrInvalid
		}
		p.decodedSize += w * h * 8
		img, e := jpeg.Decode(bytes.NewReader(b))
		if e != nil {
			return nil, e
		}
		out := make([]byte, w*h)
		for y := 0; y < h; y++ {
			if e := p.check(); e != nil {
				return nil, e
			}
			for x := 0; x < w; x++ {
				out[y*w+x] = color.GrayModel.Convert(img.At(x, y)).(color.Gray).Y
			}
		}
		return out, nil
	}
	if kind != "" {
		return nil, fmt.Errorf("unsupported soft mask encoding %s", kind)
	}
	stride := (w*bits + 7) / 8
	if h > len(b)/stride {
		return nil, ErrInvalid
	}
	if bits == 8 {
		return b[:w*h], nil
	}
	if w > (p.opts.Limits.DecodedBytes-p.decodedSize)/h {
		return nil, ErrLimit
	}
	p.decodedSize += w * h
	out := make([]byte, w*h)
	for y := 0; y < h; y++ {
		if e := p.check(); e != nil {
			return nil, e
		}
		for x := 0; x < w; x++ {
			at := y*stride + x*bits/8
			if bits == 16 {
				out[y*w+x] = b[at]
			} else {
				mask := byte(1<<bits - 1)
				out[y*w+x] = (b[at] >> uint(8-bits-x*bits%8) & mask) * byte(255/int(mask))
			}
		}
	}
	return out, nil
}
