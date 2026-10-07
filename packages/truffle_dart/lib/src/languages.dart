/// Code languages (`languages.ts`): normalizing what page markup calls a
/// language, and a fast deterministic detector for unlabelled blocks. Ids are
/// highlight.js names (except `html`, which renderers map to highlight.js
/// `xml`), so both renderers can pass them straight to their highlighter.
library;

import 'dart:convert';

import 'js.dart';
import 'match.dart';

const Map<String, String> _aliases = {
  "js": 'javascript',
  "javascript": 'javascript',
  "jsx": 'javascript',
  "mjs": 'javascript',
  "cjs": 'javascript',
  "node": 'javascript',
  "nodejs": 'javascript',
  "es6": 'javascript',
  "ecmascript": 'javascript',
  "ts": 'typescript',
  "typescript": 'typescript',
  "tsx": 'typescript',
  "mts": 'typescript',
  "cts": 'typescript',
  "py": 'python',
  "python": 'python',
  "python3": 'python',
  "py3": 'python',
  "ipython": 'python',
  "pycon": 'python',
  "python2": 'python',
  "gyp": 'python',
  "sage": 'python',
  "jupyter": 'python',
  "java": 'java',
  "jsp": 'java',
  "kt": 'kotlin',
  "kts": 'kotlin',
  "kotlin": 'kotlin',
  "scala": 'scala',
  "sc": 'scala',
  "sbt": 'scala',
  "swift": 'swift',
  "objc": 'objectivec',
  "obj-c": 'objectivec',
  "objectivec": 'objectivec',
  "objective-c": 'objectivec',
  "mm": 'objectivec',
  "c": 'c',
  "h": 'c',
  "cpp": 'cpp',
  "c++": 'cpp',
  "cc": 'cpp',
  "cxx": 'cpp',
  "hpp": 'cpp',
  "hh": 'cpp',
  "hxx": 'cpp',
  "cplusplus": 'cpp',
  "arduino": 'cpp',
  "ino": 'cpp',
  "cuda": 'cpp',
  "cu": 'cpp',
  "cs": 'csharp',
  "csharp": 'csharp',
  "c#": 'csharp',
  "dotnet": 'csharp',
  "go": 'go',
  "golang": 'go',
  "rs": 'rust',
  "rust": 'rust',
  "rb": 'ruby',
  "ruby": 'ruby',
  "gemspec": 'ruby',
  "podspec": 'ruby',
  "thor": 'ruby',
  "irb": 'ruby',
  "rake": 'ruby',
  "php": 'php',
  "php3": 'php',
  "php4": 'php',
  "php5": 'php',
  "php7": 'php',
  "php8": 'php',
  "pl": 'perl',
  "perl": 'perl',
  "pm": 'perl',
  "lua": 'lua',
  "luau": 'lua',
  "r": 'r',
  "rscript": 'r',
  "jl": 'julia',
  "julia": 'julia',
  "dart": 'dart',
  "flutter": 'dart',
  "ex": 'elixir',
  "exs": 'elixir',
  "elixir": 'elixir',
  "erl": 'erlang',
  "erlang": 'erlang',
  "hs": 'haskell',
  "haskell": 'haskell',
  "clj": 'clojure',
  "cljs": 'clojure',
  "cljc": 'clojure',
  "edn": 'clojure',
  "clojure": 'clojure',
  "ml": 'ocaml',
  "ocaml": 'ocaml',
  "mli": 'ocaml',
  "reason": 'reasonml',
  "re": 'reasonml',
  "reasonml": 'reasonml',
  "fs": 'fsharp',
  "fsharp": 'fsharp',
  "f#": 'fsharp',
  "fsx": 'fsharp',
  "fsi": 'fsharp',
  "zig": 'zig',
  "nim": 'nim',
  "sh": 'bash',
  "bash": 'bash',
  "zsh": 'bash',
  "ksh": 'bash',
  "fish": 'bash',
  "shellscript": 'bash',
  "shell-script": 'bash',
  "shell": 'shell',
  "console": 'shell',
  "terminal": 'shell',
  "shell-session": 'shell',
  "shellsession": 'shell',
  "bash-session": 'shell',
  "sh_session": 'shell',
  "cmd": 'dos',
  "bat": 'dos',
  "batch": 'dos',
  "dos": 'dos',
  "ps": 'powershell',
  "ps1": 'powershell',
  "psm1": 'powershell',
  "pwsh": 'powershell',
  "powershell": 'powershell',
  "sql": 'sql',
  "mysql": 'sql',
  "postgres": 'sql',
  "postgresql": 'sql',
  "psql": 'pgsql',
  "pgsql": 'pgsql',
  "plpgsql": 'pgsql',
  "sqlite": 'sql',
  "plsql": 'sql',
  "tsql": 'sql',
  "mssql": 'sql',
  "mariadb": 'sql',
  "bigquery": 'sql',
  "snowflake": 'sql',
  "hive": 'sql',
  "sparksql": 'sql',
  "html": 'html',
  "xhtml": 'html',
  "htm": 'html',
  "vue": 'html',
  "svelte": 'html',
  "astro": 'html',
  "handlebars": 'html',
  "hbs": 'html',
  "jinja": 'html',
  "jinja2": 'html',
  "django": 'html',
  "liquid": 'html',
  "ejs": 'html',
  "erb": 'erb',
  "razor": 'html',
  "blade": 'html',
  "twig": 'html',
  "xml": 'xml',
  "svg": 'xml',
  "rss": 'xml',
  "atom": 'xml',
  "xsl": 'xml',
  "xslt": 'xml',
  "plist": 'xml',
  "xaml": 'xml',
  "wsdl": 'xml',
  "csproj": 'xml',
  "css": 'css',
  "scss": 'scss',
  "sass": 'scss',
  "less": 'less',
  "stylus": 'stylus',
  "styl": 'stylus',
  "postcss": 'css',
  "json": 'json',
  "jsonc": 'json',
  "json5": 'json',
  "jsonl": 'json',
  "geojson": 'json',
  "webmanifest": 'json',
  "yaml": 'yaml',
  "yml": 'yaml',
  "toml": 'toml',
  "ini": 'ini',
  "cfg": 'ini',
  "conf": 'ini',
  "config": 'ini',
  "properties": 'properties',
  "env": 'bash',
  "dotenv": 'bash',
  "editorconfig": 'ini',
  "gitconfig": 'ini',
  "md": 'markdown',
  "markdown": 'markdown',
  "mdx": 'markdown',
  "mkd": 'markdown',
  "rmd": 'markdown',
  "dockerfile": 'dockerfile',
  "docker": 'dockerfile',
  "containerfile": 'dockerfile',
  "makefile": 'makefile',
  "make": 'makefile',
  "mk": 'makefile',
  "mak": 'makefile',
  "cmake": 'cmake',
  "nginx": 'nginx',
  "nginxconf": 'nginx',
  "apache": 'apache',
  "apacheconf": 'apache',
  "htaccess": 'apache',
  "graphql": 'graphql',
  "gql": 'graphql',
  "proto": 'protobuf',
  "protobuf": 'protobuf',
  "diff": 'diff',
  "patch": 'diff',
  "udiff": 'diff',
  "tex": 'latex',
  "latex": 'latex',
  "katex": 'latex',
  "bibtex": 'latex',
  "matlab": 'matlab',
  "octave": 'matlab',
  "groovy": 'groovy',
  "gradle": 'groovy',
  "jenkinsfile": 'groovy',
  "vb": 'vbnet',
  "vbnet": 'vbnet',
  "vb.net": 'vbnet',
  "vba": 'vbscript',
  "vbs": 'vbscript',
  "vbscript": 'vbscript',
  "asm": 'x86asm',
  "nasm": 'x86asm',
  "x86asm": 'x86asm',
  "assembly": 'x86asm',
  "armasm": 'armasm',
  "arm": 'armasm',
  "mips": 'mipsasm',
  "wasm": 'wasm',
  "wat": 'wasm',
  "sol": 'solidity',
  "solidity": 'solidity',
  "hcl": 'hcl',
  "tf": 'hcl',
  "terraform": 'hcl',
  "nix": 'nix',
  "vim": 'vim',
  "viml": 'vim',
  "vimscript": 'vim',
  "http": 'http',
  "https": 'http',
  "lisp": 'lisp',
  "elisp": 'lisp',
  "emacs": 'lisp',
  "emacs-lisp": 'lisp',
  "commonlisp": 'lisp',
  "scheme": 'scheme',
  "racket": 'scheme',
  "rkt": 'scheme',
  "elm": 'elm',
  "purescript": 'haskell',
  "idris": 'haskell',
  "agda": 'haskell',
  "fortran": 'fortran',
  "f90": 'fortran',
  "f95": 'fortran',
  "cobol": 'cobol',
  "pascal": 'delphi',
  "delphi": 'delphi',
  "ada": 'ada',
  "prolog": 'prolog',
  "coq": 'coq',
  "lean": 'lean',
  "lean4": 'lean',
  "crystal": 'crystal',
  "cr": 'crystal',
  "d": 'd',
  "v": 'v',
  "vala": 'vala',
  "haxe": 'haxe',
  "hx": 'haxe',
  "awk": 'awk',
  "gawk": 'awk',
  "sed": 'bash',
  "tcl": 'tcl',
  "csv": 'plaintext',
  "tsv": 'plaintext',
  "text": 'plaintext',
  "txt": 'plaintext',
  "plain": 'plaintext',
  "plaintext": 'plaintext',
  "none": 'plaintext',
  "nohighlight": 'plaintext',
  "no-highlight": 'plaintext',
  "output": 'plaintext',
  "log": 'plaintext',
  "raw": 'plaintext',
  "ascii": 'plaintext',
  "mermaid": 'plaintext',
  "regex": 'plaintext',
  "regexp": 'plaintext',
};

