import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:re_highlight/languages/ada.dart';
import 'package:re_highlight/languages/apache.dart';
import 'package:re_highlight/languages/armasm.dart';
import 'package:re_highlight/languages/awk.dart';
import 'package:re_highlight/languages/bash.dart';
import 'package:re_highlight/languages/c.dart';
import 'package:re_highlight/languages/clojure.dart';
import 'package:re_highlight/languages/cmake.dart';
import 'package:re_highlight/languages/coq.dart';
import 'package:re_highlight/languages/cpp.dart';
import 'package:re_highlight/languages/crystal.dart';
import 'package:re_highlight/languages/csharp.dart';
import 'package:re_highlight/languages/css.dart';
import 'package:re_highlight/languages/d.dart';
import 'package:re_highlight/languages/dart.dart';
import 'package:re_highlight/languages/delphi.dart';
import 'package:re_highlight/languages/diff.dart';
import 'package:re_highlight/languages/dockerfile.dart';
import 'package:re_highlight/languages/dos.dart';
import 'package:re_highlight/languages/elixir.dart';
import 'package:re_highlight/languages/elm.dart';
import 'package:re_highlight/languages/erb.dart';
import 'package:re_highlight/languages/erlang.dart';
import 'package:re_highlight/languages/fortran.dart';
import 'package:re_highlight/languages/fsharp.dart';
import 'package:re_highlight/languages/go.dart';
import 'package:re_highlight/languages/graphql.dart';
import 'package:re_highlight/languages/groovy.dart';
import 'package:re_highlight/languages/haskell.dart';
import 'package:re_highlight/languages/haxe.dart';
import 'package:re_highlight/languages/http.dart';
import 'package:re_highlight/languages/ini.dart';
import 'package:re_highlight/languages/java.dart';
import 'package:re_highlight/languages/javascript.dart';
import 'package:re_highlight/languages/json.dart';
import 'package:re_highlight/languages/julia.dart';
import 'package:re_highlight/languages/kotlin.dart';
import 'package:re_highlight/languages/latex.dart';
import 'package:re_highlight/languages/less.dart';
import 'package:re_highlight/languages/lisp.dart';
import 'package:re_highlight/languages/lua.dart';
import 'package:re_highlight/languages/makefile.dart';
import 'package:re_highlight/languages/markdown.dart';
import 'package:re_highlight/languages/matlab.dart';
import 'package:re_highlight/languages/mipsasm.dart';
import 'package:re_highlight/languages/nginx.dart';
import 'package:re_highlight/languages/nim.dart';
import 'package:re_highlight/languages/nix.dart';
import 'package:re_highlight/languages/objectivec.dart';
import 'package:re_highlight/languages/ocaml.dart';
import 'package:re_highlight/languages/perl.dart';
import 'package:re_highlight/languages/pgsql.dart';
import 'package:re_highlight/languages/php.dart';
import 'package:re_highlight/languages/plaintext.dart';
import 'package:re_highlight/languages/powershell.dart';
import 'package:re_highlight/languages/prolog.dart';
import 'package:re_highlight/languages/properties.dart';
import 'package:re_highlight/languages/protobuf.dart';
import 'package:re_highlight/languages/python.dart';
import 'package:re_highlight/languages/r.dart';
import 'package:re_highlight/languages/reasonml.dart';
import 'package:re_highlight/languages/ruby.dart';
import 'package:re_highlight/languages/rust.dart';
import 'package:re_highlight/languages/scala.dart';
import 'package:re_highlight/languages/scheme.dart';
import 'package:re_highlight/languages/scss.dart';
import 'package:re_highlight/languages/shell.dart';
import 'package:re_highlight/languages/sql.dart';
import 'package:re_highlight/languages/stylus.dart';
import 'package:re_highlight/languages/swift.dart';
import 'package:re_highlight/languages/tcl.dart';
import 'package:re_highlight/languages/typescript.dart';
import 'package:re_highlight/languages/vala.dart';
import 'package:re_highlight/languages/vbnet.dart';
import 'package:re_highlight/languages/vbscript.dart';
import 'package:re_highlight/languages/vim.dart';
import 'package:re_highlight/languages/wasm.dart';
import 'package:re_highlight/languages/x86asm.dart';
import 'package:re_highlight/languages/xml.dart';
import 'package:re_highlight/languages/yaml.dart';
import 'package:re_highlight/re_highlight.dart';
import 'package:thereader_extract/thereader_extract.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import 'article_style.dart';

/// Highlighted source as plain data (text, innermost scope), so it can be
/// produced on a background isolate.
typedef CodeTokens = List<(String, String?)>;

@immutable
class HighlightedCode {
  const HighlightedCode(this.language, this.tokens);

  /// The grammar actually used, or null for plain text.
  final String? language;
  final CodeTokens tokens;
}

