import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/highlight_colors.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/highlight.dart';
import '../../data/repositories/highlight_repository.dart';
import '../shared/states.dart';

/// A row of the highlight colours; [selected] gets a ring.
class HighlightSwatches extends StatelessWidget {
  const HighlightSwatches({
    super.key,
    required this.selected,
    required this.onChanged,
  });

  final HighlightColor selected;
  final ValueChanged<HighlightColor> onChanged;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final c in HighlightColor.values)
          Semantics(
            button: true,
            selected: c == selected,
            label: c.name,
            child: InkResponse(
              onTap: () => onChanged(c),
              radius: 22,
              child: SizedBox(
                width: 44,
                height: 44,
                child: Center(
                  child: AnimatedContainer(
                    duration: Motion.of(context, Motion.fast),
                    width: 28,
                    height: 28,
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

/// Recolour, copy or delete one highlight. Edits are local; sync sends them
/// on its next cycle.
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
              children: [
                const _Grabber(),
                HighlightSwatches(
                  selected: h.colorKey,
                  onChanged: (c) => repo.recolor(id, c.name),
                ),
                const SizedBox(height: Space.sm),
                Row(
                  children: [
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
                          repo.delete(id);
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

/// Every highlight of the open edition, in reading order.
Future<void> showHighlightsList(
  BuildContext context, {
  required HighlightRepository repo,
  required String origin,
  required String sha256,
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
      builder: (ctx, scroll) => ListenableBuilder(
        listenable: repo,
        builder: (ctx, _) {
          final items = repo.forEdition(origin, sha256);
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
              if (items.isEmpty)
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
                  itemCount: items.length,
                  itemBuilder: (_, i) {
                    final h = items[i];
                    return Dismissible(
                      key: ValueKey(h.id),
                      direction: DismissDirection.endToStart,
                      background: Container(
                        color: colors.error,
                        alignment: Alignment.centerRight,
                        padding: const EdgeInsets.only(right: Space.gutter),
                        child: Icon(Icons.delete_outline, color: colors.bg),
                      ),
                      onDismissed: (_) => repo.delete(h.id),
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
                        subtitle: h.chapter == null
                            ? null
                            : Text(
                                h.chapter!,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: text.labelSmall?.copyWith(
                                  color: colors.muted,
                                ),
                              ),
                        trailing: QuietIconButton(
                          icon: Icons.delete_outline,
                          label: 'Delete highlight',
                          color: colors.muted,
                          onPressed: () => repo.delete(h.id),
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
  );
}
