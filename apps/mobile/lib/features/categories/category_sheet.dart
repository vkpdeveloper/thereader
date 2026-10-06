import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app_scope.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/category.dart';
import '../../data/repositories/category_repository.dart';
import '../shared/states.dart';
import 'category_items.dart';
import 'category_shelf.dart';

/// "Add to…" for one item. Starts at the picker, or at the create step when
/// there are no categories yet. Choosing a category files the item, closes
/// the sheet and confirms with an undoable snack bar.
Future<void> showCategoryPicker(BuildContext context, FiledItem item) async {
  final store = AppScope.of(context).categories;
  if (store == null) return;
  final messenger = ScaffoldMessenger.maybeOf(context);
  final fg = context.colors.fg;
  final before = store.categoryOf(item.ref);
  final after = await _show<Category?>(
    context,
    (_) => _CategorySheet(store: store, item: item),
  );
  // Null means dismissed; the sheet returns [_removed] for "Remove".
  if (after == null || after.id == before?.id) return;
  final removed = identical(after, _removed);
  messenger?.showSnackBar(
    _snack(
      fg,
      removed
          ? 'Removed from ${before!.name}'
          : before == null
          ? 'Added to ${after.name}'
          : 'Moved to ${after.name}',
      undo: () => store.assign(item.ref, before?.id),
    ),
  );
}

/// Takes [item] out of its category, back to the Library home.
Future<void> removeFromCategory(BuildContext context, FiledItem item) async {
  final store = AppScope.of(context).categories;
  final before = store?.categoryOf(item.ref);
  if (store == null || before == null) return;
  final messenger = ScaffoldMessenger.maybeOf(context);
  final snack = _snack(context.colors.fg, 'Removed from ${before.name}', undo: () => store.assign(item.ref, before.id));
  await store.assign(item.ref, null);
  messenger?.showSnackBar(snack);
}

/// Create a category without filing anything yet.
Future<Category?> showCreateCategory(BuildContext context) {
  final store = AppScope.of(context).categories;
  if (store == null) return Future.value();
  return _show<Category?>(context, (_) => _CategorySheet(store: store));
}

/// Rename and recolour. [focusName] opens the keyboard on the name field.
Future<void> showEditCategory(BuildContext context, Category category, {bool focusName = true}) async {
  final store = AppScope.of(context).categories;
  if (store == null) return;
  await _show<Category?>(
    context,
    (_) => _CategorySheet(store: store, editing: category, focusName: focusName),
  );
}

Future<T?> _show<T>(BuildContext context, WidgetBuilder builder) => showModalBottomSheet<T>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  barrierColor: Colors.black54,
  builder: builder,
);

/// Undo is best effort: if the old category was deleted meanwhile, the item
/// simply stays where it is.
SnackBar _snack(Color actionColor, String message, {required Future<void> Function() undo}) => SnackBar(
  content: Text(message),
  action: SnackBarAction(
    label: 'Undo',
    textColor: actionColor,
    onPressed: () => undo().catchError((Object _) {}),
  ),
);

/// Sentinel result: the item was taken out of its category.
final _removed = Category(
  id: '',
  name: '',
  color: CategoryColor.gray,
  createdAt: DateTime.utc(0),
  updatedAt: DateTime.utc(0),
);

enum _Step { pick, create }

class _CategorySheet extends StatefulWidget {
  const _CategorySheet({required this.store, this.item, this.editing, this.focusName = true});

  final CategoryStore store;

  /// The item being filed; null when creating or editing on its own.
  final FiledItem? item;
  final Category? editing;
  final bool focusName;

  @override
  State<_CategorySheet> createState() => _CategorySheetState();
}

class _CategorySheetState extends State<_CategorySheet> {
  late _Step _step = widget.item != null && widget.store.categories.isNotEmpty ? _Step.pick : _Step.create;

  /// Steps forward (picker → create) slide in from the right; back from the left.
  bool _forward = true;

  /// The category just made here: preselected in the picker, with a button
  /// to file the item in it.
  String? _created;

  void _go(_Step step) {
    if (step == _step) return;
    if (step == _Step.pick) FocusScope.of(context).unfocus();
    setState(() {
      _forward = step == _Step.create;
      _step = step;
    });
  }

  Future<void> _choose(Category c) async {
    final item = widget.item!;
    if (widget.store.categoryOf(item.ref)?.id != c.id) {
      HapticFeedback.selectionClick();
      try {
        await widget.store.assign(item.ref, c.id);
      } on ArgumentError catch (e) {
        // Deleted on another device while the sheet was open.
        if (mounted) _fail('${e.message}');
        return;
      }
    }
    if (mounted) Navigator.of(context).pop(c);
  }

