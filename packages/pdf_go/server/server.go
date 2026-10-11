// Package server exposes PDF Extractor over HTTP for backends that cannot load Go.
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	pdf "github.com/vkpdeveloper/thereader/packages/pdf_go"
)

type Config struct {
	Token       string
	Concurrency int
	Timeout     time.Duration
	Limits      pdf.Limits
}

// Handler bounds input, concurrency, parsing and request duration. Use a
// reverse proxy with TLS and access/rate controls when exposing it publicly.
func Handler(config Config) http.Handler {
	if config.Concurrency <= 0 {
		config.Concurrency = 2
	}
	if config.Timeout <= 0 {
		config.Timeout = 30 * time.Second
	}
	if config.Limits.InputBytes <= 0 {
		config.Limits.InputBytes = 64 << 20
	}
	semaphore := make(chan struct{}, config.Concurrency)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.URL.Path == "/health" && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"status":"ok","service":"pdf-extractor"}`)
			return
		}
		if r.URL.Path != "/v1/pdf/extract" {
			problem(w, 404, "NOT_FOUND", "Route not found.")
			return
		}
		if r.Method != "POST" {
			w.Header().Set("Allow", "POST")
			problem(w, 405, "METHOD_NOT_ALLOWED", "Use POST with a PDF body.")
			return
		}
		if config.Token != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+config.Token)) != 1 {
			problem(w, 401, "UNAUTHORIZED", "PDF service authentication failed.")
			return
		}
		format := r.URL.Query().Get("format")
		if format == "" {
			format = "json"
		}
		if format != "json" && format != "markdown" && format != "epub" {
			problem(w, 400, "INVALID_FORMAT", "Choose json, markdown or epub.")
			return
		}
		if t := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0])); t != "application/pdf" {
			problem(w, 415, "INVALID_MEDIA_TYPE", "Send application/pdf.")
			return
		}
		select {
		case semaphore <- struct{}{}:
			defer func() { <-semaphore }()
		default:
			w.Header().Set("Retry-After", "2")
			problem(w, 429, "BUSY", "The PDF service is busy. Try again shortly.")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), config.Timeout)
		defer cancel()
		r.Body = http.MaxBytesReader(w, r.Body, int64(config.Limits.InputBytes))
		data, e := io.ReadAll(r.Body)
		if e != nil {
			var maxErr *http.MaxBytesError
			if errors.As(e, &maxErr) {
				problem(w, 413, "TOO_LARGE", "PDF imports are limited to 64 MiB.")
			} else {
				problem(w, 400, "INVALID_PDF", "Could not read the PDF upload.")
			}
			return
		}
		doc, e := pdf.Extract(data, pdf.Options{Context: ctx, Limits: config.Limits})
		if e != nil {
			switch {
			case errors.Is(e, pdf.ErrEncrypted):
				problem(w, 422, "ENCRYPTED_PDF", "This PDF is encrypted. Import an unencrypted copy.")
			case errors.Is(e, pdf.ErrLimit):
				problem(w, 422, "PDF_LIMIT", "This PDF exceeds the extraction limits.")
			case errors.Is(e, context.DeadlineExceeded):
				problem(w, 504, "PDF_TIMEOUT", "PDF extraction timed out.")
			default:
				problem(w, 422, "INVALID_PDF", "The PDF could not be parsed: "+e.Error())
			}
			return
		}
		if format == "epub" && doc.Stats.Characters == 0 {
			problem(w, 422, "PDF_NEEDS_OCR", "This PDF has no extractable text. Image-only scans need OCR, which PDF Extractor does not perform yet.")
			return
		}
		w.Header().Set("X-PDF-Pages", strconv.Itoa(len(doc.Pages)))
		w.Header().Set("X-PDF-Warnings", strconv.Itoa(len(doc.Warnings)))
		w.Header().Set("Server-Timing", "extract;dur="+strconv.FormatFloat(doc.Stats.DurationMS, 'f', 3, 64))
		switch format {
		case "epub":
			b, err := pdf.EPUB(doc)
			if err != nil {
				problem(w, 500, "EPUB_FAILED", "Could not create the reading edition.")
				return
			}
			if ctx.Err() != nil {
				problem(w, 504, "PDF_TIMEOUT", "PDF conversion timed out.")
				return
			}
			w.Header().Set("Content-Type", "application/epub+zip")
			w.Header().Set("Content-Disposition", `attachment; filename="reading-edition.epub"`)
			w.Write(b)
		case "markdown":
			w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
			io.WriteString(w, doc.Markdown)
		default:
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			json.NewEncoder(w).Encode(doc)
		}
	})
}
func problem(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
}
