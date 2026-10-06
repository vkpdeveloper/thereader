import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:http/http.dart' as http;
import 'package:thereader_extract/thereader_extract.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import '../shared/states.dart';
import 'article_blocks.dart';
import 'article_style.dart';
import 'article_text.dart';
import 'svg_prepare.dart';

/// The `srcset` candidate closest above [targetWidth] device pixels, else the
/// largest; falls back to `src`. Keeps phones from downloading desktop-sized
/// originals.
String pickSource(ArticleImage image, double targetWidth) {
  final srcset = image.srcset;
  if (srcset == null || srcset.isEmpty) return image.src;
  final candidates = <(String, double)>[];
  for (final part in srcset.split(RegExp(r',\s+'))) {
    final bits = part.trim().split(RegExp(r'\s+'));
    if (bits.isEmpty || bits.first.isEmpty) continue;
    final descriptor = bits.length > 1 ? bits[1] : '1x';
    final value = double.tryParse(descriptor.substring(0, descriptor.length - 1));
    if (value == null) continue;
    final width = descriptor.endsWith('w') ? value : (image.width?.toDouble() ?? 1000) * value;
    candidates.add((bits.first, width));
  }
  if (candidates.isEmpty) return image.src;
  candidates.sort((a, b) => a.$2.compareTo(b.$2));
  for (final c in candidates) {
    if (c.$2 >= targetWidth) return c.$1;
  }
  return candidates.last.$1;
}

UriData? _uriData(String src) {
  try {
    return UriData.parse(src);
  } on FormatException {
    return null;
  }
}

/// The largest source, for the full-screen viewer.
String largestSource(ArticleImage image) => pickSource(image, double.infinity);

/// A remote, `data:` or SVG image that fades in, keeps its box while loading
/// and shows a quiet placeholder on failure. Raster images decode at the
/// displayed size to keep memory flat in long, image-heavy articles.
class NetworkPicture extends StatelessWidget {
  const NetworkPicture({super.key, required this.src, this.alt = '', this.width, this.height, this.fit = BoxFit.cover, this.decodeWidth});

  final String src;

  /// Shown when an SVG can't be drawn.
  final String alt;
  final double? width;
  final double? height;
  final BoxFit fit;

  /// Logical width to decode at; null decodes at full size.
  final double? decodeWidth;

  static bool _isSvg(String src) {
    final lower = src.toLowerCase();
    return lower.startsWith('data:image/svg') || (Uri.tryParse(lower)?.path.endsWith('.svg') ?? false);
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final placeholder = ColoredBox(color: colors.panel, child: SizedBox(width: width, height: height));
    final broken = Container(
      width: width,
      height: height,
      color: colors.panel,
      alignment: Alignment.center,
      child: (height ?? 48) >= 32 ? Icon(Icons.broken_image_outlined, size: 20, color: colors.subtle) : null,
    );
    if (_isSvg(src)) {
      return ArticleSvg(src: src, alt: alt, width: width, height: height, fit: fit, placeholder: placeholder, broken: broken);
    }
    final dpr = MediaQuery.devicePixelRatioOf(context);
    final cacheWidth = decodeWidth == null ? null : (decodeWidth! * dpr).round();
    Widget frame(BuildContext context, Widget child, int? frame, bool sync) {
      if (sync) return child;
      return AnimatedOpacity(
        opacity: frame == null ? 0 : 1,
        duration: Motion.of(context, Motion.base),
        curve: Motion.curve,
        child: child,
      );
    }

    Widget error(BuildContext context, Object error, StackTrace? stack) => broken;
    if (src.startsWith('data:')) {
      final data = _uriData(src);
      if (data == null) return broken;
      return Image.memory(
        data.contentAsBytes(),
        width: width,
        height: height,
        fit: fit,
        cacheWidth: cacheWidth,
        frameBuilder: frame,
        errorBuilder: error,
      );
    }
    return Stack(
      fit: StackFit.passthrough,
      children: [
        Positioned.fill(child: placeholder),
        Image.network(
          src,
          width: width,
          height: height,
          fit: fit,
          cacheWidth: cacheWidth,
          frameBuilder: frame,
          errorBuilder: error,
        ),
      ],
    );
  }
}

