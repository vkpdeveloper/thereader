import 'package:flutter/material.dart';

import '../../app_scope.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/library.dart';
import '../book/book_detail_screen.dart';
import '../categories/category_items.dart';
import '../categories/item_actions.dart';
import '../reader/reader_screen.dart';
import '../shared/cover_art.dart';

/// Columns for the cover grid at this width.
int bookGridColumns(double width) => width >= 900
    ? 5
    : width >= 600
    ? 4
    : width >= 420
    ? 3
    : 2;

/// The cover grid's layout: a cover plus room for title, author and status.
SliverGridDelegate bookGridDelegate(BuildContext context, double width) {
  final columns = bookGridColumns(width);
  return SliverGridDelegateWithFixedCrossAxisCount(
    crossAxisCount: columns,
    mainAxisSpacing: Space.lg,
    crossAxisSpacing: Space.md,
    mainAxisExtent:
        ((width - Space.gutter * 2 - Space.md * (columns - 1)) / columns) / CoverArt.ratio +
        MediaQuery.textScalerOf(context).scale(96),
  );
}

/// A book in a cover grid. Tap reads (or opens the book page when it cannot
/// be read yet); long press offers filing and the book page.
class BookGridItem extends StatelessWidget {
  const BookGridItem({super.key, required this.entry});
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
        onLongPress: () => showItemActions(
          context,
          item: FiledBook(entry),
          subtitle: entry.book.author,
          actions: [
            ItemAction(
              icon: Icons.info_outline,
              label: 'Book details',
              onSelected: () => BookDetailScreen.open(context, entry.book, entry: entry),
            ),
          ],
        ),
        borderRadius: const BorderRadius.all(Radii.md),
        child: LayoutBuilder(
          builder: (context, c) => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              CoverArt(book: entry.book, width: c.maxWidth, imageUri: coverUriFor(services, entry)),
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
