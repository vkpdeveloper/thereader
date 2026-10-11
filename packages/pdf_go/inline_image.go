package pdfextractor

import (
	"bytes"
	"compress/zlib"
	"errors"
	"fmt"
	"io"
)

func (i *interpreter) inlineImage(l *lexer) error {
	d := dict{}
	aliases := map[string]string{"W": "Width", "H": "Height", "BPC": "BitsPerComponent", "CS": "ColorSpace", "F": "Filter", "DP": "DecodeParms", "D": "Decode", "IM": "ImageMask", "I": "Interpolate"}
	for n := 0; n < 100; n++ {
		v := l.value(0)
		if v == keyword("ID") {
			break
		}
		key, ok := v.(name)
		if !ok || l.err != nil {
			return fmt.Errorf("%w: inline image dictionary", ErrInvalid)
		}
		k := string(key)
		if full := aliases[k]; full != "" {
			k = full
		}
		d[k] = l.value(0)
		if n == 99 {
			return ErrLimit
		}
	}
	if l.pos >= len(l.b) || !white(l.b[l.pos]) {
		return ErrInvalid
	}
	if l.b[l.pos] == '\r' && l.pos+1 < len(l.b) && l.b[l.pos+1] == '\n' {
		l.pos++
	}
	l.pos++
	start := l.pos
	tail := l.b[start:]
	length := 0
	filter := named(d["Filter"])
	if a := asArray(d["Filter"]); len(a) > 0 {
		filter = named(a[0])
	}
	switch filter {
	case "":
		w, h, bits := integer(d["Width"]), integer(d["Height"]), integer(d["BitsPerComponent"])
		if mask, _ := d["ImageMask"].(bool); mask {
			bits = 1
		}
		channels := 1
		switch named(d["ColorSpace"]) {
		case "RGB", "DeviceRGB":
			channels = 3
		case "CMYK", "DeviceCMYK":
			channels = 4
		}
		if w < 1 || h < 1 || bits < 1 || bits > 16 || w > i.p.opts.Limits.ImagePixels/h {
			return ErrLimit
		}
		length = ((w*channels*bits + 7) / 8) * h
	case "Fl", "FlateDecode":
		raw := bytes.NewReader(tail)
		reader, e := zlib.NewReader(raw)
		if e != nil {
			return e
		}
		n, e := io.Copy(io.Discard, io.LimitReader(reader, int64(i.p.opts.Limits.DecodedBytes-i.p.decodedSize)+1))
		reader.Close()
		if e != nil {
			return e
		}
		if n > int64(i.p.opts.Limits.DecodedBytes-i.p.decodedSize) {
			return ErrLimit
		}
		length = len(tail) - raw.Len()
	case "A85", "ASCII85Decode":
		end := bytes.Index(tail, []byte("~>"))
		if end < 0 {
			return ErrInvalid
		}
		length = end + 2
	case "AHx", "ASCIIHexDecode":
		end := bytes.IndexByte(tail, '>')
		if end < 0 {
			return ErrInvalid
		}
		length = end + 1
	case "DCT", "DCTDecode":
		end := bytes.Index(tail, []byte{255, 217})
		if end < 0 {
			return ErrInvalid
		}
		length = end + 2
	default:
		return fmt.Errorf("unsupported inline image filter %s", filter)
	}
	if length < 0 || length > len(tail) {
		return ErrInvalid
	}
	l.pos = start + length
	if l.word() != "EI" {
		return fmt.Errorf("%w: inline image terminator", ErrInvalid)
	}
	if cs := named(d["ColorSpace"]); cs != "" {
		if v := i.p.dict(i.resources["ColorSpace"])[cs]; v != nil {
			d["ColorSpace"] = v
		}
	}
	s := &stream{d, tail[:length]}
	id, e := i.p.image(s, i.page.page.Number)
	if e != nil {
		if errors.Is(e, ErrLimit) || i.p.opts.Context.Err() != nil {
			return e
		}
		i.p.warn("image", i.page.page.Number, e.Error())
		return nil
	}
	box := i.g.ctm.rect(0, 0, 1, 1)
	if !finiteRect(box) {
		return ErrLimit
	}
	i.page.images = append(i.page.images, Block{Kind: "image", Asset: id, Alt: "Image", Box: box})
	return nil
}