/// An article SVG, rewritten by [prepareSvg] so stylesheet-driven diagrams
/// draw, and shown on a light panel when it draws dark ink on transparency.
/// One that can't be drawn becomes a compact card that opens the image.
class ArticleSvg extends StatefulWidget {
  const ArticleSvg({
    super.key,
    required this.src,
    this.alt = '',
    this.width,
    this.height,
    this.fit = BoxFit.contain,
    required this.placeholder,
    required this.broken,
  });

  final String src;
  final String alt;
  final double? width;
  final double? height;
  final BoxFit fit;
  final Widget placeholder;

  /// Stands in for cropped tiles, too small for the card.
  final Widget broken;

  /// Prepared SVGs by source and colours; failures aren't kept so a later
  /// visit can retry the network.
  static final _cache = <String, Future<PreparedSvg?>>{};

  @visibleForTesting
  static void clearCache() => _cache.clear();

  @override
  State<ArticleSvg> createState() => _ArticleSvgState();
}

class _ArticleSvgState extends State<ArticleSvg> {
  Future<PreparedSvg?>? _prepared;
  String? _key;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _load();
  }

  @override
  void didUpdateWidget(ArticleSvg old) {
    super.didUpdateWidget(old);
    if (old.src != widget.src) _load();
  }

  void _load() {
    final colors = context.colors;
    final ink = colors.ink;
    final paper = colors.paper;
    final key = '${ink.toARGB32()}:${paper.toARGB32()}:${widget.src}';
    if (key == _key) return;
    _key = key;
    final cache = ArticleSvg._cache;
    final cached = cache.remove(key);
    final future = cached ?? _fetch(widget.src).then((source) => source == null ? null : _prepare(source, ink, paper));
    cache[key] = future;
    while (cache.length > 32) {
      cache.remove(cache.keys.first);
    }
    future.then((prepared) {
      if (prepared == null && identical(cache[key], future)) cache.remove(key);
    });
    _prepared = future;
  }

  static Future<String?> _fetch(String src) async {
    try {
      if (src.startsWith('data:')) return utf8.decode(UriData.parse(src).contentAsBytes(), allowMalformed: true);
      final response = await http.get(Uri.parse(src)).timeout(const Duration(seconds: 20));
      if (response.statusCode != 200) return null;
      return utf8.decode(response.bodyBytes, allowMalformed: true);
    } catch (_) {
      return null;
    }
  }

  static Future<PreparedSvg?> _prepare(String source, Color ink, Color paper) async {
    try {
      // Large drawings parse off the UI thread.
      if (source.length < 200000) return prepareSvg(source, ink: ink, paper: paper);
      final result = await compute(_prepareRaw, (source, ink.toARGB32(), paper.toARGB32()));
      return result == null ? null : PreparedSvg(source: result.$1, ink: Color(result.$2), onLight: result.$3);
    } catch (_) {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<PreparedSvg?>(
      future: _prepared,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) return widget.placeholder;
        final prepared = snapshot.data;
        if (prepared == null) return _fallback();
        final onLight = prepared.onLight;
        final picture = SvgPicture.string(
          prepared.source,
          width: onLight ? null : widget.width,
          height: onLight ? null : widget.height,
          fit: widget.fit,
          theme: SvgTheme(currentColor: prepared.ink),
          placeholderBuilder: (_) => widget.placeholder,
          errorBuilder: (_, _, _) => _fallback(),
        );
        if (!onLight) return picture;
        return Container(
          key: const ValueKey('svg-light-panel'),
          width: widget.width,
          height: widget.height,
          color: context.colors.ink,
          padding: const EdgeInsets.all(Space.sm),
          child: picture,
        );
      },
    );
  }

  Widget _fallback() => widget.fit == BoxFit.cover ? widget.broken : SvgUnavailable(src: widget.src, alt: widget.alt, width: widget.width);
}

(String, int, bool)? _prepareRaw((String, int, int) args) {
  final prepared = prepareSvg(args.$1, ink: Color(args.$2), paper: Color(args.$3));
  return prepared == null ? null : (prepared.source, prepared.ink.toARGB32(), prepared.onLight);
}

