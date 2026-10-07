package truffle

// Code languages (languages.ts): normalizing what page markup calls a
// language, and a fast deterministic detector for unlabelled blocks. Ids are
// highlight.js names (except `html`, which renderers map to highlight.js
// `xml`), so both renderers can pass them straight to their highlighter.
//
// The detector runs the TypeScript patterns, translated by jsRegexp, with the
// meaning `RegExp.prototype.test` gives them. RE2 differs in three places, so
// the patterns are not used as they are:
//
//   - `m`: JavaScript's `^` and `$` also break lines at `\r`, U+2028 and
//     U+2029, RE2's only at `\n`. Line starts are found here, for all four,
//     and a final `$` becomes `(?:$|[\n\r\u2028\u2029])`;
//   - `i`: RE2 folds with Unicode, so `s` also matches `ſ` and `k` the Kelvin
//     sign; JavaScript without `u` folds ASCII letters only (foldASCII);
//   - the diff rule's lookahead `(?![+-])` is hand-written (diffLine).
//
// RE2 also costs more than V8's compiled patterns: a scan of 5000 characters
// takes tens of microseconds, and there are 283 rules. So each pattern is
// split at its top-level `|` and every branch is tested only where a match can
// start: at the occurrences of a literal every match begins with (after `\b`,
// `^` and indentation, or after leading character runs walked back over),
// looked up in an index of the code's byte pairs (codeIndex) or of its line
// heads. There the branch runs anchored, on the line alone when no match spans
// a line break, or, when the rest is a plain sequence of literals and
// character runs, without a regexp at all.

import (
	"encoding/json"
	"regexp"
	"regexp/syntax"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"
)

// languageAliases maps a lowercase language name to its id. A Go map has no
// prototype: `constructor` or `__proto__` are not names, as with the
// `Object.create(null)` table in TypeScript.
var languageAliases = map[string]string{
	"js": "javascript", "javascript": "javascript", "jsx": "javascript", "mjs": "javascript", "cjs": "javascript", "node": "javascript", "nodejs": "javascript", "es6": "javascript", "ecmascript": "javascript",
	"ts": "typescript", "typescript": "typescript", "tsx": "typescript", "mts": "typescript", "cts": "typescript",
	"py": "python", "python": "python", "python3": "python", "py3": "python", "ipython": "python", "pycon": "python", "python2": "python", "gyp": "python", "sage": "python", "jupyter": "python",
	"java": "java", "jsp": "java",
	"kt": "kotlin", "kts": "kotlin", "kotlin": "kotlin",
	"scala": "scala", "sc": "scala", "sbt": "scala",
	"swift": "swift",
	"objc":  "objectivec", "obj-c": "objectivec", "objectivec": "objectivec", "objective-c": "objectivec", "mm": "objectivec",
	"c": "c", "h": "c",
	"cpp": "cpp", "c++": "cpp", "cc": "cpp", "cxx": "cpp", "hpp": "cpp", "hh": "cpp", "hxx": "cpp", "cplusplus": "cpp", "arduino": "cpp", "ino": "cpp", "cuda": "cpp", "cu": "cpp",
	"cs": "csharp", "csharp": "csharp", "c#": "csharp", "dotnet": "csharp",
	"go": "go", "golang": "go",
	"rs": "rust", "rust": "rust",
	"rb": "ruby", "ruby": "ruby", "gemspec": "ruby", "podspec": "ruby", "thor": "ruby", "irb": "ruby", "rake": "ruby",
	"php": "php", "php3": "php", "php4": "php", "php5": "php", "php7": "php", "php8": "php",
	"pl": "perl", "perl": "perl", "pm": "perl",
	"lua": "lua", "luau": "lua",
	"r": "r", "rscript": "r",
	"jl": "julia", "julia": "julia",
	"dart": "dart", "flutter": "dart",
	"ex": "elixir", "exs": "elixir", "elixir": "elixir",
	"erl": "erlang", "erlang": "erlang",
	"hs": "haskell", "haskell": "haskell",
	"clj": "clojure", "cljs": "clojure", "cljc": "clojure", "edn": "clojure", "clojure": "clojure",
	"ml": "ocaml", "ocaml": "ocaml", "mli": "ocaml", "reason": "reasonml", "re": "reasonml", "reasonml": "reasonml",
	"fs": "fsharp", "fsharp": "fsharp", "f#": "fsharp", "fsx": "fsharp", "fsi": "fsharp",
	"zig": "zig",
	"nim": "nim",
	"sh":  "bash", "bash": "bash", "zsh": "bash", "ksh": "bash", "fish": "bash", "shellscript": "bash", "shell-script": "bash",
	"shell": "shell", "console": "shell", "terminal": "shell", "shell-session": "shell", "shellsession": "shell", "bash-session": "shell", "sh_session": "shell", "cmd": "dos", "bat": "dos", "batch": "dos", "dos": "dos",
	"ps": "powershell", "ps1": "powershell", "psm1": "powershell", "pwsh": "powershell", "powershell": "powershell",
	"sql": "sql", "mysql": "sql", "postgres": "sql", "postgresql": "sql", "psql": "pgsql", "pgsql": "pgsql", "plpgsql": "pgsql", "sqlite": "sql", "plsql": "sql", "tsql": "sql", "mssql": "sql", "mariadb": "sql", "bigquery": "sql", "snowflake": "sql", "hive": "sql", "sparksql": "sql",
	"html": "html", "xhtml": "html", "htm": "html", "vue": "html", "svelte": "html", "astro": "html", "handlebars": "html", "hbs": "html", "jinja": "html", "jinja2": "html", "django": "html", "liquid": "html", "ejs": "html", "erb": "erb", "razor": "html", "blade": "html", "twig": "html",
	"xml": "xml", "svg": "xml", "rss": "xml", "atom": "xml", "xsl": "xml", "xslt": "xml", "plist": "xml", "xaml": "xml", "wsdl": "xml", "csproj": "xml",
	"css": "css", "scss": "scss", "sass": "scss", "less": "less", "stylus": "stylus", "styl": "stylus", "postcss": "css",
	"json": "json", "jsonc": "json", "json5": "json", "jsonl": "json", "geojson": "json", "webmanifest": "json",
	"yaml": "yaml", "yml": "yaml",
	"toml": "toml",
	"ini":  "ini", "cfg": "ini", "conf": "ini", "config": "ini", "properties": "properties", "env": "bash", "dotenv": "bash", "editorconfig": "ini", "gitconfig": "ini",
	"md": "markdown", "markdown": "markdown", "mdx": "markdown", "mkd": "markdown", "rmd": "markdown",
	"dockerfile": "dockerfile", "docker": "dockerfile", "containerfile": "dockerfile",
	"makefile": "makefile", "make": "makefile", "mk": "makefile", "mak": "makefile",
	"cmake": "cmake",
	"nginx": "nginx", "nginxconf": "nginx",
	"apache": "apache", "apacheconf": "apache", "htaccess": "apache",
	"graphql": "graphql", "gql": "graphql",
	"proto": "protobuf", "protobuf": "protobuf",
	"diff": "diff", "patch": "diff", "udiff": "diff",
	"tex": "latex", "latex": "latex", "katex": "latex", "bibtex": "latex",
	"matlab": "matlab", "octave": "matlab",
	"groovy": "groovy", "gradle": "groovy", "jenkinsfile": "groovy",
	"vb": "vbnet", "vbnet": "vbnet", "vb.net": "vbnet", "vba": "vbscript", "vbs": "vbscript", "vbscript": "vbscript",
	"asm": "x86asm", "nasm": "x86asm", "x86asm": "x86asm", "assembly": "x86asm", "armasm": "armasm", "arm": "armasm", "mips": "mipsasm", "wasm": "wasm", "wat": "wasm",
	"sol": "solidity", "solidity": "solidity",
	"hcl": "hcl", "tf": "hcl", "terraform": "hcl",
	"nix": "nix",
	"vim": "vim", "viml": "vim", "vimscript": "vim",
	"http": "http", "https": "http",
	"lisp": "lisp", "elisp": "lisp", "emacs": "lisp", "emacs-lisp": "lisp", "commonlisp": "lisp", "scheme": "scheme", "racket": "scheme", "rkt": "scheme",
	"elm": "elm", "purescript": "haskell", "idris": "haskell", "agda": "haskell",
	"fortran": "fortran", "f90": "fortran", "f95": "fortran",
	"cobol": "cobol", "pascal": "delphi", "delphi": "delphi", "ada": "ada",
	"prolog": "prolog", "coq": "coq", "lean": "lean", "lean4": "lean",
	"crystal": "crystal", "cr": "crystal", "d": "d", "v": "v", "vala": "vala", "haxe": "haxe", "hx": "haxe", "awk": "awk", "gawk": "awk", "sed": "bash", "tcl": "tcl",
	"csv": "plaintext", "tsv": "plaintext",
	"text": "plaintext", "txt": "plaintext", "plain": "plaintext", "plaintext": "plaintext", "none": "plaintext", "nohighlight": "plaintext", "no-highlight": "plaintext", "output": "plaintext", "log": "plaintext", "raw": "plaintext", "ascii": "plaintext", "mermaid": "plaintext",
	"regex": "plaintext", "regexp": "plaintext",
}

// NormalizeLanguage is the canonical id for a language name from markup, or
// "" when the name is unknown ("" in: null).
func NormalizeLanguage(name string) string {
	key := strings.TrimPrefix(jsLower(jsTrim(name)), ".")
	if key == "" {
		return ""
	}
	return languageAliases[key]
}

// languageClass is one of CLASS_PATTERNS: the language is group 1. The
// patterns are case-insensitive; need, a lowercase literal every match
// contains, skips them for the usual class without a regexp.
type languageClass struct {
	re   *regexp.Regexp
	need string
}

var languageClasses = compileLanguageClasses(
	`(?:^|\s)(?:language|lang)-([\w#+.-]+)`,
	`(?:^|\s)highlight-(?:source-)?([\w#+.-]+)`,
	`(?:^|\s)brush:\s*([\w#+.-]+)`,
	`(?:^|\s)sourceCode\s+([\w#+.-]+)`,
	`(?:^|\s)mw-highlight-lang-([\w#+.-]+)`,
	`(?:^|\s)hljs\s+([\w#+.-]+)`,
	`(?:^|\s)prettyprint\s+lang-([\w#+.-]+)`,
	`(?:^|\s)code-([\w#+-]+)(?:\s|$)`,
	`(?:^|\s)syntax-([\w#+-]+)(?:\s|$)`,
	`(?:^|\s)([\w#+-]+)-code(?:\s|$)`,
)

func compileLanguageClasses(sources ...string) []languageClass {
	out := make([]languageClass, len(sources))
	for i, source := range sources {
		need := ""
		for _, lit := range mandatoryLiterals(elements(parseJS(source))) {
			if len(lit) > len(need) {
				need = lit
			}
		}
		out[i] = languageClass{re: jsRegexp(foldASCII(source), ""), need: asciiLower(need)}
	}
	return out
}

// LanguageFromClass is the language a class attribute names (`language-js`,
// `brush: py`, `highlight-source-rust`, ...), or "".
func LanguageFromClass(className string) string {
	if className == "" {
		return ""
	}
	lower := asciiLower(className)
	for _, p := range languageClasses {
		if !strings.Contains(lower, p.need) {
			continue
		}
		// Leftmost-first submatches: the group JavaScript's exec reports.
		if m := p.re.FindStringSubmatch(className); m != nil {
			if lang := NormalizeLanguage(m[1]); lang != "" {
				return lang
			}
		}
	}
	// A bare language class (`<code class="python">`, `<pre class="js">`).
	for _, token := range splitJSSpace(className) {
		if n := u16len(token); n >= 2 && n <= 12 {
			lang := NormalizeLanguage(token)
			if lang != "" && lang != "plaintext" && token != "text" && token != "output" {
				return lang
			}
		}
	}
	return ""
}