final _leadingDot = RegExp(r'^\.');

/// Canonical id for a language name from markup, or null when unknown.
String? normalizeLanguage(String? name) {
  if (name == null) return null;
  final key = jsLower(jsTrim(name)).replaceFirst(_leadingDot, '');
  if (key.isEmpty) return null;
  return _aliases[key];
}

final List<RegExp> _classPatterns = [
  RegExp(r'(?:^|\s)(?:language|lang)-([\w#+.-]+)', caseSensitive: false),
  RegExp(r'(?:^|\s)highlight-(?:source-)?([\w#+.-]+)', caseSensitive: false),
  RegExp(r'(?:^|\s)brush:\s*([\w#+.-]+)', caseSensitive: false),
  RegExp(r'(?:^|\s)sourceCode\s+([\w#+.-]+)', caseSensitive: false),
  RegExp(r'(?:^|\s)mw-highlight-lang-([\w#+.-]+)', caseSensitive: false),
  RegExp(r'(?:^|\s)hljs\s+([\w#+.-]+)', caseSensitive: false),
  RegExp(r'(?:^|\s)prettyprint\s+lang-([\w#+.-]+)', caseSensitive: false),
  RegExp(r'(?:^|\s)code-([\w#+-]+)(?:\s|$)', caseSensitive: false),
  RegExp(r'(?:^|\s)syntax-([\w#+-]+)(?:\s|$)', caseSensitive: false),
  RegExp(r'(?:^|\s)([\w#+-]+)-code(?:\s|$)', caseSensitive: false),
];

