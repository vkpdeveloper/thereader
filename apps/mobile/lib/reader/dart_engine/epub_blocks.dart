import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_math_fork/ast.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_widget_from_html_core/flutter_widget_from_html_core.dart';
import 'package:html/dom.dart' as dom;
import 'package:html/parser.dart' as html;

import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import '../../features/articles/article_code.dart' show HighlightedCode, codeTokenStyle, grammarFor, highlightCode;
import 'epub_chapter.dart';
import 'epub_package.dart';
import 'epub_svg.dart';
import 'epub_tex.dart';
import 'garbled_math.dart';
import 'mathml_tex.dart';

/// Native widgets for what plain HTML rendering gets wrong in technical
/// books: MathML and TeX as typeset math, `<pre>` as a scrolling code panel,
/// and equation images whose dark ink would vanish on the reader's canvas.
class EpubContentBuilder {
  EpubContentBuilder({required this.package, required this.href, required this.textStyle, required this.colors});

  final EpubPackage package;

  /// Spine document the elements come from; image paths resolve against it.
  final String href;
  final TextStyle textStyle;
  final AppColors colors;

  double get _em => textStyle.fontSize ?? 18;

  Widget? build(dom.Element element) {
    // Hidden elements fall through to the `display: none` style.
    if (element.attributes.containsKey(EpubMarks.hidden)) return null;
    final name = (element.localName ?? '').split(':').last;
    switch (name) {
      case 'math':
        return _mathml(element);
      case 'pre':
        return _code(element);
      case 'img':
        return _image(element);
      case 'svg':
        return _inlineSvg(element);
      case 'object' || 'embed':
        return _embedded(element);
      case 'mjx-container':
        return _rendered(element);
    }
    final mathml = element.attributes[EpubMarks.mathml];
    if (mathml != null) return _encodedMathml(mathml, _isDisplayElement(element) || _isRenderedDisplay(element));
    if (_isRendered(element)) return _rendered(element);
    final formula = _attributeFormula(element);
    if (formula != null) return formula;
    if ((name == 'span' || name == 'div') && element.classes.contains('math')) return _texSource(element);
    return null;
  }

  Widget? _mathml(dom.Element math, {bool? display}) {
    display ??= MathmlTex.isDisplay(math);
    final annotation = MathmlTex.annotation(math);
    final alttext = math.attributes['alttext'];
    for (final tex in [?annotation, MathmlTex.convert(math), ?alttext]) {
      final ast = EpubTex.tryParse(EpubTex.normalize(tex));
      if (ast != null) return _formula(ast, display: display);
    }
    return null;
  }

  // ------------------------------------------------------------ rendered maths

  static final _mathJaxFrame = RegExp(r'(^|\s)(MathJax|MathJax_CHTML|MathJax_SVG|MathJax_PHTML|mjx-chtml)(\s|$)');
  static final _mathJaxDisplay = RegExp(r'(^|\s)(MathJax_Display|MathJax_SVG_Display|MJXc-display|katex-display)(\s|$)');

  /// KaTeX output or a MathJax 2 frame. Without the library's stylesheet and
  /// fonts their HTML is glyph soup; the MathML they carry is shown instead.
  static bool _isRendered(dom.Element e) =>
      e.classes.contains('katex') || (e.id.endsWith('-Frame') && _mathJaxFrame.hasMatch(e.className));

  static bool _isRenderedDisplay(dom.Element e) =>
      e.attributes['display'] == 'true' || _mathJaxDisplay.hasMatch(e.className) || _mathJaxDisplay.hasMatch(e.parent?.className ?? '');

  Widget? _rendered(dom.Element e) {
    final display = _isRenderedDisplay(e);
    final math = _firstMath(e);
    if (math != null) return _mathml(math, display: display || MathmlTex.isDisplay(math));
    final svg = e.children.where((c) => c.localName == 'svg').firstOrNull;
    return svg == null ? null : _inlineSvg(svg, mathContext: true, display: display);
  }

  static dom.Element? _firstMath(dom.Element e) {
    final stack = [e];
    for (var seen = 0; stack.isNotEmpty && seen < 20000; seen++) {
      final el = stack.removeLast();
      if (el != e && (el.localName ?? '').split(':').last == 'math') return el;
      stack.addAll(el.children.reversed);
    }
    return null;
  }

