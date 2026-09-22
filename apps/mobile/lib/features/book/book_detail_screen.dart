import 'package:flutter/material.dart';

import '../../app_scope.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/book.dart';
import '../../data/api/catalog_source.dart';
import '../../data/models/library.dart';
import '../reader/reader_screen.dart';
import '../shared/cloud_status.dart';
import '../shared/cover_art.dart';
import '../shared/states.dart';

/// Book page: description, edition facts, one honest download control, and
/// a separate cloud panel (upload state, reading time). Removing a book lives
/// in the app bar, away from the reading action, and always asks first.
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
    return ListenableBuilder(
      listenable: Listenable.merge([services.library, ?imports, ?sync]),
      builder: (context, _) {
        final entry = services.library.entryFor(book, source);
        final current = entry?.book ?? book;
        final text = Theme.of(context).textTheme;
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
                    color: Palette.muted,
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
                style: text.bodyLarge?.copyWith(color: Palette.muted),
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
              const SizedBox(height: Space.lg),
              _DownloadPanel(
                book: book,
                entry: entry,
                outdated: outdated,
                source: source,
              ),
              if (entry != null && (imports != null || sync != null)) ...[
                const SizedBox(height: Space.md),
                _CloudPanel(entry: entry),
              ],
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
            child: const Text('Keep', style: TextStyle(color: Palette.muted)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Remove', style: TextStyle(color: Palette.error)),
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

/// Cloud facts for a book that is in the library, kept apart from the
/// download and read controls: is the file in the cloud yet, and how long
/// has it been read across devices.
class _CloudPanel extends StatefulWidget {
  const _CloudPanel({required this.entry});
  final LibraryEntry entry;

  @override
  State<_CloudPanel> createState() => _CloudPanelState();
}

class _CloudPanelState extends State<_CloudPanel> {
  bool _retrying = false;

  Future<void> _retry() async {
    final imports = AppScope.of(context).imports;
    if (imports == null || _retrying) return;
    setState(() => _retrying = true);
    try {
      await imports.retryPending();
    } finally {
      if (mounted) setState(() => _retrying = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    final imports = services.imports;
    final sync = services.sync;
    final entry = widget.entry;
    final text = Theme.of(context).textTheme;
    final phase = uploadPhaseFor(services, entry);

    // Upload line: only the import service knows whether the bytes are up.
    IconData icon;
    Color color;
    String line;
    double? fraction;
    switch (phase) {
      case UploadPhase.uploading:
        icon = Icons.cloud_upload_outlined;
        color = Palette.muted;
        fraction = imports?.uploadFraction;
        line = fraction == null
            ? 'Uploading to the cloud. Readable here now.'
            : 'Uploading to the cloud · ${(fraction * 100).round()}%. Readable here now.';
      case UploadPhase.pending:
        icon = Icons.cloud_queue_outlined;
        color = Palette.orange;
        line =
            'Readable here. Upload waiting; it retries when the app is open and online.';
      case UploadPhase.failed:
        icon = Icons.cloud_off_outlined;
        color = Palette.error;
        line =
            'Readable here, but the upload failed. ${imports?.errorFor(entry.id) ?? ''}'
                .trim();
      case UploadPhase.none:
        icon = Icons.cloud_done_outlined;
        color = Palette.green;
        line = entry.download.isReady
            ? 'In the cloud and on this device.'
            : 'In the cloud. Save a full copy for offline reading.';
    }

    final readingMs = sync?.readingMillisecondsFor(entry);

    return Container(
      padding: const EdgeInsets.all(Space.md),
      decoration: BoxDecoration(
        border: Border.all(color: Palette.border),
        borderRadius: const BorderRadius.all(Radii.lg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Eyebrow('Cloud'),
          const SizedBox(height: Space.sm),
          if (imports != null) ...[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 1),
                  child: Icon(icon, size: 16, color: color),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    line,
                    style: text.bodySmall?.copyWith(color: Palette.muted),
                  ),
                ),
                if (phase == UploadPhase.pending ||
                    phase == UploadPhase.failed) ...[
                  const SizedBox(width: Space.sm),
                  QuietButton(
                    label: _retrying || imports.busy ? 'Retrying' : 'Retry',
                    onPressed: _retrying || imports.busy ? null : _retry,
                  ),
                ],
              ],
            ),
            if (phase == UploadPhase.uploading) ...[
              const SizedBox(height: Space.sm),
              ClipRRect(
                borderRadius: BorderRadius.circular(1),
                child: LinearProgressIndicator(value: fraction, minHeight: 2),
              ),
            ],
          ],
          if (imports != null && sync != null) const SizedBox(height: Space.sm),
          if (sync != null)
            Row(
              children: [
                const Icon(
                  Icons.schedule_outlined,
                  size: 16,
                  color: Palette.muted,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    readingMs == null || readingMs <= 0
                        ? 'No reading time recorded yet.'
                        : 'Read for ${formatReadingTime(readingMs)} across your devices.',
                    style: text.bodySmall?.copyWith(color: Palette.muted),
                  ),
                ),
              ],
            ),
        ],
      ),
    );
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
              style: text.bodySmall?.copyWith(color: Palette.fg),
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
        // Once the opening slice is cached the book is readable while the rest
        // arrives. It is not "downloaded": that word waits for verification.
        final readable = entry != null && lib.canRead(entry!.id);
        inner = Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (readable) ...[
              QuietButton(
                label: entry!.progress == null ? 'Read' : 'Continue reading',
                emphasis: true,
                expand: true,
                onPressed: () => ReaderScreen.open(context, entry!),
              ),
              const SizedBox(height: Space.xs),
              Text('The rest downloads while you read.', style: text.bodySmall),
              const SizedBox(height: Space.md),
            ],
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
                    d.error ??
                        (outdated
                            ? 'Downloaded (an older edition). '
                            : 'Saved and verified. '),
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
              style: text.bodyMedium?.copyWith(color: Palette.error),
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
}
