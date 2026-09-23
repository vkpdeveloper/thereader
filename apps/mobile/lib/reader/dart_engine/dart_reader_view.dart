import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_widget_from_html_core/flutter_widget_from_html_core.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import '../../core/typography/reader_fonts.dart';
import '../../data/models/settings.dart';
import 'dart_reader_engine.dart';
import 'epub_package.dart';

/// Renders the current spine document on a pure black canvas. Images are
/// served straight from the EPUB container; original imagery is preserved.
class DartReaderView extends StatefulWidget {
  const DartReaderView({super.key, required this.controller});

  final DartReaderController controller;

  @override
  State<DartReaderView> createState() => _DartReaderViewState();

  /// Element styles for the active preset. Visible for tests.
  @visibleForTesting
  static Map<String, String>? stylesFor(String tag, ReaderPreferences prefs, AppColors colors) {
    final ink = colors.ink.toCssHex();
    final muted = colors.muted.toCssHex();
    final link = colors.primary.toCssHex();
    final panel = colors.panel.toCssHex();
    final border = colors.border.toCssHex();
    final justify = prefs.justify ? {'text-align': 'justify'} : <String, String>{};
    switch (tag) {
      case 'h1':
        return {'font-size': '1.55em', 'font-weight': '500', 'line-height': '1.2', 'margin': '0 0 1.2em', 'color': ink};
      case 'h2':
        return {'font-size': '1.25em', 'font-weight': '500', 'line-height': '1.25', 'margin': '1.6em 0 0.7em', 'color': ink};
      case 'h3':
      case 'h4':
        return {'font-size': '1.05em', 'font-weight': '600', 'margin': '1.4em 0 0.5em', 'color': ink};
      case 'h5':
      case 'h6':
        return {'font-size': '1em', 'font-weight': '600', 'margin': '1.2em 0 0.4em', 'color': ink};
      case 'figcaption':
      case 'caption':
        return {'font-size': '0.9em', 'margin': '0.6em 0 1.2em', 'color': ink};
      case 'th':
      case 'td':
        return {'color': ink, 'border-color': border};
      case 'p':
        return {'margin': '0 0 1em', ...justify};
      case 'blockquote':
        return {'margin': '1.2em 1.2em', 'color': muted, 'font-style': 'italic'};
      case 'a':
        return {'color': link, 'text-decoration': 'none'};
      case 'pre':
        return {'font-family': 'monospace', 'font-size': '0.82em', 'background-color': panel, 'padding': '12px', 'margin': '1em 0', 'white-space': 'pre-wrap', 'color': ink};
      case 'code':
        return {'font-family': 'monospace', 'font-size': '0.9em', 'color': ink};
      case 'hr':
        return {'border-color': border, 'margin': '1.6em 0'};
      case 'img':
      case 'image':
      case 'svg':
        return {'max-width': '100%', 'margin': '1em auto', 'display': 'block'};
      case 'table':
        return {'border-color': border, 'font-size': '0.9em'};
      case 'body':
      case 'section':
      case 'div':
        return {'background-color': 'transparent', 'color': ink};
      case 'li':
        return {'margin': '0 0 0.4em'};
    }
    return null;
  }

  static final _tag = RegExp(r'<[A-Za-z][^>]*>');
  static final _artwork = RegExp(r'<(svg|math)\b[\s\S]*?</\1>', caseSensitive: false);
  static final _colorAttrs = RegExp(
    r'''\s(?:style|color|bgcolor|text|link|vlink|alink)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)''',
    caseSensitive: false,
  );

  /// Keeps only the body and removes every publisher colour source this
  /// renderer honours: `<style>`, inline `style` (either quote style, which
  /// also covers inline `!important`) and legacy colour attributes. Only
  /// start tags are rewritten, so code samples such as `color="red"` in text
  /// survive. Inline SVG and MathML are left untouched. Visible for tests.
  @visibleForTesting
  static String prepareHtml(String xhtml) {
    var s = xhtml;
    final body = RegExp(r'<body[^>]*>([\s\S]*?)</body>', caseSensitive: false).firstMatch(s);
    if (body != null) s = body.group(1)!;
    s = s.replaceAll(RegExp(r'<style[\s\S]*?</style>', caseSensitive: false), '');
    s = s.replaceAll(RegExp(r'<script[\s\S]*?</script>', caseSensitive: false), '');
    // Artwork keeps its own colours, as in the native readers.
    return s.splitMapJoin(
      _artwork,
      onNonMatch: (text) => text.replaceAllMapped(_tag, (m) => m[0]!.replaceAll(_colorAttrs, '')),
    );
  }
}

class _DartReaderViewState extends State<DartReaderView> {
  final ScrollController _scroll = ScrollController();
  int _renderedChapter = -1;
  String? _html;
  String? _error;
  bool _seeking = false;