  /// MathML kept as a string (`data-mathml`, a `math/mml` script; see
  /// [EpubMarks.mathml]), parsed inertly.
  Widget? _encodedMathml(String encoded, bool display) {
    final String source;
    try {
      source = Uri.decodeComponent(encoded);
    } on ArgumentError {
      return null;
    }
    if (source.length > 64000 || !RegExp(r'^\s*<(\w+:)?math[\s>/]').hasMatch(source)) return null;
    final holder = dom.Element.tag('div')..nodes.addAll(html.parseFragment(source, container: 'div').nodes.toList());
    final math = _firstMath(holder);
    return math == null ? null : _mathml(math, display: display || MathmlTex.isDisplay(math));
  }

  static const _texAttributes = ['data-tex', 'data-latex'];
  static const _looseTexAttributes = ['data-equation', 'data-formula', 'data-math'];
  static final _texSignal = RegExp(r'\\[A-Za-z]+|\\[{}|,;:!]|[_^]|\{[^{}]*\}');

  /// TeX kept in attributes (`data-tex`, `data-latex`; `data-equation` only
  /// when it reads as TeX, not an equation number). `data-mathml` is read
  /// as [EpubMarks.mathml].
  /// Elements holding MathML of their own keep it.
  Widget? _attributeFormula(dom.Element e) {
    final attrs = e.attributes;
    if (!attrs.keys.any((k) => k is String && k.startsWith('data-'))) return null;
    String? tex;
    for (final a in _texAttributes) {
      final v = attrs[a]?.trim();
      if (tex == null && v != null && v.isNotEmpty) tex = v;
    }
    for (final a in _looseTexAttributes) {
      final v = attrs[a]?.trim();
      if (tex == null && v != null && v.length <= 4000 && _texSignal.hasMatch(v)) tex = v;
    }
    if (tex == null || _firstMath(e) != null) return null;
    final display = _isDisplayElement(e);
    final ast = EpubTex.tryParse(EpubTex.normalize(tex));
    return ast == null ? null : _formula(ast, display: display);
  }

  static const _blockTags = {'div', 'p', 'figure', 'section', 'blockquote', 'li', 'td', 'th', 'dd', 'dt'};

  static bool _isDisplayElement(dom.Element e) {
    final mode = (e.attributes['data-display'] ?? e.attributes['data-mode'] ?? '').toLowerCase();
    if (mode == 'block' || mode == 'display' || mode == 'true') return true;
    if (mode == 'inline' || mode == 'false') return false;
    if (e.classes.contains('display')) return true;
    return _blockTags.contains(e.localName) || _ancestors(e).take(3).any((a) => _displayClass.hasMatch(a.className));
  }

  // ------------------------------------------------------------ SVG

