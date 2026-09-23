import 'package:flutter/material.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import '../../core/typography/reader_fonts.dart';
import '../../data/repositories/settings_repository.dart';
import '../shared/states.dart';

/// Opens the font picker over the reader. Choices apply immediately, so the
/// page behind the sheet is the full-size preview.
Future<void> showReaderFontPicker(BuildContext context, SettingsRepository settings) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    barrierColor: Colors.black54,
    builder: (_) => ReaderFontPicker(settings: settings),
  );
}

/// Font list in the style of Chrome's reading mode: every name is set in its
/// own face, with a live sample of the current choice on top.
class ReaderFontPicker extends StatelessWidget {
  const ReaderFontPicker({super.key, required this.settings});

  final SettingsRepository settings;

  static TextStyle familyStyle(ReaderFontFamily f) =>
      TextStyle(fontFamily: f.flutterFamily, fontFamilyFallback: f.flutterFallback);

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final colors = context.colors;
    final maxHeight = MediaQuery.sizeOf(context).height * 0.85;
    return ListenableBuilder(
      listenable: settings,
      builder: (context, _) {
        final current = ReaderFonts.resolve(settings.reader);
        return SafeArea(
          top: false,
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: maxHeight),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(Space.gutter, Space.lg, Space.gutter, Space.md),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Center(
                    child: Container(
                      width: 36,
                      height: 4,
                      margin: const EdgeInsets.only(bottom: Space.md),
                      decoration: BoxDecoration(color: colors.element, borderRadius: const BorderRadius.all(Radius.circular(2))),
                    ),
                  ),
                  const Eyebrow('Font'),
                  const SizedBox(height: Space.md),
                  _Sample(family: current, fontSize: settings.reader.fontSize.clamp(15, 22).toDouble()),
                  const SizedBox(height: Space.md),
                  Flexible(
                    child: ListView(
                      shrinkWrap: true,
                      padding: EdgeInsets.zero,
                      children: [
                        for (final f in ReaderFonts.all)
                          _FontTile(
                            family: f,
                            selected: f.id == current.id,
                            onTap: () => settings.setFontFamily(f),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(height: Space.sm),
                  Text(
                    'Fonts are bundled with the app and work offline.',
                    style: text.bodySmall?.copyWith(color: colors.subtle),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _Sample extends StatelessWidget {
  const _Sample({required this.family, required this.fontSize});

  final ReaderFontFamily family;
  final double fontSize;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final colors = context.colors;
    final base = ReaderFontPicker.familyStyle(family).copyWith(fontSize: fontSize, height: 1.5, color: colors.ink);
    return Container(
      padding: const EdgeInsets.all(Space.md),
      decoration: BoxDecoration(
        color: colors.paper,
        border: Border.all(color: colors.border),
        borderRadius: const BorderRadius.all(Radii.lg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            label: 'Sample text in ${family.label}',
            excludeSemantics: true,
            child: Text.rich(
              TextSpan(
                style: base,
                children: const [
                  TextSpan(text: 'The lamps came on one by one, and the '),
                  TextSpan(text: 'quiet', style: TextStyle(fontStyle: FontStyle.italic)),
                  TextSpan(text: ' harbour turned to '),
                  TextSpan(text: 'gold', style: TextStyle(fontWeight: FontWeight.w700)),
                  TextSpan(text: '. Il1 O0 rn m'),
                ],
              ),
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(height: Space.sm),
          Text(family.description, style: text.bodySmall?.copyWith(color: colors.muted)),
        ],
      ),
    );
  }
}

class _FontTile extends StatelessWidget {
  const _FontTile({required this.family, required this.selected, required this.onTap});

  final ReaderFontFamily family;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final colors = context.colors;
    return Semantics(
      button: true,
      selected: selected,
      label: family.recommended ? '${family.label}, recommended' : family.label,
      excludeSemantics: true,
      // excludeSemantics drops the InkWell's action, so expose it here.
      onTap: onTap,
      child: InkWell(
        onTap: onTap,
        borderRadius: const BorderRadius.all(Radii.md),
        child: AnimatedContainer(
          duration: Motion.of(context, Motion.fast),
          constraints: const BoxConstraints(minHeight: 52),
          padding: const EdgeInsets.symmetric(horizontal: Space.md - 4),
          decoration: BoxDecoration(
            color: selected ? colors.element : Colors.transparent,
            borderRadius: const BorderRadius.all(Radii.md),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  family.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ReaderFontPicker.familyStyle(family).copyWith(
                    fontSize: 18,
                    color: selected ? colors.fg : colors.muted,
                  ),
                ),
              ),
              if (family.recommended) ...[
                const SizedBox(width: Space.sm),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    border: Border.all(color: colors.borderActive),
                    borderRadius: const BorderRadius.all(Radii.sm),
                  ),
                  child: Text('Recommended', style: text.labelSmall?.copyWith(color: colors.muted)),
                ),
              ],
              const SizedBox(width: Space.sm),
              SizedBox(
                width: 20,
                child: selected ? Icon(Icons.check, size: 18, color: colors.fg) : null,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
