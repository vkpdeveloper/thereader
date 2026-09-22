import 'package:flutter/material.dart';

import '../../core/theme/tokens.dart';
import '../../data/models/settings.dart';
import '../../data/repositories/settings_repository.dart';
import '../shared/states.dart';

/// Typography controls. Every control here does something; the flow toggle is
/// only offered when the active engine supports pagination.
class ReaderSettingsSheet extends StatelessWidget {
  const ReaderSettingsSheet({super.key, required this.settings, required this.engineName, this.engineNote});

  final SettingsRepository settings;
  final String engineName;
  final String? engineNote;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return ListenableBuilder(
      listenable: settings,
      builder: (context, _) {
        final p = settings.reader;
        return SafeArea(
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
                    decoration: const BoxDecoration(color: Palette.element, borderRadius: BorderRadius.all(Radius.circular(2))),
                  ),
                ),
                const Eyebrow('Typography'),
                const SizedBox(height: Space.md),
                _Row(
                  label: 'Font',
                  child: _Segmented<ReaderFont>(
                    value: p.font,
                    options: const {ReaderFont.serif: 'Serif', ReaderFont.sans: 'Sans'},
                    onChanged: (v) => settings.updateReader((r) => r.copyWith(font: v)),
                    labelStyle: (v) => TextStyle(fontFamily: v == ReaderFont.serif ? Fonts.serif : Fonts.sans),
                  ),
                ),
                _Row(
                  label: 'Size',
                  child: Row(
                    children: [
                      Text('A', style: text.bodySmall?.copyWith(fontFamily: Fonts.serif, fontSize: 13, color: Palette.muted)),
                      Expanded(
                        child: Semantics(
                          label: 'Text size',
                          value: '${p.fontSize.round()}',
                          child: Slider(
                            value: p.fontSize,
                            min: ReaderPreferences.minFontSize,
                            max: ReaderPreferences.maxFontSize,
                            divisions: (ReaderPreferences.maxFontSize - ReaderPreferences.minFontSize).round(),
                            onChanged: (v) => settings.updateReader((r) => r.copyWith(fontSize: v.roundToDouble())),
                          ),
                        ),
                      ),
                      Text('A', style: text.bodyLarge?.copyWith(fontFamily: Fonts.serif, fontSize: 22, color: Palette.fg)),
                      SizedBox(width: 34, child: Text('${p.fontSize.round()}', textAlign: TextAlign.right, style: text.labelMedium)),
                    ],
                  ),
                ),
                _Row(
                  label: 'Leading',
                  child: _Segmented<double>(
                    value: p.lineHeight,
                    options: {1.4: 'Tight', 1.6: 'Normal', 1.85: 'Loose'},
                    onChanged: (v) => settings.updateReader((r) => r.copyWith(lineHeight: v)),
                  ),
                ),
                _Row(
                  label: 'Margins',
                  child: _Segmented<double>(
                    value: p.marginScale,
                    options: {0.6: 'Narrow', 1.0: 'Normal', 1.6: 'Wide'},
                    onChanged: (v) => settings.updateReader((r) => r.copyWith(marginScale: v)),
                  ),
                ),
                _Row(
                  label: 'Justify',
                  child: Switch(value: p.justify, onChanged: (v) => settings.updateReader((r) => r.copyWith(justify: v))),
                ),
                const SizedBox(height: Space.sm),
                const Divider(),
                const SizedBox(height: Space.sm),

              ],
            ),
          ),
        );
      },
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.child});
  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.sm),
      child: Row(
        children: [
          SizedBox(width: 84, child: Text(label, style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Palette.muted))),
          Expanded(child: Align(alignment: Alignment.centerRight, child: child)),
        ],
      ),
    );
  }
}

class _Segmented<T> extends StatelessWidget {
  const _Segmented({required this.value, required this.options, required this.onChanged, this.labelStyle});
  final T value;
  final Map<T, String> options;
  final ValueChanged<T> onChanged;
  final TextStyle Function(T)? labelStyle;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: Palette.border),
        borderRadius: const BorderRadius.all(Radii.md),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final e in options.entries)
            Semantics(
              button: true,
              selected: e.key == value,
              child: InkWell(
                onTap: () => onChanged(e.key),
                borderRadius: const BorderRadius.all(Radii.md),
                child: AnimatedContainer(
                  duration: Motion.of(context, Motion.fast),
                  constraints: const BoxConstraints(minHeight: 40, minWidth: 64),
                  alignment: Alignment.center,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  decoration: BoxDecoration(
                    color: e.key == value ? Palette.element : Colors.transparent,
                    borderRadius: const BorderRadius.all(Radii.md),
                  ),
                  child: Text(
                    e.value,
                    style: (text.labelLarge ?? const TextStyle())
                        .merge(labelStyle?.call(e.key))
                        .copyWith(color: e.key == value ? Palette.fg : Palette.muted),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
