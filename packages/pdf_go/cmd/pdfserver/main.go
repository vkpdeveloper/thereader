package main

import (
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/vkpdeveloper/thereader/packages/pdf_go/server"
)

func main() {
	addr := os.Getenv("PDF_LISTEN")
	if addr == "" {
		addr = "127.0.0.1:8091"
	}
	token := os.Getenv("PDF_EXTRACTOR_TOKEN")
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		log.Fatal(err)
	}
	ip := net.ParseIP(host)
	if token == "" && (ip == nil || !ip.IsLoopback()) {
		log.Fatal("PDF_EXTRACTOR_TOKEN is required when listening beyond loopback")
	}
	concurrency, _ := strconv.Atoi(os.Getenv("PDF_CONCURRENCY"))
	handler := server.Handler(server.Config{Token: token, Concurrency: concurrency})
	s := &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 45 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	log.Printf("PDF Extractor listening on %s", addr)
	log.Fatal(s.ListenAndServe())
}
