import 'package:flutter/material.dart';

import '../../app_scope.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/book.dart';
import '../../data/models/library.dart';
import '../../data/repositories/catalog_repository.dart';
import '../book/book_detail_screen.dart';
import '../shared/cover_art.dart';
import '../shared/states.dart';

/// Browse the catalog: server-side search, local subject filter, paging.
class CatalogScreen extends StatefulWidget {
  const CatalogScreen({super.key, required this.onOpenSettings});

  final VoidCallback onOpenSettings;

  @override
  State<CatalogScreen> createState() => _CatalogScreenState();
}

class _CatalogScreenState extends State<CatalogScreen> {
  final TextEditingController _search = TextEditingController();
  final ScrollController _scroll = ScrollController();
  String? _subject;
  bool _onlyDownloaded = false;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (_scroll.position.extentAfter < 400) AppScope.of(context).catalog.loadMore();
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final c = AppScope.of(context).catalog;
      if (c.status == CatalogStatus.idle) c.refresh();
    });
  }

  @override
  void dispose() {
    _search.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    return ListenableBuilder(
      listenable: Listenable.merge([services.catalog, services.library]),
      builder: (context, _) {
        final catalog = services.catalog;
        if (catalog.status == CatalogStatus.idle) {
          WidgetsBinding.instance.addPostFrameCallback((_) => catalog.refresh());
        }
        final text = Theme.of(context).textTheme;
        var items = catalog.items;
        if (_subject != null) items = items.where((b) => b.subjects.contains(_subject)).toList();
        if (_onlyDownloaded) {
          items = items
              .where(
                (b) =>
                    services.library.entryFor(b, services.currentSource)?.download.isReady == true,
              )
              .toList();
        }
        final subjects = catalog.subjects;

        return CustomScrollView(
          controller: _scroll,
          physics: const BouncingScrollPhysics(parent: AlwaysScrollableScrollPhysics()),
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(Space.gutter, Space.md, Space.gutter, 0),
              sliver: SliverToBoxAdapter(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Expanded(child: Text('Browse', style: text.displaySmall)),
                        QuietIconButton(
                          icon: Icons.tune,
                          label: 'Library API settings',
                          color: Palette.muted,
                          onPressed: widget.onOpenSettings,
                        ),
                      ],
                    ),
                    const SizedBox(height: Space.md),
                    TextField(
                      controller: _search,
                      onChanged: catalog.search,
                      textInputAction: TextInputAction.search,
                      style: text.bodyMedium,
                      decoration: InputDecoration(
                        hintText: 'Search title, author or subject',
                        prefixIcon: const Icon(Icons.search, size: 18, color: Palette.muted),
                        suffixIcon: _search.text.isEmpty
                            ? null
                            : QuietIconButton(
                                icon: Icons.close,
                                label: 'Clear search',
                                color: Palette.muted,
                                onPressed: () {
                                  _search.clear();
                                  catalog.search('');
                                },
                              ),
                      ),
                    ),
                    if (subjects.isNotEmpty || services.library.entries.isNotEmpty) ...[
                      const SizedBox(height: Space.sm),
                      SizedBox(
                        height: 36,
                        child: ListView(
                          scrollDirection: Axis.horizontal,
                          children: [
                            _Chip(
                              label: 'Downloaded',
                              selected: _onlyDownloaded,
                              onTap: () => setState(() => _onlyDownloaded = !_onlyDownloaded),
                            ),
                            for (final s in subjects)
                              _Chip(
                                label: s,
                                selected: _subject == s,
                                onTap: () => setState(() => _subject = _subject == s ? null : s),
                              ),
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            ..._body(context, catalog, items),
          ],
        );
      },
    );
  }

  List<Widget> _body(
    BuildContext context,
    CatalogRepository catalog,
    List<Book> items,
  ) {
    if (catalog.status == CatalogStatus.loading || catalog.status == CatalogStatus.idle) {
      return [
        SliverToBoxAdapter(
          child: LoadingLine(label: 'Contacting ${catalog.source.origin}'),
        ),
      ];
    }
    if (catalog.status == CatalogStatus.error) {
      final err = catalog.error!;
      return [
        SliverFillRemaining(
          hasScrollBody: false,
          child: StateMessage(
            title: err.isNetwork ? "Can't reach the API." : 'The API returned an error.',
            body:
                '${err.message}\n${catalog.source.origin}${err.isNetwork ? '\n\nBooks already downloaded stay readable from Library.' : ''}',
            tone: Palette.error,
            actionLabel: 'Try again',
            onAction: catalog.refresh,
          ),
        ),
      ];
    }
    if (items.isEmpty) {
      return [
        SliverFillRemaining(
          hasScrollBody: false,
          child: StateMessage(
            title: catalog.query.isEmpty && _subject == null && !_onlyDownloaded
                ? 'The catalog is empty.'
                : 'No matches.',
            body: catalog.query.isEmpty && _subject == null && !_onlyDownloaded
                ? 'Nothing is published at ${catalog.source.origin} yet.\nPull to refresh, or change the API in Settings.'
                : 'Try a different search or clear the filters.',
            actionLabel: _subject != null || _onlyDownloaded ? 'Clear filters' : null,
            onAction: () => setState(() {
              _subject = null;
              _onlyDownloaded = false;
            }),
          ),
        ),
      ];
    }
    return [
      const SliverToBoxAdapter(child: SizedBox(height: Space.md)),
      SliverList.separated(
        itemCount: items.length,
        separatorBuilder: (_, _) => const Divider(indent: Space.gutter, endIndent: Space.gutter),
        itemBuilder: (context, i) => _CatalogRow(book: items[i]),
      ),
      SliverToBoxAdapter(
        child: catalog.isLoadingMore
            ? const LoadingLine()
            : catalog.hasMore
            ? Padding(
                padding: const EdgeInsets.all(Space.gutter),
                child: QuietButton(label: 'Load more', onPressed: catalog.loadMore),
              )
            : const SizedBox(height: Space.xxl),
      ),
    ];
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: Space.sm),
      child: Semantics(
        button: true,
        selected: selected,
        child: InkWell(
          onTap: onTap,
          borderRadius: const BorderRadius.all(Radius.circular(18)),
          child: AnimatedContainer(
            duration: Motion.of(context, Motion.fast),
            padding: const EdgeInsets.symmetric(horizontal: 12),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: selected ? Palette.fg : Colors.transparent,
              border: Border.all(color: selected ? Palette.fg : Palette.border),
              borderRadius: const BorderRadius.all(Radius.circular(18)),
            ),
            child: Text(
              label,
              style: Theme.of(
                context,
              ).textTheme.labelMedium?.copyWith(color: selected ? Palette.bg : Palette.fg),
            ),
          ),
        ),
      ),
    );
  }
}