// asciiLower lowercases ASCII letters only, keeping byte offsets: what a
// case-insensitive JavaScript pattern without `u` folds.
func asciiLower(s string) string {
	for i := 0; i < len(s); i++ {
		if c := s[i]; c >= 'A' && c <= 'Z' {
			b := []byte(s)
			for j := i; j < len(b); j++ {
				b[j] = lowerByte[b[j]]
			}
			return bytesString(b)
		}
	}
	return s
}

// ------------------------------------------------------------------ detection

type ruleSource struct {
	source string
	flags  string
	weight float64
}

// languageRules is RULES: weighted evidence per language. A line's
// indentation is `[^\S\n\r\u2028\u2029]*`, whitespace short of a line break
// (see languages.ts on why the patterns have the shapes they have).
var languageRules = []struct {
	lang  string
	rules []ruleSource
}{
	{"python", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*def \w+\s*\(.*\)\s*(->\s*[\w\[\], .]+)?:\s*$`, "m", 4},
		{`^[^\S\n\r\u2028\u2029]*class \w+(\(.*\))?:\s*$`, "m", 4},
		{`^[^\S\n\r\u2028\u2029]*(elif|except|finally|try)\b.*:\s*$`, "m", 3},
		{`\bself\.\w+`, "", 2},
		{`^[^\S\n\r\u2028\u2029]*from [\w.]+ import \w`, "m", 4},
		{`^[^\S\n\r\u2028\u2029]*import (numpy|pandas|os|sys|re|json|torch|requests|asyncio|typing)\b`, "m", 4},
		{`\b(None|True|False)\b`, "", 1},
		{`\bprint\(`, "", 1},
		{`__(init|name|main)__`, "", 4},
		{`^[^\S\n\r\u2028\u2029]*@\w+(\.\w+)*(\(.*\))?\s*$`, "m", 1},
		{`\bf["'][^"'\n]*\{`, "", 2},
		{`^>>> `, "m", 4},
		{`\blambda \w*:`, "", 2},
		{`^[^\S\n\r\u2028\u2029]*for \w+(, \w+)* in .+:\s*$`, "m", 3},
		{`^[^\S\n\r\u2028\u2029]*if .+:\s*$`, "m", 1},
		{`\bdef \w+\(self`, "", 4},
		{`\b(len|range|enumerate|isinstance)\(`, "", 1},
	}},
	{"javascript", []ruleSource{
		{`\b(const|let|var)(?:\s+[\w${}\[\],]+(?: +[\w${}\[\],]+)*|\s[^\S ]* )\s*=`, "", 2},
		{`=>`, "", 1},
		{`\bfunction\s*(?:\*\s*)?(?:[\w$]+\s*)?\(`, "", 2},
		{`\bconsole\.(log|error|warn)\(`, "", 3},
		{`\b(document|window)\.\w+`, "", 2},
		{`\brequire\(['"]`, "", 3},
		{`\bexport\s+(default|const|function|class|async)\b`, "", 2},
		{`^[^\S\n\r\u2028\u2029]*import(?:\s+\S(?:.*\S)?|\s[\n\r\u2028\u2029]*[^\S\n\r\u2028\u2029])\s+from\s+['"]`, "m", 3},
		{`===|!==`, "", 2},
		{`\bundefined\b`, "", 1},
		{`\bawait\b`, "", 0.5},
		{`\bmodule\.exports\b`, "", 4},
		{`\.then\(`, "", 1},
		{`\bnew Promise\(`, "", 2},
		{`\$\{[^}]+\}`, "", 1},
		{`\buse(State|Effect|Ref|Memo|Callback)\(`, "", 3},
		{`<\/?[A-Z]\w*[\s>]`, "", 1},
		{`\baddEventListener\(`, "", 3},
		{`\bJSON\.(parse|stringify)\(`, "", 2},
	}},
	{"typescript", []ruleSource{
		{`:\s*(string|number|boolean|any|void|unknown|never|object)(\[\])?\s*[;,)=|{]`, "", 4},
		{`^[^\S\n\r\u2028\u2029]*(export\s+)?interface\s+\w+(<.+>)?\s*(extends [\w<>, ]+)?\{`, "m", 4},
		{`^[^\S\n\r\u2028\u2029]*(export\s+)?type\s+\w+(<.+>)?\s*=`, "m", 3},
		{`\bas const\b`, "", 3},
		{`\b(private|public|protected|readonly)\s+\w+\s*[:;=(]`, "", 2},
		{`^[^\S\n\r\u2028\u2029]*(export\s+)?enum\s+\w+\s*\{`, "m", 3},
		{`\bimport type\b`, "", 4},
		{`<\w+(\[\])?>\(`, "", 1},
		{`\):\s*(Promise<|[\w<>\[\]]+\s*\{)`, "", 3},
		{`\bimplements\s+\w+`, "", 1},
		{`!\.`, "", 1},
		{`\bkeyof\b|\btypeof \w+\[`, "", 2},
	}},
	{"java", []ruleSource{
		{`\bpublic\s+(static\s+)?(final\s+)?(class|interface|enum|void|record)\b`, "", 3},
		{`\bSystem\.(out|err)\.print`, "", 5},
		{`String\[\]\s+args`, "", 5},
		{`@Override\b`, "", 3},
		{`^[^\S\n\r\u2028\u2029]*import\s+java(x)?\.[\w.]+;`, "m", 5},
		{`^[^\S\n\r\u2028\u2029]*package\s+[\w.]+;\s*$`, "m", 4},
		{`\bprivate\s+(static\s+)?(final\s+)?[A-Z]\w*(<.*>)?\s+\w+\s*[;=]`, "", 2},
		{`\bnew\s+[A-Z]\w*(<.*>)?\(`, "", 1},
		{`\bthrows\s+\w+`, "", 2},
		{`\b(ArrayList|HashMap|List<|Map<)`, "", 1},
		{`;\s*$`, "m", 0.5},
	}},
	{"kotlin", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*(suspend\s+|private\s+|override\s+|inline\s+)*fun\s+(<.+>\s*)?[\w.]+\(`, "m", 4},
		{`^[^\S\n\r\u2028\u2029]*val\s+\w+(\s*:\s*[\w<>?]+)?\s*=`, "m", 2},
		{`^[^\S\n\r\u2028\u2029]*var\s+\w+\s*:\s*\w+`, "m", 2},
		{`\bdata class\b`, "", 4},
		{`\bcompanion object\b`, "", 5},
		{`^[^\S\n\r\u2028\u2029]*import\s+(kotlin|kotlinx|androidx)\.`, "m", 5},
		{`\?:|\?\.`, "", 1},
		{`\bprintln\(`, "", 1},
		{`\bwhen\s*(\(.*\)\s*)?\{`, "", 2},
		{`\bit\.\w+`, "", 1},
	}},
	{"swift", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*(@\w+\s+)*(public\s+|private\s+|static\s+|override\s+)*func\s+\w+(<.+>)?\(`, "m", 4},
		{`^[^\S\n\r\u2028\u2029]*import\s+(UIKit|SwiftUI|Foundation|Combine|AppKit)\s*$`, "m", 5},
		{`\b(guard|if)\s+let\b`, "", 4},
		{`->\s*[\w<>\[\]?]+\s*\{`, "", 1},
		{`@(State|Published|Binding|ObservedObject|MainActor|escaping)\b`, "", 4},
		{`\bstruct\s+\w+\s*:\s*View\b`, "", 5},
		{`^[^\S\n\r\u2028\u2029]*let\s+\w+(\s*:\s*[\w<>\[\]?]+)?\s*=`, "m", 1},
		{`\bvar body: some View\b`, "", 5},
		{`\bprint\(`, "", 0.5},
	}},
	{"go", []ruleSource{
		{`^package\s+\w+\s*$`, "m", 5},
		{`^[^\S\n\r\u2028\u2029]*func\s+(\(\w+\s+\*?\w+\)\s+)?\w+\(`, "m", 4},
		{`:=`, "", 2},
		{`\bfmt\.(Print|Sprint|Fprint|Errorf)`, "", 5},
		{`\bif err != nil\b`, "", 5},
		{`\bgo func\b|\bchan\s+\w+|\bdefer\s+\w+`, "", 3},
		{`^import\s+\(\s*$`, "m", 3},
		{`\bstruct\s*\{`, "", 1},
		{`\[\]\w+\{`, "", 2},
		{`\bmake\((map|\[\]|chan)`, "", 3},
	}},
	{"rust", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*(pub(\(crate\))?\s+)?(async\s+)?fn\s+\w+(<.+>)?\(`, "m", 4},
		{`\blet\s+mut\b`, "", 4},
		{`\b(println|format|vec|panic|assert_eq|write|eprintln)!\(`, "", 4},
		{`\b(println|vec)!\[`, "", 4},
		{`^[^\S\n\r\u2028\u2029]*use\s+(std|crate|super|self|tokio|serde)::`, "m", 5},
		{`#\[(derive|cfg|test|tokio::main)`, "", 5},
		{`\bimpl(<.+>)?\s+[\w:<>]+(\s+for\s+\w+)?\s*\{`, "", 3},
		{`&(mut\s+)?(str|self)\b`, "", 3},
		{`::new\(`, "", 1},
		{`->\s*(Result|Option|Self|impl\s)`, "", 2},
		{`\bmatch\s+(?:\S.*|[^\S\n\r\u2028\u2029])\{`, "", 1},
		{`\b(Some|None|Ok|Err)\(`, "", 1},
		{`\bunwrap\(\)`, "", 3},
	}},
	{"c", []ruleSource{
		{`#include\s*<\w+\.h>`, "", 4},
		{`\bint\s+main\s*\(`, "", 3},
		{`\bprintf\s*\(`, "", 2},
		{`\b(malloc|calloc|free|sizeof|memcpy|strlen)\s*\(`, "", 2},
		{`\bstruct\s+\w+\s*\{`, "", 1},
		{`^[^\S\n\r\u2028\u2029]*#define\s+\w+`, "m", 2},
		{`\bvoid\s*\*`, "", 2},
		{`\bchar\s*\*\s*\w+`, "", 2},
		{`->`, "", 0.5},
	}},
	{"cpp", []ruleSource{
		{`#include\s*<(iostream|vector|string|memory|map|algorithm|thread|cstdio|cstdlib|unordered_map)>`, "", 5},
		{`\bstd::`, "", 4},
		{`\bstd::cout\s*<<|\bcout\s*<<`, "", 5},
		{`\btemplate\s*<`, "", 4},
		{`^[^\S\n\r\u2028\u2029]*namespace\s+\w+\s*\{`, "m", 2},
		{`\bnullptr\b`, "", 4},
		{`\busing namespace\b`, "", 5},
		{`\bauto\s+\w+\s*=`, "", 1},
		{`\b(virtual|override|constexpr|noexcept)\b`, "", 2},
		{`::\w+\(`, "", 1},
		{`\bclass\s+\w+\s*(:\s*(public|private)\s+\w+)?\s*\{`, "", 1},
	}},
	{"csharp", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*using\s+System(\.\w+)*;`, "m", 5},
		{`\bConsole\.Write(Line)?\(`, "", 5},
		{`\{\s*get;\s*(private\s+)?set;\s*\}`, "", 5},
		{`^[^\S\n\r\u2028\u2029]*namespace\s+[\w.]+`, "m", 2},
		{`\bpublic\s+(async\s+)?(static\s+)?(Task|void|string|int|bool|class|interface|record)\b`, "", 2},
		{`\bvar\s+\w+\s*=\s*new\b`, "", 2},
		{`\basync\s+Task\b`, "", 4},
		{`^[^\S\n\r\u2028\u2029]*\[\w+(\(.*\))?\]\s*$`, "m", 1},
		{`\bstring\[\]\s+args`, "", 3},
		{`\bLINQ|\.Where\(|\.Select\(`, "", 1},
	}},
	{"ruby", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*def\s+(self\.)?\w+[?!]?(\(.*\))?\s*$`, "m", 3},
		{`^[^\S\n\r\u2028\u2029]*end\s*$`, "m", 2},
		{`\bputs\b`, "", 2},
		{`^[^\S\n\r\u2028\u2029]*require(_relative)?\s+['"]`, "m", 2},
		{`\.each(_with_index)?\s+do\s*\|`, "", 5},
		{`\battr_(accessor|reader|writer)\b`, "", 5},
		{`:\w+\s*=>`, "", 2},
		{`\bdo\s*\|\w+(, \w+)*\|`, "", 3},
		{`^[^\S\n\r\u2028\u2029]*module\s+[A-Z]\w*\s*$`, "m", 2},
		{`^[^\S\n\r\u2028\u2029]*class\s+\w+\s*<\s*\w+`, "m", 3},
		{`\bnil\b`, "", 1},
		{`#\{[^}]+\}`, "", 2},
	}},
	{"php", []ruleSource{
		{`<\?php`, "", 8},
		{`\$\w+\s*=[^=]`, "", 2},
		{`\$this->\w+`, "", 4},
		{`\bfunction\s+\w+\s*\(\s*(\??\w+\s+)?\$`, "", 4},
		{`^[^\S\n\r\u2028\u2029]*namespace\s+[\w\\]+;`, "m", 4},
		{`\becho\s+`, "", 1},
		{`->\w+\(`, "", 1},
		{`\barray\(`, "", 2},
		{`::class\b`, "", 2},
	}},
	{"shell", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*[$%\u276F] \S`, "m", 3},
		{`^[^\S\n\r\u2028\u2029]*[\w.-]+@[\w.-]+:[~\/][^$#\n]*[$#] `, "m", 5},
		{`^[^\S\n\r\u2028\u2029]*PS [A-Z]:\\.*> `, "m", 3},
	}},
	{"bash", []ruleSource{
		{`^#!\/(usr\/)?bin\/(env\s+)?(ba|z)?sh`, "m", 6},
		{`^[^\S\n\r\u2028\u2029]*(sudo\s+)?(apt(-get)?|brew|npm|npx|yarn|pnpm|pip3?|cargo|go|git|docker|kubectl|curl|wget|cd|ls|mkdir|rm|cp|mv|chmod|chown|export|source|cat|grep|echo|tar|ssh|make|bun|deno|helm|terraform|aws|gcloud|systemctl|uv|poetry|conda|rustup|flutter|dart)\s`, "m", 3},
		{`^[^\S\n\r\u2028\u2029]*(if|then|fi|for|do|done|case|esac|while)\b`, "m", 1},
		{`\b(fi|done|esac)\s*$`, "m", 2},
		{`\$\{?\w+\}?`, "", 0.5},
		{`\s--?[a-z][\w-]*`, "", 0.5},
		{`\s&&\s|\s\|\s`, "", 0.5},
		{`^[^\S\n\r\u2028\u2029]*#\s`, "m", 0.5},
	}},
	{"powershell", []ruleSource{
		{`\b(Get|Set|New|Remove|Write|Invoke|Import|Start|Stop)-\w+`, "", 4},
		{`\$\w+\s*=`, "", 1},
		{`-Object\b|\|\s*Where-Object|\|\s*ForEach-Object`, "", 4},
		{`\$PSScriptRoot|\$env:`, "", 4},
	}},
	{"sql", []ruleSource{
		{`\bSELECT\b[\s\S]+?\bFROM\b`, "i", 4},
		{`\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIEW|DATABASE)|ALTER\s+TABLE|DROP\s+TABLE)\b`, "i", 5},
		{`\b(WHERE|JOIN|GROUP BY|ORDER BY|HAVING|LIMIT)\b`, "", 1},
		{`\bPRIMARY KEY\b|\bFOREIGN KEY\b|\bVARCHAR\(`, "i", 3},
	}},
	{"html", []ruleSource{
		{`<!DOCTYPE html>`, "i", 6},
		{`<(html|head|body|div|span|p|a|ul|li|script|link|meta|section|button|img|form|input|nav|header|footer)\b[^>]*>`, "i", 2},
		{`<\/(div|span|p|a|li|ul|section|button|body|html)>`, "i", 2},
		{`\b(class|href|src|id)="[^"]*"`, "", 1},
	}},
	{"xml", []ruleSource{
		{`^\s*<\?xml\b`, "", 6},
		{`<\w+:\w+[\s>]`, "", 2},
		{`xmlns(:\w+)?="`, "", 3},
		{`<\/\w+>`, "", 0.5},
	}},
	{"css", []ruleSource{
		{`^[ \t]*[.#:@]?[\w-]+(?:(?:[ \t]*[,>+~][ \t]*|[ \t]+)[.#:]?[\w-]+|[.#:][\w-]+|\([^)\n]*\))*[ \t]*\{[ \t]*$`, "m", 2},
		{`^[^\S\n\r\u2028\u2029]*(color|margin|padding|display|font-(size|family|weight)|background(-color)?|border(-radius)?|width|height|position|flex|grid-template-columns|transition|transform)\s*:[^;]+;`, "m", 3},
		{`@(media|import|keyframes|font-face|supports|layer)\b`, "", 3},
		{`^[ \t]*-?[a-z]+(?:-[a-z]+)*[ \t]*:[ \t]*[^;{}\n]+;[ \t]*$`, "m", 2},
		{`:\s*(hover|focus|before|after|root|nth-child)`, "", 1},
		{`\b\d+(px|rem|em|vh|vw)\b`, "", 1},
		{`var\(--[\w-]+\)`, "", 2},
	}},
	{"scss", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*\$[\w-]+\s*:`, "m", 3},
		{`&(:|\.|-)\w`, "", 3},
		{`@(mixin|include|extend|use|forward)\b`, "", 4},
	}},
	{"yaml", []ruleSource{
		{`^---\s*$`, "m", 1},
		{`^[^\S\n\r\u2028\u2029]*[\w.-]+:\s+[^\s{].*$`, "m", 1},
		{`^[^\S\n\r\u2028\u2029]*[\w.-]+:\s*$`, "m", 1},
		{`^[^\S\n\r\u2028\u2029]*- [\w"'].*$`, "m", 1},
		{`^[^\S\n\r\u2028\u2029]*(apiVersion|kind|metadata|spec|services|image|name|steps|jobs|runs-on|on|version|dependencies):`, "m", 3},
	}},
	{"toml", []ruleSource{
		{`^\[\[?[\w.-]+\]\]?\s*$`, "m", 3},
		{`^[^\S\n\r\u2028\u2029]*[\w.-]+\s*=\s*("|\d|\[|true|false|\{)`, "m", 2},
		{`^\[(package|dependencies|tool\.\w+|build-system|workspace)\]`, "m", 4},
	}},
	{"ini", []ruleSource{
		{`^\[[\w .-]+\]\s*$`, "m", 2},
		{`^[^\S\n\r\u2028\u2029]*[\w.-]+\s*=\s*[^=\n]*$`, "m", 1},
		{`^[^\S\n\r\u2028\u2029]*;`, "m", 1},
	}},
	{"dockerfile", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*FROM\s+[\w./:-]+(\s+AS\s+\w+)?\s*$`, "im", 5},
		{`^[^\S\n\r\u2028\u2029]*(RUN|COPY|ADD|CMD|ENTRYPOINT|WORKDIR|EXPOSE|ENV|ARG|USER|VOLUME|LABEL|HEALTHCHECK)\s`, "m", 2},
	}},
	{"makefile", []ruleSource{
		{`^[\w.%$()/-]+\s*:[^=\n]*\n\t\S`, "m", 5},
		{`\$\([\w@<^]+\)`, "", 1},
		{`^\.PHONY\s*:`, "m", 5},
	}},
	{"markdown", []ruleSource{
		{`^#{1,6}\s+\S`, "m", 2},
		{`^[^\S\n\r\u2028\u2029]*[-*+]\s+\S`, "m", 0.5},
		{`\[[^\]]+\]\([^)]+\)`, "", 2},
		{"^```", "m", 3},
		{`\*\*[^*]+\*\*`, "", 1},
	}},
	{"diff", []ruleSource{
		{`^@@ [-+]\d+(,\d+)? [-+]\d+(,\d+)? @@`, "m", 6},
		{`^(\+\+\+|---) [ab]?\/`, "m", 4},
		{`^diff --git `, "m", 6},
		{`^[+-](?![+-])`, "m", 0.5},
	}},
	{"graphql", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*(query|mutation|subscription|fragment)\s*(\w+\s*)?(\(.*\)\s*)?(on \w+\s*)?\{`, "m", 5},
		{`^[^\S\n\r\u2028\u2029]*type\s+\w+\s*(implements\s+\w+\s*)?\{`, "m", 2},
		{`^[^\S\n\r\u2028\u2029]*schema\s*\{`, "m", 4},
	}},
	{"lua", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*local\s+(function\s+)?\w+`, "m", 4},
		{`\bfunction\s+[\w.:]+\(.*\)\s*$`, "m", 1},
		{`\bthen\s*$`, "m", 2},
		{`~=`, "", 3},
		{`\bend\s*$`, "m", 1},
		{`\brequire\s*\(?["']`, "", 1},
		{`\bnil\b`, "", 1},
		{`\bipairs\(|\bpairs\(`, "", 4},
	}},
	{"r", []ruleSource{
		{`\b\w+\s*<-\s*`, "", 3},
		{`\blibrary\(\w+\)`, "", 5},
		{`\bc\(`, "", 1},
		{`\b(data\.frame|ggplot|dplyr|tidyverse|summary)\(`, "", 4},
		{`%>%|\|>`, "", 2},
	}},
	{"haskell", []ruleSource{
		{`^\w+\s*::\s*.+$`, "m", 4},
		{`::\s*\w+\s*->`, "", 3},
		{`^[^\S\n\r\u2028\u2029]*import\s+qualified\b`, "m", 5},
		{`^module\s+[\w.]+\s+where`, "m", 5},
		{`\bwhere\s*$`, "m", 1},
		{`<\$>|>>=`, "", 3},
		{`\bdata\s+\w+\s*=`, "", 2},
	}},
	{"elixir", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*defmodule\s+[\w.]+\s+do`, "m", 6},
		{`^[^\S\n\r\u2028\u2029]*defp?\s+\w.*\bdo\s*$`, "m", 3},
		{`\|>`, "", 2},
		{`\b(IO\.puts|Enum\.\w+|%\{)`, "", 3},
	}},
	{"dart", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*import\s+'package:[\w/.-]+';`, "m", 6},
		{`\bWidget\s+build\(BuildContext`, "", 6},
		{`\bsetState\(`, "", 3},
		{`@override\b`, "", 2},
		{`\bvoid\s+main\(\)`, "", 2},
		{`\bfinal\s+\w+(\s*<.+>)?\s+\w+\s*=`, "", 1},
		{`\bFuture<\w+>`, "", 2},
		{`\blate\s+\w+`, "", 3},
	}},
	{"scala", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*object\s+\w+(\s+extends\s+\w+)?\s*\{`, "m", 3},
		{`\bdef\s+\w+(\[.+\])?\(.*\)\s*:\s*[\w\[\]]+\s*=`, "", 4},
		{`\bcase class\b`, "", 4},
		{`^[^\S\n\r\u2028\u2029]*import\s+scala\.`, "m", 5},
		{`\bval\s+\w+\s*:\s*\w+`, "", 1},
	}},
	{"clojure", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*\(defn-?\s`, "m", 5},
		{`^[^\S\n\r\u2028\u2029]*\(ns\s`, "m", 5},
		{`^[^\S\n\r\u2028\u2029]*\(def\s`, "m", 3},
		{`\(let\s*\[`, "", 3},
	}},
	{"latex", []ruleSource{
		{`\\(begin|end)\{\w+\*?\}`, "", 4},
		{`\\(documentclass|usepackage|section|subsection|maketitle)\b`, "", 5},
		{`\\(frac|sum|int|alpha|beta|mathbb|mathrm|left|right)\b`, "", 2},
	}},
	{"nginx", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*server\s*\{`, "m", 3},
		{`^[^\S\n\r\u2028\u2029]*listen\s+\d+`, "m", 3},
		{`^[^\S\n\r\u2028\u2029]*location\s+(?:[~=^]+\s+)?\S+\s*\{`, "m", 4},
		{`\bproxy_pass\b|\bserver_name\b|\broot\s+\/`, "", 4},
	}},
	{"protobuf", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*syntax\s*=\s*"proto[23]";`, "m", 6},
		{`^[^\S\n\r\u2028\u2029]*message\s+\w+\s*\{`, "m", 3},
		{`^[^\S\n\r\u2028\u2029]*(repeated|optional|required)\s+\w+\s+\w+\s*=\s*\d+;`, "m", 4},
	}},
	{"solidity", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*pragma\s+solidity\b`, "m", 7},
		{`^[^\S\n\r\u2028\u2029]*contract\s+\w+`, "m", 3},
		{`\bmsg\.sender\b`, "", 4},
	}},
	{"objectivec", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*@(interface|implementation|property|end|protocol)\b`, "m", 4},
		{`^[^\S\n\r\u2028\u2029]*#import\s+[<"]`, "m", 4},
		{`\bNS(String|Log|Array|Dictionary|Object)\b`, "", 4},
		{`\[\w+\s+\w+(:\w+)?\]`, "", 1},
	}},
	{"perl", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*use\s+(strict|warnings);`, "m", 5},
		{`\bmy\s+[$@%]\w+`, "", 4},
		{`=~\s*[ms]?\/`, "", 2},
		{`\$_\b`, "", 2},
	}},
	{"matlab", []ruleSource{
		{`^[^\S\n\r\u2028\u2029]*function\s+(\[.*\]|\w+)\s*=\s*\w+\(`, "m", 4},
		{`\b(zeros|ones|linspace|plot|figure|disp)\(`, "", 2},
		{`^[^\S\n\r\u2028\u2029]*%`, "m", 1},
		{`\.\*|\.\^`, "", 2},
	}},
	{"json", []ruleSource{}},
}

// detector is languageRules compiled; built on first use.
var detector = sync.OnceValue(func() [][]*detectRule {
	out := make([][]*detectRule, len(languageRules))
	for i, l := range languageRules {
		for _, src := range l.rules {
			out[i] = append(out[i], compileRule(src))
		}
	}
	return out
})

var (
	jsonKey = jsRegexp(`^[{[]\s*"[\w$@-]+"\s*:`, "")
	// pycon is `/^[^\S\n\r\u2028\u2029]*>>>/m`: a Python console, not a shell.
	pycon = sync.OnceValue(func() *detectRule { return compileRule(ruleSource{`^[^\S\n\r\u2028\u2029]*>>>`, "m", 0}) })
)

func looksLikeJSON(code string) bool {
	first := code[0]
	if first != '{' && first != '[' {
		return false
	}
	last := code[len(code)-1]
	if !(first == '{' && last == '}') && !(first == '[' && last == ']') {
		return false
	}
	if u16len(code) > 200000 {
		return true
	}
	// json.Valid is JSON.parse's grammar; it checks syntax only, so `1e400`
	// passes, as JSON.parse reads it as Infinity (json.Unmarshal would fail).
	if json.Valid([]byte(code)) {
		return true
	}
	return jsonKey.MatchString(code)
}

// DetectLanguage is the best guess for unlabelled code, or "" when the
// evidence is weak.
func DetectLanguage(source string) string {
	code := jsTrim(jsHead(source, 5000))
	if u16len(code) < 8 {
		return ""
	}
	if looksLikeJSON(code) {
		return "json"
	}
	t := newCodeIndex(code)
	defer t.release()
	rules := detector()
	scores := make([]float64, len(rules))
	for i, lang := range rules {
		for _, r := range lang {
			if r.test(t) {
				scores[i] += r.weight
			}
		}
	}
	// TypeScript is JavaScript with types; HTML-in-JS and CSS-in-SCSS likewise.
	js, ts := scores[langJavaScript], scores[langTypeScript]
	if ts >= 3 {
		scores[langTypeScript] = ts + js
	}
	css, scss := scores[langCSS], scores[langSCSS]
	if scss >= 3 {
		scores[langSCSS] = scss + css
	}
	c, cpp := scores[langC], scores[langCPP]
	if cpp >= 4 {
		scores[langCPP] = cpp + c
	}
	// Unified diffs without headers: most lines start with + or -, both present.
	// Terminal sessions: most non-empty lines start with a prompt.
	lines, plus, minus := 0, 0, 0
	prompts, nonEmpty := 0, 0
	firstIsPrompt := false
	for rest := code; ; {
		line := rest
		k := strings.IndexByte(rest, '\n')
		if k >= 0 {
			line = rest[:k]
		}
		lines++
		if len(line) > 0 {
			if line[0] == '+' && (len(line) < 2 || line[1] != '+') {
				plus++
			} else if line[0] == '-' && (len(line) < 2 || line[1] != '-') {
				minus++
			}
		}
		if trimmed := jsTrimStart(line); trimmed != "" {
			prompt := isPrompt(trimmed)
			if nonEmpty == 0 {
				firstIsPrompt = prompt
			}
			nonEmpty++
			if prompt {
				prompts++
			}
		}
		if k < 0 {
			break
		}
		rest = rest[k+1:]
	}
	if plus > 0 && minus > 0 && lines >= 3 && float64(plus+minus) >= float64(lines)*0.4 {
		scores[langDiff] += 6
	}
	// A session opens with a prompt; what follows may be the command's output.
	if (firstIsPrompt || float64(prompts) >= float64(nonEmpty)*0.5) && prompts > 0 && !pycon().test(t) {
		scores[langShell] += 4
	}
	bash, shell := scores[langBash], scores[langShell]
	if shell >= 3 {
		scores[langShell] = shell + bash
	}
	// The first of equal scores wins, in RULES order (a Map keeps insertion order).
	best, bestScore, second := -1, 0.0, 0.0
	for i, score := range scores {
		if score > bestScore {
			second = bestScore
			bestScore = score
			best = i
		} else if score > second {
			second = score
		}
	}
	if best < 0 || bestScore < 4 {
		return ""
	}
	if bestScore-second < 2 && bestScore < second*1.5 {
		return ""
	}
	return languageRules[best].lang
}

// Indexes of the languages DetectLanguage combines.
var (
	langJavaScript = languageIndex("javascript")
	langTypeScript = languageIndex("typescript")
	langC          = languageIndex("c")
	langCPP        = languageIndex("cpp")
	langShell      = languageIndex("shell")
	langBash       = languageIndex("bash")
	langCSS        = languageIndex("css")
	langSCSS       = languageIndex("scss")
	langDiff       = languageIndex("diff")
)

func languageIndex(name string) int {
	for i, l := range languageRules {
		if l.lang == name {
			return i
		}
	}
	panic("languages: no rules for " + name)
}

// jsHead is `s.slice(0, units)` in UTF-16 units. Where the cut splits a
// surrogate pair JavaScript keeps a lone high surrogate; U+FFFD stands in for
// it, as no pattern here tells the two apart (one unit, not space, not a word
// character, in no class).
func jsHead(s string, units int) string {
	if len(s) <= units {
		return s
	}
	n := 0
	for i := 0; i < len(s); {
		if n >= units {
			return s[:i]
		}
		c := s[i]
		if c < 0x80 {
			n++
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r >= 0x10000 {
			if n+2 > units {
				return s[:i] + "\uFFFD"
			}
			n += 2
		} else {
			n++
		}
		i += size
	}
	return s
}

// isPrompt is `/^\s*(?:[$%❯>]|PS [A-Z]:\\[^>]*>|[\w.-]+@[\w.-]+:[^$#]*[$#])\s/`
// on one line without its leading spaces: no branch starts with a space, so
// `\s*` takes them all. Each run before a delimiter is taken whole, as it
// cannot contain the delimiter.
func isPrompt(s string) bool {
	if s == "" {
		return false
	}
	switch {
	case s[0] == '$' || s[0] == '%' || s[0] == '>':
		if spaceAt(s, 1) {
			return true
		}
	case strings.HasPrefix(s, "❯"):
		if spaceAt(s, len("❯")) {
			return true
		}
	}
	if len(s) > 5 && strings.HasPrefix(s, "PS ") && s[3] >= 'A' && s[3] <= 'Z' && s[4] == ':' && s[5] == '\\' {
		if k := strings.IndexByte(s[6:], '>'); k >= 0 && spaceAt(s, 6+k+1) {
			return true
		}
	}
	i := 0
	for i < len(s) && isHostByte(s[i]) {
		i++
	}
	if i == 0 || i == len(s) || s[i] != '@' {
		return false
	}
	j := i + 1
	for j < len(s) && isHostByte(s[j]) {
		j++
	}
	if j == i+1 || j == len(s) || s[j] != ':' {
		return false
	}
	k := strings.IndexAny(s[j+1:], "$#")
	return k >= 0 && spaceAt(s, j+1+k+1)
}

// isHostByte: `[\w.-]`.
func isHostByte(c byte) bool {
	return isWordByte(c) || c == '.' || c == '-'
}

// spaceAt: s[i] starts a JavaScript `\s` character.
func spaceAt(s string, i int) bool {
	if i >= len(s) {
		return false
	}
	if c := s[i]; c < 0x80 {
		return c == ' ' || (c >= 0x09 && c <= 0x0d)
	}
	r, _ := utf8.DecodeRuneInString(s[i:])
	return isJSSpace(r)
}

// ------------------------------------------------------------------ the code under test

// codeIndex is the code DetectLanguage tests, indexed for the literals the
// rules search: a bit per byte pair that occurs (ASCII letters lowercased),
// which rules most literals out at once, and the positions of the pairs,
// chained by a hash of the pair, so a literal is looked for only where its
// rarest pair is. A string search per literal would rescan the code hundreds
// of times.
type codeIndex struct {
	s string
	// breaks: s has a line break other than `\n`.
	breaks bool
	pairs  [1 << 16 / 64]uint64
	bytes  [4]uint64
	// chain[h] holds 1 + the first position of a pair hashing to h in the
	// low 16 bits and the number of such positions in the high ones; next[i]
	// is 1 + the next position after i in i's chain (0: none). Positions fit:
	// 5000 UTF-16 units are at most 15000 bytes.
	chain []uint32
	next  []uint16
	shift uint
	// Line heads, built on first use: lines holds each line's start and its
	// first position after no indentation and after indentSpace; for each,
	// headFirst[k][c] is 1 + the first line whose head k has the (lowercased)
	// byte c, headNext[k][i] 1 + the next one after line i.
	headsBuilt bool
	lines      []lineHead
	headFirst  [2][256]int32
	headNext   [2][]int32
}

type lineHead struct {
	start int32
	head  [2]int32
}

var codeIndexes = sync.Pool{New: func() any { return new(codeIndex) }}

func newCodeIndex(s string) *codeIndex {
	t := codeIndexes.Get().(*codeIndex)
	t.s, t.headsBuilt = s, false
	t.breaks = strings.IndexByte(s, '\r') >= 0 || strings.Contains(s, "\u2028") || strings.Contains(s, "\u2029")
	clear(t.pairs[:])
	clear(t.bytes[:])
	if len(s) >= 1<<16 {
		panic("languages: code too long to index")
	}
	// About two chains per byte, in a table that stays in the cache.
	bits := uint(6)
	for bits < 13 && 1<<bits < 2*len(s) {
		bits++
	}
	t.shift = 32 - bits
	if cap(t.chain) < 1<<bits {
		t.chain = make([]uint32, 1<<13)
	}
	if cap(t.next) < len(s) {
		t.next = make([]uint16, len(s))
	}
	chain, next, shift := t.chain[:1<<bits], t.next[:len(s)], t.shift
	clear(chain)
	// Backwards, so the chains run forwards.
	if len(s) > 0 {
		c := lowerByte[s[len(s)-1]]
		t.bytes[c>>6] |= 1 << (c & 63)
	}
	for i := len(s) - 2; i >= 0; i-- {
		c := lowerByte[s[i]]
		t.bytes[c>>6] |= 1 << (c & 63)
		k := uint16(c)<<8 | uint16(lowerByte[s[i+1]])
		t.pairs[k>>6] |= 1 << (k & 63)
		e := &chain[uint32(k)*0x9e3779b1>>shift]
		next[i] = uint16(*e)
		*e = uint32(i+1) | (*e&^0xffff + 1<<16)
	}
	t.chain, t.next = chain, next
	return t
}

// lineHeads builds the line heads on first use and returns headFirst.
func (t *codeIndex) lineHeads() *[2][256]int32 {
	if t.headsBuilt {
		return &t.headFirst
	}
	t.headsBuilt = true
	clear(t.headFirst[0][:])
	clear(t.headFirst[1][:])
	t.lines, t.headNext[0], t.headNext[1] = t.lines[:0], t.headNext[0][:0], t.headNext[1][:0]
	s := t.s
	for i, e := 0, 0; i >= 0; i = t.nextLine(e) {
		e = t.lineEnd(i)
		j := i
		for j < e {
			if c := s[j]; c < 0x80 {
				if c != ' ' && c != '\t' && c != '\v' && c != '\f' {
					break
				}
				j++
				continue
			}
			r, size := utf8.DecodeRuneInString(s[j:])
			if !isJSSpace(r) {
				break
			}
			j += size
		}
		n := int32(len(t.lines))
		t.lines = append(t.lines, lineHead{start: int32(i), head: [2]int32{int32(i), int32(j)}})
		for k, h := range [2]int{i, j} {
			next := int32(0)
			if h < e {
				c := lowerByte[s[h]]
				next, t.headFirst[k][c] = t.headFirst[k][c], n+1
			}
			t.headNext[k] = append(t.headNext[k], next)
		}
	}
	return &t.headFirst
}

func (t *codeIndex) release() {
	t.s = ""
	codeIndexes.Put(t)
}

// mayContain is false when the code cannot contain lit (some byte or byte
// pair of lowercased lit does not occur).
func (t *codeIndex) mayContain(lit *ruleLiteral) bool {
	if len(lit.pairs) == 0 {
		c := lowerByte[lit.s[0]]
		return t.bytes[c>>6]&(1<<(c&63)) != 0
	}
	for _, k := range lit.pairs {
		if t.pairs[k>>6]&(1<<(k&63)) == 0 {
			return false
		}
	}
	return true
}

// each calls f with the occurrences of lit (ASCII case-insensitively with
// fold, lit lowercase), in order, until f returns true; it reports whether one
// did.
func (t *codeIndex) each(lit *ruleLiteral, fold bool, f func(q int) bool) bool {
	s := t.s
	if len(lit.pairs) == 0 {
		c := lit.s[0]
		if b := lowerByte[c]; t.bytes[b>>6]&(1<<(b&63)) == 0 {
			return false
		}
		for from := 0; from < len(s); {
			k := strings.IndexByte(s[from:], c)
			if fold && c >= 'a' && c <= 'z' {
				if u := strings.IndexByte(s[from:], c-32); u >= 0 && (k < 0 || u < k) {
					k = u
				}
			}
			if k < 0 {
				return false
			}
			if f(from + k) {
				return true
			}
			from += k + 1
		}
		return false
	}
	// The chain of the pair with the fewest positions; j is its offset in lit.
	j, h := -1, uint32(0)
	for i, k := range lit.pairs {
		if t.pairs[k>>6]&(1<<(k&63)) == 0 {
			return false
		}
		if e := t.chain[uint32(k)*0x9e3779b1>>t.shift]; j < 0 || e>>16 < h>>16 {
			j, h = i, e
		}
	}
	for p := uint16(h); p != 0; p = t.next[p-1] {
		if q := int(p-1) - j; q >= 0 && hasPrefix(s[q:], lit.s, fold) && f(q) {
			return true
		}
	}
	return false
}

// hasPrefix is strings.HasPrefix, ASCII case-insensitively with fold (lit
// lowercase).
func hasPrefix(s, lit string, fold bool) bool {
	if !fold {
		return strings.HasPrefix(s, lit)
	}
	if len(s) < len(lit) {
		return false
	}
	for i := 0; i < len(lit); i++ {
		if lowerByte[s[i]] != lit[i] {
			return false
		}
	}
	return true
}

// breakAt: a line break (`\n`, `\r`, U+2028, U+2029) starts at i.
func breakAt(s string, i int) bool {
	switch s[i] {
	case '\n', '\r':
		return true
	case 0xe2:
		return i+2 < len(s) && s[i+1] == 0x80 && (s[i+2] == 0xa8 || s[i+2] == 0xa9)
	}
	return false
}

// breakBefore: a line break ends at i.
func breakBefore(s string, i int) bool {
	if i == 0 {
		return false
	}
	switch s[i-1] {
	case '\n', '\r':
		return true
	case 0xa8, 0xa9:
		return i >= 3 && s[i-3] == 0xe2 && s[i-2] == 0x80
	}
	return false
}

// lineEnd is where the line holding i ends (the next break, or len).
func (t *codeIndex) lineEnd(i int) int {
	s := t.s
	if !t.breaks {
		if k := strings.IndexByte(s[i:], '\n'); k >= 0 {
			return i + k
		}
		return len(s)
	}
	for ; i < len(s); i++ {
		if breakAt(s, i) {
			return i
		}
	}
	return len(s)
}

// nextLine is the start of the line after the one ending at e, or -1.
func (t *codeIndex) nextLine(e int) int {
	switch {
	case e == len(t.s):
		return -1
	case t.s[e] == 0xe2:
		return e + 3
	}
	return e + 1
}

// lineStart is where the line holding i starts.
func (t *codeIndex) lineStart(i int) int {
	s := t.s
	if !t.breaks {
		return strings.LastIndexByte(s[:i], '\n') + 1
	}
	for ; i > 0 && !breakBefore(s, i); i-- {
	}
	return i
}

// indentStart: the line start before i, when only indentation of the kind
// lies between; -1 otherwise.
func (t *codeIndex) indentStart(i int, kind indentKind) int {
	s := t.s
	switch kind {
	case indentTab:
		for i > 0 && (s[i-1] == ' ' || s[i-1] == '\t') {
			i--
		}
	case indentSpace:
		for i > 0 {
			if c := s[i-1]; c < 0x80 {
				if c != ' ' && c != '\t' && c != '\v' && c != '\f' {
					break
				}
				i--
				continue
			}
			r, size := utf8.DecodeLastRuneInString(s[:i])
			if !isJSSpace(r) || r == 0x2028 || r == 0x2029 {
				break
			}
			i -= size
		}
	}
	if i == 0 || breakBefore(s, i) {
		return i
	}
	return -1
}

// ------------------------------------------------------------------ rules

type detectRule struct {
	branches []*ruleBranch
	// match, when set, is the hand-written test of a pattern RE2 cannot express
	// or would run slowly.
	match  func(t *codeIndex) bool
	weight float64
}

func (r *detectRule) test(t *codeIndex) bool {
	if r.match != nil {
		return r.match(t)
	}
	for _, b := range r.branches {
		if b.test(t) {
			return true
		}
	}
	return false
}

// handWritten holds patterns by source: the one with lookaround, and one
// whose lazy `[\s\S]+?` would run on to the end from every SELECT.
var handWritten = map[string]func(t *codeIndex) bool{
	`^[+-](?![+-])`:              diffLine,
	`\bSELECT\b[\s\S]+?\bFROM\b`: selectFrom,
}

// diffLine is `/^[+-](?![+-])/m`: a line starting with one + or -.
func diffLine(t *codeIndex) bool {
	s := t.s
	for i := 0; i >= 0; i = t.nextLine(t.lineEnd(i)) {
		if i < len(s) && (s[i] == '+' || s[i] == '-') && (i+1 == len(s) || (s[i+1] != '+' && s[i+1] != '-')) {
			return true
		}
	}
	return false
}

// selectFrom is `/\bSELECT\b[\s\S]+?\bFROM\b/i`: a FROM at least a character
// after a SELECT; the first SELECT leaves the most room.
func selectFrom(t *codeIndex) bool {
	s, first := t.s, -1
	word := func(q, n int) bool { return wordBoundary(s, q) && wordBoundary(s, q+n) }
	if !t.mayContain(selectWord) || !t.mayContain(fromWord) || !t.each(selectWord, true, func(q int) bool {
		first = q
		return word(q, len("select"))
	}) {
		return false
	}
	return t.each(fromWord, true, func(q int) bool { return q > first+len("select") && word(q, len("from")) })
}

var selectWord, fromWord = newRuleLiteral("select"), newRuleLiteral("from")

type anchorKind uint8

const (
	anchorNone anchorKind = iota // the match starts anywhere
	anchorText                   // `^` without `m`: at the start
	anchorLine                   // `^` with `m`: at a line start
)

type indentKind uint8

const (
	indentNone  indentKind = iota
	indentSpace            // `[^\S\n\r\u2028\u2029]*`
	indentTab              // `[ \t]*`
)

const (
	spaceIndent = `[^\S\n\r\u2028\u2029]*`
	tabIndent   = `[ \t]*`
)

// ruleBranch is one top-level alternative of a rule's pattern.
type ruleBranch struct {
	source string
	anchor anchorKind
	indent indentKind
	// wordStart: the branch starts with `\b`, checked here (re lacks it).
	wordStart bool
	// fold: `i`; literals are lowercase and match the lowercased code.
	fold bool
	// starts are the literals searched for. A match starts at one, after the
	// anchor and the indentation, or where back, walked back over from it,
	// begins.
	starts []branchStart
	back   []seqItem
	// firstLine: for line branches without starts, a literal on every match's
	// first line; with firstLineNL, on its first `\n` line, so it serves code
	// without other breaks.
	firstLine   *ruleLiteral
	firstLineNL bool
	// need: literals every match contains.
	need []*ruleLiteral
	// local: no match spans a line break (localNL: a `\n`), so re runs on the
	// line alone.
	local, localNL bool
	// last: a character class a match ending at a line end ends with,
	// before trailing characters of trail; checked before re runs.
	trail, last []rune
	// re is anchored at the match start; full, unanchored, serves branches
	// without literals to start from.
	re   *regexp.Regexp
	full *regexp.Regexp
}

// branchStart is a literal to search for and what can follow it in a match.
type branchStart struct {
	lit  *ruleLiteral
	alts []startAlt
}

// startAlt: in some matches seq follows lit. When direct, seq is the whole
// rest of the match, checked without re; else only what every such match
// starts with, checked before re runs.
type startAlt struct {
	seq    []seqItem
	direct bool
}

type ruleLiteral struct {
	s     string
	pairs []uint16
}

func newRuleLiteral(s string) *ruleLiteral {
	l := &ruleLiteral{s: s}
	for i := 1; i < len(s); i++ {
		l.pairs = append(l.pairs, uint16(lowerByte[s[i-1]])<<8|uint16(lowerByte[s[i]]))
	}
	return l
}

func (b *ruleBranch) test(t *codeIndex) bool {
	for _, l := range b.need {
		if !t.mayContain(l) {
			return false
		}
	}
	s := t.s
	switch {
	case b.anchor == anchorText:
		return b.verify(t, 0, -1)
	case b.starts != nil:
		heads := b.anchor == anchorLine && b.back == nil && b.indent != indentTab
		for i := range b.starts {
			st := &b.starts[i]
			if heads {
				// Only line heads can hold the literal.
				if !t.mayContain(st.lit) {
					continue
				}
				k := min(int(b.indent), 1)
				for p := t.lineHeads()[k][lowerByte[st.lit.s[0]]]; p != 0; p = t.headNext[k][p-1] {
					h := &t.lines[p-1]
					if q := int(h.head[k]); hasPrefix(s[q:], st.lit.s, b.fold) && b.candidate(t, st, int(h.start), q) {
						return true
					}
				}
				continue
			}
			if t.each(st.lit, b.fold, func(q int) bool {
				start := b.start(t, s, q)
				return start >= 0 && b.candidate(t, st, start, q)
			}) {
				return true
			}
		}
		return false
	case b.anchor == anchorLine:
		first := b.firstLine != nil && (!b.firstLineNL || !t.breaks)
		if first && b.last == nil {
			next := 0
			return t.each(b.firstLine, b.fold, func(q int) bool {
				if q < next {
					return false
				}
				next = t.lineEnd(q) + 1
				return b.verify(t, t.lineStart(q), -1)
			})
		}
		// Every line, the cheap tests first.
		for i, e := 0, 0; i >= 0; i = t.nextLine(e) {
			e = t.lineEnd(i)
			if first && !strings.Contains(s[i:e], b.firstLine.s) {
				continue
			}
			if b.verify(t, i, e) {
				return true
			}
		}
		return false
	}
	return b.full.MatchString(t.s)
}

// candidate tests for a match starting at start with st's literal at q.
func (b *ruleBranch) candidate(t *codeIndex, st *branchStart, start, q int) bool {
	after := q + len(st.lit.s)
	maybe := false
	for i := range st.alts {
		a := &st.alts[i]
		if matchSeq(t.s, after, a.seq, b.fold) {
			if a.direct {
				return true
			}
			maybe = true
		}
	}
	return maybe && b.verify(t, start, -1)
}

// start is where a match with a literal at q starts, or -1 when none can.
func (b *ruleBranch) start(t *codeIndex, s string, q int) int {
	start := q
	if b.back != nil {
		if start = walkBack(s, q, b.back); start < 0 {
			return -1
		}
	}
	switch {
	case b.anchor == anchorLine:
		return t.indentStart(start, b.indent)
	case b.wordStart && !wordBoundary(s, start):
		return -1
	}
	return start
}

// walkBack takes the items backwards from i, each as many characters as it
// can: the start of the only match that can end them at i, or -1.
func walkBack(s string, i int, items []seqItem) int {
	for k := len(items) - 1; k >= 0; k-- {
		it := &items[k]
		n := 0
		for (it.max < 0 || n < it.max) && i > 0 {
			r, size := rune(s[i-1]), 1
			if r >= 0x80 {
				r, size = utf8.DecodeLastRuneInString(s[:i])
			}
			if !it.has(r) {
				break
			}
			i -= size
			n++
		}
		if n < it.min {
			return -1
		}
	}
	return i
}

// verify runs re at start, on the line alone when no match leaves it (e,
// when not -1, is the line end).
func (b *ruleBranch) verify(t *codeIndex, start, e int) bool {
	end := len(t.s)
	if b.local || (b.localNL && !t.breaks) {
		if end = e; e < 0 {
			end = t.lineEnd(start)
		}
		if b.last != nil && !b.endsWell(t.s[start:end]) {
			return false
		}
	}
	return b.re.MatchString(t.s[start:end])
}

// endsWell: the line's last character before trailing trail ones is in last.
func (b *ruleBranch) endsWell(line string) bool {
	for line != "" {
		r, size := utf8.DecodeLastRuneInString(line)
		if !inClass(b.trail, r) {
			return inClass(b.last, r)
		}
		line = line[:len(line)-size]
	}
	return true
}

func compileRule(src ruleSource) *detectRule {
	r := &detectRule{weight: src.weight}
	if m, ok := handWritten[src.source]; ok {
		r.match = m
		return r
	}
	multiline := strings.Contains(src.flags, "m")
	fold := strings.Contains(src.flags, "i")
	for _, f := range src.flags {
		if f != 'm' && f != 'i' {
			panic("languages: flag " + string(f))
		}
	}
	for _, alt := range splitAlternatives(src.source) {
		r.branches = append(r.branches, compileBranch(alt, multiline, fold))
	}
	return r
}

// splitAlternatives splits a JavaScript pattern at its top-level `|`.
func splitAlternatives(source string) []string {
	var out []string
	depth, from, inClass := 0, 0, false
	for i := 0; i < len(source); i++ {
		switch c := source[i]; {
		case c == '\\':
			i++
		case inClass:
			inClass = c != ']'
		case c == '[':
			inClass = true
		case c == '(':
			depth++
		case c == ')':
			depth--
		case c == '|' && depth == 0:
			out = append(out, source[from:i])
			from = i + 1
		}
	}
	return append(out, source[from:])
}

// escaped: the character at i follows an odd run of backslashes.
func escaped(s string, i int) bool {
	n := 0
	for j := i - 1; j >= 0 && s[j] == '\\'; j-- {
		n++
	}
	return n%2 == 1
}

func compileBranch(source string, multiline, fold bool) *ruleBranch {
	b := &ruleBranch{source: source, fold: fold}
	body := source
	if strings.HasPrefix(body, "^") {
		body = body[1:]
		b.anchor = anchorText
		if multiline {
			b.anchor = anchorLine
		}
	}
	end := ""
	var endItem *seqItem
	if strings.HasSuffix(body, "$") && !escaped(body, len(body)-1) {
		body = body[:len(body)-1]
		if multiline {
			// A final `\s*$` reaches a line end exactly when whitespace short
			// of a line break does, and then no match spans a break.
			if strings.HasSuffix(body, `\s*`) && !escaped(body, len(body)-3) {
				body = body[:len(body)-3] + spaceIndent
			}
			end = `(?:$|[\n\r\u2028\u2029])`
			endItem = &seqItem{kind: seqLineEnd}
		} else {
			end = "$"
			endItem = &seqItem{kind: seqTextEnd}
		}
	}
	if b.anchor == anchorNone && strings.HasPrefix(body, `\b`) {
		b.wordStart = true
		body = body[2:]
	}
	rest := body
	if b.anchor == anchorLine {
		if strings.HasPrefix(body, spaceIndent) {
			b.indent, rest = indentSpace, body[len(spaceIndent):]
		} else if strings.HasPrefix(body, tabIndent) {
			b.indent, rest = indentTab, body[len(tabIndent):]
		}
	}
	matched := body
	if fold {
		matched = foldASCII(body)
	}
	b.re = jsRegexp("^(?:"+matched+")"+end, "")

	tree := parseJS(rest)
	checkNoAnchors(tree, source)
	elems := elements(tree)
	b.local = !matchesAny(tree, breakRunes) && end != "$"
	b.localNL = !matchesAny(tree, []rune{'\n'}) && end != "$"
	if endItem != nil && endItem.kind == seqLineEnd && !fold {
		b.trail, b.last = lineEndClasses(elems)
	}
	lit := func(s string) *ruleLiteral {
		if fold {
			s = asciiLower(s)
		}
		return newRuleLiteral(s)
	}
	for _, s := range mandatoryLiterals(elems) {
		b.need = append(b.need, lit(s))
	}

	// What to search for: the literals the matches start with, or those after
	// leading classes walked back over, whichever has the longest shortest
	// literal (the fewest occurrences to try).
	best := 0
	for k := 0; k < len(elems); k++ {
		var back []seqItem
		if k > 0 {
			var ok bool
			if back, ok = b.backItems(elems[:k]); !ok {
				break
			}
		}
		if starts, score := b.startsFrom(elems[k:], endItem, k > 0, lit); score > best {
			best, b.starts, b.back = score, starts, back
		}
	}
	// A literal in every start literal needs no check of its own.
	need := b.need[:0]
	for _, l := range b.need {
		implied := b.starts != nil
		for _, st := range b.starts {
			implied = implied && strings.Contains(st.lit.s, l.s)
		}
		if !implied {
			need = append(need, l)
		}
	}
	b.need = need
	switch {
	case b.starts != nil || b.anchor == anchorText:
	case b.anchor == anchorLine:
		if s := firstLineLiteral(elems, breakRunes); s != "" {
			b.firstLine = lit(s)
		} else if s := firstLineLiteral(elems, []rune{'\n'}); s != "" {
			b.firstLine, b.firstLineNL = lit(s), true
		}
	default:
		prefix := ""
		if b.wordStart {
			prefix = `\b`
		}
		b.full = jsRegexp(prefix+matched+end, "")
	}
	return b
}

// startsFrom: the starts for matches of elems, with alternations and
// optional groups multiplied out, and the length of the shortest literal (0:
// none). Whitespace alone is everywhere, not worth searching for; and
// without back items, indentStart must find a literal's indentation whole.
func (b *ruleBranch) startsFrom(elems []*syntax.Regexp, end *seqItem, back bool, lit func(string) *ruleLiteral) ([]branchStart, int) {
	var starts []branchStart
	index := map[string]int{}
	shortest := 0
	for _, alt := range alternatives(elems) {
		n, lits, exact := startLiterals(alt)
		if lits == nil {
			return nil, 0
		}
		var a startAlt
		if exact {
			if a.seq, a.direct = sequence(alt[n:], end, b.fold); !a.direct {
				a.seq = necessary(alt[n:], b.fold)
			}
		}
		for _, s := range lits {
			if r, _ := utf8.DecodeRuneInString(s); isBlank(s) || (!back && b.indent != indentNone && isJSSpace(r)) {
				return nil, 0
			}
			k, ok := index[s]
			if !ok {
				k = len(starts)
				index[s] = k
				starts = append(starts, branchStart{lit: lit(s)})
			}
			starts[k].alts = append(starts[k].alts, a)
			if shortest == 0 || len(s) < shortest {
				shortest = len(s)
			}
		}
	}
	return starts, shortest
}

// necessary is the longest leading part of elems that sequence can check on
// its own: every match of elems starts with a match of it.
func necessary(elems []*syntax.Regexp, fold bool) []seqItem {
	for m := len(elems); m > 0; m-- {
		if items, ok := sequence(elems[:m], nil, fold); ok {
			return items
		}
	}
	return nil
}

// maxAlternatives bounds how far alternatives multiplies a sequence out.
const maxAlternatives = 16

// alternatives are sequences, one of which matches where elems does: groups
// flattened, alternations, optional and repeated groups (none, or one and
// the repeat) multiplied out while there are at most maxAlternatives.
func alternatives(elems []*syntax.Regexp) [][]*syntax.Regexp {
	out := [][]*syntax.Regexp{nil}
	var add func(re *syntax.Regexp)
	add = func(re *syntax.Regexp) {
		var choices [][]*syntax.Regexp
		switch re.Op {
		case syntax.OpCapture:
			add(re.Sub[0])
			return
		case syntax.OpConcat:
			for _, sub := range re.Sub {
				add(sub)
			}
			return
		case syntax.OpAlternate:
			for _, sub := range re.Sub {
				choices = append(choices, alternatives([]*syntax.Regexp{sub})...)
			}
		case syntax.OpQuest:
			if classRepeat(re) == nil {
				choices = append(alternatives(re.Sub[:1]), nil)
			}
		case syntax.OpStar:
			// No iteration, or one and then the rest.
			if classRepeat(re) == nil {
				for _, one := range alternatives(re.Sub[:1]) {
					choices = append(choices, append(one, re))
				}
				choices = append(choices, nil)
			}
		}
		if len(choices) == 0 || len(out)*len(choices) > maxAlternatives {
			for i := range out {
				out[i] = append(out[i], re)
			}
			return
		}
		next := make([][]*syntax.Regexp, 0, len(out)*len(choices))
		for _, prefix := range out {
			for _, choice := range choices {
				next = append(next, append(append([]*syntax.Regexp{}, prefix...), choice...))
			}
		}
		out = next
	}
	for _, re := range elems {
		add(re)
	}
	return out
}

// startLiterals: literals every match of elems starts with, exactly what
// the first n elements match (exact) or else any prefixes; nil when unknown.
func startLiterals(elems []*syntax.Regexp) (n int, lits []string, exact bool) {
	lead := []string{""}
	for ; n < len(elems); n++ {
		l, ok := literals(elems[n])
		if !ok {
			break
		}
		c := cross(lead, l)
		if c == nil {
			break
		}
		lead = c
	}
	if n > 0 && !containsEmpty(lead) {
		return n, lead, true
	}
	if p, ok := prefixes(elems); ok && !containsEmpty(p) {
		return 0, p, false
	}
	return 0, nil, false
}

// backItems are elems (classes, repeated or not, and literals) as walkBack
// takes them, when that finds the only start: a repeat's class is disjoint
// from those its characters could otherwise belong to, up to the match
// start, where the first repeat must stop by itself (at a line start or a
// word boundary).
func (b *ruleBranch) backItems(elems []*syntax.Regexp) ([]seqItem, bool) {
	var items []seqItem
	for _, e := range elems {
		if it := classRepeat(e); it != nil {
			items = append(items, *it)
		} else if e.Op == syntax.OpLiteral && e.Flags&syntax.FoldCase == 0 {
			for _, r := range e.Rune {
				items = append(items, classItem([]rune{r, r}, 1, 1))
			}
		} else {
			return nil, false
		}
	}
	for k := range items {
		it := &items[k]
		if b.fold && classHasLetter(it.ranges) {
			return nil, false
		}
		if it.min == it.max {
			continue
		}
		j := k - 1
		for ; j >= 0; j-- {
			if overlaps(it.ranges, items[j].ranges) {
				return nil, false
			}
			if items[j].min > 0 {
				break
			}
		}
		if j >= 0 {
			continue
		}
		switch {
		case b.anchor == anchorLine:
			for _, r := range breakRunes {
				if it.has(r) {
					return nil, false
				}
			}
			if b.indent != indentNone && overlaps(it.ranges, indentRanges[b.indent]) {
				return nil, false
			}
		case b.wordStart:
			// Word characters only: the run stops at the boundary.
			for i := 0; i < len(it.ranges); i += 2 {
				for r := it.ranges[i]; r <= it.ranges[i+1]; r++ {
					if r >= 0x80 || !isWordByte(byte(r)) {
						return nil, false
					}
				}
			}
		}
	}
	return items, true
}

// classRepeat is re as a seqItem when it is a class or a repeated class.
func classRepeat(re *syntax.Regexp) *seqItem {
	min, max := 1, 1
	sub := re
	switch re.Op {
	case syntax.OpStar, syntax.OpPlus, syntax.OpQuest, syntax.OpRepeat:
		sub = re.Sub[0]
		min, max = 0, -1
		switch re.Op {
		case syntax.OpPlus:
			min = 1
		case syntax.OpQuest:
			max = 1
		case syntax.OpRepeat:
			min, max = re.Min, re.Max
		}
	}
	var ranges []rune
	switch {
	case sub.Op == syntax.OpCharClass:
		ranges = sub.Rune
	case sub.Op == syntax.OpLiteral && len(sub.Rune) == 1 && sub.Flags&syntax.FoldCase == 0 && sub != re:
		ranges = []rune{sub.Rune[0], sub.Rune[0]}
	default:
		return nil
	}
	it := classItem(ranges, min, max)
	return &it
}

// lineEndClasses: for elems that end a match at a line end, the class of
// a final repeat (trail) and the class of what comes before it (last), when
// the two are disjoint, so the line's last character outside trail is in last.
func lineEndClasses(elems []*syntax.Regexp) (trail, last []rune) {
	if n := len(elems); n > 0 && elems[n-1].Op == syntax.OpStar {
		if sub := elems[n-1].Sub[0]; sub.Op == syntax.OpCharClass && !matchesAny(sub, breakRunes) {
			trail, elems = sub.Rune, elems[:n-1]
		}
	}
	last, ok := lastClass(elems)
	if !ok || overlaps(last, trail) || matchesAny(&syntax.Regexp{Op: syntax.OpCharClass, Rune: last}, breakRunes) {
		return nil, nil
	}
	return trail, last
}

// lastClass is the class of the last character of every match of seq.
func lastClass(seq []*syntax.Regexp) ([]rune, bool) {
	if len(seq) == 0 {
		return nil, false
	}
	re, rest := seq[len(seq)-1], seq[:len(seq)-1:len(seq)-1]
	switch re.Op {
	case syntax.OpLiteral:
		if re.Flags&syntax.FoldCase != 0 {
			return nil, false
		}
		r := re.Rune[len(re.Rune)-1]
		return []rune{r, r}, true
	case syntax.OpCharClass:
		return re.Rune, true
	case syntax.OpCapture, syntax.OpPlus:
		return lastClass(append(rest, re.Sub[0]))
	case syntax.OpConcat:
		return lastClass(append(rest, re.Sub...))
	case syntax.OpRepeat:
		if re.Min > 0 {
			return lastClass(append(rest, re.Sub[0]))
		}
		return lastClass(append(rest, &syntax.Regexp{Op: syntax.OpStar, Sub: re.Sub}))
	case syntax.OpAlternate, syntax.OpStar, syntax.OpQuest:
		subs := re.Sub
		if re.Op != syntax.OpAlternate {
			subs = re.Sub[:1]
		}
		var out []rune
		for _, sub := range subs {
			c, ok := lastClass(append(rest, sub))
			if !ok {
				return nil, false
			}
			out = unionRanges(out, c)
		}
		if re.Op != syntax.OpAlternate {
			c, ok := lastClass(rest)
			if !ok {
				return nil, false
			}
			out = unionRanges(out, c)
		}
		return out, true
	}
	return nil, false
}

// unionRanges merges two sorted lists of rune ranges.
func unionRanges(a, b []rune) []rune {
	all := append(append([]rune{}, a...), b...)
	var pairs [][2]rune
	for i := 0; i < len(all); i += 2 {
		pairs = append(pairs, [2]rune{all[i], all[i+1]})
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i][0] < pairs[j][0] })
	var out []rune
	for _, p := range pairs {
		if n := len(out); n > 0 && p[0] <= out[n-1]+1 {
			out[n-1] = max(out[n-1], p[1])
			continue
		}
		out = append(out, p[0], p[1])
	}
	return out
}

// firstLineLiteral is the longest literal every match has before its first
// character in stops.
func firstLineLiteral(elems []*syntax.Regexp, stops []rune) string {
	best := ""
	for _, e := range elems {
		if matchesAny(e, stops) {
			break
		}
		for _, s := range mandatoryLiterals([]*syntax.Regexp{e}) {
			if len(s) > len(best) {
				best = s
			}
		}
	}
	return best
}

var breakRunes = []rune{'\n', '\r', 0x2028, 0x2029}

// indentRanges are the classes of the indentation kinds.
var indentRanges = [...][]rune{
	indentSpace: parseJS(spaceIndent).Sub[0].Rune,
	indentTab:   parseJS(tabIndent).Sub[0].Rune,
}

// parseJS parses the RE2 translation of a JavaScript pattern.
func parseJS(source string) *syntax.Regexp {
	re, err := syntax.Parse(translateJS(source, ""), syntax.Perl)
	if err != nil {
		panic("languages: " + err.Error())
	}
	return re
}

// elements are the parts of a concatenation, or re alone.
func elements(re *syntax.Regexp) []*syntax.Regexp {
	if re.Op == syntax.OpConcat {
		return re.Sub
	}
	return []*syntax.Regexp{re}
}

// checkNoAnchors: `^` and `$` only at the ends, where compileBranch takes them.
func checkNoAnchors(re *syntax.Regexp, source string) {
	switch re.Op {
	case syntax.OpBeginLine, syntax.OpEndLine, syntax.OpBeginText, syntax.OpEndText:
		panic("languages: anchor inside " + source)
	}
	for _, sub := range re.Sub {
		checkNoAnchors(sub, source)
	}
}

// matchesAny: re can match one of runes.
func matchesAny(re *syntax.Regexp, runes []rune) bool {
	switch re.Op {
	case syntax.OpLiteral:
		for _, r := range re.Rune {
			for _, x := range runes {
				if r == x {
					return true
				}
			}
		}
	case syntax.OpCharClass:
		for _, r := range runes {
			if inClass(re.Rune, r) {
				return true
			}
		}
	case syntax.OpAnyChar, syntax.OpAnyCharNotNL:
		return true
	}
	for _, sub := range re.Sub {
		if matchesAny(sub, runes) {
			return true
		}
	}
	return false
}

func inClass(ranges []rune, r rune) bool {
	for i := 0; i < len(ranges); i += 2 {
		if r < ranges[i] {
			return false
		}
		if r <= ranges[i+1] {
			return true
		}
	}
	return false
}

// maxLiterals bounds the literal sets derived from a pattern.
const maxLiterals = 64

// literals is the finite set of strings re matches, when it is a small one.
func literals(re *syntax.Regexp) ([]string, bool) {
	switch re.Op {
	case syntax.OpLiteral:
		if re.Flags&syntax.FoldCase != 0 {
			return nil, false
		}
		return []string{string(re.Rune)}, true
	case syntax.OpCharClass:
		var out []string
		for i := 0; i < len(re.Rune); i += 2 {
			for r := re.Rune[i]; r <= re.Rune[i+1]; r++ {
				if len(out) == 8 {
					return nil, false
				}
				out = append(out, string(r))
			}
		}
		return out, true
	case syntax.OpEmptyMatch:
		return []string{""}, true
	case syntax.OpCapture:
		return literals(re.Sub[0])
	case syntax.OpQuest:
		l, ok := literals(re.Sub[0])
		return union([]string{""}, l), ok
	case syntax.OpConcat:
		out := []string{""}
		for _, sub := range re.Sub {
			l, ok := literals(sub)
			if !ok {
				return nil, false
			}
			if out = cross(out, l); out == nil {
				return nil, false
			}
		}
		return out, true
	case syntax.OpAlternate:
		var out []string
		for _, sub := range re.Sub {
			l, ok := literals(sub)
			if !ok {
				return nil, false
			}
			out = union(out, l)
		}
		return out, len(out) <= maxLiterals
	}
	return nil, false
}

// prefixes is a set of strings one of which every match of the sequence
// starts with.
func prefixes(seq []*syntax.Regexp) ([]string, bool) {
	if len(seq) == 0 {
		return []string{""}, true
	}
	re, rest := seq[0], seq[1:]
	with := func(head ...*syntax.Regexp) []*syntax.Regexp {
		return append(head, rest...)
	}
	switch re.Op {
	case syntax.OpWordBoundary, syntax.OpNoWordBoundary, syntax.OpEmptyMatch:
		return prefixes(rest)
	case syntax.OpCapture:
		return prefixes(with(re.Sub[0]))
	case syntax.OpConcat:
		return prefixes(with(re.Sub...))
	case syntax.OpAlternate:
		var out []string
		for _, sub := range re.Sub {
			p, ok := prefixes(with(sub))
			if !ok {
				return nil, false
			}
			out = union(out, p)
		}
		return out, len(out) <= maxLiterals
	case syntax.OpLiteral, syntax.OpCharClass:
		l, ok := literals(re)
		if !ok {
			return nil, false
		}
		if p, ok := prefixes(rest); ok {
			if c := cross(l, p); c != nil {
				return c, true
			}
		}
		return l, true
	case syntax.OpStar, syntax.OpQuest:
		p, ok := prefixes(re.Sub[:1])
		if !ok {
			return nil, false
		}
		q, ok := prefixes(rest)
		out := union(p, q)
		return out, ok && len(out) <= maxLiterals
	case syntax.OpPlus:
		return prefixes(re.Sub[:1])
	case syntax.OpRepeat:
		if re.Min == 0 {
			return prefixes(with(&syntax.Regexp{Op: syntax.OpStar, Sub: re.Sub}))
		}
		return prefixes(re.Sub[:1])
	}
	return nil, false
}

// mandatoryLiterals are literals every match of the sequence contains.
func mandatoryLiterals(seq []*syntax.Regexp) []string {
	var out []string
	for _, re := range seq {
		switch re.Op {
		case syntax.OpLiteral:
			if re.Flags&syntax.FoldCase == 0 {
				out = append(out, string(re.Rune))
			}
		case syntax.OpConcat:
			out = append(out, mandatoryLiterals(re.Sub)...)
		case syntax.OpCapture, syntax.OpPlus:
			out = append(out, mandatoryLiterals(re.Sub)...)
		case syntax.OpRepeat:
			if re.Min > 0 {
				out = append(out, mandatoryLiterals(re.Sub)...)
			}
		}
	}
	return out
}

func cross(a, b []string) []string {
	if len(a)*len(b) > maxLiterals {
		return nil
	}
	out := make([]string, 0, len(a)*len(b))
	for _, x := range a {
		for _, y := range b {
			out = union(out, []string{x + y})
		}
	}
	return out
}

func union(a, b []string) []string {
	for _, s := range b {
		found := false
		for _, t := range a {
			if s == t {
				found = true
				break
			}
		}
		if !found {
			a = append(a, s)
		}
	}
	return a
}

// ------------------------------------------------------------------ sequences

type seqKind uint8

const (
	seqLiteral seqKind = iota
	seqClass
	seqWordBoundary
	seqLineEnd // `$` with `m`
	seqTextEnd // `$`
)

// seqItem is one element of a plain sequence: a literal, a character class
// repeated min to max times (max -1: unbounded), `\b`, or an end.
type seqItem struct {
	kind     seqKind
	lit      string
	ranges   []rune
	ascii    [2]uint64
	min, max int
}

func (it *seqItem) has(r rune) bool {
	if r < 0x80 {
		return it.ascii[r>>6]&(1<<(r&63)) != 0
	}
	return inClass(it.ranges, r)
}

// sequence turns elems (and the end, if any) into seqItems, when they form a
// plain sequence a single greedy pass decides: every repeated class is
// disjoint from what can follow it, so it takes all it can. Repeats at the
// very end only need their minimum.
func sequence(elems []*syntax.Regexp, end *seqItem, fold bool) ([]seqItem, bool) {
	var items []seqItem
	var flatten func(re *syntax.Regexp) bool
	flatten = func(re *syntax.Regexp) bool {
		switch re.Op {
		case syntax.OpConcat:
			for _, sub := range re.Sub {
				if !flatten(sub) {
					return false
				}
			}
			return true
		case syntax.OpCapture:
			return flatten(re.Sub[0])
		case syntax.OpLiteral:
			if re.Flags&syntax.FoldCase != 0 {
				return false
			}
			s := string(re.Rune)
			if fold {
				s = asciiLower(s)
			}
			items = append(items, seqItem{kind: seqLiteral, lit: s})
			return true
		case syntax.OpCharClass:
			items = append(items, classItem(re.Rune, 1, 1))
			return true
		case syntax.OpWordBoundary:
			items = append(items, seqItem{kind: seqWordBoundary})
			return true
		case syntax.OpStar, syntax.OpPlus, syntax.OpQuest, syntax.OpRepeat:
			sub := re.Sub[0]
			var ranges []rune
			switch {
			case sub.Op == syntax.OpCharClass:
				ranges = sub.Rune
			case sub.Op == syntax.OpLiteral && len(sub.Rune) == 1 && sub.Flags&syntax.FoldCase == 0:
				ranges = []rune{sub.Rune[0], sub.Rune[0]}
			default:
				return false
			}
			min, max := 0, -1
			switch re.Op {
			case syntax.OpPlus:
				min = 1
			case syntax.OpQuest:
				max = 1
			case syntax.OpRepeat:
				min, max = re.Min, re.Max
			}
			items = append(items, classItem(ranges, min, max))
			return true
		}
		return false
	}
	for _, re := range elems {
		if !flatten(re) {
			return nil, false
		}
	}
	if end != nil {
		items = append(items, *end)
	} else {
		// Nothing follows a final repeat: its minimum is enough.
		for len(items) > 0 && items[len(items)-1].kind == seqClass && items[len(items)-1].min == 0 {
			items = items[:len(items)-1]
		}
		if n := len(items); n > 0 && items[n-1].kind == seqClass {
			items[n-1].max = items[n-1].min
		}
	}
	for i := range items {
		it := &items[i]
		if it.kind != seqClass || it.min == it.max {
			continue
		}
		if fold && classHasLetter(it.ranges) {
			return nil, false
		}
		// What can follow the repeat must not start with a character it takes.
	follow:
		for j := i + 1; j < len(items); j++ {
			next := &items[j]
			switch next.kind {
			case seqLiteral:
				r, _ := utf8.DecodeRuneInString(next.lit)
				if it.has(r) {
					return nil, false
				}
				break follow
			case seqClass:
				if overlaps(it.ranges, next.ranges) {
					return nil, false
				}
				if next.min > 0 {
					break follow
				}
			case seqLineEnd:
				for _, r := range []rune{'\n', '\r', 0x2028, 0x2029} {
					if it.has(r) {
						return nil, false
					}
				}
				break follow
			case seqTextEnd:
				break follow
			default:
				return nil, false
			}
		}
	}
	for i := range items {
		if it := &items[i]; it.kind == seqClass && fold && classHasLetter(it.ranges) {
			return nil, false
		}
	}
	return items, true
}

func classItem(ranges []rune, min, max int) seqItem {
	it := seqItem{kind: seqClass, ranges: ranges, min: min, max: max}
	for r := rune(0); r < 0x80; r++ {
		if inClass(ranges, r) {
			it.ascii[r>>6] |= 1 << (r & 63)
		}
	}
	return it
}

// classHasLetter: the class tells an ASCII letter from its other case, which
// the lowercased text would not.
func classHasLetter(ranges []rune) bool {
	for c := 'a'; c <= 'z'; c++ {
		if inClass(ranges, c) != inClass(ranges, c-32) {
			return true
		}
	}
	return false
}

func overlaps(a, b []rune) bool {
	for i := 0; i < len(a); i += 2 {
		for j := 0; j < len(b); j += 2 {
			if a[i] <= b[j+1] && b[j] <= a[i+1] {
				return true
			}
		}
	}
	return false
}

// matchSeq tests the sequence at i (fold: ASCII case-insensitively; the
// classes of such a sequence are closed under case).
func matchSeq(s string, i int, items []seqItem, fold bool) bool {
	for k := range items {
		it := &items[k]
		switch it.kind {
		case seqLiteral:
			if !hasPrefix(s[i:], it.lit, fold) {
				return false
			}
			i += len(it.lit)
		case seqClass:
			n := 0
			for (it.max < 0 || n < it.max) && i < len(s) {
				r, size := rune(s[i]), 1
				if r >= 0x80 {
					r, size = utf8.DecodeRuneInString(s[i:])
				}
				if !it.has(r) {
					break
				}
				i += size
				n++
			}
			if n < it.min {
				return false
			}
		case seqWordBoundary:
			if !wordBoundary(s, i) {
				return false
			}
		case seqLineEnd:
			if i < len(s) && !breakAt(s, i) {
				return false
			}
		case seqTextEnd:
			if i != len(s) {
				return false
			}
		}
	}
	return true
}

// foldASCII rewrites a pattern for the `i` flag as JavaScript reads it without
// `u`: an ASCII letter matches its other case, and nothing else does. (RE2's
// `(?i)` folds with Unicode: `s` would match `ſ` and `k` the Kelvin sign.)
// Letters inside classes are not needed and not supported.
func foldASCII(source string) string {
	var out strings.Builder
	inClass := false
	for i := 0; i < len(source); i++ {
		c := source[i]
		switch {
		case c == '\\':
			n := 2
			switch source[i+1] {
			case 'u':
				n = 6
			case 'x':
				n = 4
			}
			out.WriteString(source[i : i+n])
			i += n - 1
		case inClass:
			if (c|0x20) >= 'a' && (c|0x20) <= 'z' {
				panic("foldASCII: letter in a class in " + source)
			}
			inClass = c != ']'
			out.WriteByte(c)
		case c == '[':
			inClass = true
			out.WriteByte(c)
		case (c|0x20) >= 'a' && (c|0x20) <= 'z':
			out.WriteString("[" + string(c|0x20) + string(c&^0x20) + "]")
		default:
			out.WriteByte(c)
		}
	}
	return out.String()
}
