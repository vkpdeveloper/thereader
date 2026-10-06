import 'package:flutter/material.dart';

import '../../app_scope.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/book.dart';
import '../../data/api/catalog_source.dart';
import '../../data/models/library.dart';
import '../categories/category_items.dart';
import '../categories/category_sheet.dart';
import '../reader/reader_screen.dart';
import '../shared/cloud_status.dart';
import '../shared/cover_art.dart';
import '../shared/states.dart';

/// Book page: description, edition facts and one honest download control.
/// Cloud upload and sync state are reported only in Settings; this page stays
/// quiet about them. Removing a book lives in the app bar, away from the
/// reading action, and always asks first.
class BookDetailScreen extends StatelessWidget {
  const BookDetailScreen({super.key, required this.book, required this.source});

  final Book book;
  final CatalogSource source;

  static Future<void> open(
    BuildContext context,
    Book book, {
    LibraryEntry? entry,
  }) => Navigator.of(context).push(
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
    final imports = services.imports;
    final sync = services.sync;
    final categories = services.categories;
    return ListenableBuilder(
      // The import service is observed only so "Remove" can tell whether a
      // cancelled upload is at stake; nothing about uploads is displayed.
      listenable: Listenable.merge([services.library, ?imports, ?categories]),
      builder: (context, _) {
        final entry = services.library.entryFor(book, source);
        final current = entry?.book ?? book;
        final text = Theme.of(context).textTheme;
        final colors = context.colors;
        final d = entry?.download ?? const DownloadState();
        final coverUri = source.coverUri(current);
        final outdated =
            entry != null && entry.book.sha256 != book.sha256 && d.isReady;
        // Removing a cloud download keeps its synced metadata. There is no
        // local file to remove from an already cloud-only entry.
        final removable =
            entry != null &&
            !d.isActive &&
            (sync == null ||
                d.status != DownloadStatus.none ||
                (imports?.isPending(entry.id) ?? false));

        return Scaffold(
          appBar: AppBar(
            leading: const BackButton(),
            actions: [
              if (removable)
                Padding(
                  padding: const EdgeInsets.only(right: Space.xs),
                  child: QuietIconButton(
                    icon: Icons.delete_outline,
                    label: d.isReady || sync != null
                        ? 'Remove download'
                        : 'Remove from library',
                    color: colors.muted,
                    onPressed: () => _confirmRemove(context, entry, d),
                  ),
                ),
            ],
          ),
          body: ListView(
            physics: const BouncingScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(
              Space.gutter,
              0,
              Space.gutter,
              Space.xxl,
            ),
            children: [
              CoverArt(book: current, width: 120, imageUri: coverUri),
              const SizedBox(height: Space.lg),
              Text(current.title, style: text.displaySmall),
              const SizedBox(height: Space.xs),
              Text(
                current.author,
                style: text.bodyLarge?.copyWith(color: colors.muted),
              ),
              const SizedBox(height: Space.md),
              Wrap(
                spacing: Space.sm,
                runSpacing: Space.sm,
                children: [
                  for (final s in current.subjects) Tag(s),
                  Tag(current.language.toUpperCase()),
                  Tag(formatBytes(current.fileSize)),
                ],
              ),
              if (entry != null && categories != null) ...[
                const SizedBox(height: Space.md),
                _CategoryPill(entry: entry),
              ],
              const SizedBox(height: Space.lg),
              _DownloadPanel(
                book: book,
                entry: entry,
                outdated: outdated,
                source: source,
              ),
              const SizedBox(height: Space.xl),
              if (current.description.isNotEmpty) ...[
                const Eyebrow('About'),
                const SizedBox(height: Space.sm),
                Text(
                  current.description,
                  style: text.bodyLarge?.copyWith(
                    fontFamily: Fonts.serif,
                    height: 1.55,
                  ),
                ),
                const SizedBox(height: Space.xl),
              ],
              const Eyebrow('Edition'),
              const SizedBox(height: Space.sm),
              _Fact('Version', current.version),
              _Fact(
                'Updated',
                current.updatedAt.toLocal().toString().split(' ').first,
              ),
            ],
          ),
        );
      },
    );
  }

