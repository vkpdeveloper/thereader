package truffle

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"
)

func TestJSONParse(t *testing.T) {
	valid := []string{`{}`, `[]`, `{"a":1,"b":[true,false,null],"c":{"d":"e"}}`, ` [1, -0, 0.5, 1e3, -2E-2] `, `"xé\n\"\\\/"`, `"😀"`, `{"a":1,"a":2}`, `123`, `"tab\tok"`}
	for _, s := range valid {
		got, ok := jsonParse(s)
		var want any
		if err := json.Unmarshal([]byte(s), &want); err != nil {
			t.Fatal(s, err)
		}
		if !ok || !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %#v, want %#v", s, got, want)
		}
	}
	invalid := []string{``, `{`, `[1,]`, `{"a":1,}`, `01`, `1.`, `.5`, `+1`, `"raw` + "\n" + `newline"`, `{a:1}`, `'x'`, `[1] 2`, `NaN`, `"\x"`, `tru`, `"\u12"`}
	for _, s := range invalid {
		if _, ok := jsonParse(s); ok {
			t.Errorf("%q parsed; JSON.parse rejects it", s)
		}
	}
	// JSON.parse reads an out-of-range number as Infinity.
	if v, ok := jsonParse(`[1e400, -1e400]`); !ok || !math.IsInf(v.([]any)[0].(float64), 1) || !math.IsInf(v.([]any)[1].(float64), -1) {
		t.Errorf("1e400: %v %v", v, ok)
	}
}