  /// An inline `<svg>`: formulas drawn in black follow the reading ink;
  /// other drawings keep their paint. Rendered by flutter_svg.
  Widget? _inlineSvg(dom.Element svg, {bool mathContext = false, bool? display}) {
    var source = svg.outerHtml;
    if (!source.contains('xmlns=')) source = source.replaceFirst('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    final parsed = EpubSvg.parse(source);
    if (parsed == null) return null;
    final context = mathContext || _ancestors(svg).any((a) => _mathClass.hasMatch(a.className) || a.localName == 'mjx-container');
    final formula = EpubSvg.looksLikeFormula(parsed, mathContext: context);
    final drawn = (formula ? EpubSvg.inked(parsed) : null) ?? source;
    final width = EpubSvg.length(parsed.getAttribute('width'), _em);
    final height = EpubSvg.length(parsed.getAttribute('height'), _em);
    final picture = _svgPicture(drawn, width: width, height: height, label: null);
    if (display ?? _isDisplayImage(svg)) return _displayBox(picture);
    return InlineCustomWidget(alignment: PlaceholderAlignment.middle, child: picture);
  }

  Widget _svgPicture(String source, {double? width, double? height, String? label}) {
    // A drawing never overflows the column.
    final maxWidth = 680.0;
    if (width != null && width > maxWidth) {
      if (height != null) height = height * maxWidth / width;
      width = maxWidth;
    }
    return SvgPicture.string(
      source,
      width: width,
      height: height,
      theme: SvgTheme(currentColor: colors.ink, fontSize: _em),
      semanticsLabel: label,
      errorBuilder: (context, error, stack) => const SizedBox.shrink(),
    );
  }

  /// An SVG file (`<img src=…svg>`, `<object>`): monochrome dark drawings
  /// follow the reading ink, as formula images do on the web.
  Widget? _svgImage(String path, {double? emHeight, required bool display, String? alt}) {
    final bytes = package.readBytes(path);
    if (bytes == null || bytes.length > EpubSvg.maxLength) return null;
    final String source;
    try {
      source = utf8.decode(bytes, allowMalformed: true);
    } on Object {
      return null;
    }
    final parsed = EpubSvg.parse(source);
    if (parsed == null) return null;
    final drawn = EpubSvg.inked(parsed) ?? source;
    final height = emHeight != null ? emHeight * _em : EpubSvg.length(parsed.getAttribute('height'), _em);
    final width = emHeight != null ? null : EpubSvg.length(parsed.getAttribute('width'), _em);
    final picture = _svgPicture(drawn, width: width, height: height, label: alt == null || alt.isEmpty ? null : alt);
    if (display) return _displayBox(picture);
    return InlineCustomWidget(alignment: PlaceholderAlignment.middle, child: picture);
  }

  static final _imageFile = RegExp(r'\.(svg|png|gif|jpe?g|webp)$', caseSensitive: false);

  /// `<object data=…>` / `<embed src=…>` showing an image in the book: the
  /// image, in place of the plugin and its fallback.
  Widget? _embedded(dom.Element e) {
    final url = (e.attributes[e.localName == 'object' ? 'data' : 'src'] ?? '').trim();
    final type = (e.attributes['type'] ?? '').toLowerCase();
    if (url.isEmpty || RegExp(r'^[a-z][\w+.-]*:|^//', caseSensitive: false).hasMatch(url)) return null;
    if (!type.startsWith('image/') && !_imageFile.hasMatch(url.split(RegExp('[?#]')).first)) return null;
    final String path;
    try {
      path = package.resolve(href, url);
    } on ArgumentError {
      return null;
    }
    final emHeight = double.tryParse(e.attributes[EpubMarks.emHeight] ?? '');
    final display = _isDisplayImage(e);
    if (path.toLowerCase().endsWith('.svg')) return _svgImage(path, emHeight: emHeight, display: display, alt: e.attributes['title']);
    final bytes = package.readBytes(path);
    if (bytes == null) return null;
    final image = InkAdaptiveImage(
      package: package,
      path: path,
      ink: colors.ink,
      child: Image.memory(bytes, height: emHeight == null ? null : emHeight * _em),
    );
    return display ? _displayBox(image) : InlineCustomWidget(alignment: PlaceholderAlignment.middle, child: image);
  }

  /// Pandoc `span.math`, converted MathJax scripts, `$$…$$` runs and decoded garbled formulas.
  Widget? _texSource(dom.Element span) {
    // A garbled PDF formula keeps its original text as children and its reading here.
    final raw = (span.attributes[GarbledMath.texAttr] ?? span.text).trim();
    final display = span.classes.contains('display') || raw.startsWith(r'\[') || raw.startsWith(r'$$');
    if (!display && !span.classes.contains('inline')) return null;
    final ast = EpubTex.tryParse(EpubTex.normalize(raw));
    return ast == null ? null : _formula(ast, display: display);
  }

  static final _mathClass = RegExp(r'math|equation|formula|eqn', caseSensitive: false);
  static final _displayClass = RegExp(r'display|equation|eqn', caseSensitive: false);

  Widget? _image(dom.Element img) {
    final emHeight = double.tryParse(img.attributes[EpubMarks.emHeight] ?? '');
    // Pandoc's --webtex puts the class on the image itself.
    final mathContext = emHeight != null || _mathClass.hasMatch(img.className) || _ancestors(img).any((a) => _mathClass.hasMatch(a.className));
    final alt = img.attributes['alt'] ?? '';
    final display = _isDisplayImage(img);
    if (EpubTex.looksLikeTex(alt, mathContext: mathContext)) {
      final ast = EpubTex.tryParse(EpubTex.normalize(alt));
      if (ast != null) return _formula(ast, display: display);
    }
    final src = img.attributes['src'] ?? '';
    // The HTML widget cannot decode SVG files.
    if (src.split(RegExp('[?#]')).first.toLowerCase().endsWith('.svg')) {
      try {
        return _svgImage(package.resolve(href, src), emHeight: emHeight, display: display, alt: alt);
      } on ArgumentError {
        return null;
      }
    }
    // Inline equation images keep their em size instead of becoming blocks.
    if (emHeight == null) return null;
    final path = package.resolve(href, src);
    final bytes = package.readBytes(path);
    if (bytes == null) return null;
    final image = InkAdaptiveImage(
      package: package,
      path: path,
      ink: colors.ink,
      child: Image.memory(bytes, height: emHeight * _em, semanticLabel: alt.isEmpty ? null : alt),
    );
    if (display) return _displayBox(image);
    return InlineCustomWidget(alignment: PlaceholderAlignment.middle, child: image);
  }

  static Iterable<dom.Element> _ancestors(dom.Element e) sync* {
    var p = e.parent;
    for (var i = 0; p != null && i < 5; i++, p = p.parent) {
      yield p;
    }
  }

  static const _inlineWrappers = {'span', 'a', 'b', 'i', 'em', 'strong', 'sub', 'sup', 'font'};

  /// Inside a display-math container, or alone in its own block.
  static bool _isDisplayImage(dom.Element img) {
    if (_ancestors(img).any((a) => _displayClass.hasMatch(a.className))) return true;
    if (RegExp(r'(^|\s)display(\s|$)').hasMatch(img.className)) return true;
    var block = img.parent;
    while (block != null && _inlineWrappers.contains(block.localName)) {
      block = block.parent;
    }
    if (block == null || block.localName == 'body') return false;
    return block.text.trim().isEmpty && block.getElementsByTagName('img').length == 1;
  }

  Widget _formula(SyntaxTree ast, {required bool display}) {
    final math = Math(
      ast: ast,
      mathStyle: display ? MathStyle.display : MathStyle.text,
      textStyle: textStyle.copyWith(height: 1),
    );
    if (display) return _displayBox(math);
    return InlineCustomWidget(child: _InlineMath(child: math));
  }

  /// Centred, scrolling sideways when wider than the column, never clipped.
  Widget _displayBox(Widget child) => Padding(
        // Paragraph margins sit above; balance them below.
        padding: EdgeInsets.only(top: _em * 0.25, bottom: _em * 0.9),
        child: LayoutBuilder(
          builder: (context, constraints) => SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            physics: const ClampingScrollPhysics(),
            child: ConstrainedBox(
              constraints: BoxConstraints(minWidth: constraints.maxWidth),
              child: Center(child: child),
            ),
          ),
        ),
      );