/// A compact card for an image that can't be drawn: its alt text and a way
/// to open it where it lives.
class SvgUnavailable extends StatelessWidget {
  const SvgUnavailable({super.key, required this.src, required this.alt, this.width});

  final String src;
  final String alt;
  final double? width;

  bool get _openable => src.startsWith('http://') || src.startsWith('https://');

  void _open(BuildContext context) {
    final scope = context.getInheritedWidgetOfExactType<ArticleScope>();
    if (scope != null) return scope.onLink(src);
    launchUrl(Uri.parse(src), mode: LaunchMode.inAppBrowserView).ignore();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final caption = Theme.of(context).textTheme.bodySmall;
    final label = alt.trim().isNotEmpty ? alt.trim() : "This image can't be shown here.";
    return SizedBox(
      width: width,
      child: _Card(
        onTap: _openable ? () => _open(context) : null,
        semantics: _openable ? 'Open image: $label' : label,
        child: Row(
          children: [
            Icon(Icons.image_outlined, size: 20, color: colors.subtle),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label, maxLines: 3, overflow: TextOverflow.ellipsis, style: caption?.copyWith(color: colors.fg)),
                  if (_openable) ...[
                    const SizedBox(height: 4),
                    Text('Open image', style: caption?.copyWith(color: colors.primary)),
                  ],
                ],
              ),
            ),
            if (_openable) Icon(Icons.north_east, size: 16, color: colors.subtle),
          ],
        ),
      ),
    );
  }
}

/// One image or a gallery, with caption and credit. Images keep the aspect
/// ratio the page declared so the text below never jumps as they load.
class FigureView extends StatelessWidget {
  const FigureView({super.key, required this.figure});

  final FigureBlock figure;

  @override
  Widget build(BuildContext context) {
    final scope = ArticleScope.of(context);
    final images = figure.images;
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        final Widget media;
        if (images.length == 1) {
          media = ArticleImageView(image: images.first, maxWidth: width, onTap: () => scope.onImages(images, 0));
        } else {
          const spacing = 6.0;
          final columns = width >= 520 ? 3 : 2;
          final tile = (width - spacing * (columns - 1)) / columns;
          media = Wrap(
            spacing: spacing,
            runSpacing: spacing,
            children: [
              for (var i = 0; i < images.length; i++)
                Semantics(
                  image: true,
                  label: images[i].alt,
                  button: true,
                  child: GestureDetector(
                    onTap: () => scope.onImages(images, i),
                    child: ClipRRect(
                      borderRadius: const BorderRadius.all(Radii.sm),
                      child: NetworkPicture(
                        src: pickSource(images[i], tile * MediaQuery.devicePixelRatioOf(context)),
                        alt: images[i].alt,
                        width: tile,
                        height: tile,
                        decodeWidth: tile,
                      ),
                    ),
                  ),
                ),
            ],
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            media,
            if (figure.caption != null || figure.credit != null) const SizedBox(height: Space.sm),
            if (figure.caption != null) ArticleText(figure.caption!, style: scope.style.caption),
            if (figure.credit != null)
              ArticleText(
                figure.credit!,
                style: scope.style.caption.copyWith(color: scope.style.colors.subtle, fontSize: scope.style.caption.fontSize! * 0.92),
              ),
          ],
        );
      },
    );
  }
}

/// A single article image at the text width.
class ArticleImageView extends StatelessWidget {
  const ArticleImageView({super.key, required this.image, required this.maxWidth, this.onTap});

  final ArticleImage image;
  final double maxWidth;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final w = image.width?.toDouble();
    final h = image.height?.toDouble();
    final known = w != null && h != null && w > 0 && h > 0;
    final shown = known ? w.clamp(0.0, maxWidth) : maxWidth;
    final dpr = MediaQuery.devicePixelRatioOf(context);
    Widget picture = NetworkPicture(
      src: pickSource(image, shown * dpr),
      alt: image.alt,
      width: shown,
      height: known ? shown * h / w : null,
      fit: BoxFit.contain,
      decodeWidth: shown,
    );
    if (!known) picture = ConstrainedBox(constraints: const BoxConstraints(minHeight: 120), child: picture);
    return Semantics(
      image: true,
      label: image.alt,
      button: onTap != null,
      child: GestureDetector(
        onTap: onTap,
        child: Center(child: ClipRRect(borderRadius: const BorderRadius.all(Radii.sm), child: picture)),
      ),
    );
  }
}