final _spaceSplit = RegExp(r'\s+');

/// Language named by a class attribute (`language-js`, `brush: py`, ...).
String? languageFromClass(String className) {
  if (className.isEmpty) return null;
  if (_fromClass.containsKey(className)) return _fromClass[className];
  if (_fromClass.length >= 4096) _fromClass.clear();
  return _fromClass[className] = _languageFromClass(className);
}

final _fromClass = <String, String?>{};

String? _languageFromClass(String className) {
  for (final pattern in _classPatterns) {
    final m = pattern.firstMatch(className);
    if (m != null) {
      final lang = normalizeLanguage(m.group(1));
      if (lang != null) return lang;
    }
  }
  // A bare language class (`<code class="python">`, `<pre class="js">`).
  for (final token in jsSplit(className, _spaceSplit)) {
    if (token.length >= 2 && token.length <= 12) {
      final lang = normalizeLanguage(token);
      if (lang != null && lang != 'plaintext' && token != 'text' && token != 'output') return lang;
    }
  }
  return null;
}

/// Weighted evidence per language. A line's indentation is `[^\S\n\r\u2028\u2029]*`, whitespace short of a line
/// break: `^\s*` also runs on across blank lines, so in a long run of them every line start would rescan the rest.
/// For `hasMatch` it is the same rule, as a match can always start at the last line start. Likewise no two
/// neighbouring quantifiers take the same characters (`\s*\w*\s*`, `\s+.+\s+`), which would retry every split of a
/// long run of spaces; the rewritten rules match the same text (a second branch keeps what the old shape matched with
/// spaces alone, as in `let  =`).
final List<(String, List<(RegExp, num)>)> _rules = [
  (
    'python',
    [
      (RegExp(r'^[^\S\n\r\u2028\u2029]*def \w+\s*\(.*\)\s*(->\s*[\w\[\], .]+)?:\s*$', multiLine: true), 4),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*class \w+(\(.*\))?:\s*$', multiLine: true), 4),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*(elif|except|finally|try)\b.*:\s*$', multiLine: true), 3),
      (RegExp(r'\bself\.\w+'), 2),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*from [\w.]+ import \w', multiLine: true), 4),
      (
        RegExp(
          r'^[^\S\n\r\u2028\u2029]*import (numpy|pandas|os|sys|re|json|torch|requests|asyncio|typing)\b',
          multiLine: true,
        ),
        4,
      ),
      (RegExp(r'\b(None|True|False)\b'), 1),
      (RegExp(r'\bprint\('), 1),
      (RegExp(r'__(init|name|main)__'), 4),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*@\w+(\.\w+)*(\(.*\))?\s*$', multiLine: true), 1),
      (RegExp(r'''\bf["'][^"'\n]*\{'''), 2),
      (RegExp(r'^>>> ', multiLine: true), 4),
      (RegExp(r'\blambda \w*:'), 2),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*for \w+(, \w+)* in .+:\s*$', multiLine: true), 3),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*if .+:\s*$', multiLine: true), 1),
      (RegExp(r'\bdef \w+\(self'), 4),
      (RegExp(r'\b(len|range|enumerate|isinstance)\('), 1),
    ],
  ),
  (
    'javascript',
    [
      (RegExp(r'\b(const|let|var)(?:\s+[\w${}\[\],]+(?: +[\w${}\[\],]+)*|\s[^\S ]* )\s*='), 2),
      (RegExp(r'=>'), 1),
      (RegExp(r'\bfunction\s*(?:\*\s*)?(?:[\w$]+\s*)?\('), 2),
      (RegExp(r'\bconsole\.(log|error|warn)\('), 3),
      (RegExp(r'\b(document|window)\.\w+'), 2),
      (RegExp(r'''\brequire\(['"]'''), 3),
      (RegExp(r'\bexport\s+(default|const|function|class|async)\b'), 2),
      (
        RegExp(
          r'''^[^\S\n\r\u2028\u2029]*import(?:\s+\S(?:.*\S)?|\s[\n\r\u2028\u2029]*[^\S\n\r\u2028\u2029])\s+from\s+['"]''',
          multiLine: true,
        ),
        3,
      ),
      (RegExp(r'===|!=='), 2),
      (RegExp(r'\bundefined\b'), 1),
      (RegExp(r'\bawait\b'), 0.5),
      (RegExp(r'\bmodule\.exports\b'), 4),
      (RegExp(r'\.then\('), 1),
      (RegExp(r'\bnew Promise\('), 2),
      (RegExp(r'\$\{[^}]+\}'), 1),
      (RegExp(r'\buse(State|Effect|Ref|Memo|Callback)\('), 3),
      (RegExp(r'<\/?[A-Z]\w*[\s>]'), 1),
      (RegExp(r'\baddEventListener\('), 3),
      (RegExp(r'\bJSON\.(parse|stringify)\('), 2),
    ],
  ),
  (
    'typescript',
    [
      (RegExp(r':\s*(string|number|boolean|any|void|unknown|never|object)(\[\])?\s*[;,)=|{]'), 4),
      (
        RegExp(r'^[^\S\n\r\u2028\u2029]*(export\s+)?interface\s+\w+(<.+>)?\s*(extends [\w<>, ]+)?\{', multiLine: true),
        4,
      ),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*(export\s+)?type\s+\w+(<.+>)?\s*=', multiLine: true), 3),
      (RegExp(r'\bas const\b'), 3),
      (RegExp(r'\b(private|public|protected|readonly)\s+\w+\s*[:;=(]'), 2),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*(export\s+)?enum\s+\w+\s*\{', multiLine: true), 3),
      (RegExp(r'\bimport type\b'), 4),
      (RegExp(r'<\w+(\[\])?>\('), 1),
      (RegExp(r'\):\s*(Promise<|[\w<>\[\]]+\s*\{)'), 3),
      (RegExp(r'\bimplements\s+\w+'), 1),
      (RegExp(r'!\.'), 1),
      (RegExp(r'\bkeyof\b|\btypeof \w+\['), 2),
    ],
  ),
  (
    'java',
    [
      (RegExp(r'\bpublic\s+(static\s+)?(final\s+)?(class|interface|enum|void|record)\b'), 3),
      (RegExp(r'\bSystem\.(out|err)\.print'), 5),
      (RegExp(r'String\[\]\s+args'), 5),
      (RegExp(r'@Override\b'), 3),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*import\s+java(x)?\.[\w.]+;', multiLine: true), 5),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*package\s+[\w.]+;\s*$', multiLine: true), 4),
      (RegExp(r'\bprivate\s+(static\s+)?(final\s+)?[A-Z]\w*(<.*>)?\s+\w+\s*[;=]'), 2),
      (RegExp(r'\bnew\s+[A-Z]\w*(<.*>)?\('), 1),
      (RegExp(r'\bthrows\s+\w+'), 2),
      (RegExp(r'\b(ArrayList|HashMap|List<|Map<)'), 1),
      (RegExp(r';\s*$', multiLine: true), 0.5),
    ],
  ),
  (
    'kotlin',
    [
      (
        RegExp(
          r'^[^\S\n\r\u2028\u2029]*(suspend\s+|private\s+|override\s+|inline\s+)*fun\s+(<.+>\s*)?[\w.]+\(',
          multiLine: true,
        ),
        4,
      ),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*val\s+\w+(\s*:\s*[\w<>?]+)?\s*=', multiLine: true), 2),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*var\s+\w+\s*:\s*\w+', multiLine: true), 2),
      (RegExp(r'\bdata class\b'), 4),
      (RegExp(r'\bcompanion object\b'), 5),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*import\s+(kotlin|kotlinx|androidx)\.', multiLine: true), 5),
      (RegExp(r'\?:|\?\.'), 1),
      (RegExp(r'\bprintln\('), 1),
      (RegExp(r'\bwhen\s*(\(.*\)\s*)?\{'), 2),
      (RegExp(r'\bit\.\w+'), 1),
    ],
  ),
  (
    'swift',
    [
      (
        RegExp(
          r'^[^\S\n\r\u2028\u2029]*(@\w+\s+)*(public\s+|private\s+|static\s+|override\s+)*func\s+\w+(<.+>)?\(',
          multiLine: true,
        ),
        4,
      ),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*import\s+(UIKit|SwiftUI|Foundation|Combine|AppKit)\s*$', multiLine: true), 5),
      (RegExp(r'\b(guard|if)\s+let\b'), 4),
      (RegExp(r'->\s*[\w<>\[\]?]+\s*\{'), 1),
      (RegExp(r'@(State|Published|Binding|ObservedObject|MainActor|escaping)\b'), 4),
      (RegExp(r'\bstruct\s+\w+\s*:\s*View\b'), 5),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*let\s+\w+(\s*:\s*[\w<>\[\]?]+)?\s*=', multiLine: true), 1),
      (RegExp(r'\bvar body: some View\b'), 5),
      (RegExp(r'\bprint\('), 0.5),
    ],
  ),
  (
    'go',
    [
      (RegExp(r'^package\s+\w+\s*$', multiLine: true), 5),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*func\s+(\(\w+\s+\*?\w+\)\s+)?\w+\(', multiLine: true), 4),
      (RegExp(r':='), 2),
      (RegExp(r'\bfmt\.(Print|Sprint|Fprint|Errorf)'), 5),
      (RegExp(r'\bif err != nil\b'), 5),
      (RegExp(r'\bgo func\b|\bchan\s+\w+|\bdefer\s+\w+'), 3),
      (RegExp(r'^import\s+\(\s*$', multiLine: true), 3),
      (RegExp(r'\bstruct\s*\{'), 1),
      (RegExp(r'\[\]\w+\{'), 2),
      (RegExp(r'\bmake\((map|\[\]|chan)'), 3),
    ],
  ),
  (
    'rust',
    [
      (RegExp(r'^[^\S\n\r\u2028\u2029]*(pub(\(crate\))?\s+)?(async\s+)?fn\s+\w+(<.+>)?\(', multiLine: true), 4),
      (RegExp(r'\blet\s+mut\b'), 4),
      (RegExp(r'\b(println|format|vec|panic|assert_eq|write|eprintln)!\('), 4),
      (RegExp(r'\b(println|vec)!\['), 4),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*use\s+(std|crate|super|self|tokio|serde)::', multiLine: true), 5),
      (RegExp(r'#\[(derive|cfg|test|tokio::main)'), 5),
      (RegExp(r'\bimpl(<.+>)?\s+[\w:<>]+(\s+for\s+\w+)?\s*\{'), 3),
      (RegExp(r'&(mut\s+)?(str|self)\b'), 3),
      (RegExp(r'::new\('), 1),
      (RegExp(r'->\s*(Result|Option|Self|impl\s)'), 2),
      (RegExp(r'\bmatch\s+(?:\S.*|[^\S\n\r\u2028\u2029])\{'), 1),
      (RegExp(r'\b(Some|None|Ok|Err)\('), 1),
      (RegExp(r'\bunwrap\(\)'), 3),
    ],
  ),
  (
    'c',
    [
      (RegExp(r'#include\s*<\w+\.h>'), 4),
      (RegExp(r'\bint\s+main\s*\('), 3),
      (RegExp(r'\bprintf\s*\('), 2),
      (RegExp(r'\b(malloc|calloc|free|sizeof|memcpy|strlen)\s*\('), 2),
      (RegExp(r'\bstruct\s+\w+\s*\{'), 1),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*#define\s+\w+', multiLine: true), 2),
      (RegExp(r'\bvoid\s*\*'), 2),
      (RegExp(r'\bchar\s*\*\s*\w+'), 2),
      (RegExp(r'->'), 0.5),
    ],
  ),
  (
    'cpp',
    [
      (RegExp(r'#include\s*<(iostream|vector|string|memory|map|algorithm|thread|cstdio|cstdlib|unordered_map)>'), 5),
      (RegExp(r'\bstd::'), 4),
      (RegExp(r'\bstd::cout\s*<<|\bcout\s*<<'), 5),
      (RegExp(r'\btemplate\s*<'), 4),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*namespace\s+\w+\s*\{', multiLine: true), 2),
      (RegExp(r'\bnullptr\b'), 4),
      (RegExp(r'\busing namespace\b'), 5),
      (RegExp(r'\bauto\s+\w+\s*='), 1),
      (RegExp(r'\b(virtual|override|constexpr|noexcept)\b'), 2),
      (RegExp(r'::\w+\('), 1),
      (RegExp(r'\bclass\s+\w+\s*(:\s*(public|private)\s+\w+)?\s*\{'), 1),
    ],
  ),
  (
    'csharp',
    [
      (RegExp(r'^[^\S\n\r\u2028\u2029]*using\s+System(\.\w+)*;', multiLine: true), 5),
      (RegExp(r'\bConsole\.Write(Line)?\('), 5),
      (RegExp(r'\{\s*get;\s*(private\s+)?set;\s*\}'), 5),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*namespace\s+[\w.]+', multiLine: true), 2),
      (RegExp(r'\bpublic\s+(async\s+)?(static\s+)?(Task|void|string|int|bool|class|interface|record)\b'), 2),
      (RegExp(r'\bvar\s+\w+\s*=\s*new\b'), 2),
      (RegExp(r'\basync\s+Task\b'), 4),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*\[\w+(\(.*\))?\]\s*$', multiLine: true), 1),
      (RegExp(r'\bstring\[\]\s+args'), 3),
      (RegExp(r'\bLINQ|\.Where\(|\.Select\('), 1),
    ],
  ),
  (
    'ruby',
    [
      (RegExp(r'^[^\S\n\r\u2028\u2029]*def\s+(self\.)?\w+[?!]?(\(.*\))?\s*$', multiLine: true), 3),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*end\s*$', multiLine: true), 2),
      (RegExp(r'\bputs\b'), 2),
      (RegExp(r'''^[^\S\n\r\u2028\u2029]*require(_relative)?\s+['"]''', multiLine: true), 2),
      (RegExp(r'\.each(_with_index)?\s+do\s*\|'), 5),
      (RegExp(r'\battr_(accessor|reader|writer)\b'), 5),
      (RegExp(r':\w+\s*=>'), 2),
      (RegExp(r'\bdo\s*\|\w+(, \w+)*\|'), 3),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*module\s+[A-Z]\w*\s*$', multiLine: true), 2),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*class\s+\w+\s*<\s*\w+', multiLine: true), 3),
      (RegExp(r'\bnil\b'), 1),
      (RegExp(r'#\{[^}]+\}'), 2),
    ],
  ),
  (
    'php',
    [
      (RegExp(r'<\?php'), 8),
      (RegExp(r'\$\w+\s*=[^=]'), 2),
      (RegExp(r'\$this->\w+'), 4),
      (RegExp(r'\bfunction\s+\w+\s*\(\s*(\??\w+\s+)?\$'), 4),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*namespace\s+[\w\\]+;', multiLine: true), 4),
      (RegExp(r'\becho\s+'), 1),
      (RegExp(r'->\w+\('), 1),
      (RegExp(r'\barray\('), 2),
      (RegExp(r'::class\b'), 2),
    ],
  ),
  (
    'shell',
    [
      (RegExp(r'^[^\S\n\r\u2028\u2029]*[$%❯] \S', multiLine: true), 3),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*[\w.-]+@[\w.-]+:[~\/][^$#\n]*[$#] ', multiLine: true), 5),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*PS [A-Z]:\\.*> ', multiLine: true), 3),
    ],
  ),
  (
    'bash',
    [
      (RegExp(r'^#!\/(usr\/)?bin\/(env\s+)?(ba|z)?sh', multiLine: true), 6),
      (
        RegExp(
          r'^[^\S\n\r\u2028\u2029]*(sudo\s+)?(apt(-get)?|brew|npm|npx|yarn|pnpm|pip3?|cargo|go|git|docker|kubectl|curl|wget|cd|ls|mkdir|rm|cp|mv|chmod|chown|export|source|cat|grep|echo|tar|ssh|make|bun|deno|helm|terraform|aws|gcloud|systemctl|uv|poetry|conda|rustup|flutter|dart)\s',
          multiLine: true,
        ),
        3,
      ),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*(if|then|fi|for|do|done|case|esac|while)\b', multiLine: true), 1),
      (RegExp(r'\b(fi|done|esac)\s*$', multiLine: true), 2),
      (RegExp(r'\$\{?\w+\}?'), 0.5),
      (RegExp(r'\s--?[a-z][\w-]*'), 0.5),
      (RegExp(r'\s&&\s|\s\|\s'), 0.5),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*#\s', multiLine: true), 0.5),
    ],
  ),
  (
    'powershell',
    [
      (RegExp(r'\b(Get|Set|New|Remove|Write|Invoke|Import|Start|Stop)-\w+'), 4),
      (RegExp(r'\$\w+\s*='), 1),
      (RegExp(r'-Object\b|\|\s*Where-Object|\|\s*ForEach-Object'), 4),
      (RegExp(r'\$PSScriptRoot|\$env:'), 4),
    ],
  ),
  (
    'sql',
    [
      (RegExp(r'\bSELECT\b[\s\S]+?\bFROM\b', caseSensitive: false), 4),
      (
        RegExp(
          r'\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIEW|DATABASE)|ALTER\s+TABLE|DROP\s+TABLE)\b',
          caseSensitive: false,
        ),
        5,
      ),
      (RegExp(r'\b(WHERE|JOIN|GROUP BY|ORDER BY|HAVING|LIMIT)\b'), 1),
      (RegExp(r'\bPRIMARY KEY\b|\bFOREIGN KEY\b|\bVARCHAR\(', caseSensitive: false), 3),
    ],
  ),
  (
    'html',
    [
      (RegExp(r'<!DOCTYPE html>', caseSensitive: false), 6),
      (
        RegExp(
          r'<(html|head|body|div|span|p|a|ul|li|script|link|meta|section|button|img|form|input|nav|header|footer)\b[^>]*>',
          caseSensitive: false,
        ),
        2,
      ),
      (RegExp(r'<\/(div|span|p|a|li|ul|section|button|body|html)>', caseSensitive: false), 2),
      (RegExp(r'\b(class|href|src|id)="[^"]*"'), 1),
    ],
  ),
  (
    'xml',
    [
      (RegExp(r'^\s*<\?xml\b'), 6),
      (RegExp(r'<\w+:\w+[\s>]'), 2),
      (RegExp(r'xmlns(:\w+)?="'), 3),
      (RegExp(r'<\/\w+>'), 0.5),
    ],
  ),
  (
    'css',
    [
      (
        RegExp(
          r'^[ \t]*[.#:@]?[\w-]+(?:(?:[ \t]*[,>+~][ \t]*|[ \t]+)[.#:]?[\w-]+|[.#:][\w-]+|\([^)\n]*\))*[ \t]*\{[ \t]*$',
          multiLine: true,
        ),
        2,
      ),
      (
        RegExp(
          r'^[^\S\n\r\u2028\u2029]*(color|margin|padding|display|font-(size|family|weight)|background(-color)?|border(-radius)?|width|height|position|flex|grid-template-columns|transition|transform)\s*:[^;]+;',
          multiLine: true,
        ),
        3,
      ),
      (RegExp(r'@(media|import|keyframes|font-face|supports|layer)\b'), 3),
      (RegExp(r'^[ \t]*-?[a-z]+(?:-[a-z]+)*[ \t]*:[ \t]*[^;{}\n]+;[ \t]*$', multiLine: true), 2),
      (RegExp(r':\s*(hover|focus|before|after|root|nth-child)'), 1),
      (RegExp(r'\b\d+(px|rem|em|vh|vw)\b'), 1),
      (RegExp(r'var\(--[\w-]+\)'), 2),
    ],
  ),
  (
    'scss',
    [
      (RegExp(r'^[^\S\n\r\u2028\u2029]*\$[\w-]+\s*:', multiLine: true), 3),
      (RegExp(r'&(:|\.|-)\w'), 3),
      (RegExp(r'@(mixin|include|extend|use|forward)\b'), 4),
    ],
  ),
  (
    'yaml',
    [
      (RegExp(r'^---\s*$', multiLine: true), 1),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*[\w.-]+:\s+[^\s{].*$', multiLine: true), 1),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*[\w.-]+:\s*$', multiLine: true), 1),
      (RegExp(r'''^[^\S\n\r\u2028\u2029]*- [\w"'].*$''', multiLine: true), 1),
      (
        RegExp(
          r'^[^\S\n\r\u2028\u2029]*(apiVersion|kind|metadata|spec|services|image|name|steps|jobs|runs-on|on|version|dependencies):',
          multiLine: true,
        ),
        3,
      ),
    ],
  ),
  (
    'toml',
    [
      (RegExp(r'^\[\[?[\w.-]+\]\]?\s*$', multiLine: true), 3),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*[\w.-]+\s*=\s*("|\d|\[|true|false|\{)', multiLine: true), 2),
      (RegExp(r'^\[(package|dependencies|tool\.\w+|build-system|workspace)\]', multiLine: true), 4),
    ],
  ),
  (
    'ini',
    [
      (RegExp(r'^\[[\w .-]+\]\s*$', multiLine: true), 2),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*[\w.-]+\s*=\s*[^=\n]*$', multiLine: true), 1),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*;', multiLine: true), 1),
    ],
  ),
  (
    'dockerfile',
    [
      (RegExp(r'^[^\S\n\r\u2028\u2029]*FROM\s+[\w./:-]+(\s+AS\s+\w+)?\s*$', caseSensitive: false, multiLine: true), 5),
      (
        RegExp(
          r'^[^\S\n\r\u2028\u2029]*(RUN|COPY|ADD|CMD|ENTRYPOINT|WORKDIR|EXPOSE|ENV|ARG|USER|VOLUME|LABEL|HEALTHCHECK)\s',
          multiLine: true,
        ),
        2,
      ),
    ],
  ),
  (
    'makefile',
    [
      (RegExp(r'^[\w.%$()/-]+\s*:[^=\n]*\n\t\S', multiLine: true), 5),
      (RegExp(r'\$\([\w@<^]+\)'), 1),
      (RegExp(r'^\.PHONY\s*:', multiLine: true), 5),
    ],
  ),
  (
    'markdown',
    [
      (RegExp(r'^#{1,6}\s+\S', multiLine: true), 2),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*[-*+]\s+\S', multiLine: true), 0.5),
      (RegExp(r'\[[^\]]+\]\([^)]+\)'), 2),
      (RegExp(r'^```', multiLine: true), 3),
      (RegExp(r'\*\*[^*]+\*\*'), 1),
    ],
  ),
  (
    'diff',
    [
      (RegExp(r'^@@ [-+]\d+(,\d+)? [-+]\d+(,\d+)? @@', multiLine: true), 6),
      (RegExp(r'^(\+\+\+|---) [ab]?\/', multiLine: true), 4),
      (RegExp(r'^diff --git ', multiLine: true), 6),
      (RegExp(r'^[+-](?![+-])', multiLine: true), 0.5),
    ],
  ),
  (
    'graphql',
    [
      (
        RegExp(
          r'^[^\S\n\r\u2028\u2029]*(query|mutation|subscription|fragment)\s*(\w+\s*)?(\(.*\)\s*)?(on \w+\s*)?\{',
          multiLine: true,
        ),
        5,
      ),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*type\s+\w+\s*(implements\s+\w+\s*)?\{', multiLine: true), 2),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*schema\s*\{', multiLine: true), 4),
    ],
  ),
  (
    'lua',
    [
      (RegExp(r'^[^\S\n\r\u2028\u2029]*local\s+(function\s+)?\w+', multiLine: true), 4),
      (RegExp(r'\bfunction\s+[\w.:]+\(.*\)\s*$', multiLine: true), 1),
      (RegExp(r'\bthen\s*$', multiLine: true), 2),
      (RegExp(r'~='), 3),
      (RegExp(r'\bend\s*$', multiLine: true), 1),
      (RegExp(r'''\brequire\s*\(?["']'''), 1),
      (RegExp(r'\bnil\b'), 1),
      (RegExp(r'\bipairs\(|\bpairs\('), 4),
    ],
  ),
  (
    'r',
    [
      (RegExp(r'\b\w+\s*<-\s*'), 3),
      (RegExp(r'\blibrary\(\w+\)'), 5),
      (RegExp(r'\bc\('), 1),
      (RegExp(r'\b(data\.frame|ggplot|dplyr|tidyverse|summary)\('), 4),
      (RegExp(r'%>%|\|>'), 2),
    ],
  ),
  (
    'haskell',
    [
      (RegExp(r'^\w+\s*::\s*.+$', multiLine: true), 4),
      (RegExp(r'::\s*\w+\s*->'), 3),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*import\s+qualified\b', multiLine: true), 5),
      (RegExp(r'^module\s+[\w.]+\s+where', multiLine: true), 5),
      (RegExp(r'\bwhere\s*$', multiLine: true), 1),
      (RegExp(r'<\$>|>>='), 3),
      (RegExp(r'\bdata\s+\w+\s*='), 2),
    ],
  ),
  (
    'elixir',
    [
      (RegExp(r'^[^\S\n\r\u2028\u2029]*defmodule\s+[\w.]+\s+do', multiLine: true), 6),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*defp?\s+\w.*\bdo\s*$', multiLine: true), 3),
      (RegExp(r'\|>'), 2),
      (RegExp(r'\b(IO\.puts|Enum\.\w+|%\{)'), 3),
    ],
  ),
  (
    'dart',
    [
      (RegExp(r"^[^\S\n\r\u2028\u2029]*import\s+'package:[\w/.-]+';", multiLine: true), 6),
      (RegExp(r'\bWidget\s+build\(BuildContext'), 6),
      (RegExp(r'\bsetState\('), 3),
      (RegExp(r'@override\b'), 2),
      (RegExp(r'\bvoid\s+main\(\)'), 2),
      (RegExp(r'\bfinal\s+\w+(\s*<.+>)?\s+\w+\s*='), 1),
      (RegExp(r'\bFuture<\w+>'), 2),
      (RegExp(r'\blate\s+\w+'), 3),
    ],
  ),
  (
    'scala',
    [
      (RegExp(r'^[^\S\n\r\u2028\u2029]*object\s+\w+(\s+extends\s+\w+)?\s*\{', multiLine: true), 3),
      (RegExp(r'\bdef\s+\w+(\[.+\])?\(.*\)\s*:\s*[\w\[\]]+\s*='), 4),
      (RegExp(r'\bcase class\b'), 4),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*import\s+scala\.', multiLine: true), 5),
      (RegExp(r'\bval\s+\w+\s*:\s*\w+'), 1),
    ],
  ),
  (
    'clojure',
    [
      (RegExp(r'^[^\S\n\r\u2028\u2029]*\(defn-?\s', multiLine: true), 5),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*\(ns\s', multiLine: true), 5),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*\(def\s', multiLine: true), 3),
      (RegExp(r'\(let\s*\['), 3),
    ],
  ),
  (
    'latex',
    [
      (RegExp(r'\\(begin|end)\{\w+\*?\}'), 4),
      (RegExp(r'\\(documentclass|usepackage|section|subsection|maketitle)\b'), 5),
      (RegExp(r'\\(frac|sum|int|alpha|beta|mathbb|mathrm|left|right)\b'), 2),
    ],
  ),
  (
    'nginx',
    [
      (RegExp(r'^[^\S\n\r\u2028\u2029]*server\s*\{', multiLine: true), 3),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*listen\s+\d+', multiLine: true), 3),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*location\s+(?:[~=^]+\s+)?\S+\s*\{', multiLine: true), 4),
      (RegExp(r'\bproxy_pass\b|\bserver_name\b|\broot\s+\/'), 4),
    ],
  ),
  (
    'protobuf',
    [
      (RegExp(r'^[^\S\n\r\u2028\u2029]*syntax\s*=\s*"proto[23]";', multiLine: true), 6),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*message\s+\w+\s*\{', multiLine: true), 3),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*(repeated|optional|required)\s+\w+\s+\w+\s*=\s*\d+;', multiLine: true), 4),
    ],
  ),
  (
    'solidity',
    [
      (RegExp(r'^[^\S\n\r\u2028\u2029]*pragma\s+solidity\b', multiLine: true), 7),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*contract\s+\w+', multiLine: true), 3),
      (RegExp(r'\bmsg\.sender\b'), 4),
    ],
  ),
  (
    'objectivec',
    [
      (RegExp(r'^[^\S\n\r\u2028\u2029]*@(interface|implementation|property|end|protocol)\b', multiLine: true), 4),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*#import\s+[<"]', multiLine: true), 4),
      (RegExp(r'\bNS(String|Log|Array|Dictionary|Object)\b'), 4),
      (RegExp(r'\[\w+\s+\w+(:\w+)?\]'), 1),
    ],
  ),
  (
    'perl',
    [
      (RegExp(r'^[^\S\n\r\u2028\u2029]*use\s+(strict|warnings);', multiLine: true), 5),
      (RegExp(r'\bmy\s+[$@%]\w+'), 4),
      (RegExp(r'=~\s*[ms]?\/'), 2),
      (RegExp(r'\$_\b'), 2),
    ],
  ),
  (
    'matlab',
    [
      (RegExp(r'^[^\S\n\r\u2028\u2029]*function\s+(\[.*\]|\w+)\s*=\s*\w+\(', multiLine: true), 4),
      (RegExp(r'\b(zeros|ones|linspace|plot|figure|disp)\('), 2),
      (RegExp(r'^[^\S\n\r\u2028\u2029]*%', multiLine: true), 1),
      (RegExp(r'\.\*|\.\^'), 2),
    ],
  ),
  ('json', []),
];