  Widget? _code(dom.Element pre) {
    final code = _codeText(pre).replaceFirst(RegExp(r'^\n'), '').replaceFirst(RegExp(r'\s+$'), '');
    if (code.isEmpty) return null;
    return EpubCodeBlock(code: code, language: codeLanguage(pre), colors: colors, fontSize: _em);
  }

  static String _codeText(dom.Node node) {
    final out = StringBuffer();
    void walk(dom.Node n) {
      for (final c in n.nodes) {
        if (c is dom.Text) {
          out.write(c.data);
        } else if (c is dom.Element) {
          if (c.localName == 'br') {
            out.write('\n');
          } else if (!c.attributes.containsKey(EpubMarks.hidden)) {
            walk(c);
          }
        }
      }
    }

    walk(node);
    return out.toString();
  }

  static const _notLanguages = {'code', 'pre', 'sourcecode', 'source', 'programlisting', 'listing', 'text', 'plain', 'none'};

  /// The language a block declares: `language-x`/`lang-x` classes (on the
  /// `<pre>` or its `<code>`), pandoc's `sourceCode x`, `brush: x`, or
  /// `data-lang`-style attributes. Null leaves it to detection.
  @visibleForTesting
  static String? codeLanguage(dom.Element pre) {
    final elements = [pre, ...pre.children.where((c) => c.localName == 'code')];
    for (final e in elements) {
      for (final attr in const ['data-code-language', 'data-language', 'data-lang']) {
        final v = e.attributes[attr]?.trim().toLowerCase();
        if (v != null && v.isNotEmpty && grammarFor(v) != null) return v;
      }
      final classes = e.className.toLowerCase().replaceAll(RegExp(r'brush:\s*'), 'brush-').split(RegExp(r'[\s;]+'));
      final pandoc = classes.contains('sourcecode');
      for (final c in classes) {
        final m = RegExp(r'^(?:language|lang|brush|highlight)-(.+)$').firstMatch(c);
        final name = m?[1] ?? (pandoc && c.length > 1 && !_notLanguages.contains(c) ? c : null);
        if (name != null && grammarFor(name) != null) return name;
      }
    }
    return null;
  }
}

