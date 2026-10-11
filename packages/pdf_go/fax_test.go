package pdfextractor

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"testing"
)

func TestFaxReferenceStreams(t *testing.T) {
	// Independent libtiff T.4/T.6 streams encode these deterministic pixels.
	for _, w := range []int{17, 513} {
		for _, group := range []int{3, 4} {
			t.Run(fmt.Sprintf("G%d/%d", group, w), func(t *testing.T) {
				data, e := os.ReadFile(fmt.Sprintf("testdata/fax/group%d-%d.bin", group, w))
				if e != nil {
					t.Fatal(e)
				}
				k := 0
				if group == 4 {
					k = -1
				}
				got, e := decodeFax(data, w, 16, k, false, false, 100000, nil)
				if e != nil {
					t.Fatal(e)
				}
				for y := 0; y < 16; y++ {
					for x := 0; x < w; x++ {
						want := y == 1 || (y > 1 && ((x/(y*3+1)+y)%4 == 0 || (x/(y*3+1)+y)%4 == 1))
						actual := got[y*((w+7)/8)+x/8]>>uint(7-x%8)&1 == 1
						if actual != want {
							t.Fatalf("pixel %d,%d: got %v want %v", x, y, actual, want)
						}
					}
				}
				if _, e := decodeFax(data, w, 16, k, false, false, 1, nil); e != ErrLimit {
					t.Fatal(e)
				}
				for n := 0; n < len(data); n++ {
					_, _ = decodeFax(data[:n], w, 16, k, false, false, 100000, nil)
				}
			})
		}
	}
}
func TestFaxModesPolarityAndCancellation(t *testing.T) {
	// Horizontal: white 3, black 4; then vertical white 1. Next row V0 x3.
	data, _ := hex.DecodeString("30fc") // 001 1000 011 1 1 1 1 padded
	got, e := decodeFax(data, 8, 2, -1, false, false, 1000, nil)
	if e != nil || !bytes.Equal(got, []byte{0x1e, 0x1e}) {
		t.Fatalf("%x %v", got, e)
	}
	if _, e := decodeFax(data, 8, 2, -1, false, false, 1000, func() error { return context.Canceled }); e != context.Canceled {
		t.Fatal(e)
	}
	for _, blackIs1 := range []bool{false, true} {
		p := &pdf{opts: (Options{}).normalized(), out: &Document{}, warned: map[string]bool{}}
		s := &stream{dict: dict{"DecodeParms": dict{"K": float64(-1), "Columns": float64(8), "BlackIs1": blackIs1}, "BitsPerComponent": float64(1), "ColorSpace": name("DeviceGray")}}
		raw, e := p.faxImage(s, data, 8, 2)
		if e != nil {
			t.Fatal(e)
		}
		want := byte(0xe1)
		if blackIs1 {
			want = 0x1e
		}
		if raw[0] != want {
			t.Fatalf("%x", raw)
		}
	}
}
func TestFaxRejectsInteriorZeroRun(t *testing.T) {
	// H(white 1, black 1), H(white 0, black 1), V0 to width 4.
	// Repeated interior zero runs would create duplicate transitions and let
	// malformed data grow the fixed-capacity working rows beyond their budget.
	bits := "001" + "000111" + "010" + "001" + "00110101" + "010" + "1"
	data := make([]byte, (len(bits)+7)/8)
	for i, bit := range bits {
		if bit == '1' {
			data[i/8] |= 1 << uint(7-i%8)
		}
	}
	if _, err := decodeFax(data, 4, 1, -1, false, false, 1000, nil); err != ErrInvalid {
		t.Fatalf("interior zero run: %v", err)
	}
}
func TestIndexedBasePalettes(t *testing.T) {
	cases := []struct {
		base    any
		palette literal
		want    color.NRGBA
	}{
		{name("DeviceGray"), literal([]byte{0, 128}), color.NRGBA{128, 128, 128, 255}},
		{name("DeviceCMYK"), literal([]byte{0, 0, 0, 0, 255, 0, 0, 0}), color.NRGBA{0, 255, 255, 255}},
		{array{name("ICCBased"), dict{"N": float64(3)}}, literal([]byte{0, 0, 0, 10, 20, 30}), color.NRGBA{10, 20, 30, 255}},
	}
	for _, c := range cases {
		p := &pdf{opts: (Options{}).normalized(), out: &Document{}, warned: map[string]bool{}}
		s := &stream{dict: dict{"BitsPerComponent": float64(1), "ColorSpace": array{name("Indexed"), c.base, float64(1), c.palette}}}
		img, e := p.raster(s, []byte{0x80}, 1, 1, 1)
		if e != nil {
			t.Fatal(e)
		}
		if got := color.NRGBAModel.Convert(img.At(0, 0)); got != c.want {
			t.Fatal(got, c.want)
		}
	}
}
func FuzzFaxDecode(f *testing.F) {
	for _, group := range []int{3, 4} {
		b, _ := os.ReadFile(fmt.Sprintf("testdata/fax/group%d-17.bin", group))
		f.Add(b, uint8(group))
	}
	f.Fuzz(func(t *testing.T, b []byte, mode uint8) {
		if len(b) > 4096 {
			return
		}
		k := int(mode%3) - 1
		_, _ = decodeFax(b, 73, 12, k, false, mode&4 != 0, 10000, nil)
	})
}

