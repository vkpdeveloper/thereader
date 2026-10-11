package pdfextractor

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math"
	"strings"
)

func (p *pdf) addAsset(b []byte, mime, ext string, w, h int) string {
	hash := sha256.Sum256(b)
	id := fmt.Sprintf("assets/%x.%s", hash[:12], ext)
	if p.assetNames == nil {
		p.assetNames = map[string]bool{}
		for _, a := range p.out.Assets {
			p.assetNames[a.Name] = true
		}
	}
	if p.assetNames[id] {
		return id
	}
	if len(b) > p.opts.Limits.AssetBytes-p.assetBytes-p.outlineBytes {
		p.err = ErrLimit
		return ""
	}
	p.assetBytes += len(b)
	p.assetNames[id] = true
	p.out.Assets = append(p.out.Assets, Asset{id, mime, w, h, b})
	return id
}
func (p *pdf) image(s *stream, page int) (string, error) {
	if id, ok := p.assetIDs[s]; ok {
		return id, nil
	}
	w, h := integer(p.resolve(s.dict["Width"])), integer(p.resolve(s.dict["Height"]))
	if w <= 0 || h <= 0 || w > p.opts.Limits.ImagePixels/h {
		return "", ErrLimit
	}
	b, kind, e := p.decodeFilters(s, false)
	if e != nil {
		return "", e
	}
	var id string
	switch kind {
	case "DCTDecode", "DCT":
		if s.dict["Mask"] != nil {
			p.warn("image-mask", page, "Color-key or explicit image masks are not applied.")
		}
		cfg, e := jpeg.DecodeConfig(bytes.NewReader(b))
		if e != nil {
			return "", fmt.Errorf("invalid JPEG image: %w", e)
		}
		if cfg.Width != w || cfg.Height != h {
			return "", fmt.Errorf("invalid JPEG dimensions")
		}
		if s.dict["SMask"] != nil || s.dict["Decode"] != nil {
			img, err := p.jpegRaster(s, b, w, h, page)
			if err != nil {
				return "", err
			}
			id, err = p.pngAsset(img, w, h)
			if err != nil {
				return "", err
			}
		} else {
			id = p.addAsset(b, "image/jpeg", "jpg", w, h)
		}
	case "JPXDecode":
		return "", fmt.Errorf("JPEG 2000 images require an unsupported decoder")
	case "":
		img, e := p.raster(s, b, w, h, page)
		if e != nil {
			return "", e
		}
		id, e = p.pngAsset(img, w, h)
		if e != nil {
			return "", e
		}
	default:
		return "", fmt.Errorf("unsupported image encoding %s", kind)
	}
	p.assetIDs[s] = id
	return id, nil
}

func (p *pdf) pngAsset(img image.Image, w, h int) (string, error) {
	var out bytes.Buffer
	encoder := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := encoder.Encode(&out, img); err != nil {
		return "", err
	}
	p.decodedSize += out.Len()
	if p.decodedSize > p.opts.Limits.DecodedBytes {
		return "", ErrLimit
	}
	return p.addAsset(out.Bytes(), "image/png", "png", w, h), nil
}