/// `invert(1) hue-rotate(180deg)`, scaled so black ink lands on [ink]:
/// lightness flips, hues stay roughly where they were.
List<double> inkInversionMatrix(Color ink) {
  final r = ink.r;
  final g = ink.g;
  final b = ink.b;
  return [
    0.574 * r, -1.430 * r, -0.144 * r, 0, 255 * r, //
    -0.426 * g, -0.430 * g, -0.144 * g, 0, 255 * g,
    -0.426 * b, -1.430 * b, 0.856 * b, 0, 255 * b,
    0, 0, 0, 1, 0,
  ];
}

/// Inline math sits on the text baseline; a formula wider than the line
/// scales down rather than overflowing the column.
class _InlineMath extends SingleChildRenderObjectWidget {
  const _InlineMath({required Widget super.child});

  @override
  RenderObject createRenderObject(BuildContext context) => _RenderInlineMath();
}

class _RenderInlineMath extends RenderProxyBox {
  double _scale = 1;

  @override
  void performLayout() {
    final child = this.child!;
    child.layout(BoxConstraints(maxHeight: constraints.maxHeight), parentUsesSize: true);
    final width = child.size.width;
    _scale = width > constraints.maxWidth && width > 0 ? constraints.maxWidth / width : 1;
    size = constraints.constrain(child.size * _scale);
  }

  @override
  Size computeDryLayout(BoxConstraints constraints) {
    final size = child!.getDryLayout(BoxConstraints(maxHeight: constraints.maxHeight));
    final scale = size.width > constraints.maxWidth && size.width > 0 ? constraints.maxWidth / size.width : 1.0;
    return constraints.constrain(size * scale);
  }

  @override
  double? computeDistanceToActualBaseline(TextBaseline baseline) {
    final d = child?.getDistanceToActualBaseline(baseline);
    return d == null ? null : d * _scale;
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    if (_scale == 1) return super.paint(context, offset);
    context.pushTransform(needsCompositing, offset, Matrix4.diagonal3Values(_scale, _scale, 1), (context, offset) {
      context.paintChild(child!, offset);
    });
  }

  @override
  void applyPaintTransform(RenderBox child, Matrix4 transform) {
    transform.scaleByDouble(_scale, _scale, 1, 1);
  }

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) => false;
}

/// A `<pre>` block: theme panel, rounded corners, monospace, whitespace kept
/// and scrolled sideways instead of wrapped mid-token. Declared languages
/// highlight immediately; undeclared ones are detected off the UI thread
/// and stay plain unless detection is confident.
class EpubCodeBlock extends StatefulWidget {
  const EpubCodeBlock({super.key, required this.code, required this.language, required this.colors, required this.fontSize});

  final String code;
  final String? language;
  final AppColors colors;

  /// Body text size; code is set a little smaller.
  final double fontSize;

  @override
  State<EpubCodeBlock> createState() => _EpubCodeBlockState();
}

HighlightedCode _highlightOffThread((String, String?) input) => highlightCode(input.$1, input.$2);

class _EpubCodeBlockState extends State<EpubCodeBlock> {
  static final _cache = <String, HighlightedCode>{};

  /// Detection runs one block at a time: a chapter can hold a hundred.
  static Future<void> _queue = Future.value();

  HighlightedCode? _code;

  String get _key => '${widget.language}\u0000${widget.code}';

  @override
  void initState() {
    super.initState();
    _highlight();
  }