  @override
  void initState() {
    super.initState();
    widget.controller.chapter.addListener(_onChapter);
    _scroll.addListener(_onScroll);
    _onChapter();
  }

  @override
  void dispose() {
    widget.controller.chapter.removeListener(_onChapter);
    _scroll.dispose();
    super.dispose();
  }

  void _onChapter() {
    final index = widget.controller.chapter.value;
    if (index < 0) return;
    final pkg = widget.controller.package;
    final item = pkg.spine[index];
    setState(() {
      _renderedChapter = index;
      _error = null;
      _seeking = true;
      final text = pkg.readText(item.href);
      _html = text == null ? null : _prepare(text);
      if (_html == null) _error = 'Could not read ${item.href} from the book.';
    });
    // Seek after layout.
    WidgetsBinding.instance.addPostFrameCallback((_) => _seekTo(widget.controller.pendingProgression));
  }

  void _seekTo(double fraction) {
    if (!mounted || !_scroll.hasClients) return;
    final max = _scroll.position.maxScrollExtent;
    _scroll.jumpTo((max * fraction).clamp(0, max));
    // A second pass once images have laid out and extents settled.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      final m = _scroll.position.maxScrollExtent;
      if ((m - max).abs() > 1) _scroll.jumpTo((m * fraction).clamp(0, m));
      _seeking = false;
    });
  }

  void _onScroll() {
    if (_seeking || !_scroll.hasClients) return;
    final max = _scroll.position.maxScrollExtent;
    final f = max <= 0 ? 1.0 : (_scroll.offset / max).clamp(0.0, 1.0);
    widget.controller.reportProgression(f);
  }

  /// Strips the document down to its body so page-level CSS cannot paint a
  /// white background or fight the reader's typography.
  static String _prepare(String xhtml) => DartReaderView.prepareHtml(xhtml);

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    return ValueListenableBuilder<ReaderPreferences>(
      valueListenable: controller.prefs,
      builder: (context, prefs, _) {
        final colors = context.colors;
        final family = ReaderFonts.resolve(prefs);
        final base = TextStyle(
          fontFamily: family.flutterFamily,
          fontFamilyFallback: family.flutterFallback,
          fontSize: prefs.fontSize,
          height: prefs.lineHeight,
          color: colors.ink,
          fontWeight: FontWeight.w400,
        );
        final gutter = (Space.gutter + 8) * prefs.marginScale;
        final item = controller.package.spine[_renderedChapter < 0 ? 0 : _renderedChapter];
        final content = _error != null
            ? Padding(
                padding: EdgeInsets.symmetric(horizontal: gutter, vertical: Space.xxl),
                child: Text(_error!, style: base.copyWith(color: colors.muted)),
              )
            : HtmlWidget(
                _html ?? '',
                key: ValueKey('${item.href}#${family.id}#${colors.hashCode}'),
                textStyle: base,
                baseUrl: Uri.parse('epub:///${item.href}'),
                factoryBuilder: () => _EpubWidgetFactory(controller.package, item.href),
                customStylesBuilder: (element) => _styles(element, prefs, colors),
                renderMode: RenderMode.column,
              );
        return ColoredBox(
          color: colors.paper,
          child: Scrollbar(
            controller: _scroll,
            child: SingleChildScrollView(
              controller: _scroll,
              physics: const ClampingScrollPhysics(),
              padding: EdgeInsets.fromLTRB(
                gutter,
                MediaQuery.paddingOf(context).top + Space.xxl + Space.md,
                gutter,
                MediaQuery.paddingOf(context).bottom + Space.xxl * 2,
              ),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 680),
                  child: content,
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  static Map<String, String>? _styles(dynamic element, ReaderPreferences prefs, AppColors colors) =>
      DartReaderView.stylesFor((element.localName as String?) ?? '', prefs, colors);
}

class _EpubWidgetFactory extends WidgetFactory {
  _EpubWidgetFactory(this.package, this.fromHref);

  final EpubPackage package;
  final String fromHref;

  @override
  ImageProvider? imageProviderFromNetwork(String url) => _fromPackage(url) ?? super.imageProviderFromNetwork(url);

  @override
  ImageProvider? imageProviderFromFileUri(String url) => _fromPackage(url) ?? super.imageProviderFromFileUri(url);

  @override
  ImageProvider? imageProviderFromAsset(String url) => _fromPackage(url) ?? super.imageProviderFromAsset(url);

  /// Relative `src` values are resolved by the HTML widget against the
  /// synthetic `epub:///` base URL, then served from the container here.
  ImageProvider? _fromPackage(String url) {
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) return null;
    final path = url.startsWith('epub:///')
        ? Uri.decodeComponent(url.substring('epub:///'.length).split('#').first)
        : package.resolve(fromHref, url);
    final bytes = package.readBytes(path);
    if (bytes == null) return null;
    return MemoryImage(Uint8List.fromList(bytes));
  }
}
