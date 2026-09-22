import 'package:flutter/material.dart';

import '../../app_scope.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/book.dart';
import '../../data/api/catalog_source.dart';
import '../../data/models/library.dart';
import '../reader/reader_screen.dart';
import '../shared/cover_art.dart';
import '../shared/states.dart';

/// Book page: description, edition facts, and one honest download control.
class BookDetailScreen extends StatelessWidget {
  const BookDetailScreen({super.key, required this.book, required this.source});

  final Book book;
  final CatalogSource source;

  static Future<void> open(BuildContext context, Book book, {LibraryEntry? entry}) =>
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => BookDetailScreen(
            book: book,
            source: entry == null
                ? AppScope.of(context).currentSource
                : AppScope.of(context).sourceForEntry(entry),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    return Scaffold(
      appBar: AppBar(leading: const BackButton()),
      body: ListenableBuilder(
        listenable: services.library,
        builder: (context, _) {
          final entry = services.library.entryFor(book, source);
          final current = entry?.book ?? book;
          final text = Theme.of(context).textTheme;
          final d = entry?.download ?? const DownloadState();
          final coverUri = source.coverUri(current);
          final outdated = entry != null && entry.book.sha256 != book.sha256 && d.isReady;

          return ListView(
            physics: const BouncingScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(Space.gutter, 0, Space.gutter, Space.xxl),
            children: [
              CoverArt(book: current, width: 120, imageUri: coverUri),
              const SizedBox(height: Space.lg),
              Text(current.title, style: text.displaySmall),
              const SizedBox(height: Space.xs),
              Text(current.author, style: text.bodyLarge?.copyWith(color: Palette.muted)),
              const SizedBox(height: Space.md),
              Wrap(
                spacing: Space.sm,
                runSpacing: Space.sm,
                children: [
                  for (final s in current.subjects) Tag(s),
                  Tag(current.language.toUpperCase()),
                  Tag(formatBytes(current.fileSize)),
                  if (entry != null)
                    Tag(
                      entry.source.label,
                      color: entry.source == BookSource.sample ? Palette.orange : Palette.green,
                    ),
                ],
              ),
              const SizedBox(height: Space.lg),
              _DownloadPanel(book: book, entry: entry, outdated: outdated, source: source),
              const SizedBox(height: Space.xl),
              if (current.description.isNotEmpty) ...[
                const Eyebrow('About'),
                const SizedBox(height: Space.sm),
                Text(
                  current.description,
                  style: text.bodyLarge?.copyWith(fontFamily: Fonts.serif, height: 1.55),
                ),
                const SizedBox(height: Space.xl),
              ],
              const Eyebrow('Edition'),
              const SizedBox(height: Space.sm),
              _Fact('Version', current.version),
              _Fact('Updated', current.updatedAt.toLocal().toString().split(' ').first),
              _Fact('SHA-256', current.sha256, mono: true),
              if (d.isReady && d.path != null) _Fact('Stored at', d.path!, mono: true),
            ],
          );
        },
      ),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact(this.label, this.value, {this.mono = false});
  final String label;
  final String value;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.sm),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 84, child: Text(label, style: text.bodySmall)),
          Expanded(
            child: SelectableText(
              value,
              style: text.bodySmall?.copyWith(
                color: Palette.fg,
                fontFamily: mono ? 'monospace' : null,
                fontSize: mono ? 11.5 : null,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _DownloadPanel extends StatelessWidget {
  const _DownloadPanel({
    required this.book,
    required this.entry,
    required this.outdated,
    required this.source,
  });
  final Book book;
  final LibraryEntry? entry;
  final bool outdated;
  final CatalogSource source;

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    final text = Theme.of(context).textTheme;
    final d = entry?.download ?? const DownloadState();
    final lib = services.library;

    Widget inner;
    switch (d.status) {
      case DownloadStatus.queued:
      case DownloadStatus.downloading:
      case DownloadStatus.verifying:
        final label = d.status == DownloadStatus.verifying
            ? 'Verifying SHA-256'
            : d.status == DownloadStatus.queued
            ? 'Connecting'
            : '${formatBytes(d.receivedBytes)} of ${formatBytes(d.totalBytes ?? book.fileSize)}';
        inner = Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(label, style: text.bodyMedium)),
                if (d.status != DownloadStatus.verifying)
                  QuietIconButton(
                    icon: Icons.close,
                    label: 'Cancel download',
                    onPressed: () => lib.cancelDownload(entry!.id),
                  ),
              ],
            ),
            const SizedBox(height: Space.sm),
            ClipRRect(
              borderRadius: BorderRadius.circular(1),
              child: LinearProgressIndicator(
                value: d.status == DownloadStatus.verifying ? null : d.fraction,
                minHeight: 2,
              ),
            ),
          ],
        );
      case DownloadStatus.ready:
        inner = Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.check, size: 16, color: Palette.green),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    outdated ? 'Downloaded (an older edition). ' : 'Downloaded and verified. ',
                    style: text.bodySmall?.copyWith(
                      color: outdated ? Palette.orange : Palette.muted,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: Space.md),
            Row(
              children: [
                Expanded(
                  child: QuietButton(
                    label: entry?.progress == null ? 'Read' : 'Continue reading',
                    emphasis: true,
                    expand: true,
                    onPressed: () => ReaderScreen.open(context, entry!),
                  ),
                ),
                const SizedBox(width: Space.sm),
                if (outdated)
                  QuietButton(label: 'Update', onPressed: () => lib.download(book, source)),
                if (outdated) const SizedBox(width: Space.sm),
                QuietIconButton(
                  icon: Icons.delete_outline,
                  label: 'Remove download',
                  color: Palette.muted,
                  onPressed: () => _confirmRemove(context),
                ),
              ],
            ),
          ],
        );
      case DownloadStatus.failed:
        inner = Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              d.error ?? 'Download failed.',
              style: text.bodyMedium?.copyWith(color: Palette.error),
            ),
            const SizedBox(height: Space.md),
            Row(
              children: [
                Expanded(
                  child: QuietButton(
                    label: 'Try again',
                    emphasis: true,
                    expand: true,
                    onPressed: () => lib.download(book, source),
                  ),
                ),
                const SizedBox(width: Space.sm),
                QuietIconButton(
                  icon: Icons.delete_outline,
                  label: 'Remove from library',
                  color: Palette.muted,
                  onPressed: () => lib.remove(entry!.id),
                ),
              ],
            ),
          ],
        );
      case DownloadStatus.none:
        inner = Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              services.library.bookStore.isDurable
                  ? 'Kept on this device for offline reading. Verified against the catalog checksum.'
                  : 'Browser preview: kept in memory for this session only.',
              style: text.bodySmall,
            ),
            const SizedBox(height: Space.md),
            QuietButton(
              label: 'Download · ${formatBytes(book.fileSize)}',
              emphasis: true,
              expand: true,
              icon: Icons.arrow_downward,
              onPressed: () => lib.download(book, source),
            ),
          ],
        );
    }

    return AnimatedSize(
      duration: Motion.of(context, Motion.base),
      curve: Motion.curve,
      alignment: Alignment.topCenter,
      child: Container(
        padding: const EdgeInsets.all(Space.md),
        decoration: BoxDecoration(
          color: Palette.panel,
          border: Border.all(color: Palette.border),
          borderRadius: const BorderRadius.all(Radii.lg),
        ),
        child: inner,
      ),
    );
  }

  Future<void> _confirmRemove(BuildContext context) async {
    final lib = AppScope.of(context).library;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove download?'),
        content: const Text(
          'The file and your reading position for this book will be deleted from this device.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Keep', style: TextStyle(color: Palette.muted)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Remove', style: TextStyle(color: Palette.error)),
          ),
        ],
      ),
    );
    if (ok == true) await lib.remove(entry!.id);
  }
}