func TestFaxMixedRowsAndAlignment(t *testing.T) {
	pack := func(s string) []byte {
		b := make([]byte, (len(s)+7)/8)
		for i, c := range s {
			if c == '1' {
				b[i/8] |= 1 << uint(7-i%8)
			}
		}
		return b
	}
	// EOL, one-dimensional tag, white 3 / black 4 / white 1;
	// EOL, two-dimensional tag, three unchanged transitions.
	eol := "000000000001"
	data := pack(eol + "1" + "1000" + "011" + "000111" + eol + "0" + "111")
	got, e := decodeFax(data, 8, 2, 1, true, false, 1000, nil)
	if e != nil || !bytes.Equal(got, []byte{0x1e, 0x1e}) {
		t.Fatalf("%x %v", got, e)
	}
	data = pack("1000" + "011" + "000111" + "000" + "1000" + "011" + "000111")
	got, e = decodeFax(data, 8, 2, 0, false, true, 1000, nil)
	if e != nil || !bytes.Equal(got, []byte{0x1e, 0x1e}) {
		t.Fatalf("%x %v", got, e)
	}
}

func TestSoftMaskPackedDepthsAndJPEG(t *testing.T) {
	for _, tc := range []struct {
		bits int
		raw  []byte
		want []byte
	}{
		{1, []byte{0x40}, []byte{0, 255}},
		{2, []byte{0x30}, []byte{0, 255}},
		{4, []byte{0x0f}, []byte{0, 255}},
		{8, []byte{0, 255}, []byte{0, 255}},
		{16, []byte{0, 0, 255, 255}, []byte{0, 255}},
	} {
		p := &pdf{opts: (Options{}).normalized()}
		got, e := p.maskSamples(&stream{dict: dict{"BitsPerComponent": float64(tc.bits)}, raw: tc.raw}, 2, 1)
		if e != nil || !bytes.Equal(got, tc.want) {
			t.Fatal(tc.bits, got, e)
		}
	}
	gray := image.NewGray(image.Rect(0, 0, 16, 8))
	for y := 0; y < 8; y++ {
		for x := 8; x < 16; x++ {
			gray.SetGray(x, y, color.Gray{Y: 255})
		}
	}
	var encoded bytes.Buffer
	if e := jpeg.Encode(&encoded, gray, &jpeg.Options{Quality: 100}); e != nil {
		t.Fatal(e)
	}
	p := &pdf{opts: (Options{}).normalized()}
	s := &stream{dict: dict{"BitsPerComponent": float64(8), "Filter": name("DCTDecode")}, raw: encoded.Bytes()}
	got, e := p.maskSamples(s, 16, 8)
	if e != nil || got[0] > 1 || got[15] < 254 {
		t.Fatal(got, e)
	}
	if _, e := p.maskSamples(s, 15, 8); e == nil {
		t.Fatal("accepted mismatched JPEG mask dimensions")
	}
}