  @override
  void didUpdateWidget(EpubCodeBlock oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.code != widget.code || oldWidget.language != widget.language) _highlight();
  }

  void _highlight() {
    final key = _key;
    _code = _cache[key];
    if (_code != null) return;
    if (widget.language != null && widget.code.length <= 8000) {
      _code = _remember(key, highlightCode(widget.code, widget.language));
      return;
    }
    final input = (widget.code, widget.language);
    _queue = _queue.then((_) async {
      if (!mounted || _key != key) return;
      try {
        final code = _remember(key, await compute(_highlightOffThread, input));
        if (mounted && _key == key) setState(() => _code = code);
      } on Object catch (e) {
        debugPrint('[reader] code highlight failed: $e');
      }
    });
  }

  static HighlightedCode _remember(String key, HighlightedCode code) {
    _cache[key] = code;
    if (_cache.length > 300) _cache.remove(_cache.keys.first);
    return code;
  }

  @override
  Widget build(BuildContext context) {
    final colors = widget.colors;
    final tokens = _code?.tokens ?? [(widget.code, null)];
    final mono = TextStyle(
      fontFamily: 'monospace',
      fontFamilyFallback: const ['Menlo', 'SF Mono', 'Courier New', 'Roboto Mono'],
      fontSize: (widget.fontSize * 0.8).clamp(12.0, 17.0),
      height: 1.5,
      color: colors.ink,
      fontStyle: FontStyle.normal,
      fontWeight: FontWeight.w400,
    );
    return Padding(
      padding: EdgeInsets.symmetric(vertical: widget.fontSize * 0.5),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: colors.panel,
            border: Border.all(color: colors.border),
            borderRadius: const BorderRadius.all(Radii.md),
          ),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            physics: const ClampingScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            child: Text.rich(
              TextSpan(
                style: mono,
                children: [
                  for (final (text, scope) in tokens)
                    TextSpan(
                      text: text.replaceAll('\t', '    '),
                      style: scope == null ? null : codeTokenStyle(scope, colors),
                    ),
                ],
              ),
              softWrap: false,
            ),
          ),
        ),
      ),
    );
  }
}

/// An EPUB image that, when it is dark ink on a transparent background
/// (equations, line diagrams), is inverted so the ink reads on the dark
/// canvas. Photos and anything with an opaque background are left alone.
class InkAdaptiveImage extends StatefulWidget {
  const InkAdaptiveImage({super.key, required this.package, required this.path, required this.ink, required this.child});

  final EpubPackage package;
  final String path;

  /// Colour black ink becomes: the theme's reading ink.
  final Color ink;
  final Widget child;

  /// Formats that can be ink: transparency (PNG, GIF, WebP) or black on
  /// white (those and JPEG equation exports).
  static bool canHaveAlpha(String path) => RegExp(r'\.(png|gif|webp|jpe?g)$', caseSensitive: false).hasMatch(path);

  @override
  State<InkAdaptiveImage> createState() => _InkAdaptiveImageState();
}

class _InkAdaptiveImageState extends State<InkAdaptiveImage> {
  bool _dark = false;

  @override
  void initState() {
    super.initState();
    _inspect();
  }

  @override
  void didUpdateWidget(InkAdaptiveImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.path != widget.path || oldWidget.package != widget.package) _inspect();
  }

  void _inspect() {
    final path = widget.path;
    final known = InkAnalysis.cached(widget.package, path);
    if (known != null) {
      _dark = known;
      return;
    }
    _dark = false;
    InkAnalysis.of(widget.package, path).then((dark) {
      if (mounted && widget.path == path && dark != _dark) setState(() => _dark = dark);
    });
  }

  @override
  Widget build(BuildContext context) =>
      _dark ? ColorFiltered(colorFilter: ColorFilter.matrix(inkInversionMatrix(widget.ink)), child: widget.child) : widget.child;
}

/// Decides, once per image path per book, whether an image is dark ink on
/// transparency by decoding a small copy and sampling its pixels.
abstract final class InkAnalysis {
  static final _results = Expando<Map<String, bool>>();
  static final _pending = Expando<Map<String, Future<bool>>>();

  static bool? cached(EpubPackage package, String path) => _results[package]?[path];

  static Future<bool> of(EpubPackage package, String path) {
    final known = cached(package, path);
    if (known != null) return SynchronousFuture(known);
    final pending = _pending[package] ??= {};
    return pending[path] ??= _decide(package, path).then((dark) {
      (_results[package] ??= {})[path] = dark;
      pending.remove(path);
      return dark;
    });
  }

