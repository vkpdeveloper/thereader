// Package pdfextractor converts PDF bytes to structured content, Markdown and EPUB.
// The parser and layout engine use only the Go standard library. No subprocesses,
// extraction libraries, network services or models are used.
package pdfextractor

import (
	"context"
	"errors"
	"fmt"
	"time"
)

const Version = "0.2.0"

var (
	ErrInvalid   = errors.New("invalid PDF")
	ErrEncrypted = errors.New("encrypted PDFs are not supported")
	ErrLimit     = errors.New("PDF resource limit exceeded")
)

// Limits are per document, including decoded streams and resources shared by pages.
// Zero fields use the defaults. A caller can lower them for untrusted uploads.
type Limits struct {
	InputBytes   int
	DecodedBytes int
	Objects      int
	Pages        int
	Operations   int
	Spans        int
	ImagePixels  int
	AssetBytes   int // generated assets plus cached glyph outlines
}

type Options struct {
	Context context.Context
	Limits  Limits
	// KeepArtifacts retains marked artifacts and repeating margin text.
	KeepArtifacts bool
}

func (o Options) normalized() Options {
	if o.Context == nil {
		o.Context = context.Background()
	}
	d := Limits{64 << 20, 256 << 20, 200000, 10000, 5000000, 2000000, 20000000, 128 << 20}
	fields := []*int{&o.Limits.InputBytes, &o.Limits.DecodedBytes, &o.Limits.Objects, &o.Limits.Pages, &o.Limits.Operations, &o.Limits.Spans, &o.Limits.ImagePixels, &o.Limits.AssetBytes}
	defaults := []int{d.InputBytes, d.DecodedBytes, d.Objects, d.Pages, d.Operations, d.Spans, d.ImagePixels, d.AssetBytes}
	for i, f := range fields {
		if *f <= 0 {
			*f = defaults[i]
		}
	}
	return o
}

// Rect uses PDF points in a top-left coordinate system, after page rotation.
type Rect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"width"`
	H float64 `json:"height"`
}
type Run struct {
	Text       string  `json:"text"`
	Bold       bool    `json:"bold,omitempty"`
	Italic     bool    `json:"italic,omitempty"`
	Link       string  `json:"link,omitempty"`
	Script     string  `json:"script,omitempty"` // sup or sub; inferred from the baseline
	Asset      string  `json:"asset,omitempty"`  // inline positioned math, when present
	Height     float64 `json:"heightEm,omitempty"`
	Depth      float64 `json:"depthEm,omitempty"`
	Monochrome bool    `json:"monochrome,omitempty"`
}
type Block struct {
	Kind           string     `json:"kind"` // heading, paragraph, list, table, image, code
	Text           string     `json:"text,omitempty"`
	Runs           []Run      `json:"runs,omitempty"`
	Level          int        `json:"level,omitempty"`
	Rows           [][]string `json:"rows,omitempty"`
	Asset          string     `json:"asset,omitempty"`
	Alt            string     `json:"alt,omitempty"`
	Role           string     `json:"role,omitempty"`           // e.g. reference, index, caption, footnote
	Language       string     `json:"language,omitempty"`       // code language, when recognizable
	Representation string     `json:"representation,omitempty"` // positioned for visual math; not semantic LaTeX
	WidthEm        float64    `json:"widthEm,omitempty"`        // positioned display math width relative to body text
	Monochrome     bool       `json:"monochrome,omitempty"`
	Box            Rect       `json:"box"`
}
type Page struct {
	Number   int     `json:"number"`
	Width    float64 `json:"width"`
	Height   float64 `json:"height"`
	Blocks   []Block `json:"blocks"`
	NeedsOCR bool    `json:"needsOCR,omitempty"`
}
type Asset struct {
	Name      string `json:"name"`
	MediaType string `json:"mediaType"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Data      []byte `json:"data"` // base64 in JSON; relative asset path in Markdown/EPUB
}
type Outline struct {
	Title string `json:"title"`
	Page  int    `json:"page"`
	Level int    `json:"level"`
}
type Warning struct {
	Code    string `json:"code"`
	Page    int    `json:"page,omitempty"`
	Message string `json:"message"`
}
type Stats struct {
	Pages      int     `json:"pages"`
	Characters int     `json:"characters"`
	Images     int     `json:"images"`
	Tables     int     `json:"tables"`
	Math       int     `json:"math"`
	Headings   int     `json:"headings"`
	DurationMS float64 `json:"durationMs"`
}
type Document struct {
	Engine   string    `json:"engine"`
	Version  string    `json:"version"`
	Title    string    `json:"title"`
	Author   string    `json:"author,omitempty"`
	Language string    `json:"language,omitempty"`
	Subject  string    `json:"subject,omitempty"`
	Keywords string    `json:"keywords,omitempty"`
	Creator  string    `json:"creator,omitempty"`
	Created  string    `json:"created,omitempty"`
	SHA256   string    `json:"sha256"`
	Pages    []Page    `json:"pages"`
	Assets   []Asset   `json:"assets"`
	Outline  []Outline `json:"outline"`
	Warnings []Warning `json:"warnings"`
	// Complete means no known unsupported feature was encountered. It is NOT an accuracy score.
	Complete bool   `json:"complete"`
	Markdown string `json:"markdown"`
	Stats    Stats  `json:"stats"`
}

func (p *pdf) warn(code string, page int, message string) {
	p.out.Complete = false
	if len(p.out.Warnings) >= 1000 {
		return
	}
	key := fmt.Sprintf("%s:%d:%s", code, page, message)
	if p.warned[key] {
		return
	}
	p.warned[key] = true
	p.out.Warnings = append(p.out.Warnings, Warning{code, page, message})
}

func milliseconds(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }
