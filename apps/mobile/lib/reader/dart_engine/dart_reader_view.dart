import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_widget_from_html_core/flutter_widget_from_html_core.dart';
import 'package:html/dom.dart' as dom;

import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import '../../core/typography/reader_fonts.dart';
import '../../data/models/settings.dart';
import 'dart_reader_engine.dart';
import 'epub_blocks.dart';
import 'epub_chapter.dart';
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
  static Map<String, String>? stylesFor(
    String tag,
    ReaderPreferences prefs,
    AppColors colors, {
    bool figureCaption = false,
    bool inPre = false,
  }) {
    final ink = colors.ink.toCssHex();
    final muted = colors.muted.toCssHex();
    final link = colors.primary.toCssHex();
    final panel = colors.panel.toCssHex();
    final border = colors.border.toCssHex();
    final justify = prefs.justify ? {'text-align': 'justify'} : <String, String>{};
    final caption = {
      'font-size': '0.8em', 'font-weight': '400', 'font-style': 'normal',
      'line-height': '1.4', 'text-align': 'left', 'margin': '0.6em 0 1.2em', 'color': muted,
    };
    if (figureCaption) return caption;
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
        return caption;
      case 'th':
      case 'td':
        return {'color': ink, 'border-color': border, 'padding': '0.25em 0.6em'};
      case 'p':
        return {'margin': '0 0 1em', ...justify};
      case 'blockquote':
        return {'margin': '1.2em 1.2em', 'color': muted, 'font-style': 'italic'};
      case 'a':
        return {'color': link, 'text-decoration': 'none'};
      case 'pre':
        // Code blocks normally render as [EpubCodeBlock]; this is the fallback.
        return {'font-family': 'monospace', 'font-size': '0.82em', 'background-color': panel, 'padding': '12px', 'margin': '1em 0', 'white-space': 'pre', 'color': ink};
      case 'code':
        return {'font-family': 'monospace', 'font-size': '0.86em', 'color': ink, if (!inPre) 'background-color': colors.element.toCssHex()};
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

  /// Keeps only the body and removes every publisher colour source this
  /// renderer honours: `<style>`, inline `style` (either quote style, which
  /// also covers inline `!important`) and legacy colour attributes. Only
  /// start tags are rewritten, so code samples such as `color="red"` in text
  /// survive. Inline SVG and MathML are left untouched. Math sources,
  /// equation sizing and PDF-conversion repairs are prepared for the
  /// builders (see [EpubChapter]). Visible for tests.
  @visibleForTesting
  static String prepareHtml(String xhtml) => EpubChapter.prepare(xhtml);
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

  EpubContentBuilder? _builder;

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
                factoryBuilder: () => _EpubWidgetFactory(controller.package, item.href, colors.ink),
                customStylesBuilder: (element) => _styles(element, prefs, colors),
                customWidgetBuilder: (element) => _contentBuilder(item.href, base, colors).build(element),
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

  EpubContentBuilder _contentBuilder(String href, TextStyle base, AppColors colors) {
    final current = _builder;
    if (current != null && current.href == href && current.textStyle == base && current.colors == colors) return current;
    return _builder = EpubContentBuilder(package: widget.controller.package, href: href, textStyle: base, colors: colors);
  }

  static Map<String, String>? _styles(dom.Element element, ReaderPreferences prefs, AppColors colors) {
    if (element.attributes.containsKey(EpubMarks.hidden)) return const {'display': 'none'};
    final tag = element.localName ?? '';
    final figureCaption = tag == 'h5' &&
        (element.classes.contains('figure-container-h5') || element.parent?.classes.contains('figure-container') == true);
    final inPre = tag == 'code' && element.parent?.localName == 'pre';
    return DartReaderView.stylesFor(tag, prefs, colors, figureCaption: figureCaption, inPre: inPre);
  }
}

class _EpubWidgetFactory extends WidgetFactory {
  _EpubWidgetFactory(this.package, this.fromHref, this.ink);

  final EpubPackage package;
  final String fromHref;
  final Color ink;

  /// Dark-ink figures on transparency are inverted to read on the canvas.
  @override
  Widget? buildImageWidget(BuildTree tree, ImageSource src) {
    final image = super.buildImageWidget(tree, src);
    final path = _pathFor(src.url);
    if (image == null || path == null || !InkAdaptiveImage.canHaveAlpha(path)) return image;
    return InkAdaptiveImage(package: package, path: path, ink: ink, child: image);
  }

  @override
  ImageProvider? imageProviderFromNetwork(String url) => _fromPackage(url) ?? super.imageProviderFromNetwork(url);

  @override
  ImageProvider? imageProviderFromFileUri(String url) => _fromPackage(url) ?? super.imageProviderFromFileUri(url);

  @override
  ImageProvider? imageProviderFromAsset(String url) => _fromPackage(url) ?? super.imageProviderFromAsset(url);

  /// Relative `src` values are resolved by the HTML widget against the
  /// synthetic `epub:///` base URL, then served from the container here.
  ImageProvider? _fromPackage(String url) {
    final path = _pathFor(url);
    if (path == null) return null;
    final bytes = package.readBytes(path);
    if (bytes == null) return null;
    return MemoryImage(Uint8List.fromList(bytes));
  }

  String? _pathFor(String url) {
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) return null;
    return url.startsWith('epub:///')
        ? Uri.decodeComponent(url.substring('epub:///'.length).split('#').first)
        : package.resolve(fromHref, url);
  }
}
