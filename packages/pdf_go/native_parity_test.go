package pdfextractor

// An opt-in exporter captures the original synthetic byte fixtures and the Go
// oracle without introducing a PDF generator/extractor dependency in either port.
// Run: PDF_PARITY_EXPORT=/absolute/output go test .
import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

func recordNativeParityFixture(data []byte) {
	dir := os.Getenv("PDF_PARITY_EXPORT")
	if dir == "" {
		return
	}
	hash := sha256.Sum256(data)
	name := hex.EncodeToString(hash[:])
	if err := os.MkdirAll(dir, 0755); err != nil {
		panic(err)
	}
	doc, err := Extract(data, Options{})
	result := struct {
		Document *Document `json:"document,omitempty"`
		Error    string    `json:"error,omitempty"`
	}{Document: doc}
	if err != nil {
		switch {
		case errors.Is(err, ErrEncrypted):
			result.Error = "ENCRYPTED_PDF"
		case errors.Is(err, ErrLimit):
			result.Error = "RESOURCE_LIMIT"
		default:
			result.Error = "INVALID_PDF"
		}
	} else {
		doc.Stats.DurationMS = 0
	}
	b, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		panic(err)
	}
	for ext, value := range map[string][]byte{".pdf": data, ".json": append(b, '\n')} {
		if err := os.WriteFile(filepath.Join(dir, name+ext), value, 0644); err != nil {
			panic(err)
		}
	}
}
