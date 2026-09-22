import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'tokens.dart';

abstract final class AppTheme {
  static const SystemUiOverlayStyle overlay = SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarBrightness: Brightness.dark,
    statusBarIconBrightness: Brightness.light,
    systemNavigationBarColor: Palette.bg,
    systemNavigationBarIconBrightness: Brightness.light,
    systemNavigationBarDividerColor: Palette.bg,
  );

  static TextTheme get textTheme {
    const base = TextStyle(color: Palette.fg, fontFamily: Fonts.sans, height: 1.4);
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
      bodySmall: base.copyWith(fontSize: 12.5, fontWeight: FontWeight.w400, color: Palette.muted, height: 1.4),
      labelLarge: base.copyWith(fontSize: 14, fontWeight: FontWeight.w500, letterSpacing: 0),
      labelMedium: base.copyWith(fontSize: 12.5, fontWeight: FontWeight.w500, color: Palette.muted),
      labelSmall: base.copyWith(
          fontSize: 11, fontWeight: FontWeight.w500, color: Palette.muted, letterSpacing: 0.4, height: 1.2),
    );
  }

  static ThemeData get dark {
    final text = textTheme;
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: Palette.bg,
      canvasColor: Palette.bg,
      fontFamily: Fonts.sans,
      textTheme: text,
      colorScheme: const ColorScheme.dark(
        surface: Palette.bg,
        onSurface: Palette.fg,
        primary: Palette.primary,
        onPrimary: Palette.bg,
        secondary: Palette.purple,
        onSecondary: Palette.bg,
        error: Palette.error,
        onError: Palette.bg,
        outline: Palette.border,
        outlineVariant: Palette.border,
        surfaceContainerHighest: Palette.element,
        surfaceContainer: Palette.panel,
        onSurfaceVariant: Palette.muted,
      ),
      splashFactory: InkSparkle.splashFactory,
      splashColor: Palette.fg.withValues(alpha: 0.06),
      highlightColor: Palette.fg.withValues(alpha: 0.04),
      hoverColor: Palette.fg.withValues(alpha: 0.03),
      focusColor: Palette.borderActive.withValues(alpha: 0.4),
      dividerTheme: const DividerThemeData(color: Palette.border, thickness: 1, space: 1),
      iconTheme: const IconThemeData(color: Palette.fg, size: 20),
      appBarTheme: AppBarTheme(
        backgroundColor: Palette.bg,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: text.titleLarge,
        iconTheme: const IconThemeData(color: Palette.fg, size: 20),
        systemOverlayStyle: overlay,
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: Palette.panel,
        surfaceTintColor: Colors.transparent,
        modalBackgroundColor: Palette.panel,
        showDragHandle: false,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radii.lg)),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: Palette.panel,
        surfaceTintColor: Colors.transparent,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radii.lg)),
        titleTextStyle: text.titleLarge,
        contentTextStyle: text.bodyMedium?.copyWith(color: Palette.muted),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: Palette.element,
        contentTextStyle: text.bodyMedium,
        behavior: SnackBarBehavior.floating,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radii.md)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Palette.panel,
        hintStyle: text.bodyMedium?.copyWith(color: Palette.subtle),
        labelStyle: text.labelMedium,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        border: const OutlineInputBorder(
            borderRadius: BorderRadius.all(Radii.md), borderSide: BorderSide(color: Palette.border)),
        enabledBorder: const OutlineInputBorder(
            borderRadius: BorderRadius.all(Radii.md), borderSide: BorderSide(color: Palette.border)),
        focusedBorder: const OutlineInputBorder(
            borderRadius: BorderRadius.all(Radii.md), borderSide: BorderSide(color: Palette.borderActive)),
        errorBorder: const OutlineInputBorder(
            borderRadius: BorderRadius.all(Radii.md), borderSide: BorderSide(color: Palette.error)),
        focusedErrorBorder: const OutlineInputBorder(
            borderRadius: BorderRadius.all(Radii.md), borderSide: BorderSide(color: Palette.error)),
      ),
      textSelectionTheme: TextSelectionThemeData(
        cursorColor: Palette.fg,
        selectionColor: Palette.blue.withValues(alpha: 0.3),
        selectionHandleColor: Palette.blue,
      ),
      progressIndicatorTheme: const ProgressIndicatorThemeData(
        color: Palette.fg,
        linearTrackColor: Palette.element,
        circularTrackColor: Palette.element,
      ),
      sliderTheme: SliderThemeData(
        activeTrackColor: Palette.fg,
        inactiveTrackColor: Palette.element,
        thumbColor: Palette.fg,
        overlayColor: Palette.fg.withValues(alpha: 0.08),
        trackHeight: 2,
        thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 7),
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith(
            (s) => s.contains(WidgetState.selected) ? Palette.bg : Palette.muted),
        trackColor: WidgetStateProperty.resolveWith(
            (s) => s.contains(WidgetState.selected) ? Palette.fg : Palette.element),
        trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
      ),
      listTileTheme: ListTileThemeData(
        textColor: Palette.fg,
        iconColor: Palette.muted,
        titleTextStyle: text.bodyLarge,
        subtitleTextStyle: text.bodySmall,
        contentPadding: const EdgeInsets.symmetric(horizontal: Space.gutter),
      ),
      pageTransitionsTheme: const PageTransitionsTheme(builders: {
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.android: FadeForwardsPageTransitionsBuilder(),
        TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.linux: FadeForwardsPageTransitionsBuilder(),
        TargetPlatform.windows: FadeForwardsPageTransitionsBuilder(),
      }),
    );
  }
}
