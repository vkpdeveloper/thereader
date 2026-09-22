import 'package:flutter/material.dart';
import '../../core/theme/tokens.dart';
import '../../reader/engine/reader_engine.dart';

class ReaderSearchSheet extends StatefulWidget {
  const ReaderSearchSheet({super.key, required this.controller});
  final ReaderController controller;
  @override
  State<ReaderSearchSheet> createState() => _ReaderSearchSheetState();
}

class _ReaderSearchSheetState extends State<ReaderSearchSheet> {
  final _query = TextEditingController();
  List<ReaderSearchMatch>? _matches;
  bool _busy = false;
  String? _error;
  Future<void> _search() async {
    if (_busy || _query.text.trim().isEmpty) return;
    setState(() { _busy = true; _error = null; });
    try {
      final matches = await (widget.controller as ReaderSearch).search(_query.text);
      if (mounted) setState(() => _matches = matches);
    } catch (_) {
      if (mounted) setState(() => _error = 'Search could not finish. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
  @override
  void dispose() { _query.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) => SafeArea(
    child: Padding(
      padding: EdgeInsets.fromLTRB(Space.gutter, Space.lg, Space.gutter, MediaQuery.viewInsetsOf(context).bottom),
      child: SizedBox(height: MediaQuery.sizeOf(context).height * .6, child: Column(
        children: [
          TextField(controller: _query, textInputAction: TextInputAction.search,
            onSubmitted: (_) => _search(), decoration: InputDecoration(hintText: 'Search this book',
              suffixIcon: IconButton(tooltip: 'Find text', onPressed: _busy ? null : _search, icon: const Icon(Icons.search)))),
          const SizedBox(height: Space.md),
          if (_busy) const LinearProgressIndicator(minHeight: 2),
          if (_error != null) Text(_error!),
          if (_matches?.isEmpty == true) const Text('No matches.'),
          Expanded(child: ListView.builder(itemCount: _matches?.length ?? 0, itemBuilder: (context, index) {
            final match = _matches![index];
            return ListTile(contentPadding: EdgeInsets.zero,
              title: Text(match.excerpt.isEmpty ? (match.locator.title ?? 'Match') : match.excerpt,
                maxLines: 3, overflow: TextOverflow.ellipsis),
              onTap: () { Navigator.pop(context); widget.controller.goTo(match.locator); });
          })),
        ],
      )),
    ),
  );
}
