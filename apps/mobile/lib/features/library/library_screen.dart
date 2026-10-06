import 'package:flutter/material.dart';

import '../../app_scope.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/article_summary.dart';
import '../../data/models/book.dart';
import '../../data/models/library.dart';
import '../articles/add_article_sheet.dart';
import '../articles/article_tile.dart';
import '../book/book_detail_screen.dart';
import '../reader/reader_screen.dart';
import '../shared/cover_art.dart';
import '../shared/states.dart';

enum _Filter { all, downloaded, inProgress, articles }

/// Home: an editorial title, one continue-reading entry, saved articles, then
/// a cover-led grid of everything you have. Works fully offline.
class LibraryScreen extends StatefulWidget {
  const LibraryScreen({super.key, required this.onBrowse});

  final VoidCallback onBrowse;

  @override
  State<LibraryScreen> createState() => _LibraryScreenState();
}

class _LibraryScreenState extends State<LibraryScreen> {
  static const _articlePreview = 3;
  _Filter _filter = _Filter.all;
  bool _importing = false;

  /// Native picker, local copy, then straight to the book page. The pick
  /// returns as soon as the file is readable here; the upload is queued and
  /// reported by the import service, not awaited.
  Future<void> _import() async {
    final services = AppScope.of(context);
    final imports = services.imports;
    if (imports == null || _importing) return;
    setState(() => _importing = true);
    LibraryEntry? entry;
    String? failure;
    try {
      entry = await imports.pickAndImport();
    } catch (e) {
      failure = e.toString();
    } finally {
      if (mounted) setState(() => _importing = false);
    }
    if (!mounted) return;
    if (entry != null) {
      await BookDetailScreen.open(context, entry.book, entry: entry);
    } else if (failure != null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not import that file. $failure')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    final imports = services.imports;
    final articles = services.articles;
    // Upload and sync progress are deliberately not observed here: the
    // library stays quiet and Settings is the one place that reports them.
    return ListenableBuilder(
      listenable: Listenable.merge([services.library, services.settings, ?articles]),
      builder: (context, _) {
        final lib = services.library;
        final text = Theme.of(context).textTheme;
        final colors = context.colors;
        if (!lib.loaded) return const LoadingLine();
        final canImport = imports != null && imports.isSupported;
        final current = lib.continueReading.firstOrNull;
        final all = lib.entries.toList()..sort((a, b) => b.addedAt.compareTo(a.addedAt));
        final shown = switch (_filter) {
          _Filter.all => all,
          _Filter.downloaded => all.where((e) => e.download.isReady).toList(),
          _Filter.inProgress =>
            all.where((e) => e.progress != null && e.progress!.percent < 0.995).toList(),
          _Filter.articles => <LibraryEntry>[],
        };
        final saved = articles != null && articles.loaded ? articles.articles : const <ArticleSummary>[];
        final shownArticles = switch (_filter) {
          _Filter.all => saved.take(_articlePreview).toList(),
          _Filter.inProgress => saved.where((a) => a.progress != null && !a.progress!.finished).toList(),
          _Filter.articles => saved,
          _Filter.downloaded => const <ArticleSummary>[],
        };
        final both = shown.isNotEmpty && shownArticles.isNotEmpty;
        final count = switch (_filter) {
          _Filter.all => all.length + saved.length,
          _ => shown.length + shownArticles.length,
        };
        final width = MediaQuery.sizeOf(context).width;
        final columns = width >= 900
            ? 5
            : width >= 600
            ? 4
            : width >= 420
            ? 3
            : 2;

        return CustomScrollView(
          physics: const BouncingScrollPhysics(parent: AlwaysScrollableScrollPhysics()),
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(Space.gutter, Space.md, Space.gutter, 0),
              sliver: SliverToBoxAdapter(
                child: ScreenHeader(
                  title: 'Library',
                  style: text.displayLarge,
                  trailing: !canImport && articles == null
                      ? null
                      : Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (canImport)
                              _importing
                                  ? Padding(
                                      padding: const EdgeInsets.all(12),
                                      child: SizedBox(
                                        width: 20,
                                        height: 20,
                                        child: Semantics(
                                          label: 'Importing book',
                                          child: CircularProgressIndicator(strokeWidth: 1.5),
                                        ),
                                      ),
                                    )
                                  : QuietIconButton(
                                      icon: Icons.file_upload_outlined,
                                      label: 'Import EPUB or MOBI',
                                      // Uploads run in the background; only the pick
                                      // and local copy block a second import.
                                      onPressed: _import,
                                    ),
                            if (articles != null)
                              QuietIconButton(
                                icon: Icons.add,
                                label: 'Save article from link',
                                onPressed: () => showAddArticleSheet(context, articles),
                              ),
                          ],
                        ),
                ),
              ),
            ),
            if (all.isEmpty && saved.isEmpty)
              SliverFillRemaining(
                hasScrollBody: false,
                child: StateMessage(
                  title: 'Nothing here yet.',
                  body: [
                    canImport
                        ? 'Browse the library and download a book, or import an EPUB or MOBI from your files with the button above.'
                        : 'Browse the library and download a book.',
                    if (articles != null) 'Save any article from the web with the + button.',
                    'Everything is kept on this device for offline reading.',
                  ].join(' '),
                  actionLabel: 'Browse books',
                  onAction: widget.onBrowse,
                ),
              )
            else ...[
              if (current != null)
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(Space.gutter, Space.xl, Space.gutter, 0),
                  sliver: SliverToBoxAdapter(child: _ContinueReading(entry: current)),
                ),
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(Space.gutter, Space.xl, Space.gutter, Space.md),
                sliver: SliverToBoxAdapter(
                  child: Row(
                    children: [
                      Expanded(
                        child: SingleChildScrollView(
                          scrollDirection: Axis.horizontal,
                          child: Row(
                            children: [
                              for (final f in _Filter.values)
                                if (f != _Filter.articles || articles != null) ...[
                                  _FilterLink(
                                    label: switch (f) {
                                      _Filter.all => 'All',
                                      _Filter.downloaded => 'Downloaded',
                                      _Filter.inProgress => 'In progress',
                                      _Filter.articles => 'Articles',
                                    },
                                    selected: _filter == f,
                                    onTap: () => setState(() => _filter = f),
                                  ),
                                  const SizedBox(width: Space.md),
                                ],
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(width: Space.sm),
                      if (!lib.bookStore.isDurable)
                        Tag('Session only', color: colors.orange)
                      else
                        Text('$count', style: text.labelSmall),
                    ],
                  ),
                ),
              ),
              const SliverPadding(
                padding: EdgeInsets.symmetric(horizontal: Space.gutter),
                sliver: SliverToBoxAdapter(child: Divider()),
              ),
              if (shownArticles.isNotEmpty) ...[
                if (both)
                  const SliverPadding(
                    padding: EdgeInsets.fromLTRB(Space.gutter, Space.lg, Space.gutter, 0),
                    sliver: SliverToBoxAdapter(child: Eyebrow('Articles')),
                  ),
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(Space.gutter, Space.sm, Space.gutter, 0),
                  sliver: SliverList.builder(
                    itemCount: shownArticles.length,
                    itemBuilder: (context, i) => ArticleTile(summary: shownArticles[i], articles: articles!),
                  ),
                ),
                if (_filter == _Filter.all && saved.length > _articlePreview)
                  SliverPadding(
                    padding: const EdgeInsets.symmetric(horizontal: Space.gutter),
                    sliver: SliverToBoxAdapter(
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: _FilterLink(
                          label: 'All ${saved.length} articles',
                          selected: false,
                          onTap: () => setState(() => _filter = _Filter.articles),
                        ),
                      ),
                    ),
                  ),
                if (both)
                  const SliverPadding(
                    padding: EdgeInsets.fromLTRB(Space.gutter, Space.lg, Space.gutter, 0),
                    sliver: SliverToBoxAdapter(child: Eyebrow('Books')),
                  ),
              ],
              if (shown.isEmpty && shownArticles.isEmpty)
                SliverToBoxAdapter(
                  child: _filter == _Filter.articles
                      ? const StateMessage(title: 'No articles yet.', body: 'Save one from a link with the + button above.')
                      : const StateMessage(title: 'Nothing matches.', body: 'Try another filter.'),
                )
              else if (shown.isNotEmpty)
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(
                    Space.gutter,
                    Space.lg,
                    Space.gutter,
                    Space.xxl,
                  ),
                  sliver: SliverGrid.builder(
                    gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: columns,
                      mainAxisSpacing: Space.lg,
                      crossAxisSpacing: Space.md,
                      mainAxisExtent:
                          ((width - Space.gutter * 2 - Space.md * (columns - 1)) / columns) /
                              CoverArt.ratio + MediaQuery.textScalerOf(context).scale(96),
                    ),
                    itemCount: shown.length,
                    itemBuilder: (context, i) => _GridItem(entry: shown[i]),
                  ),
                ),
            ],
          ],
        );
      },
    );
  }
}

