package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	pdf "github.com/vkpdeveloper/thereader/packages/pdf_go"
)

func TestEndpoint(t *testing.T) {
	data, e := os.ReadFile("../testdata/reading.pdf")
	if e != nil {
		t.Fatal(e)
	}
	h := Handler(Config{Token: "test-token"})
	for _, tc := range []struct {
		name, path, method, token, content string
		bytes                              []byte
		status                             int
	}{
		{"epub", "/v1/pdf/extract?format=epub", "POST", "test-token", "application/pdf", data, 200},
		{"json", "/v1/pdf/extract", "POST", "test-token", "application/pdf", data, 200},
		{"unauthenticated", "/v1/pdf/extract", "POST", "", "application/pdf", data, 401},
		{"wrong method", "/v1/pdf/extract", "GET", "test-token", "application/pdf", nil, 405},
		{"bad type", "/v1/pdf/extract", "POST", "test-token", "text/html", data, 415},
		{"bad PDF", "/v1/pdf/extract", "POST", "test-token", "application/pdf", []byte("nope"), 422},
		{"bad format", "/v1/pdf/extract?format=html", "POST", "test-token", "application/pdf", data, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, bytes.NewReader(tc.bytes))
			r.Header.Set("Content-Type", tc.content)
			r.Header.Set("Authorization", "Bearer "+tc.token)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			if w.Code == 200 && tc.name == "epub" {
				if w.Header().Get("Content-Type") != "application/epub+zip" || !bytes.HasPrefix(w.Body.Bytes(), []byte("PK")) {
					t.Fatal("not EPUB")
				}
			} else {
				var v any
				if e := json.Unmarshal(w.Body.Bytes(), &v); e != nil {
					t.Fatal(e)
				}
			}
		})
	}
	h = Handler(Config{Limits: pdf.Limits{InputBytes: 8}})
	r := httptest.NewRequest("POST", "/v1/pdf/extract", bytes.NewReader(data))
	r.Header.Set("Content-Type", "application/pdf")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("limit: %d", w.Code)
	}
}
