package pdfextractor

import (
	_ "embed"
	"encoding/binary"
	"fmt"
	"strings"
)

// These are format reference tables, not font-parsing code. See data/README.md.
//
//go:embed data/cff-strings.txt
var cffStringsData string

//go:embed data/cff-expert-charset.txt
var cffExpertData string

//go:embed data/cff-expert-subset-charset.txt
var cffExpertSubsetData string

//go:embed data/cff-standard-encoding.txt
var cffStandardEncodingData string

var cffStrings = cffReferenceFields(cffStringsData)

func cffReferenceFields(data string) []string {
	var out []string
	for _, line := range strings.Split(data, "\n") {
		if !strings.HasPrefix(line, "#") {
			out = append(out, strings.Fields(line)...)
		}
	}
	return out
}

var cffStandardEncoding = strings.Fields(cffStandardEncodingData)

// Adobe 5176 sections 10–13: charset entries are SIDs, custom encoding
// entries are GIDs, and supplemental encodings are code-to-SID pairs.
func cffNamedCharset(f *outlineFont, b []byte, d map[int][]float64, custom [][]byte) error {
	nameFor := func(sid int) (string, error) {
		if sid < 0 || sid >= 65000 {
			return "", ErrInvalid
		}
		if sid < len(cffStrings) {
			return cffStrings[sid], nil
		}
		sid -= len(cffStrings)
		if sid >= len(custom) || len(custom[sid]) == 0 || len(custom[sid]) > 127 {
			return "", ErrInvalid
		}
		return string(custom[sid]), nil
	}
	f.names = map[string]int{".notdef": 0}
	charset := make([]int, len(f.chars))
	at := cffInt(d, 15)
	if at >= 0 && at <= 2 {
		predefined := cffStrings[:229]
		if at == 1 {
			predefined = strings.Fields(cffExpertData)
		} else if at == 2 {
			predefined = strings.Fields(cffExpertSubsetData)
		}
		if len(f.chars) > len(predefined) {
			return ErrInvalid
		}
		for gid, name := range predefined[:len(f.chars)] {
			f.names[name] = gid
			for sid, s := range cffStrings {
				if s == name {
					charset[gid] = sid
					break
				}
			}
		}
	} else {
		if at < 3 || at >= len(b) {
			return ErrInvalid
		}
		format := b[at]
		at++
		for gid := 1; gid < len(f.chars); {
			if at+2 > len(b) {
				return ErrInvalid
			}
			first := int(binary.BigEndian.Uint16(b[at:]))
			at += 2
			n := 0
			switch format {
			case 0:
			case 1:
				if at >= len(b) {
					return ErrInvalid
				}
				n = int(b[at])
				at++
			case 2:
				if at+2 > len(b) {
					return ErrInvalid
				}
				n = int(binary.BigEndian.Uint16(b[at:]))
				at += 2
			default:
				return ErrInvalid
			}
			if n >= len(f.chars)-gid {
				return ErrInvalid
			}
			for j := 0; j <= n; j++ {
				name, e := nameFor(first + j)
				if e != nil {
					return e
				}
				if _, exists := f.names[name]; exists {
					return ErrInvalid
				}
				charset[gid] = first + j
				f.names[name] = gid
				gid++
			}
		}
	}
	at = cffInt(d, 16)
	if at == 0 {
		for code, name := range cffStandardEncoding {
			if gid, ok := f.names[name]; ok && name != ".notdef" {
				f.codes[uint32(code)] = gid
			}
		}
		return nil
	}
	if at == 1 {
		return fmt.Errorf("CFF ExpertEncoding is unsupported")
	}
	if at < 2 || at+2 > len(b) {
		return ErrInvalid
	}
	format, n := b[at], int(b[at+1])
	at += 2
	set := func(code, gid int) error {
		if code > 255 || gid >= len(f.chars) {
			return ErrInvalid
		}
		if _, exists := f.codes[uint32(code)]; exists {
			return ErrInvalid
		}
		f.codes[uint32(code)] = gid
		return nil
	}
	switch format & 127 {
	case 0:
		if n > len(b)-at {
			return ErrInvalid
		}
		for j := 0; j < n; j++ {
			if e := set(int(b[at+j]), j+1); e != nil {
				return e
			}
		}
		at += n
	case 1:
		if n*2 > len(b)-at {
			return ErrInvalid
		}
		gid := 1
		for j := 0; j < n; j++ {
			first, last := int(b[at]), int(b[at+1])
			at += 2
			for k := 0; k <= last; k++ {
				if e := set(first+k, gid); e != nil {
					return e
				}
				gid++
			}
		}
	default:
		return ErrInvalid
	}
	if format&128 != 0 {
		if at >= len(b) {
			return ErrInvalid
		}
		n = int(b[at])
		at++
		if n*3 > len(b)-at {
			return ErrInvalid
		}
		bySID := map[int]int{}
		for gid, sid := range charset {
			bySID[sid] = gid
		}
		for j := 0; j < n; j++ {
			code := uint32(b[at])
			sid := int(binary.BigEndian.Uint16(b[at+1:]))
			at += 3
			gid, ok := bySID[sid]
			if !ok {
				return ErrInvalid
			}
			if _, exists := f.codes[code]; exists {
				return ErrInvalid
			}
			f.codes[code] = gid
		}
	}
	return nil
}
