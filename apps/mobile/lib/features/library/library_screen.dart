import 'package:flutter/material.dart';

import '../../app_scope.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/book.dart';
import '../../data/models/library.dart';
import '../../data/models/settings.dart';
import '../book/book_detail_screen.dart';
import '../reader/reader_screen.dart';
import '../shared/cover_art.dart';
import '../shared/states.dart';

enum _Filter { all, downloaded, inProgress }

/// Home: an editorial title, one continue-reading entry, then a cover-led
/// grid of everything you have. Works fully offline.
class LibraryScreen extends StatefulWidget {
  const LibraryScreen({super.key, required this.onBrowse});

  final VoidCallback onBrowse;

  @override
  State<LibraryScreen> createState() => _LibraryScreenState();
}

class _LibraryScreenState extends State<LibraryScreen> {
  _Filter _filter = _Filter.all;

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    return ListenableBuilder(
      listenable: Listenable.merge([services.library, services.settings]),
      builder: (context, _) {
        final lib = services.library;
        final text = Theme.of(context).textTheme;
        if (!lib.loaded) return const LoadingLine();
        final current = lib.continueReading.firstOrNull;
        final all = lib.entries.toList()..sort((a, b) => b.addedAt.compareTo(a.addedAt));
        final shown = switch (_filter) {
          _Filter.all => all,
          _Filter.downloaded => all.where((e) => e.download.isReady).toList(),
          _Filter.inProgress =>
            all.where((e) => e.progress != null && e.progress!.percent < 0.995).toList(),
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
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Expanded(child: Text('Library', style: text.displayLarge)),
                    if (services.settings.settings.mode == AppMode.sample)
                      const Padding(
                        padding: EdgeInsets.only(bottom: 10),
                        child: Tag('Sample mode', color: Palette.orange, filled: true),
                      ),
                  ],
                ),
              ),
            ),
            if (all.isEmpty)
              SliverFillRemaining(
                hasScrollBody: false,
                child: StateMessage(
                  title: 'Nothing here yet.',
                  body: services.settings.settings.mode == AppMode.sample
                      ? 'Browse the bundled samples and download one to start reading. Sample mode is on; switch to your API in Settings.'
                      : 'Browse your catalog and download a book. Downloads are kept on this device for offline reading.',
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
                      for (final f in _Filter.values) ...[
                        _FilterLink(
                          label: switch (f) {
                            _Filter.all => 'All',
                            _Filter.downloaded => 'Downloaded',
                            _Filter.inProgress => 'In progress',
                          },
                          selected: _filter == f,
                          onTap: () => setState(() => _filter = f),
                        ),
                        const SizedBox(width: Space.md),
                      ],
                      const Spacer(),
                      if (!lib.bookStore.isDurable)
                        const Tag('Session only', color: Palette.orange)
                      else
                        Text('${shown.length}', style: text.labelSmall),
                    ],
                  ),
                ),
              ),
              const SliverPadding(
                padding: EdgeInsets.symmetric(horizontal: Space.gutter),
                sliver: SliverToBoxAdapter(child: Divider()),
              ),
              if (shown.isEmpty)
                const SliverToBoxAdapter(
                  child: StateMessage(title: 'No books match.', body: 'Try another filter.'),
                )
              else
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
                      childAspectRatio: 0.52,
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
            ).textTheme.labelLarge!.copyWith(color: selected ? Palette.fg : Palette.muted),
            child: Text(label),
          ),
        ),
      ),
    );
  }
}

Uri? _cover(AppServices services, LibraryEntry entry) =>
    entry.source == BookSource.api ? services.currentSource.coverUri(entry.book) : null;

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
                Icon(Icons.chevron_right, size: 18, color: Palette.subtle),
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
    final d = entry.download;
    final percent = entry.progress?.percent;

    Widget status;
    if (d.isReady) {
      status = percent == null
          ? Text('Downloaded', style: text.labelSmall?.copyWith(letterSpacing: 0))
          : percent >= 0.995
          ? Text(
              'Finished',
              style: text.labelSmall?.copyWith(letterSpacing: 0, color: Palette.green),
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
        style: text.labelSmall?.copyWith(letterSpacing: 0, color: Palette.error),
      );
    } else {
      status = Text('Not downloaded', style: text.labelSmall?.copyWith(letterSpacing: 0));
    }

    return Semantics(
      button: true,
      label: '${entry.book.title} by ${entry.book.author}',
      child: InkWell(
        onTap: () => d.isReady
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
              Row(
                children: [
                  Expanded(child: status),
                  if (entry.source == BookSource.sample) ...[
                    const SizedBox(width: 6),
                    const Tag('Sample', color: Palette.orange),
                  ],
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
