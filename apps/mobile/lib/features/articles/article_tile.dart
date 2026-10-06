import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/article_summary.dart';
import '../../data/repositories/article_repository.dart';
import 'article_media.dart';
import 'article_screen.dart';

/// A saved article in the library: lead image, title, site, reading time and
/// progress. Long press (or right click) offers removal.
class ArticleTile extends StatelessWidget {
  const ArticleTile({super.key, required this.summary, required this.articles});

  final ArticleSummary summary;
  final ArticleRepository articles;

  static const double thumb = 72;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final colors = context.colors;
    final progress = summary.progress;
    final Widget status;
    if (!summary.stored && progress == null) {
      // Saved on another device; the text downloads when it opens.
      status = Text('Not downloaded', style: text.labelSmall?.copyWith(letterSpacing: 0));
    } else if (progress == null || summary.lastOpenedAt == null) {
      status = Text('New', style: text.labelSmall?.copyWith(letterSpacing: 0, color: colors.blue));
    } else if (progress.finished) {
      status = Text('Finished', style: text.labelSmall?.copyWith(letterSpacing: 0, color: colors.green));
    } else {
      status = Row(
        children: [
          SizedBox(
            width: 64,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(1),
              child: LinearProgressIndicator(value: progress.percent, minHeight: 2),
            ),
          ),
          const SizedBox(width: Space.sm),
          Text('${(progress.percent * 100).round()}%', style: text.labelSmall),
        ],
      );
    }
    return Semantics(
      button: true,
      label: '${summary.title}, ${summary.site}',
      child: InkWell(
        onTap: () => ArticleScreen.open(context, summary),
        onLongPress: () => _actions(context),
        onSecondaryTap: () => _actions(context),
        borderRadius: const BorderRadius.all(Radii.md),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: Space.sm),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _Thumbnail(summary: summary),
              const SizedBox(width: Space.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      summary.title,
                      style: text.titleMedium?.copyWith(fontFamily: Fonts.serif, fontWeight: FontWeight.w500, height: 1.25),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      textDirection: summary.rtl ? TextDirection.rtl : null,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '${summary.site} · ${summary.readingMinutes} min',
                      style: text.bodySmall,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 6),
                    status,
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _actions(BuildContext context) async {
    final colors = context.colors;
    final action = await showModalBottomSheet<String>(
      context: context,
      barrierColor: Colors.black54,
      builder: (ctx) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.only(top: Space.lg, bottom: Space.sm),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: Space.gutter),
                child: Text(
                  summary.title,
                  style: Theme.of(ctx).textTheme.titleMedium,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(height: Space.sm),
              ListTile(
                leading: const Icon(Icons.open_in_new, size: 20),
                title: const Text('Open original'),
                onTap: () => Navigator.pop(ctx, 'open'),
              ),
              ListTile(
                leading: Icon(Icons.delete_outline, size: 20, color: colors.error),
                title: Text('Remove from library', style: TextStyle(color: colors.error)),
                onTap: () => Navigator.pop(ctx, 'remove'),
              ),
            ],
          ),
        ),
      ),
    );
    if (!context.mounted) return;
    switch (action) {
      case 'open':
        await launchUrl(Uri.parse(summary.url), mode: LaunchMode.inAppBrowserView);
      case 'remove':
        await articles.remove(summary.id);
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Removed “${summary.title}”.')));
        }
    }
  }
}

class _Thumbnail extends StatelessWidget {
  const _Thumbnail({required this.summary});

  final ArticleSummary summary;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final image = summary.leadImage;
    final initial = Container(
      color: colors.panel,
      alignment: Alignment.center,
      child: Text(
        summary.site.isEmpty ? '·' : summary.site.characters.first.toUpperCase(),
        style: Theme.of(context).textTheme.headlineMedium?.copyWith(color: colors.muted),
      ),
    );
    return ClipRRect(
      borderRadius: const BorderRadius.all(Radii.sm),
      child: SizedBox(
        width: ArticleTile.thumb,
        height: ArticleTile.thumb,
        child: image == null
            ? initial
            : NetworkPicture(src: image, width: ArticleTile.thumb, height: ArticleTile.thumb, decodeWidth: ArticleTile.thumb * 2),
      ),
    );
  }
}