class _CatalogRow extends StatelessWidget {
  const _CatalogRow({required this.book});
  final Book book;

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    final entry = services.library.entryFor(book, services.currentSource);
    final text = Theme.of(context).textTheme;
    final d = entry?.download;
    Widget trailing;
    if (d != null && d.isActive) {
      trailing = SizedBox(
        width: 22,
        height: 22,
        child: CircularProgressIndicator(
          strokeWidth: 2,
          value: d.status == DownloadStatus.verifying ? null : d.fraction,
        ),
      );
    } else if (d != null && d.isReady) {
      trailing = const Icon(Icons.check, size: 18, color: Palette.green);
    } else if (d != null && d.status == DownloadStatus.failed) {
      trailing = const Icon(Icons.error_outline, size: 18, color: Palette.error);
    } else {
      trailing = Icon(Icons.chevron_right, size: 18, color: Palette.subtle);
    }
    return ListTile(
      onTap: () => BookDetailScreen.open(context, book),
      leading: CoverArt(book: book, width: 40, imageUri: services.catalog.source.coverUri(book)),
      title: Text(book.title, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(
        [
          book.author,
          if (book.subjects.isNotEmpty) book.subjects.first,
          formatBytes(book.fileSize),
        ].join(' · '),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: text.bodySmall,
      ),
      trailing: trailing,
    );
  }
}
