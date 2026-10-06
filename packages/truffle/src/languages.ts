/**
 * Code languages: normalizing what page markup calls a language, and a fast
 * deterministic detector for unlabelled blocks. Ids are highlight.js names
 * (except `html`, which renderers map to highlight.js `xml`), so both
 * renderers can pass them straight to their highlighter.
 */

const ALIASES: Record<string, string> = Object.assign(Object.create(null) as {}, {
  js: 'javascript', javascript: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript', nodejs: 'javascript', es6: 'javascript', ecmascript: 'javascript',
  ts: 'typescript', typescript: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', python: 'python', python3: 'python', py3: 'python', ipython: 'python', pycon: 'python', python2: 'python', gyp: 'python', sage: 'python', jupyter: 'python',
  java: 'java', jsp: 'java',
  kt: 'kotlin', kts: 'kotlin', kotlin: 'kotlin',
  scala: 'scala', sc: 'scala', sbt: 'scala',
  swift: 'swift',
  objc: 'objectivec', 'obj-c': 'objectivec', objectivec: 'objectivec', 'objective-c': 'objectivec', mm: 'objectivec',
  c: 'c', h: 'c',
  cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', cplusplus: 'cpp', arduino: 'cpp', ino: 'cpp', cuda: 'cpp', cu: 'cpp',
  cs: 'csharp', csharp: 'csharp', 'c#': 'csharp', dotnet: 'csharp',
  go: 'go', golang: 'go',
  rs: 'rust', rust: 'rust',
  rb: 'ruby', ruby: 'ruby', gemspec: 'ruby', podspec: 'ruby', thor: 'ruby', irb: 'ruby', rake: 'ruby',
  php: 'php', php3: 'php', php4: 'php', php5: 'php', php7: 'php', php8: 'php',
  pl: 'perl', perl: 'perl', pm: 'perl',
  lua: 'lua', luau: 'lua',
  r: 'r', rscript: 'r',
  jl: 'julia', julia: 'julia',
  dart: 'dart', flutter: 'dart',
  ex: 'elixir', exs: 'elixir', elixir: 'elixir',
  erl: 'erlang', erlang: 'erlang',
  hs: 'haskell', haskell: 'haskell',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure', clojure: 'clojure',
  ml: 'ocaml', ocaml: 'ocaml', mli: 'ocaml', reason: 'reasonml', re: 'reasonml', reasonml: 'reasonml',
  fs: 'fsharp', fsharp: 'fsharp', 'f#': 'fsharp', fsx: 'fsharp', fsi: 'fsharp',
  zig: 'zig',
  nim: 'nim',
  sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash', fish: 'bash', shellscript: 'bash', 'shell-script': 'bash',
  shell: 'shell', console: 'shell', terminal: 'shell', 'shell-session': 'shell', shellsession: 'shell', 'bash-session': 'shell', sh_session: 'shell', cmd: 'dos', bat: 'dos', batch: 'dos', dos: 'dos',
  ps: 'powershell', ps1: 'powershell', psm1: 'powershell', pwsh: 'powershell', powershell: 'powershell',
  sql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql', psql: 'pgsql', pgsql: 'pgsql', plpgsql: 'pgsql', sqlite: 'sql', plsql: 'sql', tsql: 'sql', mssql: 'sql', mariadb: 'sql', bigquery: 'sql', snowflake: 'sql', hive: 'sql', sparksql: 'sql',
  html: 'html', xhtml: 'html', htm: 'html', vue: 'html', svelte: 'html', astro: 'html', handlebars: 'html', hbs: 'html', jinja: 'html', jinja2: 'html', django: 'html', liquid: 'html', ejs: 'html', erb: 'erb', razor: 'html', blade: 'html', twig: 'html',
  xml: 'xml', svg: 'xml', rss: 'xml', atom: 'xml', xsl: 'xml', xslt: 'xml', plist: 'xml', xaml: 'xml', wsdl: 'xml', csproj: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less', stylus: 'stylus', styl: 'stylus', postcss: 'css',
  json: 'json', jsonc: 'json', json5: 'json', jsonl: 'json', geojson: 'json', webmanifest: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  ini: 'ini', cfg: 'ini', conf: 'ini', config: 'ini', properties: 'properties', env: 'bash', dotenv: 'bash', editorconfig: 'ini', gitconfig: 'ini',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', mkd: 'markdown', rmd: 'markdown',
  dockerfile: 'dockerfile', docker: 'dockerfile', containerfile: 'dockerfile',
  makefile: 'makefile', make: 'makefile', mk: 'makefile', mak: 'makefile',
  cmake: 'cmake',
  nginx: 'nginx', nginxconf: 'nginx',
  apache: 'apache', apacheconf: 'apache', htaccess: 'apache',
  graphql: 'graphql', gql: 'graphql',
  proto: 'protobuf', protobuf: 'protobuf',
  diff: 'diff', patch: 'diff', udiff: 'diff',
  tex: 'latex', latex: 'latex', katex: 'latex', bibtex: 'latex',
  matlab: 'matlab', octave: 'matlab',
  groovy: 'groovy', gradle: 'groovy', jenkinsfile: 'groovy',
  vb: 'vbnet', vbnet: 'vbnet', 'vb.net': 'vbnet', vba: 'vbscript', vbs: 'vbscript', vbscript: 'vbscript',
  asm: 'x86asm', nasm: 'x86asm', x86asm: 'x86asm', assembly: 'x86asm', armasm: 'armasm', arm: 'armasm', mips: 'mipsasm', wasm: 'wasm', wat: 'wasm',
  sol: 'solidity', solidity: 'solidity',
  hcl: 'hcl', tf: 'hcl', terraform: 'hcl',
  nix: 'nix',
  vim: 'vim', viml: 'vim', vimscript: 'vim',
  http: 'http', https: 'http',
  lisp: 'lisp', elisp: 'lisp', emacs: 'lisp', 'emacs-lisp': 'lisp', commonlisp: 'lisp', scheme: 'scheme', racket: 'scheme', rkt: 'scheme',
  elm: 'elm', purescript: 'haskell', idris: 'haskell', agda: 'haskell',
  fortran: 'fortran', f90: 'fortran', f95: 'fortran',
  cobol: 'cobol', pascal: 'delphi', delphi: 'delphi', ada: 'ada',
  prolog: 'prolog', coq: 'coq', lean: 'lean', lean4: 'lean',
  crystal: 'crystal', cr: 'crystal', d: 'd', v: 'v', vala: 'vala', haxe: 'haxe', hx: 'haxe', awk: 'awk', gawk: 'awk', sed: 'bash', tcl: 'tcl',
  csv: 'plaintext', tsv: 'plaintext',
  text: 'plaintext', txt: 'plaintext', plain: 'plaintext', plaintext: 'plaintext', none: 'plaintext', nohighlight: 'plaintext', 'no-highlight': 'plaintext', output: 'plaintext', log: 'plaintext', raw: 'plaintext', ascii: 'plaintext', mermaid: 'plaintext',
  regex: 'plaintext', regexp: 'plaintext',
});

