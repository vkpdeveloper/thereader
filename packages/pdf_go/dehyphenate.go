package pdfextractor

import (
	"strings"
	"unicode"
)

// A visible line-end hyphen is ambiguous. Remove it only when the same solid
// spelling occurs elsewhere on the page, and no explicit hyphenated spelling
// contradicts that evidence. Code, math and ordinary inline hyphens stay intact.
func pageWords(lines []*line) map[string]bool {
	words := map[string]bool{}
	for _, l := range lines {
		if l.mono || l.math {
			continue
		}
		for _, w := range strings.FieldsFunc(l.text, func(r rune) bool { return !unicode.IsLetter(r) && r != '-' }) {
			if len(w) > 2 && !strings.HasSuffix(w, "-") {
				words[strings.ToLower(w)] = true
			}
		}
	}
	return words
}
func witnessedHyphen(a, b string, words map[string]bool) bool {
	if !canDehyphenate(a, b) {
		return false
	}
	a = strings.TrimSuffix(a, "-")
	left := []rune(a)
	start := len(left)
	for start > 0 && unicode.IsLetter(left[start-1]) {
		start--
	}
	right := []rune(b)
	end := 0
	for end < len(right) && unicode.IsLetter(right[end]) {
		end++
	}
	if start == len(left) || end == 0 {
		return false
	}
	prefix, suffix := strings.ToLower(string(left[start:])), strings.ToLower(string(right[:end]))
	return words[prefix+suffix] && !words[prefix+"-"+suffix]
}
func trimRunHyphen(runs []Run) {
	for j := len(runs) - 1; j >= 0; j-- {
		if runs[j].Text != "" {
			runs[j].Text = strings.TrimSuffix(runs[j].Text, "-")
			return
		}
	}
}
