import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/highlight_colors.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/highlight.dart';
import '../../data/repositories/highlight_repository.dart';
import '../shared/states.dart';

/// A row of the highlight colours; [selected] gets a ring. [order] puts the
/// colours in another order (the default first, in the selection toolbar).
class HighlightSwatches extends StatelessWidget {
  const HighlightSwatches({
    super.key,
    required this.selected,
    required this.onChanged,
    this.order,
    this.compact = false,
  });

  final HighlightColor selected;
  final ValueChanged<HighlightColor> onChanged;
  final List<HighlightColor>? order;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final box = compact ? 38.0 : 44.0;
    final dot = compact ? 24.0 : 28.0;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final c in order ?? HighlightColor.values)
          Semantics(
            button: true,
            selected: c == selected,
            label: c.name,
            child: InkResponse(
              onTap: () => onChanged(c),
              radius: box / 2,
              child: SizedBox(
                width: box,
                height: box,
                child: Center(
                  child: AnimatedContainer(
                    duration: Motion.of(context, Motion.fast),
                    width: dot,
                    height: dot,
                    padding: const EdgeInsets.all(3),
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: c == selected ? colors.fg : colors.border,
                        width: c == selected ? 2 : 1,
                      ),
                    ),
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: HighlightColors.swatch(c),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// The toolbar for a fresh selection: highlight in a colour (the default
/// first), highlight and write a note, or copy. Placed like the system
/// toolbar it replaces, above the selection or else below it.
class HighlightSelectionToolbar extends StatelessWidget {
  const HighlightSelectionToolbar({
    super.key,
    required this.anchors,
    required this.defaultColor,
    required this.onHighlight,
    required this.onNote,
    required this.onCopy,
  });

  final TextSelectionToolbarAnchors anchors;
  final HighlightColor defaultColor;
  final ValueChanged<HighlightColor> onHighlight;
  final VoidCallback onNote;
  final VoidCallback onCopy;

  static const _screenPadding = 8.0;
  static const _gapAbove = 10.0;

  /// Clears the selection handles below the text.
  static const _gapBelow = 22.0;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final top = MediaQuery.paddingOf(context).top + _screenPadding;
    final shift = Offset(_screenPadding, top);
    final order = [
      defaultColor,
      ...HighlightColor.values.where((c) => c != defaultColor),
    ];
    final label = Theme.of(
      context,
    ).textTheme.labelLarge?.copyWith(color: colors.fg);
    Widget action(IconData icon, String text, VoidCallback onPressed) =>
        InkWell(
          onTap: onPressed,
          borderRadius: const BorderRadius.all(Radii.sm),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 44),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(icon, size: 17, color: colors.fg),
                  const SizedBox(width: 6),
                  Text(text, style: label),
                ],
              ),
            ),
          ),
        );
    return Padding(
      padding: EdgeInsets.fromLTRB(
        _screenPadding,
        top,
        _screenPadding,
        _screenPadding,
      ),
      child: CustomSingleChildLayout(
        delegate: TextSelectionToolbarLayoutDelegate(
          anchorAbove:
              anchors.primaryAnchor - const Offset(0, _gapAbove) - shift,
          anchorBelow:
              (anchors.secondaryAnchor ?? anchors.primaryAnchor) +
              const Offset(0, _gapBelow) -
              shift,
        ),
        child: Semantics(
          container: true,
          label: 'Selection',
          child: Material(
            color: colors.panel,
            elevation: 8,
            shadowColor: Colors.black,
            shape: RoundedRectangleBorder(
              borderRadius: const BorderRadius.all(Radii.md),
              side: BorderSide(color: colors.border),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  HighlightSwatches(
                    selected: defaultColor,
                    order: order,
                    compact: true,
                    onChanged: onHighlight,
                  ),
                  Container(
                    width: 1,
                    height: 24,
                    margin: const EdgeInsets.symmetric(horizontal: 4),
                    color: colors.border,
                  ),
                  action(Icons.edit_note, 'Note', onNote),
                  action(Icons.copy, 'Copy', onCopy),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Grabber extends StatelessWidget {
  const _Grabber();

  @override
  Widget build(BuildContext context) => Center(
    child: Container(
      width: 36,
      height: 4,
      margin: const EdgeInsets.only(bottom: Space.md),
      decoration: BoxDecoration(
        color: context.colors.element,
        borderRadius: const BorderRadius.all(Radius.circular(2)),
      ),
    ),
  );
}

/// A note as quoted under a passage: a rule at the start, serif text.
class _NoteText extends StatelessWidget {
  const _NoteText(this.note, {this.maxLines});

  final String note;
  final int? maxLines;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsetsDirectional.only(start: 10),
      decoration: BoxDecoration(
        border: BorderDirectional(
          start: BorderSide(color: colors.borderActive, width: 2),
        ),
      ),
      child: Text(
        note,
        maxLines: maxLines,
        overflow: maxLines == null ? null : TextOverflow.ellipsis,
        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
          fontFamily: Fonts.serif,
          color: colors.fg,
          height: 1.45,
        ),
      ),
    );
  }
}

/// Deletes at once and offers Undo, which restores the passage as a new
/// highlight (as the web app does).
void deleteHighlightWithUndo(
  BuildContext context,
  HighlightRepository repo,
  Highlight h,
) {
  final messenger = ScaffoldMessenger.maybeOf(context);
  repo.delete(h.id);
  messenger
    ?..hideCurrentSnackBar()
    ..showSnackBar(
      SnackBar(
        content: const Text('Highlight deleted.'),
        action: SnackBarAction(
          label: 'Undo',
          onPressed: () => repo.create(
            bookId: h.bookId,
            sha256: h.sha256,
            origin: h.origin,
            locator: h.locator,
            text: h.text,
            color: h.color,
            note: h.note,
          ),
        ),
      ),
    );
}

/// Recolour, annotate, copy or delete one highlight. Its note shows above
/// the actions. Edits are local; sync sends them on its next cycle.
Future<void> showHighlightActions(
  BuildContext context,
  HighlightRepository repo,
  String id,
) {
  return showModalBottomSheet<void>(
    context: context,
    barrierColor: Colors.black54,
    builder: (ctx) => ListenableBuilder(
      listenable: repo,
      builder: (ctx, _) {
        final h = repo.byId(id);
        if (h == null || h.deleted) return const SizedBox.shrink();
        final colors = ctx.colors;
        final note = h.noteText;
        void editNote() {
          Navigator.pop(ctx);
          editHighlightNote(context, repo, id);
        }

        return SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              Space.gutter,
              Space.lg,
              Space.gutter,
              Space.md,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const _Grabber(),
                if (note != null) ...[
                  Semantics(
                    button: true,
                    label: 'Edit note',
                    child: InkWell(
                      onTap: editNote,
                      borderRadius: const BorderRadius.all(Radii.sm),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: Space.xs),
                        child: _NoteText(note, maxLines: 6),
                      ),
                    ),
                  ),
                  const SizedBox(height: Space.md),
                ],
                Center(
                  child: HighlightSwatches(
                    selected: h.colorKey,
                    onChanged: (c) => repo.recolor(id, c.name),
                  ),
                ),
                const SizedBox(height: Space.sm),
                Row(
                  children: [
                    Expanded(
                      child: TextButton.icon(
                        onPressed: editNote,
                        icon: Icon(Icons.edit_note, size: 20, color: colors.fg),
                        label: Text(
                          note == null ? 'Note' : 'Edit note',
                          style: TextStyle(color: colors.fg),
                        ),
                      ),
                    ),
                    Expanded(
                      child: TextButton.icon(
                        onPressed: () {
                          Clipboard.setData(ClipboardData(text: h.text));
                          Navigator.pop(ctx);
                        },
                        icon: Icon(Icons.copy, size: 18, color: colors.fg),
                        label: Text('Copy', style: TextStyle(color: colors.fg)),
                      ),
                    ),
                    Expanded(
                      child: TextButton.icon(
                        onPressed: () {
                          Navigator.pop(ctx);
                          deleteHighlightWithUndo(context, repo, h);
                        },
                        icon: Icon(
                          Icons.delete_outline,
                          size: 18,
                          color: colors.error,
                        ),
                        label: Text(
                          'Delete',
                          style: TextStyle(color: colors.error),
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    ),
  );
}

/// Writes, edits or removes a highlight's note. Saving an empty note
/// removes it.
Future<void> editHighlightNote(
  BuildContext context,
  HighlightRepository repo,
  String id,
) async {
  final h = repo.byId(id);
  if (h == null || h.deleted) return;
  final result = await showModalBottomSheet<({String? note})>(
    context: context,
    isScrollControlled: true,
    barrierColor: Colors.black54,
    builder: (_) => _NoteEditor(initial: h.noteText, quote: h.text),
  );
  if (result != null) await repo.setNote(id, result.note);
}

class _NoteEditor extends StatefulWidget {
  const _NoteEditor({required this.initial, required this.quote});

  final String? initial;

  /// The highlighted passage, shown above the field for context.
  final String quote;

  @override
  State<_NoteEditor> createState() => _NoteEditorState();
}

class _NoteEditorState extends State<_NoteEditor> {
  late final TextEditingController _field = TextEditingController(
    text: widget.initial ?? '',
  );

  @override
  void dispose() {
    _field.dispose();
    super.dispose();
  }

  void _save() {
    final text = _field.text.trim();
    Navigator.pop(context, (note: text.isEmpty ? null : text));
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final theme = Theme.of(context).textTheme;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            Space.gutter,
            Space.lg,
            Space.gutter,
            Space.sm,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const _Grabber(),
              Text(
                widget.quote,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: theme.bodyMedium?.copyWith(
                  fontFamily: Fonts.serif,
                  color: colors.muted,
                ),
              ),
              const SizedBox(height: Space.md),
              TextField(
                controller: _field,
                autofocus: true,
                minLines: 3,
                maxLines: 8,
                maxLength: HighlightRepository.maxNote,
                textCapitalization: TextCapitalization.sentences,
                style: theme.bodyLarge?.copyWith(color: colors.fg),
                decoration: const InputDecoration(
                  hintText: 'Add a note',
                  semanticCounterText: '',
                ),
                buildCounter:
                    (
                      _, {
                      required currentLength,
                      required isFocused,
                      required maxLength,
                    }) => maxLength != null && currentLength > maxLength - 200
                    ? Text(
                        '${maxLength - currentLength} left',
                        style: theme.labelSmall?.copyWith(color: colors.subtle),
                      )
                    : null,
              ),
              const SizedBox(height: Space.sm),
              Row(
                children: [
                  if (widget.initial != null)
                    TextButton(
                      onPressed: () => Navigator.pop(context, (note: null)),
                      child: Text(
                        'Remove',
                        style: TextStyle(color: colors.error),
                      ),
                    ),
                  const Spacer(),
                  TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: Text(
                      'Cancel',
                      style: TextStyle(color: colors.muted),
                    ),
                  ),
                  const SizedBox(width: Space.xs),
                  QuietButton(label: 'Save', emphasis: true, onPressed: _save),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Every highlight [items] lists (one book edition, or one article), in
/// reading order, with notes.
Future<void> showHighlightsList(
  BuildContext context, {
  required HighlightRepository repo,
  required List<Highlight> Function() items,
  required ValueChanged<Highlight> onOpen,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    barrierColor: Colors.black54,
    builder: (ctx) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.6,
      maxChildSize: 0.92,
      // Its own messenger, so Undo shows on the sheet rather than under it.
      builder: (ctx, scroll) => ScaffoldMessenger(
        child: Scaffold(
          backgroundColor: Colors.transparent,
          body: ListenableBuilder(
            listenable: repo,
            builder: (ctx, _) {
              final list = items();
              final colors = ctx.colors;
              final text = Theme.of(ctx).textTheme;
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Padding(
                    padding: EdgeInsets.fromLTRB(
                      Space.gutter,
                      Space.lg,
                      Space.gutter,
                      Space.sm,
                    ),
                    child: Eyebrow('Highlights'),
                  ),
                  if (list.isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(Space.gutter),
                      child: Text(
                        'No highlights yet.',
                        style: text.bodyMedium?.copyWith(color: colors.muted),
                      ),
                    ),
                  Expanded(
                    child: ListView.builder(
                      controller: scroll,
                      itemCount: list.length,
                      itemBuilder: (_, i) {
                        final h = list[i];
                        final note = h.noteText;
                        return Dismissible(
                          key: ValueKey(h.id),
                          direction: DismissDirection.endToStart,
                          background: Container(
                            color: colors.error,
                            alignment: Alignment.centerRight,
                            padding: const EdgeInsets.only(right: Space.gutter),
                            child: Icon(Icons.delete_outline, color: colors.bg),
                          ),
                          onDismissed: (_) =>
                              deleteHighlightWithUndo(ctx, repo, h),
                          child: ListTile(
                            contentPadding: const EdgeInsets.only(
                              left: Space.gutter,
                              right: Space.sm,
                            ),
                            leading: Container(
                              width: 10,
                              height: 10,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: HighlightColors.swatch(h.colorKey),
                              ),
                            ),
                            minLeadingWidth: 10,
                            title: Text(
                              h.text,
                              maxLines: 3,
                              overflow: TextOverflow.ellipsis,
                              style: text.bodyMedium?.copyWith(
                                fontFamily: Fonts.serif,
                                color: colors.fg,
                              ),
                            ),
                            subtitle: note == null && h.chapter == null
                                ? null
                                : Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      if (note != null)
                                        Padding(
                                          padding: const EdgeInsets.only(
                                            top: Space.xs + 2,
                                          ),
                                          child: _NoteText(note, maxLines: 3),
                                        ),
                                      if (h.chapter != null)
                                        Padding(
                                          padding: const EdgeInsets.only(
                                            top: Space.xs,
                                          ),
                                          child: Text(
                                            h.chapter!,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: text.labelSmall?.copyWith(
                                              color: colors.muted,
                                            ),
                                          ),
                                        ),
                                    ],
                                  ),
                            trailing: QuietIconButton(
                              icon: Icons.delete_outline,
                              label: 'Delete highlight',
                              color: colors.muted,
                              onPressed: () =>
                                  deleteHighlightWithUndo(ctx, repo, h),
                            ),
                            onTap: () {
                              Navigator.pop(ctx);
                              onOpen(h);
                            },
                          ),
                        );
                      },
                    ),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    ),
  );
}