/// Full-screen viewer with pinch zoom; swipes between gallery images.
class ArticleImageViewer extends StatefulWidget {
  const ArticleImageViewer({super.key, required this.images, required this.initial});

  final List<ArticleImage> images;
  final int initial;

  static Future<void> open(BuildContext context, List<ArticleImage> images, int index) =>
      Navigator.of(context).push(
        PageRouteBuilder<void>(
          opaque: false,
          barrierColor: Colors.black,
          transitionDuration: Motion.of(context, Motion.base),
          reverseTransitionDuration: Motion.of(context, Motion.fast),
          pageBuilder: (_, _, _) => ArticleImageViewer(images: images, initial: index),
          transitionsBuilder: (_, anim, _, child) =>
              FadeTransition(opacity: CurvedAnimation(parent: anim, curve: Motion.curve), child: child),
        ),
      );

  @override
  State<ArticleImageViewer> createState() => _ArticleImageViewerState();
}

class _ArticleImageViewerState extends State<ArticleImageViewer> {
  late final PageController _pages = PageController(initialPage: widget.initial);
  late int _index = widget.initial;

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final image = widget.images[_index];
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          PageView.builder(
            controller: _pages,
            itemCount: widget.images.length,
            onPageChanged: (i) => setState(() => _index = i),
            itemBuilder: (context, i) => InteractiveViewer(
              maxScale: 5,
              child: Center(
                child: NetworkPicture(src: largestSource(widget.images[i]), alt: widget.images[i].alt, fit: BoxFit.contain),
              ),
            ),
          ),
          Positioned(
            top: MediaQuery.paddingOf(context).top + Space.xs,
            left: Space.xs,
            child: QuietIconButton(icon: Icons.close, label: 'Close', color: Colors.white, onPressed: () => Navigator.of(context).maybePop()),
          ),
          if (image.alt.isNotEmpty || widget.images.length > 1)
            Positioned(
              left: Space.gutter,
              right: Space.gutter,
              bottom: MediaQuery.paddingOf(context).bottom + Space.md,
              child: Text(
                [if (widget.images.length > 1) '${_index + 1} / ${widget.images.length}', if (image.alt.isNotEmpty) image.alt].join('  ·  '),
                style: text.bodySmall?.copyWith(color: Colors.white70),
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
              ),
            ),
        ],
      ),
    );
  }
}

/// Display name for a provider id from the model.
String providerName(String provider, String url) => switch (provider) {
      'youtube' => 'YouTube',
      'vimeo' => 'Vimeo',
      'dailymotion' => 'Dailymotion',
      'twitch' => 'Twitch',
      'loom' => 'Loom',
      'wistia' => 'Wistia',
      'ted' => 'TED',
      'twitter' => 'X',
      'mastodon' => 'Mastodon',
      'bluesky' => 'Bluesky',
      'instagram' => 'Instagram',
      'threads' => 'Threads',
      'reddit' => 'Reddit',
      'tiktok' => 'TikTok',
      'facebook' => 'Facebook',
      'linkedin' => 'LinkedIn',
      'codepen' => 'CodePen',
      'gist' => 'GitHub Gist',
      'spotify' => 'Spotify',
      'soundcloud' => 'SoundCloud',
      'applepodcasts' || 'apple' => 'Apple Podcasts',
      _ => Uri.tryParse(url)?.host.replaceFirst(RegExp(r'^www\.'), '') ?? provider,
    };

/// A poster with a play button; opens the video where it lives.
class VideoFacade extends StatelessWidget {
  const VideoFacade({super.key, required this.video});

  final VideoBlock video;

