import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app_scope.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import 'category_items.dart';
import 'category_sheet.dart';

/// One extra row in [showItemActions].
class ItemAction {
  const ItemAction({required this.icon, required this.label, required this.onSelected, this.destructive = false});
  final IconData icon;
  final String label;
  final VoidCallback onSelected;
  final bool destructive;
}

/// The long-press menu of a book or article: filing it ("Add to…", or
/// "Move to…" and "Remove from category" once filed), then the caller's own
/// [actions]. The header names the item and the category it is in.
Future<void> showItemActions(
  BuildContext context, {
  required FiledItem item,
  required String subtitle,
  List<ItemAction> actions = const [],
}) async {
  HapticFeedback.selectionClick();
  final store = AppScope.of(context).categories;
  final current = store?.categoryOf(item.ref);
  final rows = <ItemAction>[
    if (store != null)
      ItemAction(
        icon: current == null ? Icons.create_new_folder_outlined : Icons.drive_file_move_outline,
        label: current == null ? 'Add to…' : 'Move to…',
        onSelected: () => showCategoryPicker(context, item),
      ),
    if (current != null)
      ItemAction(
        icon: Icons.close,
        label: 'Remove from category',
        onSelected: () => removeFromCategory(context, item),
      ),
    ...actions,
  ];
  await showItemActionsFor(
    context,
    title: item.title,
    subtitle: Builder(
      builder: (ctx) {
        final text = Theme.of(ctx).textTheme;
        return Row(
          children: [
            if (current != null) ...[
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(color: current.color.hue, shape: BoxShape.circle),
              ),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  current.name,
                  style: text.bodySmall?.copyWith(color: ctx.colors.fg),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Text('  ·  ', style: text.bodySmall),
            ],
            Flexible(
              child: Text(subtitle, style: text.bodySmall, maxLines: 1, overflow: TextOverflow.ellipsis),
            ),
          ],
        );
      },
    ),
    actions: rows,
  );
}

/// A titled list of actions in a bottom sheet; the chosen one runs after the
/// sheet has closed, so it may open a sheet or dialog of its own.
Future<void> showItemActionsFor(
  BuildContext context, {
  required String title,
  Widget? subtitle,
  required List<ItemAction> actions,
}) async {
  final chosen = await showModalBottomSheet<ItemAction>(
    context: context,
    barrierColor: Colors.black54,
    builder: (ctx) {
      final colors = ctx.colors;
      return SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.only(top: Space.lg, bottom: Space.sm),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: Space.gutter),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: Theme.of(ctx).textTheme.titleMedium,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (subtitle != null) ...[const SizedBox(height: 4), subtitle],
                  ],
                ),
              ),
              const SizedBox(height: Space.sm),
              for (final a in actions)
                ListTile(
                  minTileHeight: 52,
                  leading: Icon(a.icon, size: 20, color: a.destructive ? colors.error : null),
                  title: Text(a.label, style: a.destructive ? TextStyle(color: colors.error) : null),
                  onTap: () => Navigator.pop(ctx, a),
                ),
            ],
          ),
        ),
      );
    },
  );
  if (chosen != null && context.mounted) chosen.onSelected();
}