/// [requiredLiterals] of every pattern in [_rules].
final _ruleLiterals = [
  for (final (_, rules) in _rules) [for (final (pattern, _) in rules) requiredLiterals(pattern)],
];

final _jsonKey = RegExp(r'^[{[]\s*"[\w$@-]+"\s*:');

bool _looksLikeJson(String code) {
  final first = charCodeAt(code, 0);
  if (first != 123 && first != 91) return false;
  final last = charCodeAt(code, code.length - 1);
  if (!(first == 123 && last == 125) && !(first == 91 && last == 93)) return false;
  if (code.length > 200000) return true;
  try {
    jsonDecode(code);
    return true;
  } on FormatException {
    return _jsonKey.hasMatch(code);
  }
}

final _prompt = RegExp(r'^\s*(?:[$%❯>]|PS [A-Z]:\\[^>]*>|[\w.-]+@[\w.-]+:[^$#]*[$#])\s');
final _pycon = RegExp(r'^[^\S\n\r\u2028\u2029]*>>>', multiLine: true);

/// Best guess for unlabelled code, or null when the evidence is weak.
String? detectLanguage(String source) {
  final code = jsTrim(source.length > 5000 ? source.substring(0, 5000) : source);
  if (code.length < 8) return null;
  if (_looksLikeJson(code)) return 'json';
  final scores = <String, num>{};
  // Most rules require a literal the code lacks: rule those out before running their patterns.
  final screen = LiteralScreen(code);
  for (var l = 0; l < _rules.length; l++) {
    final (lang, rules) = _rules[l];
    final literals = _ruleLiterals[l];
    num score = 0;
    for (var r = 0; r < rules.length; r++) {
      final (pattern, weight) = rules[r];
      final required = literals[r];
      final possible = required == null || screen.containsAny(required, ignoreCase: !pattern.isCaseSensitive);
      assert(possible || !pattern.hasMatch(code), 'required literals $required of ${pattern.pattern}');
      if (possible && pattern.hasMatch(code)) score += weight;
    }
    scores[lang] = score;
  }
  final js = scores['javascript'] ?? 0;
  final ts = scores['typescript'] ?? 0;
  if (ts >= 3) scores['typescript'] = ts + js;
  final css = scores['css'] ?? 0;
  final scss = scores['scss'] ?? 0;
  if (scss >= 3) scores['scss'] = scss + css;
  final c = scores['c'] ?? 0;
  final cpp = scores['cpp'] ?? 0;
  if (cpp >= 4) scores['cpp'] = cpp + c;
  final lines = code.split('\n');
  var plus = 0;
  var minus = 0;
  for (final line in lines) {
    final c0 = charCodeAt(line, 0);
    final c1 = charCodeAt(line, 1);
    if (c0 == 43 && c1 != 43) {
      plus++;
    } else if (c0 == 45 && c1 != 45) {
      minus++;
    }
  }
  // Unified diffs without headers: most lines start with + or -, both present.
  if (plus > 0 && minus > 0 && lines.length >= 3 && plus + minus >= lines.length * 0.4) {
    scores['diff'] = (scores['diff'] ?? 0) + 6;
  }
  var prompts = 0;
  var nonEmpty = 0;
  var firstIsPrompt = false;
  for (final line in lines) {
    if (isBlank(line)) continue;
    final prompt = _prompt.hasMatch(line);
    if (nonEmpty == 0) firstIsPrompt = prompt;
    nonEmpty++;
    if (prompt) prompts++;
  }
  // A session opens with a prompt; what follows may be the command's output.
  if ((firstIsPrompt || prompts >= nonEmpty * 0.5) && prompts > 0 && !_pycon.hasMatch(code)) {
    scores['shell'] = (scores['shell'] ?? 0) + 4;
  }
  final bash = scores['bash'] ?? 0;
  final shell = scores['shell'] ?? 0;
  if (shell >= 3) scores['shell'] = shell + bash;
  String? best;
  num bestScore = 0;
  num second = 0;
  scores.forEach((lang, score) {
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = lang;
    } else if (score > second) {
      second = score;
    }
  });
  if (best == null || bestScore < 4) return null;
  if (bestScore - second < 2 && bestScore < second * 1.5) return null;
  return best;
}
