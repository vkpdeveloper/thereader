import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/cupertino.dart' as cupertino;

import 'app_colors.dart';
import 'tokens.dart';

/// Builds the one dark [ThemeData] for a set of [AppColors]. Every preset is
/// dark, so brightness and system bar icon styles never change; only the
/// colours behind them do.
abstract final class AppTheme {
  /// Overlay for the Default preset. Prefer [overlayFor] with the active
  /// colours; this constant is for the pre-`runApp` call in `main`.
  static const SystemUiOverlayStyle overlay = SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarBrightness: Brightness.dark,
    statusBarIconBrightness: Brightness.light,
    systemNavigationBarColor: Palette.bg,
    systemNavigationBarIconBrightness: Brightness.light,
    systemNavigationBarDividerColor: Palette.bg,
  );

  static SystemUiOverlayStyle overlayFor(AppColors c) => SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarBrightness: Brightness.dark,
        statusBarIconBrightness: Brightness.light,
        systemNavigationBarColor: c.bg,
        systemNavigationBarIconBrightness: Brightness.light,
        systemNavigationBarDividerColor: c.bg,
      );

  /// Overlay for the colours currently in scope.
  static SystemUiOverlayStyle overlayOf(BuildContext context) => overlayFor(AppColors.of(context));

  static TextTheme textThemeFor(AppColors c) {
    final base = TextStyle(color: c.fg, fontFamily: Fonts.sans, height: 1.4);
    return TextTheme(
      displayLarge: base.copyWith(
          fontFamily: Fonts.serif, fontSize: 40, fontWeight: FontWeight.w500, height: 1.1, letterSpacing: -0.5),
      displaySmall: base.copyWith(
          fontFamily: Fonts.serif, fontSize: 28, fontWeight: FontWeight.w500, height: 1.15, letterSpacing: -0.3),
      headlineMedium: base.copyWith(
          fontFamily: Fonts.serif, fontSize: 22, fontWeight: FontWeight.w500, height: 1.2, letterSpacing: -0.2),
      titleLarge: base.copyWith(fontSize: 17, fontWeight: FontWeight.w600, height: 1.3, letterSpacing: -0.2),
      titleMedium: base.copyWith(fontSize: 15, fontWeight: FontWeight.w600, height: 1.3, letterSpacing: -0.1),
      titleSmall: base.copyWith(fontSize: 13, fontWeight: FontWeight.w600, height: 1.3),
      bodyLarge: base.copyWith(fontSize: 16, fontWeight: FontWeight.w400, height: 1.5),
      bodyMedium: base.copyWith(fontSize: 14, fontWeight: FontWeight.w400, height: 1.5),
      bodySmall: base.copyWith(fontSize: 12.5, fontWeight: FontWeight.w400, color: c.muted, height: 1.4),
      labelLarge: base.copyWith(fontSize: 14, fontWeight: FontWeight.w500, letterSpacing: 0),
      labelMedium: base.copyWith(fontSize: 12.5, fontWeight: FontWeight.w500, color: c.muted),
      labelSmall: base.copyWith(
          fontSize: 11, fontWeight: FontWeight.w500, color: c.muted, letterSpacing: 0.4, height: 1.2),
    );
  }

  /// The Default preset's theme. Identical to the historical `AppTheme.dark`.
  static ThemeData get dark => build(AppColors.defaults);

  static ThemeData build(AppColors c) {
    final text = textThemeFor(c);
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      extensions: [c],
      scaffoldBackgroundColor: c.bg,
      canvasColor: c.bg,
      fontFamily: Fonts.sans,
      textTheme: text,
      colorScheme: ColorScheme.dark(
        surface: c.bg,
        onSurface: c.fg,
        primary: c.primary,
        onPrimary: c.bg,
        secondary: c.purple,
        onSecondary: c.bg,
        error: c.error,
        onError: c.bg,
        outline: c.border,
        outlineVariant: c.border,
        surfaceContainerHighest: c.element,
        surfaceContainer: c.panel,
        onSurfaceVariant: c.muted,
      ),
      splashFactory: InkSparkle.splashFactory,
      splashColor: c.fg.withValues(alpha: 0.06),
      highlightColor: c.fg.withValues(alpha: 0.04),
      hoverColor: c.fg.withValues(alpha: 0.03),
      focusColor: c.borderActive.withValues(alpha: 0.4),
      dividerTheme: DividerThemeData(color: c.border, thickness: 1, space: 1),
      iconTheme: IconThemeData(color: c.fg, size: 20),
      appBarTheme: AppBarTheme(
        backgroundColor: c.bg,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: text.titleLarge,
        iconTheme: IconThemeData(color: c.fg, size: 20),
        systemOverlayStyle: overlayFor(c),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: c.panel,
        surfaceTintColor: Colors.transparent,
        modalBackgroundColor: c.panel,
        showDragHandle: false,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radii.lg)),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: c.panel,
        surfaceTintColor: Colors.transparent,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radii.lg)),
        titleTextStyle: text.titleLarge,
        contentTextStyle: text.bodyMedium?.copyWith(color: c.muted),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: c.element,
        contentTextStyle: text.bodyMedium,
        behavior: SnackBarBehavior.floating,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radii.md)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: c.panel,
        hintStyle: text.bodyMedium?.copyWith(color: c.subtle),
        labelStyle: text.labelMedium,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        border: OutlineInputBorder(
            borderRadius: const BorderRadius.all(Radii.md), borderSide: BorderSide(color: c.border)),
        enabledBorder: OutlineInputBorder(
            borderRadius: const BorderRadius.all(Radii.md), borderSide: BorderSide(color: c.border)),
        focusedBorder: OutlineInputBorder(
            borderRadius: const BorderRadius.all(Radii.md), borderSide: BorderSide(color: c.borderActive)),
        errorBorder: OutlineInputBorder(
            borderRadius: const BorderRadius.all(Radii.md), borderSide: BorderSide(color: c.error)),
        focusedErrorBorder: OutlineInputBorder(
            borderRadius: const BorderRadius.all(Radii.md), borderSide: BorderSide(color: c.error)),
      ),
      textSelectionTheme: TextSelectionThemeData(
        cursorColor: c.fg,
        selectionColor: c.blue.withValues(alpha: 0.3),
        selectionHandleColor: c.blue,
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: c.fg,
        linearTrackColor: c.element,
        circularTrackColor: c.element,
      ),
      sliderTheme: SliderThemeData(
        activeTrackColor: c.fg,
        inactiveTrackColor: c.element,
        thumbColor: c.fg,
        overlayColor: c.fg.withValues(alpha: 0.08),
        trackHeight: 2,
        thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 7),
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith(
            (s) => s.contains(WidgetState.selected) ? c.bg : c.muted),
        trackColor: WidgetStateProperty.resolveWith(
            (s) => s.contains(WidgetState.selected) ? c.fg : c.element),
        trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
      ),
      listTileTheme: ListTileThemeData(
        textColor: c.fg,
        iconColor: c.muted,
        titleTextStyle: text.bodyLarge,
        subtitleTextStyle: text.bodySmall,
        contentPadding: const EdgeInsets.symmetric(horizontal: Space.gutter),
      ),
      pageTransitionsTheme: const PageTransitionsTheme(builders: {
        TargetPlatform.iOS: cupertino.CupertinoPageTransitionsBuilder(),
        TargetPlatform.android: FadeForwardsPageTransitionsBuilder(),
        TargetPlatform.macOS: cupertino.CupertinoPageTransitionsBuilder(),
        TargetPlatform.linux: FadeForwardsPageTransitionsBuilder(),
        TargetPlatform.windows: FadeForwardsPageTransitionsBuilder(),
      }),
    );
  }
}