  static Future<bool> _decide(EpubPackage package, String path) async {
    if (!InkAdaptiveImage.canHaveAlpha(path)) return false;
    final bytes = package.readBytes(path);
    if (bytes == null) return false;
    try {
      final sampled = await sample(bytes);
      return sampled != null && (isDarkInk(sampled.rgba) || isInkOnPaper(sampled.rgba, sampled.width));
    } on Object {
      return false;
    }
  }

  /// Widest sample decoded.
  static const sampleWidth = 192;

  /// Larger images are not sampled: a few kilobytes of PNG can declare a
  /// frame of gigabytes.
  static const maxSampledPixels = 50 << 20;

  /// Native resources are released even when a corrupt image fails to decode.
  @visibleForTesting
  static Future<({Uint8List rgba, int width})?> sample(Uint8List bytes) async {
    final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
    try {
      final descriptor = await ui.ImageDescriptor.encoded(buffer);
      try {
        if (descriptor.width * descriptor.height > maxSampledPixels) return null;
        final scale = descriptor.width > sampleWidth ? sampleWidth / descriptor.width : 1.0;
        final width = (descriptor.width * scale).round().clamp(1, sampleWidth);
        final codec = await descriptor.instantiateCodec(
          targetWidth: width,
          targetHeight: (descriptor.height * scale).round().clamp(1, 4096),
        );
        try {
          final frame = await codec.getNextFrame();
          try {
            final data = await frame.image.toByteData(format: ui.ImageByteFormat.rawRgba);
            return data == null ? null : (rgba: data.buffer.asUint8List(), width: frame.image.width);
          } finally {
            frame.image.dispose();
          }
        } finally {
          codec.dispose();
        }
      } finally {
        descriptor.dispose();
      }
    } finally {
      buffer.dispose();
    }
  }

  /// Black on opaque white (Word, InDesign and Kindle equation exports): all
  /// greys, at least three quarters white with a white border, and ink that is
  /// mostly solid. A greyscale photo fills more of its frame and spreads its
  /// tones over the middle. The web rule's `paper` verdict (enhance/ink.ts).
  @visibleForTesting
  static bool isInkOnPaper(Uint8List rgba, int width) {
    final pixels = rgba.length ~/ 4;
    if (width < 3 || pixels < width * 3) return false;
    final height = pixels ~/ width;
    var opaque = 0, grey = 0, light = 0, dark = 0, mid = 0, border = 0, borderLight = 0;
    for (var p = 0; p < width * height; p++) {
      final i = p * 4;
      final a = rgba[i + 3];
      if (a < 24) continue;
      opaque++;
      final r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      final lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      final hi = r > g ? (r > b ? r : b) : (g > b ? g : b);
      final lo = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (hi - lo <= 36) grey++;
      if (lum > 200 && a > 200) light++;
      if (lum < 110) {
        dark++;
      } else if (lum <= 200) {
        mid++;
      }
      final x = p % width, y = p ~/ width;
      if (x == 0 || y == 0 || x == width - 1 || y == height - 1) {
        border++;
        if (a > 200 && lum > 215) borderLight++;
      }
    }
    if (opaque < pixels * 0.98 || opaque == 0 || border == 0) return false;
    final ink = dark + mid;
    if (grey / opaque < 0.97 || light / opaque < 0.75 || ink / opaque < 0.005 || dark < mid * 0.4) return false;
    return borderLight / border >= 0.9;
  }

  /// Mostly transparent, and what is opaque is mostly dark.
  @visibleForTesting
  static bool isDarkInk(Uint8List rgba) {
    var total = 0, clear = 0, opaque = 0, dark = 0;
    for (var i = 0; i + 3 < rgba.length; i += 4) {
      total++;
      final a = rgba[i + 3];
      if (a < 24) {
        clear++;
        continue;
      }
      if (a < 128) continue;
      opaque++;
      // Raw RGBA is premultiplied only for partial alpha; opaque pixels are exact.
      final luma = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255;
      if (luma < 0.4) dark++;
    }
    if (total == 0 || opaque == 0) return false;
    return clear / total >= 0.3 && dark / opaque >= 0.6;
  }
}
