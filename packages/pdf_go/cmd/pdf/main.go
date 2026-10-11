package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	pdf "github.com/vkpdeveloper/thereader/packages/pdf_go"
)

func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
func run() error {
	format := flag.String("format", "markdown", "markdown, json, epub or text")
	out := flag.String("out", "", "output file (stdout if omitted); Markdown assets go beside it")
	repeats := flag.Int("repeat", 1, "repeat the complete in-memory extraction, emit JSON timing samples on stderr")
	keep := flag.Bool("keep-artifacts", false, "retain marked artifacts and repeating margins")
	flag.Parse()
	if flag.NArg() != 1 {
		return fmt.Errorf("usage: pdf [-format markdown|json|epub|text] [-out file] input.pdf")
	}
	if *repeats < 1 || *repeats > 10000 {
		return fmt.Errorf("repeat must be between 1 and 10000")
	}
	var r io.Reader = os.Stdin
	if flag.Arg(0) != "-" {
		f, e := os.Open(flag.Arg(0))
		if e != nil {
			return e
		}
		defer f.Close()
		r = f
	}
	data, e := io.ReadAll(io.LimitReader(r, (64<<20)+1))
	if e != nil {
		return e
	}
	if len(data) > 64<<20 {
		return pdf.ErrLimit
	}
	var doc *pdf.Document
	times := make([]float64, 0, *repeats)
	for n := 0; n < *repeats; n++ {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		started := time.Now()
		doc, e = pdf.Extract(data, pdf.Options{Context: ctx, KeepArtifacts: *keep})
		elapsed := time.Since(started)
		cancel()
		if e != nil {
			return e
		}
		times = append(times, float64(elapsed)/float64(time.Millisecond))
	}
	var output []byte
	switch *format {
	case "markdown":
		output = []byte(doc.Markdown)
	case "json":
		output, e = json.MarshalIndent(doc, "", "  ")
	case "epub":
		output, e = pdf.EPUB(doc)
	case "text":
		for _, p := range doc.Pages {
			for _, b := range p.Blocks {
				output = append(output, []byte(b.Text+"\n")...)
				for _, row := range b.Rows {
					for _, cell := range row {
						output = append(output, []byte(cell+" ")...)
					}
					output = append(output, '\n')
				}
			}
		}
	default:
		return fmt.Errorf("unknown format %s", *format)
	}
	if e != nil {
		return e
	}
	if *out == "" {
		_, e = os.Stdout.Write(output)
	} else {
		if e = os.MkdirAll(filepath.Dir(*out), 0755); e != nil {
			return e
		}
		e = os.WriteFile(*out, output, 0644)
		if e == nil && *format == "markdown" {
			e = pdf.WriteAssets(doc, func(name string, r io.Reader) error {
				path := filepath.Join(filepath.Dir(*out), name)
				if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
					return err
				}
				f, err := os.Create(path)
				if err != nil {
					return err
				}
				_, err = io.Copy(f, r)
				closeErr := f.Close()
				if err != nil {
					return err
				}
				return closeErr
			})
		}
	}
	if *repeats > 1 {
		json.NewEncoder(os.Stderr).Encode(map[string]any{"engine": "PDF Extractor", "version": pdf.Version, "pages": len(doc.Pages), "samplesMs": times, "scope": "in-memory parse + decode + layout + images + Markdown (EPUB and file I/O excluded)"})
	}
	return e
}
