import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:super_sliver_list/super_sliver_list.dart';
import 'package:thereader_extract/thereader_extract.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app_scope.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_theme.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/article_summary.dart';
import '../../data/repositories/article_repository.dart';
import '../reader/reader_settings_sheet.dart';
import '../shared/states.dart';
import 'article_blocks.dart';
import 'article_media.dart';
import 'article_style.dart';

/// Reads a saved article from its stored document: never fetches. Text is
/// selectable, links open in the in-app browser, and the position is saved
/// as the top block plus the offset into it.
class ArticleScreen extends StatefulWidget {
  const ArticleScreen({super.key, required this.summary});

  final ArticleSummary summary;

  static Future<void> open(BuildContext context, ArticleSummary summary) => Navigator.of(context).push(
        PageRouteBuilder<void>(
          transitionDuration: Motion.of(context, Motion.slow),
          reverseTransitionDuration: Motion.of(context, Motion.base),
          pageBuilder: (_, _, _) => ArticleScreen(summary: summary),
          transitionsBuilder: (_, anim, _, child) =>
              FadeTransition(opacity: CurvedAnimation(parent: anim, curve: Motion.curve), child: child),
        ),
      );

  @override
  State<ArticleScreen> createState() => _ArticleScreenState();
}

class _ArticleScreenState extends State<ArticleScreen> with WidgetsBindingObserver {
  final ScrollController _scroll = ScrollController();
  final ListController _list = ListController();
  final ValueNotifier<double> _percent = ValueNotifier(0);
  final ValueNotifier<double?> _returnOffset = ValueNotifier(null);
  final Map<int, BuildContext> _slots = {};
  final Map<String, GlobalKey> _noteKeys = {};
  final Map<String, int> _noteBlocks = {};
  late ArticleRepository _articles;
  Article? _article;
  ArticleProgress? _latest;
  Object? _error;

