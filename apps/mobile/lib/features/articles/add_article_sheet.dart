import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import '../../data/articles/page_fetcher.dart';
import '../../data/models/article_summary.dart';
import '../../data/repositories/article_repository.dart';
import '../shared/states.dart';
import 'article_screen.dart';

/// Asks for a link, saves the article and opens it.
Future<void> showAddArticleSheet(BuildContext context, ArticleRepository articles) async {
  final summary = await showModalBottomSheet<ArticleSummary>(
    context: context,
    isScrollControlled: true,
    barrierColor: Colors.black54,
    builder: (_) => AddArticleSheet(articles: articles),
  );
  if (summary != null && context.mounted) await ArticleScreen.open(context, summary);
}

class AddArticleSheet extends StatefulWidget {
  const AddArticleSheet({super.key, required this.articles});

  final ArticleRepository articles;

  @override
  State<AddArticleSheet> createState() => _AddArticleSheetState();
}

class _AddArticleSheetState extends State<AddArticleSheet> {
  final TextEditingController _url = TextEditingController();
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  Future<void> _paste() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text?.trim();
    if (text == null || text.isEmpty || !mounted) return;
    _url.value = TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length));
    setState(() => _error = null);
  }

  Future<void> _save() async {
    if (_busy) return;
    if (ArticleRepository.parseInput(_url.text) == null) {
      setState(() => _error = 'Enter a web address, like example.com/story.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final summary = await widget.articles.add(_url.text);
      if (mounted) Navigator.of(context).pop(summary);
    } on ArticleFetchException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = "Couldn't save that article. $e");
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final colors = context.colors;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(Space.gutter, Space.lg, Space.gutter, Space.md),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Container(
                  width: 36,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: Space.md),
                  decoration: BoxDecoration(color: colors.element, borderRadius: const BorderRadius.all(Radius.circular(2))),
                ),
              ),
              const Eyebrow('Save an article'),
              const SizedBox(height: Space.sm),
              Text(
                'Paste a link to any article. It is saved on this device to read offline, without the clutter.',
                style: text.bodyMedium?.copyWith(color: colors.muted),
              ),
              const SizedBox(height: Space.md),
              TextField(
                controller: _url,
                autofocus: true,
                enabled: !_busy,
                keyboardType: TextInputType.url,
                textInputAction: TextInputAction.go,
                autocorrect: false,
                enableSuggestions: false,
                onSubmitted: (_) => _save(),
                onChanged: (_) {
                  if (_error != null) setState(() => _error = null);
                },
                style: text.bodyLarge,
                decoration: InputDecoration(
                  hintText: 'example.com/story',
                  errorText: _error,
                  errorMaxLines: 3,
                  suffixIcon: IconButton(
                    tooltip: 'Paste link',
                    onPressed: _busy ? null : _paste,
                    icon: Icon(Icons.content_paste_rounded, size: 18, color: colors.muted),
                  ),
                ),
              ),
              const SizedBox(height: Space.md),
              ValueListenableBuilder<ArticleAddProgress?>(
                valueListenable: widget.articles.adding,
                builder: (context, progress, _) {
                  if (!_busy || progress == null) {
                    return QuietButton(label: 'Save article', emphasis: true, expand: true, onPressed: _save);
                  }
                  final percent = progress.fraction == null ? '' : ' ${(progress.fraction! * 100).round()}%';
                  final label = switch (progress.phase) {
                    ArticlePhase.fetching => 'Fetching the page$percent',
                    ArticlePhase.extracting => 'Finding the article',
                    ArticlePhase.saving => 'Saving to your library',
                  };
                  return Semantics(
                    liveRegion: true,
                    label: label,
                    child: SizedBox(
                      height: 44,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text(label, style: text.bodySmall),
                          const SizedBox(height: Space.sm),
                          ClipRRect(
                            borderRadius: BorderRadius.circular(1),
                            child: LinearProgressIndicator(
                              value: progress.phase == ArticlePhase.fetching ? progress.fraction : null,
                              minHeight: 2,
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}