class _FilterLink extends StatelessWidget {
  const _FilterLink({required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      child: InkWell(
        onTap: onTap,
        borderRadius: const BorderRadius.all(Radii.sm),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: AnimatedDefaultTextStyle(
            duration: Motion.of(context, Motion.fast),
            style: Theme.of(
              context,
            ).textTheme.labelLarge!.copyWith(color: selected ? context.colors.fg : context.colors.muted),
            child: Text(label),
          ),
        ),
      ),
    );
  }
}

Uri? _cover(AppServices services, LibraryEntry entry) =>
    entry.source == BookSource.api ? services.sourceForEntry(entry).coverUri(entry.book) : null;

/// The single in-progress feature: cover, title, chapter, a thin progress line.
class _ContinueReading extends StatelessWidget {
  const _ContinueReading({required this.entry});
  final LibraryEntry entry;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final services = AppScope.of(context);
    final percent = entry.progress?.percent ?? 0;
    final chapter = entry.progress?.locator.title;
    return Semantics(
      button: true,
      label: 'Continue reading ${entry.book.title}',
      child: InkWell(
        onTap: () => ReaderScreen.open(context, entry),
        borderRadius: const BorderRadius.all(Radii.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Eyebrow('Continue reading'),
            const SizedBox(height: Space.md),
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                CoverArt(book: entry.book, width: 64, imageUri: _cover(services, entry)),
                const SizedBox(width: Space.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        entry.book.title,
                        style: text.headlineMedium,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        chapter == null ? entry.book.author : '${entry.book.author} · $chapter',
                        style: text.bodySmall,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: Space.md),
                      Row(
                        children: [
                          Expanded(
                            child: ClipRRect(
                              borderRadius: BorderRadius.circular(1),
                              child: LinearProgressIndicator(value: percent, minHeight: 2),
                            ),
                          ),
                          const SizedBox(width: Space.sm),
                          Text('${(percent * 100).round()}%', style: text.labelSmall),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: Space.sm),
                Icon(Icons.chevron_right, size: 18, color: context.colors.subtle),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _GridItem extends StatelessWidget {
  const _GridItem({required this.entry});
  final LibraryEntry entry;

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    final text = Theme.of(context).textTheme;
    final colors = context.colors;
    final d = entry.download;
    final percent = entry.progress?.percent;

    Widget status;
    if (d.isReady) {
      status = percent == null
          ? Text('Downloaded', style: text.labelSmall?.copyWith(letterSpacing: 0))
          : percent >= 0.995
          ? Text(
              'Finished',
              style: text.labelSmall?.copyWith(letterSpacing: 0, color: colors.green),
            )
          : ClipRRect(
              borderRadius: BorderRadius.circular(1),
              child: LinearProgressIndicator(value: percent, minHeight: 2),
            );
    } else if (d.isActive) {
      status = ClipRRect(
        borderRadius: BorderRadius.circular(1),
        child: LinearProgressIndicator(
          value: d.status == DownloadStatus.verifying ? null : d.fraction,
          minHeight: 2,
        ),
      );
    } else if (d.status == DownloadStatus.failed) {
      status = Text(
        'Download failed',
        style: text.labelSmall?.copyWith(letterSpacing: 0, color: colors.error),
      );
    } else {
      status = Text('Not downloaded', style: text.labelSmall?.copyWith(letterSpacing: 0));
    }

    return Semantics(
      button: true,
      label: '${entry.book.title} by ${entry.book.author}',
      child: InkWell(
        onTap: () => services.library.canRead(entry.id)
            ? ReaderScreen.open(context, entry)
            : BookDetailScreen.open(context, entry.book, entry: entry),
        onLongPress: () => BookDetailScreen.open(context, entry.book, entry: entry),
        borderRadius: const BorderRadius.all(Radii.md),
        child: LayoutBuilder(
          builder: (context, c) => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              CoverArt(book: entry.book, width: c.maxWidth, imageUri: _cover(services, entry)),
              const SizedBox(height: Space.sm),
              Text(
                entry.book.title,
                style: text.titleSmall,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 2),
              Text(
                entry.book.author,
                style: text.bodySmall,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 6),
              status,
            ],
          ),
        ),
      ),
    );
  }
}
