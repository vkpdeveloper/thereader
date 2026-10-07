import 'package:flutter_math_fork/tex.dart';

/// TeX as books carry it, made digestible for flutter_math_fork: delimiters
/// removed, LaTeX environments it lacks mapped to ones it has, and a few
/// widespread package macros defined. Book-specific macros are not guessed;
/// callers fall back to the publisher's own rendering when parsing fails.
abstract final class EpubTex {
  static final TexParserSettings settings = TexParserSettings(
    macros: {
      // physics / braket packages and common definitions.
      r'\ketbra': MacroDefinition.fromString(r'\left|#1\right\rangle\!\left\langle #2\right|'),
      r'\eqdef': MacroDefinition.fromString(r'\stackrel{\text{def}}{=}'),
      r'\mathbbm': MacroDefinition.fromString(r'\mathbb{#1}'),
      r'\Tr': MacroDefinition.fromString(r'\operatorname{Tr}'),
      r'\tr': MacroDefinition.fromString(r'\operatorname{tr}'),
      r'\emph': MacroDefinition.fromString(r'\textit{#1}'),
    },
  );

  static final _envs = RegExp(r'\\(begin|end)\{(align|alignat|flalign|eqnarray|gather|equation|displaymath|multline|split)(\*?)\}(\{\d+\})?');
  static final _label = RegExp(r'\\(?:label|vspace\*?)\s*\{[^{}]*\}');
  static final _tag = RegExp(r'\\tag\*?\s*\{([^{}]*)\}');

  /// Strips `\(…\)`, `\[…\]`, `$$…$$` and `$…$` around [tex] and rewrites
  /// what the parser does not know.
  static String normalize(String tex) {
    var s = stripDelimiters(tex);
    s = s.replaceAllMapped(_envs, (m) {
      final begin = m[1] == 'begin';
      switch (m[2]) {
        case 'equation' || 'displaymath':
          return '';
        case 'gather' || 'multline':
          return begin ? r'\begin{array}{c}' : r'\end{array}';
        case 'split':
          return begin ? r'\begin{aligned}' : r'\end{aligned}';
        default:
          return begin ? r'\begin{aligned}' : r'\end{aligned}';
      }
    });
    s = s.replaceAll(_label, '').replaceAll(r'\nonumber', '').replaceAll(r'\notag', '');
    return s.replaceAllMapped(_tag, (m) => r'\qquad(\text{' '${m[1]}' '})').trim();
  }

  static String stripDelimiters(String tex) {
    final s = tex.trim();
    for (final (open, close) in const [(r'\(', r'\)'), (r'\[', r'\]'), (r'$$', r'$$'), (r'$', r'$')]) {
      if (s.length >= open.length + close.length && s.startsWith(open) && s.endsWith(close)) {
        return s.substring(open.length, s.length - close.length).trim();
      }
    }
    return s;
  }

  /// The parsed formula, or null when flutter_math_fork cannot read it.
  /// Parsing up front lets callers choose a fallback before building.
  static SyntaxTree? tryParse(String tex) {
    if (tex.trim().isEmpty) return null;
    try {
      return SyntaxTree(greenRoot: TexParser(tex, settings).parse());
    } on Object {
      return null;
    }
  }

  static final _command = RegExp(r'\\[A-Za-z]+|\\[,;:!{}|]');
  static final _prose = RegExp(r'[A-Za-z]{2,}\s+[A-Za-z]{2,}\s+[A-Za-z]{2,}');
  static final _fileName = RegExp(r'\.(?:png|jpe?g|gif|svg|webp)$', caseSensitive: false);

  /// Whether an image `alt` reads as TeX. Outside a known equation context
  /// ([mathContext]) it needs a command such as `\vec`; prose descriptions
  /// are never taken as TeX unless they carry one inside a formula.
  static bool looksLikeTex(String alt, {required bool mathContext}) {
    final s = alt.trim();
    if (s.isEmpty || s.length > 4000 || _fileName.hasMatch(s)) return false;
    if (mathContext) return _command.hasMatch(s) || !_prose.hasMatch(s);
    return _command.hasMatch(s) && !_prose.hasMatch(s);
  }
}