  /// Running text length before each block, for the percentage read.
  List<int> _starts = const [];
  int _total = 1;
  bool _restoring = false;
  bool _started = false;
  bool _measureScheduled = false;
  Timer? _saveDebounce;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _scroll.addListener(_onScroll);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _articles = AppScope.of(context).articles!;
    if (!_started) {
      _started = true;
      _load();
    }
  }

  Future<void> _load() async {
    try {
      final article = await _articles.loadArticle(widget.summary.id);
      if (!mounted) return;
      final starts = <int>[];
      var total = 0;
      for (var i = 0; i < article.blocks.length; i++) {
        starts.add(total);
        total += blocksText([article.blocks[i]]).length + 1;
        if (article.blocks[i] case FootnotesBlock(:final items)) {
          for (final note in items) {
            _noteBlocks[note.id] = i;
          }
        }
      }
      setState(() {
        _article = article;
        _starts = starts;
        _total = total == 0 ? 1 : total;
        _percent.value = widget.summary.progress?.percent ?? 0;
      });
      unawaited(_articles.markOpened(widget.summary.id));
      final progress = widget.summary.progress;
      if (progress != null && (progress.block > 0 || progress.offset > 0)) _restore(progress);
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  /// Jumps to the saved block, then refines into it once it has laid out.
  void _restore(ArticleProgress progress) {
    _restoring = true;
    void refine(int pass) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_scroll.hasClients) return;
        if (_list.isAttached && pass == 0) {
          _list.jumpToItem(index: progress.block, scrollController: _scroll, alignment: 0);
        } else {
          final box = _slots[progress.block]?.findRenderObject() as RenderBox?;
          if (box != null && box.hasSize) {
            final top = RenderAbstractViewport.of(box).getOffsetToReveal(box, 0).offset;
            final target = (top + progress.offset * box.size.height).clamp(0.0, _scroll.position.maxScrollExtent);
            _scroll.jumpTo(target);
          }
        }
        if (pass < 2) {
          refine(pass + 1);
        } else {
          _restoring = false;
        }
      });
    }

    refine(0);
  }

  /// The top visible block and how far into it the reader is.
  ArticleProgress? _position() {
    if (!_list.isAttached || !_scroll.hasClients) return null;
    final range = _list.visibleRange;
    if (range == null) return const ArticleProgress(block: 0, offset: 0, percent: 0);
    final first = range.$1;
    final box = _slots[first]?.findRenderObject() as RenderBox?;
    var offset = 0.0;
    if (box != null && box.hasSize && box.size.height > 0) {
      final top = RenderAbstractViewport.of(box).getOffsetToReveal(box, 0).offset;
      offset = ((_scroll.offset - top) / box.size.height).clamp(0.0, 1.0);
    }
    final length = (first + 1 < _starts.length ? _starts[first + 1] : _total) - _starts[first];
    final atEnd = _scroll.position.extentAfter < 4;
    final percent = atEnd ? 1.0 : ((_starts[first] + offset * length) / _total).clamp(0.0, 1.0);
    return ArticleProgress(block: first, offset: offset, percent: percent);
  }

  /// Positions are measured after the frame the scroll produces, when the
  /// list has laid out and reported its visible range.
  void _onScroll() {
    if (_measureScheduled) return;
    _measureScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _measureScheduled = false;
      if (!mounted || _restoring || _article == null) return;
      final p = _position();
      if (p == null) return;
      _latest = p;
      _percent.value = p.percent;
      _saveDebounce?.cancel();
      _saveDebounce = Timer(const Duration(milliseconds: 600), _save);
    });
  }

  void _save() {
    final p = _latest;
    if (p != null) unawaited(_articles.saveProgress(widget.summary.id, p));
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed && _saveDebounce?.isActive == true) {
      _saveDebounce!.cancel();
      _save();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    if (_saveDebounce?.isActive == true) {
      _saveDebounce!.cancel();
      // Dispose runs while the tree is locked; notify listeners afterwards.
      final p = _latest!;
      final articles = _articles;
      final id = widget.summary.id;
      Future.microtask(() => articles.saveProgress(id, p));
    }
    _scroll.dispose();
    _list.dispose();
    _percent.dispose();
    _returnOffset.dispose();
    super.dispose();
  }

  /// Web links open in the in-app browser; mail and phone links go to their
  /// apps; media opens where it lives.
  Future<void> _openLink(String href) async {
    final uri = Uri.tryParse(href);
    if (uri == null) return;
    final scheme = uri.scheme.toLowerCase();
    final web = scheme == 'http' || scheme == 'https';
    if (!web && scheme != 'mailto' && scheme != 'tel') return;
    var opened = false;
    try {
      opened = await launchUrl(uri, mode: web ? LaunchMode.inAppBrowserView : LaunchMode.externalApplication);
    } catch (_) {}
    if (!opened && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("Couldn't open link.")));
    }
  }

  void _toFootnote(String id) {
    final block = _noteBlocks[id];
    if (block == null || !_list.isAttached) return;
    _returnOffset.value = _scroll.offset;
    _list.jumpToItem(index: block, scrollController: _scroll, alignment: 0);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final note = _noteKeys[id]?.currentContext;
      if (note != null && note.mounted) {
        Scrollable.ensureVisible(note, alignment: 0.25, duration: Motion.of(context, Motion.base), curve: Motion.curve);
      }
    });
  }

  void _backFromFootnote() {
    final offset = _returnOffset.value;
    if (offset == null || !_scroll.hasClients) return;
    _returnOffset.value = null;
    _scroll.jumpTo(offset.clamp(0.0, _scroll.position.maxScrollExtent));
  }

  Future<void> _openSettings() => showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        barrierColor: Colors.black54,
        builder: (_) => ReaderSettingsSheet(
          settings: AppScope.of(context).settings,
          engineName: 'Article',
          highlights: false,
        ),
      );

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    final colors = context.colors;
    return Scaffold(
      backgroundColor: colors.paper,
      body: AnnotatedRegion<SystemUiOverlayStyle>(
        value: AppTheme.overlayFor(colors),
        child: ListenableBuilder(
          listenable: services.settings,
          builder: (context, _) {
            final style = ArticleStyle.of(services.settings.reader, colors);
            final article = _article;
            if (_error != null) {
              return SafeArea(
                child: StateMessage(
                  title: "Couldn't open this article.",
                  body: '$_error',
                  error: true,
                  actionLabel: 'Back',
                  onAction: () => Navigator.of(context).maybePop(),
                ),
              );
            }
            if (article == null) return const SafeArea(child: LoadingLine(label: 'Opening'));
            return ArticleScope(
              style: style,
              onLink: _openLink,
              onFootnote: _toFootnote,
              onFootnoteBack: _backFromFootnote,
              onImages: (images, index) => ArticleImageViewer.open(context, images, index),
              footnoteKey: (id) => _noteKeys.putIfAbsent(id, GlobalKey.new),
              child: Stack(
                children: [
                  _body(article, style),
                  Positioned(
                    top: 0,
                    left: 0,
                    right: 0,
                    height: MediaQuery.paddingOf(context).top,
                    child: ColoredBox(color: colors.paper),
                  ),
                  _ProgressReadout(percent: _percent),
                  _BackToText(offset: _returnOffset, onPressed: _backFromFootnote),
                ],
              ),
            );
          },
        ),
      ),
    );
  }

  Widget _body(Article article, ArticleStyle style) {
    final colors = style.colors;
    final padding = MediaQuery.paddingOf(context);
    final blocks = article.blocks;
    return SelectionArea(
      child: Scrollbar(
        controller: _scroll,
        child: CustomScrollView(
          controller: _scroll,
          slivers: [
            SliverAppBar(
              floating: true,
              snap: true,
              backgroundColor: colors.paper,
              leading: QuietIconButton(
                icon: Icons.arrow_back,
                label: 'Back',
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              actions: [
                QuietIconButton(icon: Icons.text_fields, label: 'Typography', onPressed: _openSettings),
                QuietIconButton(icon: Icons.open_in_new, label: 'Open original', onPressed: () => _openLink(article.url)),
                const SizedBox(width: Space.xs),
              ],
            ),
            SliverPadding(
              padding: EdgeInsets.fromLTRB(style.gutter, Space.md, style.gutter, style.gap * 1.5),
              sliver: SliverToBoxAdapter(
                child: _measure(article, _ArticleHeader(article: article, onOpen: () => _openLink(article.url))),
              ),
            ),
            SliverPadding(
              padding: EdgeInsets.fromLTRB(style.gutter, 0, style.gutter, padding.bottom + Space.xxl * 2),
              sliver: SuperSliverList(
                listController: _list,
                delegate: SliverChildBuilderDelegate(
                  (context, i) => _BlockSlot(
                    index: i,
                    slots: _slots,
                    child: _measure(
                      article,
                      Padding(
                        padding: EdgeInsets.only(
                          top: blocks[i] is HeadingBlock && i > 0 ? style.gap * 0.7 : 0,
                          bottom: style.gap,
                        ),
                        child: BlockView(block: blocks[i]),
                      ),
                    ),
                  ),
                  childCount: blocks.length,
                ),
                extentEstimation: (i, crossAxis) => _estimate(i, blocks, style, crossAxis),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// A rough height before a block is laid out, so the scrollbar and jumps
  /// stay steady in long articles.
  double _estimate(int? i, List<Block> blocks, ArticleStyle style, double width) {
    final line = style.fontSize * style.lineHeight;
    final perLine = (width.clamp(200.0, ArticleStyle.measure) / (style.fontSize * 0.5)).floorToDouble();
    final chars = i == null || i >= _starts.length ? 200 : (i + 1 < _starts.length ? _starts[i + 1] : _total) - _starts[i];
    final media = switch (i == null ? null : blocks[i]) {
      FigureBlock() || VideoBlock() => width * 0.6,
      _ => 0.0,
    };
    return media + (chars / perLine).ceil() * line + style.gap;
  }

  /// Centres [child] at the reading measure in the article's direction.
  static Widget _measure(Article article, Widget child) => Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: ArticleStyle.measure),
          child: SizedBox(
            width: double.infinity,
            child: Directionality(
              textDirection: article.dir == ArticleDirection.rtl ? TextDirection.rtl : TextDirection.ltr,
              child: child,
            ),
          ),
        ),
      );
}

/// Registers its context while mounted so the screen can measure the block
/// at the top of the view.
class _BlockSlot extends StatefulWidget {
  const _BlockSlot({required this.index, required this.slots, required this.child});

  final int index;
  final Map<int, BuildContext> slots;
  final Widget child;

  @override
  State<_BlockSlot> createState() => _BlockSlotState();
}

class _BlockSlotState extends State<_BlockSlot> {
  @override
  void initState() {
    super.initState();
    widget.slots[widget.index] = context;
  }

  @override
  void didUpdateWidget(_BlockSlot oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.index != widget.index) {
      if (identical(widget.slots[oldWidget.index], context)) widget.slots.remove(oldWidget.index);
      widget.slots[widget.index] = context;
    }
  }

  @override
  void dispose() {
    if (identical(widget.slots[widget.index], context)) widget.slots.remove(widget.index);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

class _ArticleHeader extends StatelessWidget {
  const _ArticleHeader({required this.article, required this.onOpen});

  final Article article;
  final VoidCallback onOpen;

  static const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  static String? _date(String? iso) {
    final d = iso == null ? null : DateTime.tryParse(iso)?.toLocal();
    return d == null ? null : '${_months[d.month - 1]}\u00a0${d.day}, ${d.year}';
  }

  @override
  Widget build(BuildContext context) {
    final scope = ArticleScope.of(context);
    final style = scope.style;
    final colors = style.colors;
    final host = Uri.tryParse(article.url)?.host.replaceFirst(RegExp(r'^www\.'), '') ?? '';
    final site = article.siteName ?? host;
    final meta = [
      if (article.byline != null) article.byline!,
      ?_date(article.publishedAt),
      '${article.readingMinutes}\u00a0min read',
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          link: true,
          label: 'Open original on $site',
          excludeSemantics: true,
          child: InkWell(
            onTap: onOpen,
            borderRadius: const BorderRadius.all(Radii.sm),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (article.favicon != null) _Favicon(src: article.favicon!),
                  Flexible(
                    child: Text(
                      site.toUpperCase(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: style.caption.copyWith(letterSpacing: 0.6, fontWeight: FontWeight.w600),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Icon(Icons.north_east, size: 13, color: colors.subtle),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(height: Space.md),
        Semantics(
          header: true,
          child: Text(
            article.title,
            style: style.body.copyWith(fontSize: style.fontSize * 1.7, fontWeight: FontWeight.w700, height: 1.18),
          ),
        ),
        if (article.subtitle != null) ...[
          const SizedBox(height: Space.sm + 2),
          Text(article.subtitle!, style: style.body.copyWith(fontSize: style.fontSize * 1.08, color: colors.muted, height: 1.4)),
        ],
        const SizedBox(height: Space.md),
        Text(meta.join('  ·  '), style: style.caption),
      ],
    );
  }
}

/// The site icon; takes no space until it loads, or at all if it fails.
class _Favicon extends StatelessWidget {
  const _Favicon({required this.src});

  final String src;

  @override
  Widget build(BuildContext context) => Image.network(
        src,
        width: 16,
        height: 16,
        cacheWidth: (16 * MediaQuery.devicePixelRatioOf(context)).round(),
        frameBuilder: (_, child, frame, sync) => frame == null && !sync
            ? const SizedBox.shrink()
            : Padding(
                padding: const EdgeInsetsDirectional.only(end: 8),
                child: ClipRRect(borderRadius: BorderRadius.circular(3), child: child),
              ),
        errorBuilder: (_, _, _) => const SizedBox.shrink(),
      );
}

/// Quiet corner readout of the share read, like the book reader's.
class _ProgressReadout extends StatelessWidget {
  const _ProgressReadout({required this.percent});

  final ValueListenable<double> percent;

  @override
  Widget build(BuildContext context) => PositionedDirectional(
        end: Space.gutter,
        bottom: MediaQuery.paddingOf(context).bottom + Space.sm,
        child: IgnorePointer(
          child: ValueListenableBuilder<double>(
            valueListenable: percent,
            builder: (context, p, _) => Text(
              '${(p * 100).round()}%',
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: context.colors.subtle,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
            ),
          ),
        ),
      );
}

/// Shown after jumping to a note; returns to the reference.
class _BackToText extends StatelessWidget {
  const _BackToText({required this.offset, required this.onPressed});

  final ValueListenable<double?> offset;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => Positioned(
        left: 0,
        right: 0,
        bottom: MediaQuery.paddingOf(context).bottom + Space.lg,
        child: ValueListenableBuilder<double?>(
          valueListenable: offset,
          builder: (context, value, _) => IgnorePointer(
            ignoring: value == null,
            child: AnimatedOpacity(
              opacity: value == null ? 0 : 1,
              duration: Motion.of(context, Motion.base),
              child: Center(child: QuietButton(label: 'Back to text', icon: Icons.arrow_upward, onPressed: onPressed)),
            ),
          ),
        ),
      );
}
