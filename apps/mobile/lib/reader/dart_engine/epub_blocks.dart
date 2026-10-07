import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_math_fork/ast.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:flutter_widget_from_html_core/flutter_widget_from_html_core.dart';
import 'package:html/dom.dart' as dom;

import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import '../../features/articles/article_code.dart' show HighlightedCode, codeTokenStyle, grammarFor, highlightCode;
import 'epub_chapter.dart';
import 'epub_package.dart';
import 'epub_tex.dart';
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
    switch ((element.localName ?? '').split(':').last) {
      case 'math':
        return _mathml(element);
      case 'pre':
        return _code(element);
      case 'img':
        return _image(element);
      case 'span' || 'div' when element.classes.contains('math'):
        return _texSource(element);
    }
    return null;
  }

  Widget? _mathml(dom.Element math) {
    final display = MathmlTex.isDisplay(math);
    final annotation = MathmlTex.annotation(math);
    final alttext = math.attributes['alttext'];
    for (final tex in [?annotation, MathmlTex.convert(math), ?alttext]) {
      final ast = EpubTex.tryParse(EpubTex.normalize(tex));
      if (ast != null) return _formula(ast, display: display);
    }
    return null;
  }

  /// Pandoc `span.math`, converted MathJax scripts and `$$…$$` runs.
  Widget? _texSource(dom.Element span) {
    final raw = span.text.trim();
    final display = span.classes.contains('display') || raw.startsWith(r'\[') || raw.startsWith(r'$$');
    if (!display && !span.classes.contains('inline')) return null;
    final ast = EpubTex.tryParse(EpubTex.normalize(raw));
    return ast == null ? null : _formula(ast, display: display);
  }

  static final _mathClass = RegExp(r'math|equation|formula|eqn', caseSensitive: false);
  static final _displayClass = RegExp(r'display|equation|eqn', caseSensitive: false);

  Widget? _image(dom.Element img) {
    final emHeight = double.tryParse(img.attributes[EpubMarks.emHeight] ?? '');
    final mathContext = emHeight != null || _ancestors(img).any((a) => _mathClass.hasMatch(a.className));
    final alt = img.attributes['alt'] ?? '';
    final display = _isDisplayImage(img);
    if (EpubTex.looksLikeTex(alt, mathContext: mathContext)) {
      final ast = EpubTex.tryParse(EpubTex.normalize(alt));
      if (ast != null) return _formula(ast, display: display);
    }
    // Inline equation images keep their em size instead of becoming blocks.
    if (emHeight == null) return null;
    final path = package.resolve(href, img.attributes['src'] ?? '');
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

  /// Only formats that can carry transparency are inspected.
  static bool canHaveAlpha(String path) => RegExp(r'\.(png|gif|webp)$', caseSensitive: false).hasMatch(path);

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
      final rgba = await _sample(bytes);
      return rgba != null && isDarkInk(rgba);
    } on Object {
      return false;
    }
  }

  /// Native resources are released even when a corrupt image fails to decode.
  static Future<Uint8List?> _sample(Uint8List bytes) async {
    final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
    try {
      final descriptor = await ui.ImageDescriptor.encoded(buffer);
      try {
        final scale = descriptor.width > 96 ? 96 / descriptor.width : 1.0;
        final codec = await descriptor.instantiateCodec(
          targetWidth: (descriptor.width * scale).round().clamp(1, 96),
          targetHeight: (descriptor.height * scale).round().clamp(1, 4096),
        );
        try {
          final frame = await codec.getNextFrame();
          try {
            final data = await frame.image.toByteData(format: ui.ImageByteFormat.rawRgba);
            return data?.buffer.asUint8List();
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
