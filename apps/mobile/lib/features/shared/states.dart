import 'package:flutter/material.dart';

import '../../core/theme/tokens.dart';

/// Quiet loading indicator: a single thin line, no spinner clutter.
class LoadingLine extends StatelessWidget {
  const LoadingLine({super.key, this.label});
  final String? label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: Space.gutter, vertical: Space.xl),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SizedBox(
            width: 120,
            child: LinearProgressIndicator(minHeight: 2, borderRadius: BorderRadius.all(Radius.circular(1))),
          ),
          if (label != null) ...[
            const SizedBox(height: Space.md),
            Text(label!, style: Theme.of(context).textTheme.bodySmall),
          ],
        ],
      ),
    );
  }
}

/// Editorial empty/error message with an optional single action.
class StateMessage extends StatelessWidget {
  const StateMessage({
    super.key,
    required this.title,
    this.body,
    this.actionLabel,
    this.onAction,
    this.tone = Palette.muted,
  });

  final String title;
  final String? body;
  final String? actionLabel;
  final VoidCallback? onAction;
  final Color tone;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.gutter, Space.xxl, Space.gutter, Space.xl),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(width: 22, height: 2, color: tone, margin: const EdgeInsets.only(bottom: Space.md)),
          Text(title, style: text.headlineMedium),
          if (body != null) ...[
            const SizedBox(height: Space.sm),
            Text(body!, style: text.bodyMedium?.copyWith(color: Palette.muted)),
          ],
          if (actionLabel != null && onAction != null) ...[
            const SizedBox(height: Space.lg),
            QuietButton(label: actionLabel!, onPressed: onAction),
          ],
        ],
      ),
    );
  }
}

/// Compact bordered button: the app's one button style.
class QuietButton extends StatelessWidget {
  const QuietButton({
    super.key,
    required this.label,
    this.onPressed,
    this.emphasis = false,
    this.icon,
    this.expand = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool emphasis;
  final IconData? icon;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null;
    final bg = emphasis ? Palette.fg : Palette.element;
    final fg = emphasis ? Palette.bg : Palette.fg;
    final child = Row(
      mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (icon != null) ...[Icon(icon, size: 16, color: fg), const SizedBox(width: 8)],
        Text(label, style: Theme.of(context).textTheme.labelLarge?.copyWith(color: fg)),
      ],
    );
    return AnimatedOpacity(
      duration: Motion.of(context, Motion.fast),
      opacity: enabled ? 1 : 0.45,
      child: Material(
        color: bg,
        borderRadius: const BorderRadius.all(Radii.md),
        child: InkWell(
          onTap: onPressed,
          borderRadius: const BorderRadius.all(Radii.md),
          child: Container(
            constraints: const BoxConstraints(minHeight: 44),
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: BoxDecoration(
              borderRadius: const BorderRadius.all(Radii.md),
              border: Border.all(color: emphasis ? Palette.fg : Palette.border),
            ),
            child: child,
          ),
        ),
      ),
    );
  }
}

/// Icon-only tap target with a 44pt hit area and an accessible label.
class QuietIconButton extends StatelessWidget {
  const QuietIconButton({super.key, required this.icon, required this.label, this.onPressed, this.color});
  final IconData icon;
  final String label;
  final VoidCallback? onPressed;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      onPressed: onPressed,
      tooltip: label,
      icon: Icon(icon, size: 20, color: color ?? Palette.fg),
      constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
      style: IconButton.styleFrom(foregroundColor: Palette.fg),
    );
  }
}

/// Small uppercase label used for section headings.
class Eyebrow extends StatelessWidget {
  const Eyebrow(this.text, {super.key, this.color});
  final String text;
  final Color? color;

  @override
  Widget build(BuildContext context) => Text(
        text.toUpperCase(),
        style: Theme.of(context).textTheme.labelSmall?.copyWith(color: color ?? Palette.muted),
      );
}

/// Tiny pill for mode/source badges.
class Tag extends StatelessWidget {
  const Tag(this.text, {super.key, this.color = Palette.muted, this.filled = false});
  final String text;
  final Color color;
  final bool filled;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: filled ? color.withValues(alpha: 0.14) : Colors.transparent,
        border: Border.all(color: filled ? Colors.transparent : Palette.border),
        borderRadius: const BorderRadius.all(Radius.circular(4)),
      ),
      child: Text(
        text.toUpperCase(),
        style: Theme.of(context).textTheme.labelSmall?.copyWith(color: color, fontSize: 10, letterSpacing: 0.6),
      ),
    );
  }
}

String formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(bytes < 10240 ? 1 : 0)} KB';
  if (bytes < 1024 * 1024 * 1024) return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  return '${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(2)} GB';
}
