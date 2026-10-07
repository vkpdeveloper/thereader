// Command truffle extracts the readable article from a web page: HTML in
// (a file, standard input or a URL to fetch), a structured article out as
// JSON, Markdown or plain text.
//
//	truffle https://example.com/post                 # fetch, extract, print JSON
//	truffle -format markdown page.html -url https://example.com/post
//	curl -s https://example.com/post | truffle -url https://example.com/post -format text -
//
// Several inputs print one compact JSON article per line (JSON Lines).
package main

import (
	"bufio"
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/net/html/charset"

	truffle "github.com/vkpdeveloper/thereader/packages/truffle_go"
)

// The request headers the reader app sends when it fetches an article.
var fetchHeaders = map[string]string{
	"User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
	"Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
}

const usage = `truffle extracts the readable article from a web page.

Usage:
  truffle [flags] <file | URL | ->...

A URL (http or https) is fetched; "-" reads standard input. Output is the
article as JSON (the model of packages/truffle/src/model.ts), Markdown or
plain text; "null" (JSON) or nothing when the page holds no article, with
exit status 3.

Flags:
`

func main() {
	pageURL := flag.String("url", "", "URL the HTML was fetched from; resolves links (a fetched page uses its final URL)")
	format := flag.String("format", "json", "output: json, markdown or text")
	withMarkdown := flag.Bool("markdown", false, "include the Markdown export in JSON output")
	compact := flag.Bool("compact", false, "one-line JSON")
	outPath := flag.String("o", "", "write the output to this file instead of standard output")
	timing := flag.Bool("timing", false, "print parse and extraction times to standard error")
	charsetName := flag.String("charset", "", "decode input with this charset instead of detecting it")
	timeout := flag.Duration("timeout", 30*time.Second, "fetch timeout")
	flag.Usage = func() {
		fmt.Fprint(os.Stderr, usage)
		flag.PrintDefaults()
	}
	flag.Parse()
	inputs := flag.Args()
	if len(inputs) == 0 {
		if isTerminal(os.Stdin) {
			flag.Usage()
			os.Exit(2)
		}
		inputs = []string{"-"}
	}
	switch *format {
	case "json", "markdown", "md", "text", "txt":
	default:
		fail(fmt.Errorf("unknown format %q (json, markdown or text)", *format))
	}

	var out io.Writer = os.Stdout
	if *outPath != "" {
		f, err := os.Create(*outPath)
		if err != nil {
			fail(err)
		}
		defer f.Close()
		out = f
	}
	w := bufio.NewWriter(out)
	defer w.Flush()

	missing := 0
	var parser truffle.Parser // pages one after another reuse the memory
	for _, input := range inputs {
		html, url, err := load(input, *pageURL, *charsetName, *timeout)
		if err != nil {
			fail(fmt.Errorf("%s: %w", input, err))
		}
		t0 := time.Now()
		doc := parser.ParseDocument(html)
		t1 := time.Now()
		article := truffle.ExtractTree(doc, truffle.Options{URL: url, Markdown: *withMarkdown || *format == "markdown" || *format == "md"})
		t2 := time.Now()
		if *timing {
			fmt.Fprintf(os.Stderr, "%s: %d KB, parse %.3f ms, extract %.3f ms\n", input, len(html)/1024, ms(t1.Sub(t0)), ms(t2.Sub(t1)))
		}
		if article == nil {
			missing++
		}
		switch *format {
		case "json":
			switch {
			case article == nil:
				w.WriteString("null\n")
			case *compact || len(inputs) > 1:
				w.Write(article.JSON(""))
				w.WriteByte('\n')
			default:
				w.Write(article.JSON("  "))
				w.WriteByte('\n')
			}
		case "markdown", "md":
			if article != nil {
				w.WriteString(*article.Markdown)
			}
		case "text", "txt":
			if article != nil {
				if article.Title != "" {
					w.WriteString(article.Title)
					w.WriteString("\n\n")
				}
				w.WriteString(truffle.ArticleText(article))
				w.WriteByte('\n')
			}
		}
	}
	w.Flush()
	if missing > 0 {
		os.Exit(3)
	}
}

func ms(d time.Duration) float64 { return float64(d.Nanoseconds()) / 1e6 }

// load reads one input and decodes it as a browser would pick the encoding:
// BOM, Content-Type charset, a <meta> prescan, then UTF-8.
func load(input, pageURL, charsetName string, timeout time.Duration) (html, url string, err error) {
	var raw []byte
	contentType := ""
	url = pageURL
	switch {
	case strings.HasPrefix(input, "http://") || strings.HasPrefix(input, "https://"):
		client := &http.Client{Timeout: timeout}
		req, err := http.NewRequest("GET", input, nil)
		if err != nil {
			return "", "", err
		}
		for k, v := range fetchHeaders {
			req.Header.Set(k, v)
		}
		resp, err := client.Do(req)
		if err != nil {
			return "", "", err
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			return "", "", fmt.Errorf("HTTP %s", resp.Status)
		}
		raw, err = io.ReadAll(resp.Body)
		if err != nil {
			return "", "", err
		}
		contentType = resp.Header.Get("Content-Type")
		if url == "" {
			url = resp.Request.URL.String()
		}
	case input == "-":
		raw, err = io.ReadAll(os.Stdin)
		if err != nil {
			return "", "", err
		}
	default:
		raw, err = os.ReadFile(input)
		if err != nil {
			return "", "", err
		}
		if url == "" {
			abs, _ := filepath.Abs(input)
			url = "file://" + filepath.ToSlash(abs)
		}
	}
	if url == "" {
		return "", "", errors.New("standard input needs -url")
	}
	if charsetName != "" {
		contentType = "text/html; charset=" + charsetName
	}
	enc, name, _ := charset.DetermineEncoding(raw, contentType)
	if name == "utf-8" || name == "" {
		return string(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))), url, nil
	}
	decoded, err := enc.NewDecoder().Bytes(raw)
	if err != nil {
		return "", "", err
	}
	return string(decoded), url, nil
}

func isTerminal(f *os.File) bool {
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "truffle:", err)
	os.Exit(1)
}
