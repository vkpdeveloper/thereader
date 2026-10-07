import 'package:flutter/material.dart';

import '../../app_scope.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/category.dart';
import '../articles/article_tile.dart';
import '../library/book_grid_item.dart';
import '../shared/states.dart';
import 'category_items.dart';
import 'category_sheet.dart';
import 'category_shelf.dart';
import 'item_actions.dart';

/// One category: its name over a wash of its colour, then its books and
/// articles, newest first. Options rename, recolour or delete it; deleting
/// sends its items back to the Library home.
class CategoryScreen extends StatelessWidget {
  const CategoryScreen({super.key, required this.categoryId});

  final String categoryId;

  static Future<void> open(BuildContext context, String categoryId) =>
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => CategoryScreen(categoryId: categoryId)));

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    final store = services.categories!;
    return ListenableBuilder(
      listenable: Listenable.merge([store, services.library, ?services.articles]),
      builder: (context, _) {
        final category = store.byId(categoryId);
        if (category == null) {
          // Deleted here a moment ago, or on another device.
          return Scaffold(
            appBar: AppBar(leading: const BackButton()),
            body: StateMessage(
              title: 'This category is gone.',
              body: 'It was deleted. Anything that was in it is back in your library.',
              actionLabel: 'Back to library',
              onAction: () => Navigator.of(context).maybePop(),
            ),
          );
        }
        final items = filedItems(services, categoryId);
        final books = items.whereType<FiledBook>().toList();
        final articles = items.whereType<FiledArticle>().toList();
        final both = books.isNotEmpty && articles.isNotEmpty;
        final width = MediaQuery.sizeOf(context).width;
        final hue = category.color.hue;
        return Scaffold(
          extendBodyBehindAppBar: true,
          appBar: AppBar(
            leading: const BackButton(),
            backgroundColor: Colors.transparent,
            actions: [
              Padding(
                padding: const EdgeInsets.only(right: Space.xs),
                child: QuietIconButton(
                  icon: Icons.more_horiz,
                  label: 'Category options',
                  onPressed: () => _options(context, category, items.length),
                ),
              ),
            ],
          ),
          body: CustomScrollView(
            physics: const BouncingScrollPhysics(parent: AlwaysScrollableScrollPhysics()),
            slivers: [
              SliverToBoxAdapter(
                child: _Header(category: category, items: items),
              ),
              if (items.isEmpty)
                SliverToBoxAdapter(child: _EmptyShelf(color: hue))
              else ...[
                if (books.isNotEmpty) ...[
                  if (both)
                    const SliverPadding(
                      padding: EdgeInsets.fromLTRB(Space.gutter, Space.lg, Space.gutter, 0),
                      sliver: SliverToBoxAdapter(child: Eyebrow('Books')),
                    ),
                  SliverPadding(
                    padding: const EdgeInsets.fromLTRB(Space.gutter, Space.lg, Space.gutter, Space.lg),
                    sliver: SliverGrid.builder(
                      gridDelegate: bookGridDelegate(context, width),
                      itemCount: books.length,
                      itemBuilder: (context, i) => BookGridItem(entry: books[i].entry),
                    ),
                  ),
                ],
                if (articles.isNotEmpty) ...[
                  if (both)
                    const SliverPadding(
                      padding: EdgeInsets.fromLTRB(Space.gutter, Space.md, Space.gutter, 0),
                      sliver: SliverToBoxAdapter(child: Eyebrow('Articles')),
                    ),
                  SliverPadding(
                    padding: const EdgeInsets.fromLTRB(Space.gutter, Space.sm, Space.gutter, Space.xxl),
                    sliver: SliverList.builder(
                      itemCount: articles.length,
                      itemBuilder: (context, i) =>
                          ArticleTile(summary: articles[i].summary, articles: services.articles!),
                    ),
                  ),
                ],
              ],
            ],
          ),
        );
      },
    );
  }

  Future<void> _options(BuildContext context, Category category, int count) => showItemActionsFor(
    context,
    title: category.name,
    actions: [
      ItemAction(icon: Icons.edit_outlined, label: 'Rename', onSelected: () => showEditCategory(context, category)),
      ItemAction(
        icon: Icons.palette_outlined,
        label: 'Change colour',
        onSelected: () => showEditCategory(context, category, focusName: false),
      ),
      ItemAction(
        icon: Icons.delete_outline,
        label: 'Delete category',
        destructive: true,
        onSelected: () => _confirmDelete(context, category, count),
      ),
    ],
  );

  Future<void> _confirmDelete(BuildContext context, Category category, int count) async {
    final colors = context.colors;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Delete “${category.name}”?'),
        content: Text(
          count == 0
              ? 'The shelf is empty, so nothing else changes.'
              : '${count == 1 ? 'Its one item goes' : 'Its $count items go'} back to your library. Nothing is removed from this device.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('Keep', style: TextStyle(color: colors.muted)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text('Delete', style: TextStyle(color: colors.error)),
          ),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    final store = AppScope.of(context).categories!;
    final messenger = ScaffoldMessenger.maybeOf(context);
    // Leave first so this screen never shows its own "gone" state.
    Navigator.of(context).pop();
    await store.delete(category.id);
    messenger
      ?..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(
            count == 0
                ? 'Deleted ${category.name}.'
                : 'Deleted ${category.name}. ${count == 1 ? '1 item is' : '$count items are'} back in your library.',
          ),
        ),
      );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.category, required this.items});
  final Category category;
  final List<FiledItem> items;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final colors = context.colors;
    final hue = category.color.hue;
    // The app bar floats over the wash; the body's top padding includes it.
    final top = MediaQuery.paddingOf(context).top;
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [hue.withValues(alpha: 0.16), hue.withValues(alpha: 0.04), hue.withValues(alpha: 0)],
          stops: const [0, 0.6, 1],
        ),
      ),
      child: Padding(
        padding: EdgeInsets.fromLTRB(Space.gutter, top + Space.sm, Space.gutter, Space.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(color: hue, shape: BoxShape.circle),
                ),
                const SizedBox(width: Space.sm),
                const Eyebrow('Category'),
              ],
            ),
            const SizedBox(height: Space.sm),
            Text(category.name, style: text.displayLarge),
            const SizedBox(height: Space.sm),
            Text(
              items.isEmpty ? 'Empty shelf' : itemBreakdown(items),
              style: text.bodyMedium?.copyWith(color: colors.muted),
            ),
          ],
        ),
      ),
    );
  }
}

class _EmptyShelf extends StatelessWidget {
  const _EmptyShelf({required this.color});
  final Color color;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.gutter, Space.xl, Space.gutter, Space.xl),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ExcludeSemantics(
            child: ShelfCase(color: color, items: const [], width: 200),
          ),
          const SizedBox(height: Space.lg),
          Text('Nothing on this shelf yet.', style: text.headlineMedium),
          const SizedBox(height: Space.sm),
          Text(
            'In your library, press and hold a book or an article, then choose Add to…',
            style: text.bodyMedium?.copyWith(color: colors.muted),
          ),
        ],
      ),
    );
  }
}