/** Canonical id for a language name from markup, or null when unknown. */
export function normalizeLanguage(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null;
  const key = name.trim().toLowerCase().replace(/^\./, '');
  if (key.length === 0) return null;
  return ALIASES[key] ?? null;
}

const CLASS_PATTERNS: RegExp[] = [
  /(?:^|\s)(?:language|lang)-([\w#+.-]+)/i,
  /(?:^|\s)highlight-(?:source-)?([\w#+.-]+)/i,
  /(?:^|\s)brush:\s*([\w#+.-]+)/i,
  /(?:^|\s)sourceCode\s+([\w#+.-]+)/i,
  /(?:^|\s)mw-highlight-lang-([\w#+.-]+)/i,
  /(?:^|\s)hljs\s+([\w#+.-]+)/i,
  /(?:^|\s)prettyprint\s+lang-([\w#+.-]+)/i,
  /(?:^|\s)code-([\w#+-]+)(?:\s|$)/i,
  /(?:^|\s)syntax-([\w#+-]+)(?:\s|$)/i,
  /(?:^|\s)([\w#+-]+)-code(?:\s|$)/i,
];

/** Language named by a class attribute (`language-js`, `brush: py`, `highlight-source-rust`, ...). */
export function languageFromClass(className: string): string | null {
  if (className.length === 0) return null;
  for (const pattern of CLASS_PATTERNS) {
    const m = pattern.exec(className);
    if (m !== null) {
      const lang = normalizeLanguage(m[1]);
      if (lang !== null) return lang;
    }
  }
  // A bare language class (`<code class="python">`, `<pre class="js">`).
  for (const token of className.split(/\s+/)) {
    if (token.length >= 2 && token.length <= 12) {
      const lang = normalizeLanguage(token);
      if (lang !== null && lang !== 'plaintext' && token !== 'text' && token !== 'output') return lang;
    }
  }
  return null;
}

type Rule = [RegExp, number];

/**
 * Weighted evidence per language. Patterns are cheap; the whole table runs in well under a millisecond per block.
 * A line's indentation is `[^\S\n\r\u2028\u2029]*`, whitespace short of a line break: `^\s*` also runs on across
 * blank lines, so in a long run of them every line start would rescan the rest. For `test` it is the same rule, as
 * a match can always start at the last line start. Likewise no two neighbouring quantifiers take the same characters
 * (`\s*\w*\s*`, `\s+.+\s+`), which would retry every split of a long run of spaces; the rewritten rules match the
 * same text (a second branch keeps what the old shape matched with spaces alone, as in `let  =`).
 */
const RULES: [string, Rule[]][] = [
  ['python', [
    [/^[^\S\n\r\u2028\u2029]*def \w+\s*\(.*\)\s*(->\s*[\w\[\], .]+)?:\s*$/m, 4], [/^[^\S\n\r\u2028\u2029]*class \w+(\(.*\))?:\s*$/m, 4], [/^[^\S\n\r\u2028\u2029]*(elif|except|finally|try)\b.*:\s*$/m, 3],
    [/\bself\.\w+/, 2], [/^[^\S\n\r\u2028\u2029]*from [\w.]+ import \w/m, 4], [/^[^\S\n\r\u2028\u2029]*import (numpy|pandas|os|sys|re|json|torch|requests|asyncio|typing)\b/m, 4],
    [/\b(None|True|False)\b/, 1], [/\bprint\(/, 1], [/__(init|name|main)__/, 4], [/^[^\S\n\r\u2028\u2029]*@\w+(\.\w+)*(\(.*\))?\s*$/m, 1], [/\bf["'][^"'\n]*\{/, 2],
    [/^>>> /m, 4], [/\blambda \w*:/, 2], [/^[^\S\n\r\u2028\u2029]*for \w+(, \w+)* in .+:\s*$/m, 3], [/^[^\S\n\r\u2028\u2029]*if .+:\s*$/m, 1], [/\bdef \w+\(self/, 4], [/\b(len|range|enumerate|isinstance)\(/, 1],
  ]],
  ['javascript', [
    [/\b(const|let|var)(?:\s+[\w${}\[\],]+(?: +[\w${}\[\],]+)*|\s[^\S ]* )\s*=/, 2], [/=>/, 1], [/\bfunction\s*(?:\*\s*)?(?:[\w$]+\s*)?\(/, 2], [/\bconsole\.(log|error|warn)\(/, 3],
    [/\b(document|window)\.\w+/, 2], [/\brequire\(['"]/, 3], [/\bexport\s+(default|const|function|class|async)\b/, 2], [/^[^\S\n\r\u2028\u2029]*import(?:\s+\S(?:.*\S)?|\s[\n\r\u2028\u2029]*[^\S\n\r\u2028\u2029])\s+from\s+['"]/m, 3],
    [/===|!==/, 2], [/\bundefined\b/, 1], [/\bawait\b/, 0.5], [/\bmodule\.exports\b/, 4], [/\.then\(/, 1], [/\bnew Promise\(/, 2], [/\$\{[^}]+\}/, 1],
    [/\buse(State|Effect|Ref|Memo|Callback)\(/, 3], [/<\/?[A-Z]\w*[\s>]/, 1], [/\baddEventListener\(/, 3], [/\bJSON\.(parse|stringify)\(/, 2],
  ]],
  ['typescript', [
    [/:\s*(string|number|boolean|any|void|unknown|never|object)(\[\])?\s*[;,)=|{]/, 4], [/^[^\S\n\r\u2028\u2029]*(export\s+)?interface\s+\w+(<.+>)?\s*(extends [\w<>, ]+)?\{/m, 4],
    [/^[^\S\n\r\u2028\u2029]*(export\s+)?type\s+\w+(<.+>)?\s*=/m, 3], [/\bas const\b/, 3], [/\b(private|public|protected|readonly)\s+\w+\s*[:;=(]/, 2], [/^[^\S\n\r\u2028\u2029]*(export\s+)?enum\s+\w+\s*\{/m, 3],
    [/\bimport type\b/, 4], [/<\w+(\[\])?>\(/, 1], [/\):\s*(Promise<|[\w<>\[\]]+\s*\{)/, 3], [/\bimplements\s+\w+/, 1], [/!\./, 1], [/\bkeyof\b|\btypeof \w+\[/, 2],
  ]],
  ['java', [
    [/\bpublic\s+(static\s+)?(final\s+)?(class|interface|enum|void|record)\b/, 3], [/\bSystem\.(out|err)\.print/, 5], [/String\[\]\s+args/, 5], [/@Override\b/, 3],
    [/^[^\S\n\r\u2028\u2029]*import\s+java(x)?\.[\w.]+;/m, 5], [/^[^\S\n\r\u2028\u2029]*package\s+[\w.]+;\s*$/m, 4], [/\bprivate\s+(static\s+)?(final\s+)?[A-Z]\w*(<.*>)?\s+\w+\s*[;=]/, 2], [/\bnew\s+[A-Z]\w*(<.*>)?\(/, 1],
    [/\bthrows\s+\w+/, 2], [/\b(ArrayList|HashMap|List<|Map<)/, 1], [/;\s*$/m, 0.5],
  ]],
  ['kotlin', [
    [/^[^\S\n\r\u2028\u2029]*(suspend\s+|private\s+|override\s+|inline\s+)*fun\s+(<.+>\s*)?[\w.]+\(/m, 4], [/^[^\S\n\r\u2028\u2029]*val\s+\w+(\s*:\s*[\w<>?]+)?\s*=/m, 2], [/^[^\S\n\r\u2028\u2029]*var\s+\w+\s*:\s*\w+/m, 2],
    [/\bdata class\b/, 4], [/\bcompanion object\b/, 5], [/^[^\S\n\r\u2028\u2029]*import\s+(kotlin|kotlinx|androidx)\./m, 5], [/\?:|\?\./, 1], [/\bprintln\(/, 1], [/\bwhen\s*(\(.*\)\s*)?\{/, 2], [/\bit\.\w+/, 1],
  ]],
  ['swift', [
    [/^[^\S\n\r\u2028\u2029]*(@\w+\s+)*(public\s+|private\s+|static\s+|override\s+)*func\s+\w+(<.+>)?\(/m, 4], [/^[^\S\n\r\u2028\u2029]*import\s+(UIKit|SwiftUI|Foundation|Combine|AppKit)\s*$/m, 5],
    [/\b(guard|if)\s+let\b/, 4], [/->\s*[\w<>\[\]?]+\s*\{/, 1], [/@(State|Published|Binding|ObservedObject|MainActor|escaping)\b/, 4], [/\bstruct\s+\w+\s*:\s*View\b/, 5],
    [/^[^\S\n\r\u2028\u2029]*let\s+\w+(\s*:\s*[\w<>\[\]?]+)?\s*=/m, 1], [/\bvar body: some View\b/, 5], [/\bprint\(/, 0.5],
  ]],
  ['go', [
    [/^package\s+\w+\s*$/m, 5], [/^[^\S\n\r\u2028\u2029]*func\s+(\(\w+\s+\*?\w+\)\s+)?\w+\(/m, 4], [/:=/, 2], [/\bfmt\.(Print|Sprint|Fprint|Errorf)/, 5], [/\bif err != nil\b/, 5],
    [/\bgo func\b|\bchan\s+\w+|\bdefer\s+\w+/, 3], [/^import\s+\(\s*$/m, 3], [/\bstruct\s*\{/, 1], [/\[\]\w+\{/, 2], [/\bmake\((map|\[\]|chan)/, 3],
  ]],
  ['rust', [
    [/^[^\S\n\r\u2028\u2029]*(pub(\(crate\))?\s+)?(async\s+)?fn\s+\w+(<.+>)?\(/m, 4], [/\blet\s+mut\b/, 4], [/\b(println|format|vec|panic|assert_eq|write|eprintln)!\(/, 4], [/\b(println|vec)!\[/, 4],
    [/^[^\S\n\r\u2028\u2029]*use\s+(std|crate|super|self|tokio|serde)::/m, 5], [/#\[(derive|cfg|test|tokio::main)/, 5], [/\bimpl(<.+>)?\s+[\w:<>]+(\s+for\s+\w+)?\s*\{/, 3], [/&(mut\s+)?(str|self)\b/, 3],
    [/::new\(/, 1], [/->\s*(Result|Option|Self|impl\s)/, 2], [/\bmatch\s+(?:\S.*|[^\S\n\r\u2028\u2029])\{/, 1], [/\b(Some|None|Ok|Err)\(/, 1], [/\bunwrap\(\)/, 3],
  ]],
  ['c', [
    [/#include\s*<\w+\.h>/, 4], [/\bint\s+main\s*\(/, 3], [/\bprintf\s*\(/, 2], [/\b(malloc|calloc|free|sizeof|memcpy|strlen)\s*\(/, 2], [/\bstruct\s+\w+\s*\{/, 1],
    [/^[^\S\n\r\u2028\u2029]*#define\s+\w+/m, 2], [/\bvoid\s*\*/, 2], [/\bchar\s*\*\s*\w+/, 2], [/->/, 0.5],
  ]],
  ['cpp', [
    [/#include\s*<(iostream|vector|string|memory|map|algorithm|thread|cstdio|cstdlib|unordered_map)>/, 5], [/\bstd::/, 4], [/\bstd::cout\s*<<|\bcout\s*<</, 5],
    [/\btemplate\s*</, 4], [/^[^\S\n\r\u2028\u2029]*namespace\s+\w+\s*\{/m, 2], [/\bnullptr\b/, 4], [/\busing namespace\b/, 5], [/\bauto\s+\w+\s*=/, 1], [/\b(virtual|override|constexpr|noexcept)\b/, 2],
    [/::\w+\(/, 1], [/\bclass\s+\w+\s*(:\s*(public|private)\s+\w+)?\s*\{/, 1],
  ]],
  ['csharp', [
    [/^[^\S\n\r\u2028\u2029]*using\s+System(\.\w+)*;/m, 5], [/\bConsole\.Write(Line)?\(/, 5], [/\{\s*get;\s*(private\s+)?set;\s*\}/, 5], [/^[^\S\n\r\u2028\u2029]*namespace\s+[\w.]+/m, 2],
    [/\bpublic\s+(async\s+)?(static\s+)?(Task|void|string|int|bool|class|interface|record)\b/, 2], [/\bvar\s+\w+\s*=\s*new\b/, 2], [/\basync\s+Task\b/, 4], [/^[^\S\n\r\u2028\u2029]*\[\w+(\(.*\))?\]\s*$/m, 1],
    [/\bstring\[\]\s+args/, 3], [/\bLINQ|\.Where\(|\.Select\(/, 1],
  ]],
  ['ruby', [
    [/^[^\S\n\r\u2028\u2029]*def\s+(self\.)?\w+[?!]?(\(.*\))?\s*$/m, 3], [/^[^\S\n\r\u2028\u2029]*end\s*$/m, 2], [/\bputs\b/, 2], [/^[^\S\n\r\u2028\u2029]*require(_relative)?\s+['"]/m, 2], [/\.each(_with_index)?\s+do\s*\|/, 5],
    [/\battr_(accessor|reader|writer)\b/, 5], [/:\w+\s*=>/, 2], [/\bdo\s*\|\w+(, \w+)*\|/, 3], [/^[^\S\n\r\u2028\u2029]*module\s+[A-Z]\w*\s*$/m, 2], [/^[^\S\n\r\u2028\u2029]*class\s+\w+\s*<\s*\w+/m, 3], [/\bnil\b/, 1], [/#\{[^}]+\}/, 2],
  ]],
  ['php', [
    [/<\?php/, 8], [/\$\w+\s*=[^=]/, 2], [/\$this->\w+/, 4], [/\bfunction\s+\w+\s*\(\s*(\??\w+\s+)?\$/, 4], [/^[^\S\n\r\u2028\u2029]*namespace\s+[\w\\]+;/m, 4], [/\becho\s+/, 1], [/->\w+\(/, 1], [/\barray\(/, 2], [/::class\b/, 2],
  ]],
  ['shell', [
    [/^[^\S\n\r\u2028\u2029]*[$%❯] \S/m, 3], [/^[^\S\n\r\u2028\u2029]*[\w.-]+@[\w.-]+:[~\/][^$#\n]*[$#] /m, 5], [/^[^\S\n\r\u2028\u2029]*PS [A-Z]:\\.*> /m, 3],
  ]],
  ['bash', [
    [/^#!\/(usr\/)?bin\/(env\s+)?(ba|z)?sh/m, 6], [/^[^\S\n\r\u2028\u2029]*(sudo\s+)?(apt(-get)?|brew|npm|npx|yarn|pnpm|pip3?|cargo|go|git|docker|kubectl|curl|wget|cd|ls|mkdir|rm|cp|mv|chmod|chown|export|source|cat|grep|echo|tar|ssh|make|bun|deno|helm|terraform|aws|gcloud|systemctl|uv|poetry|conda|rustup|flutter|dart)\s/m, 3],
    [/^[^\S\n\r\u2028\u2029]*(if|then|fi|for|do|done|case|esac|while)\b/m, 1], [/\b(fi|done|esac)\s*$/m, 2], [/\$\{?\w+\}?/, 0.5], [/\s--?[a-z][\w-]*/, 0.5], [/\s&&\s|\s\|\s/, 0.5], [/^[^\S\n\r\u2028\u2029]*#\s/m, 0.5],
  ]],
  ['powershell', [
    [/\b(Get|Set|New|Remove|Write|Invoke|Import|Start|Stop)-\w+/, 4], [/\$\w+\s*=/, 1], [/-Object\b|\|\s*Where-Object|\|\s*ForEach-Object/, 4], [/\$PSScriptRoot|\$env:/, 4],
  ]],
  ['sql', [
    [/\bSELECT\b[\s\S]+?\bFROM\b/i, 4], [/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIEW|DATABASE)|ALTER\s+TABLE|DROP\s+TABLE)\b/i, 5],
    [/\b(WHERE|JOIN|GROUP BY|ORDER BY|HAVING|LIMIT)\b/, 1], [/\bPRIMARY KEY\b|\bFOREIGN KEY\b|\bVARCHAR\(/i, 3],
  ]],
  ['html', [
    [/<!DOCTYPE html>/i, 6], [/<(html|head|body|div|span|p|a|ul|li|script|link|meta|section|button|img|form|input|nav|header|footer)\b[^>]*>/i, 2], [/<\/(div|span|p|a|li|ul|section|button|body|html)>/i, 2], [/\b(class|href|src|id)="[^"]*"/, 1],
  ]],
  ['xml', [
    [/^\s*<\?xml\b/, 6], [/<\w+:\w+[\s>]/, 2], [/xmlns(:\w+)?="/, 3], [/<\/\w+>/, 0.5],
  ]],
  ['css', [
    [/^[ \t]*[.#:@]?[\w-]+(?:(?:[ \t]*[,>+~][ \t]*|[ \t]+)[.#:]?[\w-]+|[.#:][\w-]+|\([^)\n]*\))*[ \t]*\{[ \t]*$/m, 2], [/^[^\S\n\r\u2028\u2029]*(color|margin|padding|display|font-(size|family|weight)|background(-color)?|border(-radius)?|width|height|position|flex|grid-template-columns|transition|transform)\s*:[^;]+;/m, 3],
    [/@(media|import|keyframes|font-face|supports|layer)\b/, 3], [/^[ \t]*-?[a-z]+(?:-[a-z]+)*[ \t]*:[ \t]*[^;{}\n]+;[ \t]*$/m, 2], [/:\s*(hover|focus|before|after|root|nth-child)/, 1], [/\b\d+(px|rem|em|vh|vw)\b/, 1], [/var\(--[\w-]+\)/, 2],
  ]],
  ['scss', [
    [/^[^\S\n\r\u2028\u2029]*\$[\w-]+\s*:/m, 3], [/&(:|\.|-)\w/, 3], [/@(mixin|include|extend|use|forward)\b/, 4],
  ]],
  ['yaml', [
    [/^---\s*$/m, 1], [/^[^\S\n\r\u2028\u2029]*[\w.-]+:\s+[^\s{].*$/m, 1], [/^[^\S\n\r\u2028\u2029]*[\w.-]+:\s*$/m, 1], [/^[^\S\n\r\u2028\u2029]*- [\w"'].*$/m, 1], [/^[^\S\n\r\u2028\u2029]*(apiVersion|kind|metadata|spec|services|image|name|steps|jobs|runs-on|on|version|dependencies):/m, 3],
  ]],
  ['toml', [
    [/^\[\[?[\w.-]+\]\]?\s*$/m, 3], [/^[^\S\n\r\u2028\u2029]*[\w.-]+\s*=\s*("|\d|\[|true|false|\{)/m, 2], [/^\[(package|dependencies|tool\.\w+|build-system|workspace)\]/m, 4],
  ]],
  ['ini', [
    [/^\[[\w .-]+\]\s*$/m, 2], [/^[^\S\n\r\u2028\u2029]*[\w.-]+\s*=\s*[^=\n]*$/m, 1], [/^[^\S\n\r\u2028\u2029]*;/m, 1],
  ]],
  ['dockerfile', [
    [/^[^\S\n\r\u2028\u2029]*FROM\s+[\w./:-]+(\s+AS\s+\w+)?\s*$/im, 5], [/^[^\S\n\r\u2028\u2029]*(RUN|COPY|ADD|CMD|ENTRYPOINT|WORKDIR|EXPOSE|ENV|ARG|USER|VOLUME|LABEL|HEALTHCHECK)\s/m, 2],
  ]],
  ['makefile', [
    [/^[\w.%$()/-]+\s*:[^=\n]*\n\t\S/m, 5], [/\$\([\w@<^]+\)/, 1], [/^\.PHONY\s*:/m, 5],
  ]],
  ['markdown', [
    [/^#{1,6}\s+\S/m, 2], [/^[^\S\n\r\u2028\u2029]*[-*+]\s+\S/m, 0.5], [/\[[^\]]+\]\([^)]+\)/, 2], [/^```/m, 3], [/\*\*[^*]+\*\*/, 1],
  ]],
  ['diff', [
    [/^@@ [-+]\d+(,\d+)? [-+]\d+(,\d+)? @@/m, 6], [/^(\+\+\+|---) [ab]?\//m, 4], [/^diff --git /m, 6], [/^[+-](?![+-])/m, 0.5],
  ]],
  ['graphql', [
    [/^[^\S\n\r\u2028\u2029]*(query|mutation|subscription|fragment)\s*(\w+\s*)?(\(.*\)\s*)?(on \w+\s*)?\{/m, 5], [/^[^\S\n\r\u2028\u2029]*type\s+\w+\s*(implements\s+\w+\s*)?\{/m, 2], [/^[^\S\n\r\u2028\u2029]*schema\s*\{/m, 4],
  ]],
  ['lua', [
    [/^[^\S\n\r\u2028\u2029]*local\s+(function\s+)?\w+/m, 4], [/\bfunction\s+[\w.:]+\(.*\)\s*$/m, 1], [/\bthen\s*$/m, 2], [/~=/, 3], [/\bend\s*$/m, 1], [/\brequire\s*\(?["']/, 1], [/\bnil\b/, 1], [/\bipairs\(|\bpairs\(/, 4],
  ]],
  ['r', [
    [/\b\w+\s*<-\s*/, 3], [/\blibrary\(\w+\)/, 5], [/\bc\(/, 1], [/\b(data\.frame|ggplot|dplyr|tidyverse|summary)\(/, 4], [/%>%|\|>/, 2],
  ]],
  ['haskell', [
    [/^\w+\s*::\s*.+$/m, 4], [/::\s*\w+\s*->/, 3], [/^[^\S\n\r\u2028\u2029]*import\s+qualified\b/m, 5], [/^module\s+[\w.]+\s+where/m, 5], [/\bwhere\s*$/m, 1], [/<\$>|>>=/, 3], [/\bdata\s+\w+\s*=/, 2],
  ]],
  ['elixir', [
    [/^[^\S\n\r\u2028\u2029]*defmodule\s+[\w.]+\s+do/m, 6], [/^[^\S\n\r\u2028\u2029]*defp?\s+\w.*\bdo\s*$/m, 3], [/\|>/, 2], [/\b(IO\.puts|Enum\.\w+|%\{)/, 3],
  ]],
  ['dart', [
    [/^[^\S\n\r\u2028\u2029]*import\s+'package:[\w/.-]+';/m, 6], [/\bWidget\s+build\(BuildContext/, 6], [/\bsetState\(/, 3], [/@override\b/, 2], [/\bvoid\s+main\(\)/, 2], [/\bfinal\s+\w+(\s*<.+>)?\s+\w+\s*=/, 1], [/\bFuture<\w+>/, 2], [/\blate\s+\w+/, 3],
  ]],
  ['scala', [
    [/^[^\S\n\r\u2028\u2029]*object\s+\w+(\s+extends\s+\w+)?\s*\{/m, 3], [/\bdef\s+\w+(\[.+\])?\(.*\)\s*:\s*[\w\[\]]+\s*=/, 4], [/\bcase class\b/, 4], [/^[^\S\n\r\u2028\u2029]*import\s+scala\./m, 5], [/\bval\s+\w+\s*:\s*\w+/, 1],
  ]],
  ['clojure', [
    [/^[^\S\n\r\u2028\u2029]*\(defn-?\s/m, 5], [/^[^\S\n\r\u2028\u2029]*\(ns\s/m, 5], [/^[^\S\n\r\u2028\u2029]*\(def\s/m, 3], [/\(let\s*\[/, 3],
  ]],
  ['latex', [
    [/\\(begin|end)\{\w+\*?\}/, 4], [/\\(documentclass|usepackage|section|subsection|maketitle)\b/, 5], [/\\(frac|sum|int|alpha|beta|mathbb|mathrm|left|right)\b/, 2],
  ]],
  ['nginx', [
    [/^[^\S\n\r\u2028\u2029]*server\s*\{/m, 3], [/^[^\S\n\r\u2028\u2029]*listen\s+\d+/m, 3], [/^[^\S\n\r\u2028\u2029]*location\s+(?:[~=^]+\s+)?\S+\s*\{/m, 4], [/\bproxy_pass\b|\bserver_name\b|\broot\s+\//, 4],
  ]],
  ['protobuf', [
    [/^[^\S\n\r\u2028\u2029]*syntax\s*=\s*"proto[23]";/m, 6], [/^[^\S\n\r\u2028\u2029]*message\s+\w+\s*\{/m, 3], [/^[^\S\n\r\u2028\u2029]*(repeated|optional|required)\s+\w+\s+\w+\s*=\s*\d+;/m, 4],
  ]],
  ['solidity', [
    [/^[^\S\n\r\u2028\u2029]*pragma\s+solidity\b/m, 7], [/^[^\S\n\r\u2028\u2029]*contract\s+\w+/m, 3], [/\bmsg\.sender\b/, 4],
  ]],
  ['objectivec', [
    [/^[^\S\n\r\u2028\u2029]*@(interface|implementation|property|end|protocol)\b/m, 4], [/^[^\S\n\r\u2028\u2029]*#import\s+[<"]/m, 4], [/\bNS(String|Log|Array|Dictionary|Object)\b/, 4], [/\[\w+\s+\w+(:\w+)?\]/, 1],
  ]],
  ['perl', [
    [/^[^\S\n\r\u2028\u2029]*use\s+(strict|warnings);/m, 5], [/\bmy\s+[$@%]\w+/, 4], [/=~\s*[ms]?\//, 2], [/\$_\b/, 2],
  ]],
  ['matlab', [
    [/^[^\S\n\r\u2028\u2029]*function\s+(\[.*\]|\w+)\s*=\s*\w+\(/m, 4], [/\b(zeros|ones|linspace|plot|figure|disp)\(/, 2], [/^[^\S\n\r\u2028\u2029]*%/m, 1], [/\.\*|\.\^/, 2],
  ]],
  ['json', []],
];

function looksLikeJson(code: string): boolean {
  const first = code.charCodeAt(0);
  if (first !== 123 && first !== 91) return false;
  const last = code.charCodeAt(code.length - 1);
  if (!(first === 123 && last === 125) && !(first === 91 && last === 93)) return false;
  if (code.length > 200000) return true;
  try {
    JSON.parse(code);
    return true;
  } catch {
    return /^[{[]\s*"[\w$@-]+"\s*:/.test(code);
  }
}

/** Best guess for unlabelled code, or null when the evidence is weak. */
export function detectLanguage(source: string): string | null {
  const code = (source.length > 5000 ? source.slice(0, 5000) : source).trim();
  if (code.length < 8) return null;
  if (looksLikeJson(code)) return 'json';
  let best: string | null = null;
  let bestScore = 0;
  let second = 0;
  const scores = new Map<string, number>();
  for (const [lang, rules] of RULES) {
    let score = 0;
    for (const [pattern, weight] of rules) if (pattern.test(code)) score += weight;
    scores.set(lang, score);
  }
  // TypeScript is JavaScript with types; HTML-in-JS and CSS-in-SCSS likewise.
  const js = scores.get('javascript') ?? 0;
  const ts = scores.get('typescript') ?? 0;
  if (ts >= 3) scores.set('typescript', ts + js);
  const css = scores.get('css') ?? 0;
  const scss = scores.get('scss') ?? 0;
  if (scss >= 3) scores.set('scss', scss + css);
  const c = scores.get('c') ?? 0;
  const cpp = scores.get('cpp') ?? 0;
  if (cpp >= 4) scores.set('cpp', cpp + c);
  // Unified diffs without headers: most lines start with + or -, both present.
  const lines = code.split('\n');
  let plus = 0;
  let minus = 0;
  for (const line of lines) {
    const c0 = line.charCodeAt(0);
    const c1 = line.charCodeAt(1);
    if (c0 === 43 && c1 !== 43) plus++;
    else if (c0 === 45 && c1 !== 45) minus++;
  }
  if (plus > 0 && minus > 0 && lines.length >= 3 && plus + minus >= lines.length * 0.4) scores.set('diff', (scores.get('diff') ?? 0) + 6);
  // Terminal sessions: most non-empty lines start with a prompt.
  let prompts = 0;
  let nonEmpty = 0;
  let firstIsPrompt = false;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const prompt = /^\s*(?:[$%❯>]|PS [A-Z]:\\[^>]*>|[\w.-]+@[\w.-]+:[^$#]*[$#])\s/.test(line);
    if (nonEmpty === 0) firstIsPrompt = prompt;
    nonEmpty++;
    if (prompt) prompts++;
  }
  // A session opens with a prompt; what follows may be the command's output.
  if ((firstIsPrompt || prompts >= nonEmpty * 0.5) && prompts > 0 && !/^[^\S\n\r\u2028\u2029]*>>>/m.test(code)) scores.set('shell', (scores.get('shell') ?? 0) + 4);
  const bash = scores.get('bash') ?? 0;
  const shell = scores.get('shell') ?? 0;
  if (shell >= 3) scores.set('shell', shell + bash);
  for (const [lang, score] of scores) {
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = lang;
    } else if (score > second) {
      second = score;
    }
  }
  if (best === null || bestScore < 4) return null;
  if (bestScore - second < 2 && bestScore < second * 1.5) return null;
  return best;
}