func (p *pdf) jpegRaster(s *stream, b []byte, w, h, page int) (*image.NRGBA, error) {
	// Budget both the JPEG decoder's surface and the RGBA result.
	if w > (p.opts.Limits.DecodedBytes-p.decodedSize)/8/h {
		return nil, ErrLimit
	}
	p.decodedSize += w * h * 8
	source, err := jpeg.Decode(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	decode := p.array(s.dict["Decode"])
	mapValue := func(v byte, component int) byte {
		if len(decode) < component*2+2 {
			return v
		}
		lo, hi := number(decode[component*2]), number(decode[component*2+1])
		return byte(math.Round(max(0, min(255, (lo+float64(v)/255*(hi-lo))*255))))
	}
	for y := 0; y < h; y++ {
		if y%128 == 0 {
			if err := p.check(); err != nil {
				return nil, err
			}
		}
		for x := 0; x < w; x++ {
			v := source.At(x, y)
			c := color.NRGBAModel.Convert(v).(color.NRGBA)
			switch len(decode) {
			case 0:
			case 2:
				gray := mapValue(color.GrayModel.Convert(v).(color.Gray).Y, 0)
				c.R, c.G, c.B = gray, gray, gray
			case 6:
				c.R, c.G, c.B = mapValue(c.R, 0), mapValue(c.G, 1), mapValue(c.B, 2)
			case 8:
				cm := color.CMYKModel.Convert(v).(color.CMYK)
				c.R, c.G, c.B = color.CMYKToRGB(mapValue(cm.C, 0), mapValue(cm.M, 1), mapValue(cm.Y, 2), mapValue(cm.K, 3))
			default:
				return nil, fmt.Errorf("unsupported JPEG Decode array")
			}
			img.SetNRGBA(x, y, c)
		}
	}
	if err = p.softMask(s, img, page); err != nil {
		return nil, err
	}
	return img, nil
}

func (p *pdf) raster(s *stream, b []byte, w, h, page int) (image.Image, error) {
	bits := integer(p.resolve(s.dict["BitsPerComponent"]))
	mask, _ := s.dict["ImageMask"].(bool)
	if mask {
		bits = 1
	}
	if bits != 1 && bits != 2 && bits != 4 && bits != 8 && bits != 16 {
		return nil, fmt.Errorf("unsupported image bit depth %d", bits)
	}
	cs := p.resolve(s.dict["ColorSpace"])
	kind := named(cs)
	palette := []byte(nil)
	indexed := false
	high := 255
	channels := 1
	if a := asArray(cs); len(a) > 0 {
		kind = named(a[0])
		switch kind {
		case "ICCBased":
			if len(a) > 1 {
				d := p.dict(a[1])
				switch integer(d["N"]) {
				case 1:
					kind = "DeviceGray"
				case 3:
					kind = "DeviceRGB"
				case 4:
					kind = "DeviceCMYK"
				}
			}
			p.warn("icc-profile", page, "Embedded image ICC profiles are approximated in device color space.")
		case "Indexed", "I":
			if len(a) < 4 {
				return nil, ErrInvalid
			}
			if named(p.resolve(a[1])) != "DeviceRGB" {
				return nil, fmt.Errorf("unsupported indexed image base color space")
			}
			indexed = true
			high = integer(p.resolve(a[2]))
			if bits > 8 || high < 0 || high > 255 {
				return nil, ErrInvalid
			}
			switch v := p.resolve(a[3]).(type) {
			case literal:
				palette = []byte(v)
			case *stream:
				var e error
				palette, e = p.decode(v)
				if e != nil {
					return nil, e
				}
			}
		case "CalRGB":
			kind = "DeviceRGB"
		case "CalGray":
			kind = "DeviceGray"
		}
	}
	if mask {
		kind = "DeviceGray"
		p.warn("image-stencil", page, "A stencil image is preserved as grayscale.")
	}
	switch kind {
	case "DeviceRGB", "RGB":
		channels = 3
	case "DeviceCMYK", "CMYK":
		channels = 4
	case "DeviceGray", "G", "Indexed", "I":
	case "":
		if !mask {
			return nil, fmt.Errorf("image is missing its color space")
		}
	default:
		return nil, fmt.Errorf("unsupported image color space %s", kind)
	}
	row := (w*channels*bits + 7) / 8
	if h > len(b)/row {
		return nil, fmt.Errorf("%w: truncated image", ErrInvalid)
	}
	if w > (p.opts.Limits.DecodedBytes-p.decodedSize)/4/h {
		return nil, ErrLimit
	}
	p.decodedSize += w * h * 4
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	decode := p.array(s.dict["Decode"])
	sample := func(y, index int) byte {
		bit := index * bits
		offset := y*row + bit/8
		var v int
		if bits == 16 {
			v = int(b[offset])
		} else if bits == 8 {
			v = int(b[offset])
		} else {
			mask := (1 << bits) - 1
			v = int((b[offset] >> uint(8-bits-bit%8)) & byte(mask))
			if !indexed {
				v = v * 255 / mask
			}
		}
		c := index % channels
		if indexed {
			if len(decode) >= 2 {
				lo, hi := number(decode[0]), number(decode[1])
				v = int(math.Round(lo + float64(v)/float64((uint(1)<<uint(bits))-1)*(hi-lo)))
			}
			return byte(max(0, min(high, v)))
		}
		if len(decode) >= 2*channels {
			lo, hi := number(decode[2*c]), number(decode[2*c+1])
			v = int((lo + float64(v)/255*(hi-lo)) * 255)
			if v < 0 {
				v = 0
			}
			if v > 255 {
				v = 255
			}
		}
		return byte(v)
	}
	for y := 0; y < h; y++ {
		if y%128 == 0 {
			if e := p.check(); e != nil {
				return nil, e
			}
		}
		for x := 0; x < w; x++ {
			at := y*img.Stride + 4*x
			var r, g, bl byte
			v := sample(y, x*channels)
			switch channels {
			case 1:
				if indexed {
					index := int(v)
					j := 3 * index
					if j+2 >= len(palette) {
						return nil, ErrInvalid
					}
					r, g, bl = palette[j], palette[j+1], palette[j+2]
				} else {
					r, g, bl = v, v, v
				}
			case 3:
				r, g, bl = v, sample(y, x*3+1), sample(y, x*3+2)
			case 4:
				r, g, bl = color.CMYKToRGB(v, sample(y, x*4+1), sample(y, x*4+2), sample(y, x*4+3))
			}
			img.Pix[at], img.Pix[at+1], img.Pix[at+2], img.Pix[at+3] = r, g, bl, 255
		}
	}
	if err := p.softMask(s, img, page); err != nil {
		return nil, err
	}
	return img, nil
}

func (p *pdf) softMask(s *stream, img *image.NRGBA, page int) error {
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	if sm, ok := p.resolve(s.dict["SMask"]).(*stream); ok {
		mw, mh := integer(p.resolve(sm.dict["Width"])), integer(p.resolve(sm.dict["Height"]))
		if mw < 1 || mh < 1 || mw > p.opts.Limits.ImagePixels/mh {
			return ErrLimit
		}
		if integer(p.resolve(sm.dict["BitsPerComponent"])) != 8 {
			return fmt.Errorf("unsupported soft mask bit depth")
		}
		if sm.dict["Matte"] != nil {
			if mw != w || mh != h {
				return fmt.Errorf("matte soft mask dimensions must match the image")
			}
			p.warn("image-matte", page, "Soft-mask matte colors are not unblended; edge colors need visual review.")
		}
		alpha, err := p.decode(sm)
		if err != nil {
			return err
		}
		if len(alpha) < mw*mh {
			return ErrInvalid
		}
		decode := p.array(sm.dict["Decode"])
		interpolate, _ := sm.dict["Interpolate"].(bool)
		for y := 0; y < h; y++ {
			if y%128 == 0 {
				if err := p.check(); err != nil {
					return err
				}
			}
			for x := 0; x < w; x++ {
				sy, sx := (2*y+1)*mh/(2*h), (2*x+1)*mw/(2*w)
				a := float64(alpha[sy*mw+sx]) / 255
				if interpolate && (mw != w || mh != h) {
					fx, fy := (float64(x)+.5)*float64(mw)/float64(w)-.5, (float64(y)+.5)*float64(mh)/float64(h)-.5
					x0, y0 := int(math.Floor(fx)), int(math.Floor(fy))
					tx, ty := fx-float64(x0), fy-float64(y0)
					at := func(xx, yy int) float64 { return float64(alpha[max(0, min(mh-1, yy))*mw+max(0, min(mw-1, xx))]) / 255 }
					a = (at(x0, y0)*(1-tx)+at(x0+1, y0)*tx)*(1-ty) + (at(x0, y0+1)*(1-tx)+at(x0+1, y0+1)*tx)*ty
				}
				if len(decode) == 2 {
					a = number(decode[0]) + a*(number(decode[1])-number(decode[0]))
				}
				img.Pix[y*img.Stride+x*4+3] = byte(math.Round(max(0, min(1, a)) * 255))
			}
		}
	}
	if s.dict["Mask"] != nil {
		p.warn("image-mask", page, "Color-key or explicit image masks are not applied.")
	}
	return nil
}

// Group connected drawing geometry and retain its labels in the same asset.
// Background panels with substantial prose remain reflowable text.
func (p *pdf) vectorAsset(pc *pageContent, represented []Block, lines []*line) {
	if len(pc.paths) > 5000 {
		p.warn("vector-complexity", pc.page.Number, "More than 5000 paths on a page; vector grouping skipped.")
		return
	}
	type component struct {
		box   Rect
		paths []vectorPath
	}
	groups := []component{}
	for _, path := range pc.paths {
		used := false
		for _, b := range represented {
			if contained(path.box, b.Box, 2) {
				used = true
				break
			}
		}
		if used {
			continue
		}
		if path.box.W < .1 || path.box.H < .1 {
			continue
		}
		c := component{path.box, []vectorPath{path}}
		for j := 0; j < len(groups); {
			if intersects(expand(c.box, 2), groups[j].box) {
				c.box = union(c.box, groups[j].box)
				c.paths = append(c.paths, groups[j].paths...)
				groups = append(groups[:j], groups[j+1:]...)
				j = 0
			} else {
				j++
			}
		}
		groups = append(groups, c)
	}
	for _, group := range groups {
		box := group.box
		if box.W < 12 || box.H < 12 {
			continue
		}
		labels := []span{}
		labelText := []string{}
		textChars := 0
		for _, l := range lines {
			if l.used {
				continue
			}
			for _, s := range l.spans {
				if contained(s.box, box, 2) {
					labels = append(labels, s)
					labelText = append(labelText, s.text)
					textChars += len(s.text)
				}
			}
		}
		if len(group.paths) < 8 && textChars > 50 {
			continue
		}
		if len(group.paths) == 1 && textChars == 0 { // Keep complex illustrations, discard empty callout borders.
			if strings.Count(group.paths[0].svg, "C") < 5 {
				continue
			}
		}
		for _, l := range lines {
			if l.used {
				continue
			}
			kept := l.spans[:0]
			for _, s := range l.spans {
				if !contained(s.box, box, 2) {
					kept = append(kept, s)
				}
			}
			if len(kept) == len(l.spans) {
				continue
			}
			l.spans = kept
			if len(kept) == 0 {
				l.used = true
			} else {
				l.box = kept[0].box
				for _, s := range kept[1:] {
					l.box = union(l.box, s.box)
				}
				finishLine(l)
			}
		}
		text := strings.Join(labelText, " ")
		asset, visualBox := p.positionedAsset(pc, labels, group.paths, box, text)
		pc.images = append(pc.images, Block{Kind: "image", Asset: asset, Alt: "Vector illustration", Text: text, Box: visualBox, Representation: "positioned"})
	}
}