  @override
  Widget build(BuildContext context) {
    final scope = ArticleScope.of(context);
    final colors = scope.style.colors;
    final name = providerName(video.provider, video.url);
    final poster = video.poster;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          button: true,
          label: 'Play ${video.title ?? 'video'} on $name',
          excludeSemantics: true,
          child: GestureDetector(
            onTap: () => scope.onLink(video.url),
            child: ClipRRect(
              borderRadius: const BorderRadius.all(Radii.sm),
              child: AspectRatio(
                aspectRatio: 16 / 9,
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    if (poster != null)
                      LayoutBuilder(
                        builder: (context, c) => NetworkPicture(src: poster, decodeWidth: c.maxWidth),
                      )
                    else
                      ColoredBox(color: colors.panel),
                    const DecoratedBox(
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: [Color(0x00000000), Color(0xAA000000)],
                        ),
                      ),
                    ),
                    Center(
                      child: Container(
                        width: 56,
                        height: 56,
                        decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.55), shape: BoxShape.circle),
                        child: const Icon(Icons.play_arrow_rounded, color: Colors.white, size: 34),
                      ),
                    ),
                    Positioned(
                      left: 12,
                      right: 12,
                      bottom: 10,
                      child: Text(
                        [name, if (video.title != null) video.title!].join('  ·  '),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: scope.style.caption.copyWith(color: Colors.white),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        if (video.caption != null) ...[
          const SizedBox(height: Space.sm),
          ArticleText(video.caption!, style: scope.style.caption),
        ],
      ],
    );
  }
}

/// Audio as a compact card that opens the episode or file.
class AudioCard extends StatelessWidget {
  const AudioCard({super.key, required this.audio});

  final AudioBlock audio;

  @override
  Widget build(BuildContext context) {
    final scope = ArticleScope.of(context);
    final colors = scope.style.colors;
    final name = providerName(audio.provider, audio.url);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _Card(
          onTap: () => scope.onLink(audio.url),
          semantics: 'Play ${audio.title ?? 'audio'} on $name',
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(color: colors.element, shape: BoxShape.circle),
                child: Icon(Icons.play_arrow_rounded, color: colors.fg),
              ),
              const SizedBox(width: Space.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      audio.title ?? 'Listen',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: scope.style.caption.copyWith(color: colors.fg, fontWeight: FontWeight.w600),
                    ),
                    Text(name, style: scope.style.caption),
                  ],
                ),
              ),
              Icon(Icons.north_east, size: 16, color: colors.subtle),
            ],
          ),
        ),
        if (audio.caption != null) ...[
          const SizedBox(height: Space.sm),
          ArticleText(audio.caption!, style: scope.style.caption),
        ],
      ],
    );
  }
}

/// A social post or third-party embed, kept as a quiet card with its text.
class EmbedCard extends StatelessWidget {
  const EmbedCard({super.key, required this.embed});

  final EmbedBlock embed;

  @override
  Widget build(BuildContext context) {
    final scope = ArticleScope.of(context);
    final colors = scope.style.colors;
    final style = scope.style;
    final name = providerName(embed.provider, embed.url);
    final blocks = embed.blocks;
    return _Card(
      onTap: () => scope.onLink(embed.url),
      semantics: null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(text: name, style: TextStyle(color: colors.fg, fontWeight: FontWeight.w600)),
                      if (embed.author != null) TextSpan(text: '  ${embed.author}'),
                    ],
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: style.caption,
                ),
              ),
              Icon(Icons.north_east, size: 16, color: colors.subtle),
            ],
          ),
          if (blocks != null && blocks.isNotEmpty) ...[
            const SizedBox(height: Space.sm),
            scope.restyled(style.derive(scale: 0.92), BlockColumn(blocks: blocks)),
          ] else ...[
            const SizedBox(height: 4),
            Text('Open on $name', style: style.caption.copyWith(color: colors.primary)),
          ],
        ],
      ),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.child, required this.onTap, required this.semantics});

  final Widget child;
  final VoidCallback? onTap;
  final String? semantics;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Semantics(
      button: onTap != null,
      label: semantics,
      child: Material(
        color: colors.panel,
        borderRadius: const BorderRadius.all(Radii.md),
        child: InkWell(
          onTap: onTap,
          borderRadius: const BorderRadius.all(Radii.md),
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              border: Border.all(color: colors.border),
              borderRadius: const BorderRadius.all(Radii.md),
            ),
            child: child,
          ),
        ),
      ),
    );
  }
}
