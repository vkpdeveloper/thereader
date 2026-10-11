package pdfextractor

import (
	"fmt"
	"image/color"
)

func (p *pdf) imageBaseColor(v any, page int) (int, error) {
	v = p.resolve(v)
	kind := named(v)
	if a := asArray(v); len(a) > 0 {
		kind = named(p.resolve(a[0]))
		switch kind {
		case "ICCBased":
			if len(a) < 2 {
				return 0, ErrInvalid
			}
			n := integer(p.resolve(p.dict(a[1])["N"]))
			if n != 1 && n != 3 && n != 4 {
				return 0, ErrInvalid
			}
			p.warn("icc-profile", page, "Embedded image ICC profiles are approximated in device color space.")
			return n, nil
		case "CalGray":
			p.warn("color-space", page, "Calibrated grayscale image colors are approximated in device color space.")
			return 1, nil
		case "CalRGB":
			p.warn("color-space", page, "Calibrated RGB image colors are approximated in device color space.")
			return 3, nil
		}
	}
	switch kind {
	case "DeviceGray", "G":
		return 1, nil
	case "DeviceRGB", "RGB":
		return 3, nil
	case "DeviceCMYK", "CMYK":
		return 4, nil
	}
	return 0, fmt.Errorf("unsupported indexed image base color space %s", kind)
}
func indexedRGB(data []byte, high, channels int) ([]byte, error) {
	if len(data) < (high+1)*channels {
		return nil, ErrInvalid
	}
	palette := make([]byte, (high+1)*3)
	for i := 0; i <= high; i++ {
		at := i * channels
		var r, g, b byte
		switch channels {
		case 1:
			r, g, b = data[at], data[at], data[at]
		case 3:
			r, g, b = data[at], data[at+1], data[at+2]
		case 4:
			r, g, b = color.CMYKToRGB(data[at], data[at+1], data[at+2], data[at+3])
		default:
			return nil, ErrInvalid
		}
		palette[3*i], palette[3*i+1], palette[3*i+2] = r, g, b
	}
	return palette, nil
}