  /// Cloud books retain their position and library membership when local bytes
  /// are removed. An unpublished import is cancelled before removing its file.
  Future<void> _confirmRemove(
    BuildContext context,
    LibraryEntry entry,
    DownloadState d,
  ) async {
    final services = AppScope.of(context);
    final lib = services.library;
    final phase = uploadPhaseFor(services, entry);
    final keepMetadata = services.sync != null && phase == UploadPhase.none;
    final uploadNote = switch (phase) {
      UploadPhase.none => '',
      UploadPhase.uploading => ' The upload in progress will be cancelled.',
      UploadPhase.pending || UploadPhase.failed =>
        ' The waiting upload will be cancelled, so this book will not reach your other devices.',
    };
    final colors = context.colors;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(
          d.isReady || keepMetadata
              ? 'Remove download?'
              : 'Remove from library?',
        ),
        content: Text(
          (keepMetadata
                  ? 'The file will be removed from this device. Your cloud book, reading position and reading time stay available.'
                  : d.isReady
                  ? 'The file and your reading position for this book will be deleted from this device.'
                  : 'This book and its reading position will be removed from your library. You can download it again from Browse.') +
              uploadNote,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('Keep', style: TextStyle(color: colors.muted)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text('Remove', style: TextStyle(color: colors.error)),
          ),
        ],
      ),
    );
    if (ok != true) return;
    // Abort the upload before the bytes disappear; the service tolerates ids
    // that were never queued.
    await services.imports?.cancelPending(entry.id);
    await lib.remove(entry.id, keepMetadata: keepMetadata);
  }
}

class _Fact extends StatelessWidget {
  const _Fact(this.label, this.value);
  final String label;
  final String value;

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
              style: text.bodySmall?.copyWith(color: context.colors.fg),
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
    final colors = context.colors;
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
        // Once the opening slice is cached the book is readable while the rest
        // arrives. It is not "downloaded": that word waits for verification.
        final readable = entry != null && lib.canRead(entry!.id);
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
            if (readable) ...[
              const SizedBox(height: Space.md),
              QuietButton(
                label: entry!.progress == null ? 'Read' : 'Continue reading',
                emphasis: true,
                expand: true,
                onPressed: () => ReaderScreen.open(context, entry!),
              ),
            ],
          ],
        );
      case DownloadStatus.ready:
        inner = Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.check, size: 16, color: colors.green),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    d.error ??
                        (outdated
                            ? 'Downloaded (an older edition). '
                            : 'Saved and verified. '),
                    style: text.bodySmall?.copyWith(
                      color: outdated ? colors.orange : colors.muted,
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
                    label: entry?.progress == null
                        ? 'Read'
                        : 'Continue reading',
                    emphasis: true,
                    expand: true,
                    onPressed: () => ReaderScreen.open(context, entry!),
                  ),
                ),
                if (outdated) ...[
                  const SizedBox(width: Space.sm),
                  QuietButton(
                    label: 'Update',
                    onPressed: () => lib.download(book, source),
                  ),
                ],
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
              style: text.bodyMedium?.copyWith(color: colors.error),
            ),
            const SizedBox(height: Space.md),
            QuietButton(
              label: 'Try again',
              emphasis: true,
              expand: true,
              onPressed: () => lib.download(book, source),
            ),
          ],
        );
      case DownloadStatus.none:
        inner = Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              services.library.bookStore.isDurable
                  ? 'Saved offline and checksum-verified.'
                  : 'Browser preview: this session only.',
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
          color: colors.panel,
          border: Border.all(color: colors.border),
          borderRadius: const BorderRadius.all(Radii.lg),
        ),
        child: inner,
      ),
    );
  }
}

/// Where this book is filed, or an invitation to file it. Tapping opens the
/// "Add to…" sheet either way.
class _CategoryPill extends StatelessWidget {
  const _CategoryPill({required this.entry});
  final LibraryEntry entry;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final colors = context.colors;
    final item = FiledBook(entry);
    final category = AppScope.of(context).categories?.categoryOf(item.ref);
    final hue = category?.color.hue;
    return Align(
      alignment: Alignment.centerLeft,
      child: Semantics(
        button: true,
        label: category == null ? 'Add to category' : 'In ${category.name}. Move to another category',
        excludeSemantics: true,
        child: InkWell(
          onTap: () => showCategoryPicker(context, item),
          borderRadius: const BorderRadius.all(Radius.circular(22)),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 44),
            child: Center(
              widthFactor: 1,
              child: AnimatedContainer(
                duration: Motion.of(context, Motion.base),
                curve: Motion.curve,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                decoration: BoxDecoration(
                  color: hue?.withValues(alpha: 0.12) ?? Colors.transparent,
                  border: Border.all(color: hue?.withValues(alpha: 0.35) ?? colors.border),
                  borderRadius: const BorderRadius.all(Radius.circular(16)),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (hue != null)
                      Container(
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(color: hue, shape: BoxShape.circle),
                      )
                    else
                      Icon(Icons.create_new_folder_outlined, size: 16, color: colors.muted),
                    const SizedBox(width: Space.sm),
                    Flexible(
                      child: Text(
                        category?.name ?? 'Add to category',
                        style: text.labelLarge?.copyWith(color: hue == null ? colors.muted : colors.fg),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Icon(Icons.expand_more, size: 16, color: colors.muted),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