final Map<String, Mode> _grammars = {
  'ada': langAda, 'apache': langApache, 'armasm': langArmasm, 'awk': langAwk, 'bash': langBash, 'c': langC, //
  'clojure': langClojure, 'cmake': langCmake, 'coq': langCoq, 'cpp': langCpp, 'crystal': langCrystal,
  'csharp': langCsharp, 'css': langCss, 'd': langD, 'dart': langDart, 'delphi': langDelphi, 'diff': langDiff,
  'dockerfile': langDockerfile, 'dos': langDos, 'elixir': langElixir, 'elm': langElm, 'erb': langErb,
  'erlang': langErlang, 'fortran': langFortran, 'fsharp': langFsharp, 'go': langGo, 'graphql': langGraphql,
  'groovy': langGroovy, 'haskell': langHaskell, 'haxe': langHaxe, 'http': langHttp, 'ini': langIni, 'java': langJava,
  'javascript': langJavascript, 'json': langJson, 'julia': langJulia, 'kotlin': langKotlin, 'latex': langLatex,
  'less': langLess, 'lisp': langLisp, 'lua': langLua, 'makefile': langMakefile, 'markdown': langMarkdown,
  'matlab': langMatlab, 'mipsasm': langMipsasm, 'nginx': langNginx, 'nim': langNim, 'nix': langNix,
  'objectivec': langObjectivec, 'ocaml': langOcaml, 'perl': langPerl, 'pgsql': langPgsql, 'php': langPhp,
  'plaintext': langPlaintext, 'powershell': langPowershell, 'prolog': langProlog, 'properties': langProperties,
  'protobuf': langProtobuf, 'python': langPython, 'r': langR, 'reasonml': langReasonml, 'ruby': langRuby,
  'rust': langRust, 'scala': langScala, 'scheme': langScheme, 'scss': langScss, 'shell': langShell, 'sql': langSql,
  'stylus': langStylus, 'swift': langSwift, 'tcl': langTcl, 'typescript': langTypescript, 'vala': langVala,
  'vbnet': langVbnet, 'vbscript': langVbscript, 'vim': langVim, 'wasm': langWasm, 'x86asm': langX86Asm,
  'xml': langXml, 'yaml': langYaml,
};

/// Grammars tried when the page named no language. Kept to languages that
/// articles commonly show, which also keeps detection fast.
const _autodetect = [
  'bash', 'c', 'cpp', 'csharp', 'css', 'dart', 'diff', 'dockerfile', 'go', 'java', 'javascript', 'json', 'kotlin', //
  'makefile', 'php', 'python', 'ruby', 'rust', 'scss', 'shell', 'sql', 'swift', 'typescript', 'xml', 'yaml',
];

Highlight? _instance;
Highlight get _highlight => _instance ??= Highlight()..registerLanguages(_grammars);

/// The bundled grammar for an extractor language id. Ids are highlight.js
/// names; `html` resolves through highlight.js's own alias to `xml`.
String? grammarFor(String language) => _highlight.getLanguage(language) == null ? null : language;

/// Highlights [code] in [language], or detects the language when it is null
/// and keeps the result only when detection is confident.
HighlightedCode highlightCode(String code, String? language) {
  final plain = HighlightedCode(null, [(code, null)]);
  final grammar = language == null ? null : grammarFor(language);
  if (language != null && (grammar == null || _highlight.getLanguage(grammar) == langPlaintext)) return plain;
  final HighlightResult result;
  if (grammar != null) {
    result = _highlight.highlight(code: code, language: grammar);
  } else {
    final best = _highlight.highlightAuto(code, _autodetect);
    final runnerUp = best.secondBest?.relevance ?? 0;
    if (best.language == null || best.relevance < 8 || best.relevance - runnerUp < 3) return plain;
    result = best;
  }
  final renderer = _TokenRenderer();
  result.render(renderer);
  return HighlightedCode(result.language ?? grammar, renderer.tokens);
}

HighlightedCode _highlightInBackground((String, String?) input) => highlightCode(input.$1, input.$2);

class _TokenRenderer implements HighlightRenderer {
  final CodeTokens tokens = [];
  final List<String?> _scopes = [];

  @override
  void addText(String text) {
    String? scope;
    for (var i = _scopes.length - 1; i >= 0 && scope == null; i--) {
      scope = _scopes[i];
    }
    tokens.add((text, scope));
  }

  @override
  void openNode(DataNode node) => _scopes.add(node.scope);

  @override
  void closeNode(DataNode node) => _scopes.removeLast();
}

/// Theme-matched token colours: the preset's accents in One Dark roles.
TextStyle? codeTokenStyle(String scope, AppColors c) {
  final root = scope.split(RegExp(r'[.\s]')).first;
  return switch (root) {
    'comment' || 'quote' => TextStyle(color: c.subtle, fontStyle: FontStyle.italic),
    'keyword' || 'selector-tag' || 'doctag' => TextStyle(color: c.purple),
    'string' || 'regexp' || 'addition' => TextStyle(color: c.green),
    'number' || 'literal' || 'attr' || 'attribute' || 'selector-attr' || 'selector-pseudo' => TextStyle(color: c.orange),
    'title' when scope.startsWith('title.class') => TextStyle(color: c.cyan),
    'title' || 'function' || 'section' => TextStyle(color: c.blue),
    'built_in' || 'type' || 'class' || 'selector-class' => TextStyle(color: c.cyan),
    'name' || 'tag' || 'selector-id' || 'deletion' || 'variable' || 'template-variable' => TextStyle(color: c.pink),
    'symbol' || 'bullet' || 'link' || 'meta' || 'char' => TextStyle(color: c.cyan),
    'emphasis' => const TextStyle(fontStyle: FontStyle.italic),
    'strong' => const TextStyle(fontWeight: FontWeight.w700),
    _ => null,
  };
}