  Future<void> _remove() async {
    await widget.store.assign(widget.item!.ref, null);
    if (mounted) Navigator.of(context).pop(_removed);
  }

  void _fail(String message) =>
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(message)));

  Future<void> _submit(String name, CategoryColor color) async {
    final editing = widget.editing;
    if (editing != null) {
      await widget.store.update(
        editing.id,
        name: name == editing.name ? null : name,
        color: color == editing.color ? null : color,
      );
      if (mounted) Navigator.of(context).pop(widget.store.byId(editing.id));
      return;
    }
    final created = await widget.store.create(name, color);
    if (!mounted) return;
    if (widget.item == null) {
      Navigator.of(context).pop(created);
      return;
    }
    _created = created.id;
    _go(_Step.pick);
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final duration = Motion.of(context, Motion.base);
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.only(top: Space.md, bottom: Space.sm),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Container(
                  width: 36,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: Space.sm),
                  decoration: BoxDecoration(
                    color: colors.element,
                    borderRadius: const BorderRadius.all(Radius.circular(2)),
                  ),
                ),
              ),
              AnimatedSize(
                duration: duration,
                curve: Motion.curve,
                alignment: Alignment.topCenter,
                child: AnimatedSwitcher(
                  duration: duration,
                  switchInCurve: Motion.curve,
                  switchOutCurve: Curves.easeInCubic,
                  layoutBuilder: (current, previous) => Stack(
                    alignment: Alignment.topCenter,
                    children: [...previous, ?current],
                  ),
                  transitionBuilder: (child, animation) {
                    final incoming = child.key == ValueKey(_step);
                    final dx = (incoming == _forward ? 1 : -1) * 0.08;
                    return FadeTransition(
                      opacity: animation,
                      child: SlideTransition(
                        position: Tween(begin: Offset(dx, 0), end: Offset.zero).animate(animation),
                        child: child,
                      ),
                    );
                  },
                  child: switch (_step) {
                    _Step.pick => _Picker(
                      key: const ValueKey(_Step.pick),
                      store: widget.store,
                      item: widget.item!,
                      created: _created,
                      onChoose: _choose,
                      onRemove: _remove,
                      onNew: () => _go(_Step.create),
                    ),
                    _Step.create => _CreateForm(
                      key: const ValueKey(_Step.create),
                      store: widget.store,
                      item: widget.item,
                      editing: widget.editing,
                      autofocus: widget.focusName,
                      onBack: widget.item != null && widget.store.categories.isNotEmpty
                          ? () => _go(_Step.pick)
                          : null,
                      onSubmit: _submit,
                    ),
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Picker extends StatelessWidget {
  const _Picker({
    super.key,
    required this.store,
    required this.item,
    required this.created,
    required this.onChoose,
    required this.onRemove,
    required this.onNew,
  });

  final CategoryStore store;
  final FiledItem item;
  final String? created;
  final ValueChanged<Category> onChoose;
  final VoidCallback onRemove;
  final VoidCallback onNew;

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    final text = Theme.of(context).textTheme;
    final colors = context.colors;
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final current = store.categoryOf(item.ref);
        final categories = store.categories;
        final fresh = created == null ? null : store.byId(created!);
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _SheetHeader(eyebrow: current == null ? 'Add to' : 'Move to', title: item.title),
            const SizedBox(height: Space.sm),
            Flexible(
              child: ConstrainedBox(
                constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.5),
                child: ListView(
                  shrinkWrap: true,
                  padding: EdgeInsets.zero,
                  physics: const BouncingScrollPhysics(parent: AlwaysScrollableScrollPhysics()),
                  children: [
                    for (final c in categories)
                      _Row(
                        leading: _Dot(color: c.color.hue),
                        label: c.name,
                        trailing: Text(
                          '${filedItems(services, c.id).length}',
                          style: text.labelSmall?.copyWith(letterSpacing: 0),
                        ),
                        checked: c.id == current?.id || c.id == fresh?.id,
                        tint: c.id == fresh?.id ? c.color.hue : null,
                        semanticsLabel: c.id == current?.id ? '${c.name}, current category' : c.name,
                        onTap: () => onChoose(c),
                      ),
                    _Row(
                      leading: Icon(Icons.add, size: 18, color: colors.muted),
                      label: 'New category…',
                      muted: true,
                      onTap: onNew,
                    ),
                  ],
                ),
              ),
            ),
            if (current != null) ...[
              const Padding(
                padding: EdgeInsets.symmetric(vertical: Space.xs),
                child: Divider(indent: Space.gutter, endIndent: Space.gutter),
              ),
              _Row(
                leading: Icon(Icons.close, size: 18, color: colors.muted),
                label: 'Remove from category',
                muted: true,
                onTap: onRemove,
              ),
            ],
            if (fresh != null && current?.id != fresh.id)
              Padding(
                padding: const EdgeInsets.fromLTRB(Space.gutter, Space.md, Space.gutter, 0),
                child: QuietButton(
                  label: current == null ? 'Add to ${fresh.name}' : 'Move to ${fresh.name}',
                  emphasis: true,
                  expand: true,
                  onPressed: () => onChoose(fresh),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _SheetHeader extends StatelessWidget {
  const _SheetHeader({required this.eyebrow, this.title, this.onBack});
  final String eyebrow;
  final String? title;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: EdgeInsets.fromLTRB(onBack == null ? Space.gutter : Space.xs, Space.xs, Space.gutter, 0),
      child: Row(
        children: [
          if (onBack != null) QuietIconButton(icon: Icons.arrow_back, label: 'Back to categories', onPressed: onBack),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Eyebrow(eyebrow),
                if (title != null) ...[
                  const SizedBox(height: 4),
                  Text(title!, style: text.titleMedium, maxLines: 1, overflow: TextOverflow.ellipsis),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot({required this.color});
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    width: 12,
    height: 12,
    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
  );
}

class _Row extends StatelessWidget {
  const _Row({
    required this.leading,
    required this.label,
    required this.onTap,
    this.trailing,
    this.checked = false,
    this.muted = false,
    this.tint,
    this.semanticsLabel,
  });

  final Widget leading;
  final String label;
  final VoidCallback onTap;
  final Widget? trailing;
  final bool checked;
  final bool muted;
  final Color? tint;
  final String? semanticsLabel;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final colors = context.colors;
    return Semantics(
      button: true,
      selected: checked,
      label: semanticsLabel ?? label,
      excludeSemantics: true,
      child: AnimatedContainer(
        duration: Motion.of(context, Motion.slow),
        curve: Motion.curve,
        color: tint?.withValues(alpha: 0.10) ?? Colors.transparent,
        child: InkWell(
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 52),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.gutter),
              child: Row(
                children: [
                  SizedBox(width: 20, child: Center(child: leading)),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Text(
                      label,
                      style: text.bodyLarge?.copyWith(color: muted ? colors.muted : colors.fg),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (trailing != null) ...[const SizedBox(width: Space.sm), trailing!],
                  SizedBox(
                    width: 30,
                    child: checked
                        ? Align(
                            alignment: Alignment.centerRight,
                            child: Icon(Icons.check, size: 18, color: colors.fg),
                          )
                        : null,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Name, colour and a live preview of the shelf as it will look on the
/// Library home, with the item being filed already standing on it.
class _CreateForm extends StatefulWidget {
  const _CreateForm({
    super.key,
    required this.store,
    required this.item,
    required this.editing,
    required this.autofocus,
    required this.onBack,
    required this.onSubmit,
  });

  final CategoryStore store;
  final FiledItem? item;
  final Category? editing;
  final bool autofocus;
  final VoidCallback? onBack;
  final Future<void> Function(String name, CategoryColor color) onSubmit;

  @override
  State<_CreateForm> createState() => _CreateFormState();
}

class _CreateFormState extends State<_CreateForm> {
  late final TextEditingController _name = TextEditingController(text: widget.editing?.name);
  late CategoryColor _color =
      widget.editing?.color ?? CategoryColor.next(widget.store.categories.map((c) => c.color));
  bool _tried = false;
  bool _busy = false;

  /// A rejection from the store, shown until the name changes.
  String? _failure;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  String get _trimmed => _name.text.trim();

  /// The repository's own rules; "Enter a name." waits for a submit.
  String? get _error {
    if (_failure != null) return _failure;
    if (!_tried && _trimmed.isEmpty) return null;
    try {
      CategoryRepository.validateName(_name.text);
      return null;
    } on FormatException catch (e) {
      return e.message;
    }
  }

  /// Names may repeat (the contract allows it), but say so.
  String? get _warning {
    final n = _trimmed.toLowerCase();
    if (n.isEmpty) return null;
    final same = widget.store.categories.any((c) => c.id != widget.editing?.id && c.name.toLowerCase() == n);
    return same ? 'You already have a category with this name.' : null;
  }

  bool get _valid {
    try {
      CategoryRepository.validateName(_name.text);
      return true;
    } on FormatException {
      return false;
    }
  }

  Future<void> _submit() async {
    setState(() => _tried = true);
    if (!_valid || _busy) return;
    setState(() => _busy = true);
    try {
      await widget.onSubmit(_trimmed, _color);
    } on FormatException catch (e) {
      if (mounted) setState(() => _failure = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final colors = context.colors;
    final editing = widget.editing;
    final item = widget.item;
    final previewItems = editing != null
        ? filedItems(AppScope.of(context), editing.id).take(3).toList()
        : [?item];
    final count = editing != null ? filedItems(AppScope.of(context), editing.id).length : previewItems.length;
    final warning = _warning;
    final length = _trimmed.length;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _SheetHeader(
          eyebrow: editing != null ? 'Edit category' : 'New category',
          title: item == null ? null : 'For ${item.title}',
          onBack: widget.onBack,
        ),
        const SizedBox(height: Space.md),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: Space.gutter),
          child: Row(
            children: [
              TweenAnimationBuilder<Color?>(
                tween: ColorTween(end: _color.hue),
                duration: Motion.of(context, Motion.base),
                curve: Motion.curve,
                builder: (context, hue, _) => ExcludeSemantics(
                  child: ShelfCase(color: hue!, items: previewItems, width: 96),
                ),
              ),
              const SizedBox(width: Space.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _trimmed.isEmpty ? 'Untitled' : _trimmed,
                      style: text.headlineMedium?.copyWith(color: _trimmed.isEmpty ? colors.subtle : colors.fg),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      count == 0 ? 'Empty shelf' : itemCount(count),
                      style: text.labelSmall?.copyWith(letterSpacing: 0),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: Space.md),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: Space.gutter),
          child: TextField(
            controller: _name,
            autofocus: widget.autofocus,
            enabled: !_busy,
            textCapitalization: TextCapitalization.sentences,
            textInputAction: TextInputAction.done,
            inputFormatters: [FilteringTextInputFormatter.deny(RegExp(r'[\u0000-\u001F\u007F]'))],
            onChanged: (_) => setState(() => _failure = null),
            onSubmitted: (_) => _submit(),
            style: text.bodyLarge,
            decoration: InputDecoration(
              hintText: 'Name, like Programming',
              errorText: _error,
              helperText: warning,
              helperStyle: text.bodySmall?.copyWith(color: colors.orange),
              suffixText: length > maxCategoryName - 15 ? '$length/$maxCategoryName' : null,
              suffixStyle: text.labelSmall?.copyWith(
                color: length > maxCategoryName ? colors.error : colors.muted,
                letterSpacing: 0,
              ),
            ),
          ),
        ),
        const SizedBox(height: Space.md),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: Space.gutter - 4),
          child: _Swatches(selected: _color, onSelect: (c) => setState(() => _color = c)),
        ),
        const SizedBox(height: Space.md),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: Space.gutter),
          child: QuietButton(
            label: editing != null ? 'Save' : 'Create',
            emphasis: true,
            expand: true,
            onPressed: _valid && !_busy ? _submit : null,
          ),
        ),
      ],
    );
  }
}

class _Swatches extends StatelessWidget {
  const _Swatches({required this.selected, required this.onSelect});
  final CategoryColor selected;
  final ValueChanged<CategoryColor> onSelect;

  static const double _target = 44;
  static const int _perRow = 6;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final duration = Motion.of(context, Motion.fast);
    return LayoutBuilder(
      builder: (context, c) {
        final gap = ((c.maxWidth - _target * _perRow) / (_perRow - 1)).clamp(0.0, 20.0);
        return Wrap(
          spacing: gap,
          runSpacing: 4,
          children: [
            for (final color in CategoryColor.values)
              Semantics(
                button: true,
                selected: color == selected,
                label: '${color.name[0].toUpperCase()}${color.name.substring(1)}',
                excludeSemantics: true,
                child: InkResponse(
                  onTap: () {
                    HapticFeedback.selectionClick();
                    onSelect(color);
                  },
                  radius: _target / 2,
                  child: SizedBox.square(
                    dimension: _target,
                    child: Center(
                      child: AnimatedContainer(
                        duration: duration,
                        curve: Motion.curve,
                        width: 36,
                        height: 36,
                        padding: EdgeInsets.all(color == selected ? 4 : 0),
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: color == selected ? color.hue : Colors.transparent,
                            width: 2,
                          ),
                        ),
                        child: DecoratedBox(
                          decoration: BoxDecoration(color: color.hue, shape: BoxShape.circle),
                          child: AnimatedOpacity(
                            duration: duration,
                            opacity: color == selected ? 1 : 0,
                            child: Icon(Icons.check, size: 16, color: colors.bg),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}
