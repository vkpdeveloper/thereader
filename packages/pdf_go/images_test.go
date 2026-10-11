package pdfextractor

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

func TestIndexedDecodeUsesPaletteIndices(t *testing.T) {
	p, err := openPDF(simplePDF(""), Options{}.normalized())
	if err != nil {
		t.Fatal(err)
	}
	s := &stream{dict: dict{"BitsPerComponent": float64(2), "ColorSpace": array{name("Indexed"), name("DeviceRGB"), float64(3), literal([]byte{255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255})}, "Decode": array{float64(3), float64(0)}}}
	img, err := p.raster(s, []byte{0x30}, 2, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if got := color.NRGBAModel.Convert(img.At(0, 0)); got != (color.NRGBA{255, 255, 255, 255}) {
		t.Fatalf("index 0 maps to 3: %v", got)
	}
	if got := color.NRGBAModel.Convert(img.At(1, 0)); got != (color.NRGBA{255, 0, 0, 255}) {
		t.Fatalf("index 3 maps to 0: %v", got)
	}
}

func TestJPEGDecodeAndScaledSoftMask(t *testing.T) {
	p, err := openPDF(simplePDF(""), Options{}.normalized())
	if err != nil {
		t.Fatal(err)
	}
	gray := image.NewGray(image.Rect(0, 0, 8, 8))
	for i := range gray.Pix {
		gray.Pix[i] = 64
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, gray, &jpeg.Options{Quality: 100}); err != nil {
		t.Fatal(err)
	}
	mask := &stream{dict: dict{"Width": float64(2), "Height": float64(1), "BitsPerComponent": float64(8), "ColorSpace": name("DeviceGray")}, raw: []byte{0, 128}}
	s := &stream{dict: dict{"Width": float64(8), "Height": float64(8), "Filter": name("DCTDecode"), "ColorSpace": name("DeviceGray"), "Decode": array{float64(1), float64(0)}, "SMask": mask}, raw: encoded.Bytes()}
	if _, err := p.image(s, 1); err != nil {
		t.Fatal(err)
	}
	if p.out.Assets[0].MediaType != "image/png" {
		t.Fatal("masked JPEG was not converted")
	}
	img, err := png.Decode(bytes.NewReader(p.out.Assets[0].Data))
	if err != nil {
		t.Fatal(err)
	}
	left := color.NRGBAModel.Convert(img.At(0, 0)).(color.NRGBA)
	right := color.NRGBAModel.Convert(img.At(7, 0)).(color.NRGBA)
	if left.A != 0 || right.A != 128 || right.R < 190 || right.R > 192 {
		t.Fatalf("mask/decode: %v %v", left, right)
	}
}
