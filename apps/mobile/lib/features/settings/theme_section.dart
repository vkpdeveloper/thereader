import 'package:flutter/material.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/theme_presets.dart';
import '../../core/theme/tokens.dart';
import '../shared/states.dart';

/// Theme picker: one card per preset, each a miniature of the app painted in
/// that preset's own colours, so the choice is visible before it is made.
class ThemeSection extends StatelessWidget {
  const ThemeSection({super.key, required this.selectedId, required this.onSelect});

  /// Saved id; null or unknown selects Default.
  final String? selectedId;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final current = ThemePreset.byId(selectedId);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Eyebrow('Theme'),
        const SizedBox(height: Space.sm),
        Text(
          'Colours for the whole app, including the reading page. All themes are dark.',
          style: text.bodySmall,
        ),
        const SizedBox(height: Space.md),
        LayoutBuilder(
          builder: (context, c) {
            final columns = c.maxWidth >= 560 ? 3 : 2;
            final width = (c.maxWidth - Space.sm * (columns - 1)) / columns;
            return Wrap(
              spacing: Space.sm,
              runSpacing: Space.sm,
              children: [
                for (final preset in ThemePreset.all)
                  SizedBox(
                    width: width,
                    child: ThemePreviewCard(
                      preset: preset,
                      selected: preset.id == current.id,
                      onTap: () => onSelect(preset.id),
                    ),
                  ),
              ],
            );
          },
        ),
      ],
    );
  }
}

/// A selectable preset card: miniature preview above, name below. Selection
/// is drawn with the preset's own foreground so the ring reads on any card.
class ThemePreviewCard extends StatelessWidget {
  const ThemePreviewCard({
    super.key,
    required this.preset,
    required this.selected,
    required this.onTap,
  });