const _labels = {
  'javascript': 'JavaScript', 'typescript': 'TypeScript', 'python': 'Python', 'bash': 'Shell', 'shell': 'Console', //
  'cpp': 'C++', 'csharp': 'C#', 'c': 'C', 'go': 'Go', 'rust': 'Rust', 'java': 'Java', 'kotlin': 'Kotlin',
  'swift': 'Swift', 'ruby': 'Ruby', 'php': 'PHP', 'html': 'HTML', 'xml': 'XML', 'css': 'CSS', 'scss': 'SCSS',
  'json': 'JSON', 'yaml': 'YAML', 'toml': 'TOML', 'sql': 'SQL', 'markdown': 'Markdown', 'dockerfile': 'Dockerfile',
  'diff': 'Diff', 'dart': 'Dart', 'objectivec': 'Objective-C', 'graphql': 'GraphQL', 'jsx': 'JSX', 'tsx': 'TSX',
  'powershell': 'PowerShell', 'latex': 'LaTeX', 'makefile': 'Makefile', 'lua': 'Lua', 'elixir': 'Elixir',
  'haskell': 'Haskell', 'scala': 'Scala', 'perl': 'Perl', 'r': 'R', 'julia': 'Julia', 'nginx': 'Nginx',
};

/// A code block: language label, copy button, horizontal scroll, monospace
/// text highlighted in the theme's colours. Highlighting is cached per block;
/// detection and very long blocks run on a background isolate.
class CodeBlockView extends StatefulWidget {
  const CodeBlockView({super.key, required this.block});

  final CodeBlock block;

  @override
  State<CodeBlockView> createState() => _CodeBlockViewState();
}

class _CodeBlockViewState extends State<CodeBlockView> {
  static final _cache = Expando<HighlightedCode>();
  HighlightedCode? _code;
  bool _copied = false;
  Timer? _copiedReset;

  @override
  void initState() {
    super.initState();
    _highlightBlock();
  }

  @override
  void didUpdateWidget(CodeBlockView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.block, widget.block)) _highlightBlock();
  }

  void _highlightBlock() {
    final block = widget.block;
    _code = _cache[block];
    if (_code != null) return;
    if (block.language != null && block.code.length <= 8000) {
      _code = _cache[block] = highlightCode(block.code, block.language);
      return;
    }
    compute(_highlightInBackground, (block.code, block.language)).then((code) {
      _cache[block] = code;
      if (mounted && identical(widget.block, block)) setState(() => _code = code);
    }, onError: (Object e) => debugPrint('[articles] highlight failed: $e'));
  }

  @override
  void dispose() {
    _copiedReset?.cancel();
    super.dispose();
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.block.code));
    if (!mounted) return;
    setState(() => _copied = true);
    _copiedReset?.cancel();
    _copiedReset = Timer(const Duration(milliseconds: 1500), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final style = ArticleScope.of(context).style;
    final colors = style.colors;
    final block = widget.block;
    final language = block.language ?? _code?.language;
    final label = [
      if (block.title != null) block.title!,
      if (language != null) _labels[language] ?? language,
    ].join('  ·  ');
    final tokens = _code?.tokens ?? [(block.code, null)];
    final spans = <TextSpan>[];
    for (var i = 0; i < tokens.length; i++) {
      var (text, scope) = tokens[i];
      if (i == tokens.length - 1) text = text.replaceFirst(RegExp(r'\n+$'), '');
      spans.add(TextSpan(text: text.replaceAll('\t', '    '), style: scope == null ? null : codeTokenStyle(scope, colors)));
    }
    final caption = Theme.of(context).textTheme.labelSmall?.copyWith(color: colors.muted, letterSpacing: 0.2);
    return Directionality(
      textDirection: TextDirection.ltr,
      child: Container(
        decoration: BoxDecoration(
          color: colors.panel,
          border: Border.all(color: colors.border),
          borderRadius: const BorderRadius.all(Radii.md),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.only(left: 14),
              child: Row(
                children: [
                  Expanded(child: Text(label, style: caption, maxLines: 1, overflow: TextOverflow.ellipsis)),
                  IconButton(
                    onPressed: _copy,
                    tooltip: _copied ? 'Copied' : 'Copy code',
                    icon: Icon(_copied ? Icons.check : Icons.copy_rounded, size: 16, color: _copied ? colors.green : colors.muted),
                    constraints: const BoxConstraints(minWidth: 40, minHeight: 36),
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: colors.border),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
              child: Text.rich(TextSpan(style: style.mono, children: spans), softWrap: false),
            ),
          ],
        ),
      ),
    );
  }
}