  final ThemePreset preset;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final app = context.colors;
    final c = preset.colors;
    return Semantics(
      button: true,
      selected: selected,
      label: '${preset.name} theme',
      child: InkWell(
        onTap: onTap,
        borderRadius: const BorderRadius.all(Radii.lg),
        child: AnimatedContainer(
          duration: Motion.of(context, Motion.fast),
          curve: Motion.curve,
          decoration: BoxDecoration(
            color: app.panel,
            borderRadius: const BorderRadius.all(Radii.lg),
            border: Border.all(
              color: selected ? app.fg : app.border,
              width: selected ? 1.5 : 1,
            ),
          ),
          padding: const EdgeInsets.all(6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ClipRRect(
                borderRadius: const BorderRadius.all(Radii.md),
                child: AspectRatio(
                  aspectRatio: 4 / 3,
                  child: ThemeMiniature(colors: c),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(6, 10, 4, 4),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        preset.name,
                        style: text.labelLarge?.copyWith(color: selected ? app.fg : app.muted),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (selected)
                      Icon(Icons.check, size: 16, color: app.fg)
                    else
                      const SizedBox(width: 16, height: 16),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A tiny mock of the Library screen: title, a continue-reading row with a
/// cover and progress line, two grid covers, and the tab row. Every colour
/// comes from [colors], never from the surrounding theme.
class ThemeMiniature extends StatelessWidget {
  const ThemeMiniature({super.key, required this.colors});

  final AppColors colors;

  @override
  Widget build(BuildContext context) {
    final c = colors;
    return ExcludeSemantics(
      child: DecoratedBox(
        decoration: BoxDecoration(color: c.bg),
        child: LayoutBuilder(
          builder: (context, box) {
            final w = box.maxWidth;
            final unit = w / 100;
            return Stack(
              children: [
                // Title.
                Positioned(
                  left: 8 * unit,
                  top: 8 * unit,
                  child: Text(
                    'Library',
                    style: TextStyle(
                      fontFamily: Fonts.serif,
                      fontSize: 9 * unit,
                      fontWeight: FontWeight.w500,
                      color: c.fg,
                      height: 1,
                    ),
                  ),
                ),
                // Continue reading: cover, two text lines, progress.
                Positioned(
                  left: 8 * unit,
                  top: 24 * unit,
                  child: _Cover(width: 12 * unit, accent: c.accents[0], colors: c),
                ),
                Positioned(
                  left: 24 * unit,
                  top: 26 * unit,
                  child: _Bar(width: 40 * unit, height: 3 * unit, color: c.fg),
                ),
                Positioned(
                  left: 24 * unit,
                  top: 32 * unit,
                  child: _Bar(width: 26 * unit, height: 2.2 * unit, color: c.muted),
                ),
                Positioned(
                  left: 24 * unit,
                  top: 39 * unit,
                  child: _Bar(width: 52 * unit, height: 1.4 * unit, color: c.element),
                ),
                Positioned(
                  left: 24 * unit,
                  top: 39 * unit,
                  child: _Bar(width: 22 * unit, height: 1.4 * unit, color: c.fg),
                ),
                // Divider.
                Positioned(
                  left: 8 * unit,
                  right: 8 * unit,
                  top: 48 * unit,
                  child: _Bar(width: double.infinity, height: 0.8 * unit, color: c.border),
                ),
                // Grid covers with accents.
                Positioned(
                  left: 8 * unit,
                  top: 53 * unit,
                  child: _Cover(width: 14 * unit, accent: c.accents[1], colors: c),
                ),
                Positioned(
                  left: 27 * unit,
                  top: 53 * unit,
                  child: _Cover(width: 14 * unit, accent: c.accents[3], colors: c),
                ),
                // Paper swatch: what the reading page looks like.
                Positioned(
                  left: 50 * unit,
                  top: 53 * unit,
                  right: 8 * unit,
                  child: Container(
                    height: 20 * unit,
                    decoration: BoxDecoration(
                      color: c.paper,
                      border: Border.all(color: c.border, width: 0.8 * unit),
                      borderRadius: BorderRadius.circular(1.5 * unit),
                    ),
                    padding: EdgeInsets.all(2.5 * unit),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        _Bar(width: 24 * unit, height: 1.6 * unit, color: c.ink),
                        SizedBox(height: 1.6 * unit),
                        _Bar(width: 30 * unit, height: 1.6 * unit, color: c.ink),
                        SizedBox(height: 1.6 * unit),
                        _Bar(width: 18 * unit, height: 1.6 * unit, color: c.ink),
                      ],
                    ),
                  ),
                ),
                // Tab row.
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: Container(
                    height: 9 * unit,
                    decoration: BoxDecoration(
                      color: c.bg,
                      border: Border(top: BorderSide(color: c.border, width: 0.8 * unit)),
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                      children: [
                        _Bar(width: 12 * unit, height: 2 * unit, color: c.fg),
                        _Bar(width: 12 * unit, height: 2 * unit, color: c.subtle),
                        _Bar(width: 12 * unit, height: 2 * unit, color: c.subtle),
                      ],
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _Bar extends StatelessWidget {
  const _Bar({required this.width, required this.height, required this.color});
  final double width;
  final double height;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
        width: width,
        height: height,
        decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(height)),
      );
}

class _Cover extends StatelessWidget {
  const _Cover({required this.width, required this.accent, required this.colors});
  final double width;
  final Color accent;
  final AppColors colors;

  @override
  Widget build(BuildContext context) => Container(
        width: width,
        height: width * 1.5,
        decoration: BoxDecoration(
          color: colors.panel,
          border: Border.all(color: colors.border, width: width * 0.06),
          borderRadius: BorderRadius.circular(width * 0.12),
        ),
        padding: EdgeInsets.all(width * 0.15),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(width: width * 0.45, height: width * 0.09, color: accent),
            const Spacer(),
            Container(width: width * 0.6, height: width * 0.09, color: colors.fg),
            SizedBox(height: width * 0.08),
            Container(width: width * 0.4, height: width * 0.07, color: colors.muted),
          ],
        ),
      );
}
