import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';

import '../../core/theme/tokens.dart';
import '../../reader/comic/comic_layout.dart';
import '../../reader/comic/comic_page_store.dart';

/// Drives a [ComicReaderView] from outside (chrome, keys) and reports which
/// pages are on screen.
class ComicViewController extends ChangeNotifier {
  _ComicReaderViewState? _view;
  int _first = 0;
  int _last = 0;
  int _count = 0;
  bool _disposed = false;

  /// First page visible (the left page of a spread), 0-based.
  int get firstPage => _first;
  int get lastPage => _last;
  int get pageCount => _count;

  /// Turns from the chrome's own buttons, which stays up.
  void next() => _view?._turn(1, fromChrome: true);
  void previous() => _view?._turn(-1, fromChrome: true);
  void jumpTo(int page) => _view?._jumpTo(page);

  /// Holds a flip still at [progress] (0 = spread [from], 1 = the next one),
  /// for captures and tests.
  @visibleForTesting
  void debugHoldFlip({required int from, required double progress}) =>
      _view?._hold(from, progress);

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }

  void _report(int first, int last, int count) {
    if (first == _first && last == _last && count == _count) return;
    _first = first;
    _last = last;
    _count = count;
    // Layout can change mid-build (rotation); listeners rebuild ancestors.
    if (SchedulerBinding.instance.schedulerPhase == SchedulerPhase.persistentCallbacks) {
      SchedulerBinding.instance.addPostFrameCallback((_) {
        if (!_disposed) notifyListeners();
      });
    } else {
      notifyListeners();
    }
  }
}

/// Pages on pure black: single pages on portrait phones, two-page spreads
/// elsewhere, turned with a 3D hinge flip that follows the finger. Taps on the
/// outer thirds turn at once; a double tap in the centre third (anywhere while
/// zoomed) zooms, and a single centre tap toggles the chrome once it is clear
/// no second tap is coming. Pinch zooms too; while zoomed, drags pan instead
/// of turning.
class ComicReaderView extends StatefulWidget {
  const ComicReaderView({
    super.key,
    required this.store,
    required this.controller,
    this.initialPage = 0,
    this.onCenterTap,
    this.onTurn,
  });

  final ComicPageStore store;
  final ComicViewController controller;
  final int initialPage;
  final VoidCallback? onCenterTap;

  /// Called when a tap, swipe or key turns the page (the screen hides its
  /// chrome).
  final VoidCallback? onTurn;

  /// A tap-triggered turn; drags finish on a spring instead.
  static const turnDuration = Duration(milliseconds: 500);
  static const fadeDuration = Duration(milliseconds: 180);

  @override
  State<ComicReaderView> createState() => _ComicReaderViewState();
}

class _ComicReaderViewState extends State<ComicReaderView> with TickerProviderStateMixin {
  // Reduced motion gets its own cross-fade; don't let the controller also
  // shorten it to nothing.
  late final AnimationController _flip = AnimationController(
    vsync: this,
    animationBehavior: AnimationBehavior.preserve,
  );
  late final AnimationController _zoomAnim = AnimationController(
    vsync: this,
    duration: Motion.base,
  );
  final TransformationController _zoom = TransformationController();
  final FocusNode _focus = FocusNode(debugLabel: 'comic');

  List<ComicSpread> _spreads = const [];
  bool _twoUp = false;
  int _wideRevision = -1;
  int _index = 0;

  /// The page the reader is on. Layout changes (rotation, a page turning out
  /// to be a double-page scan) re-find it instead of keeping the spread index.
  late int _anchor = widget.initialPage;

  /// The flip on screen shows spread [_from] turning into [_from] + 1.
  int? _from;
  double _target = 0;
  bool _fade = false;
  int _flipToken = 0;

  bool _dragCandidate = false;
  bool _dragging = false;
  double _dragDx = 0;

  bool _zoomed = false;

  /// A centre tap waiting out the double-tap window before toggling chrome.
  Timer? _centerTap;
  Offset? _centerTapAt;
  bool _secondTap = false;

  Size _viewSize = Size.zero;
  double _dpr = 1;
  bool _requestScheduled = false;

  bool get _reduceMotion => MediaQuery.maybeDisableAnimationsOf(context) ?? false;

  @override
  void initState() {
    super.initState();
    widget.controller._view = this;
    widget.store.addListener(_onStore);
    _zoom.addListener(_onZoom);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _dpr = MediaQuery.devicePixelRatioOf(context);
    _relayout();
  }

  @override
  void didUpdateWidget(ComicReaderView old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      old.controller._view = null;
      widget.controller._view = this;
    }
    if (old.store != widget.store) {
      old.store.removeListener(_onStore);
      widget.store.addListener(_onStore);
    }
  }

  @override
  void dispose() {
    if (widget.controller._view == this) widget.controller._view = null;
    widget.store.removeListener(_onStore);
    _zoom.removeListener(_onZoom);
    _centerTap?.cancel();
    _flip.dispose();
    _zoomAnim.dispose();
    _zoom.dispose();
    _focus.dispose();
    super.dispose();
  }

  // Layout -----------------------------------------------------------------

  void _relayout() {
    final twoUp = comicTwoUp(MediaQuery.sizeOf(context));
    final revision = widget.store.wideRevision;
    if (twoUp == _twoUp && revision == _wideRevision && _spreads.isNotEmpty) return;
    if (_from != null) {
      // A newly found double-page scan waits for the flip to land; rotation
      // doesn't: the flip finishes now and the page it lands on is kept.
      if (twoUp == _twoUp) return;
      _settleNow();
    }
    _twoUp = twoUp;
    _wideRevision = revision;
    _spreads = computeSpreads(
      widget.store.pageCount,
      twoUp: twoUp,
      isWide: widget.store.isWide,
    );
    _index = spreadIndexOf(_spreads, _anchor);
    _report();
    _scheduleRequest();
  }

  void _onStore() {
    if (!mounted) return;
    setState(_relayout);
  }

  void _report() {
    final s = _spreads[_index];
    widget.controller._report(s.first, s.last, widget.store.pageCount);
  }

  double _aspectOf(int page) {
    final size = widget.store.sizeOf(page);
    if (size == null || size.height <= 0) return defaultPageAspect;
    return size.width / size.height;
  }

  // Page loading -----------------------------------------------------------

  void _scheduleRequest() {
    if (_requestScheduled) return;
    _requestScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _requestScheduled = false;
      if (mounted) _requestPages();
    });
  }

  /// The visible spread first, then its neighbours so a flip never shows a
  /// blank leaf; only ±2 spreads stay decoded.
  void _requestPages() {
    if (_spreads.isEmpty || _viewSize.isEmpty) return;
    Iterable<int> pagesOf(int i) sync* {
      if (i < 0 || i >= _spreads.length) return;
      final s = _spreads[i];
      for (var p = s.first; p <= s.last; p++) {
        yield p;
      }
    }

    final wanted = <int>[
      for (final i in [_index, _from, if (_from != null) _from! + 1, _index + 1, _index - 1, _index + 2])
        if (i != null) ...pagesOf(i),
    ];
    final keep = <int>{for (var i = _index - 2; i <= _index + 2; i++) ...pagesOf(i)};
    final visible = pagesOf(_index).toSet();
    final zoom = _zoom.value.getMaxScaleOnAxis().clamp(1.0, 3.0);
    widget.store.request(
      wanted,
      keep: keep,
      target: (page, intrinsic) {
        final wide = intrinsic.width > intrinsic.height;
        final box = comicDisplayBox(_viewSize, twoUp: _twoUp, wide: wide);
        final scale = math.min(box.width / intrinsic.width, box.height / intrinsic.height);
        final boost = visible.contains(page) ? zoom : 1.0;
        return intrinsic * (scale * _dpr * boost);
      },
    );
  }

  // Turning ----------------------------------------------------------------

  void _turn(int direction, {bool fromChrome = false}) {
    if (_spreads.isEmpty) return;
    if (_zoomed) _resetZoom(animate: false);
    if (_from != null) _settleNow();
    final target = _index + direction;
    if (target < 0 || target >= _spreads.length) return;
    if (!fromChrome) widget.onTurn?.call();
    _fade = _reduceMotion;
    setState(() => _from = direction > 0 ? _index : target);
    _flip.value = direction > 0 ? 0 : 1;
    _animateTo(
      direction > 0 ? 1 : 0,
      duration: _fade ? ComicReaderView.fadeDuration : ComicReaderView.turnDuration,
    );
    _scheduleRequest();
  }

  void _animateTo(double target, {Duration? duration, double velocity = 0}) {
    _target = target;
    final token = ++_flipToken;
    final TickerFuture run;
    if (duration != null) {
      run = _flip.animateTo(target, duration: duration, curve: Curves.easeInOut);
    } else {
      // Critically damped: lands without bouncing the leaf back over.
      final spring = SpringDescription.withDampingRatio(mass: 1, stiffness: 180, ratio: 1);
      run = _flip.animateWith(
        SpringSimulation(spring, _flip.value, target, velocity, tolerance: const Tolerance(distance: 0.002, velocity: 0.05)),
      );
    }
    run.then((_) {
      if (mounted && token == _flipToken) setState(_land);
    });
  }

  /// Ends the flip on the spread it was heading for.
  void _land() {
    final from = _from;
    if (from == null) return;
    _flipToken++;
    _index = _target >= 1 ? from + 1 : from;
    _from = null;
    _flip.stop();
    _anchor = _spreads[_index].first;
    _report();
    _relayout();
    _scheduleRequest();
  }

  void _settleNow() {
    if (_from == null) return;
    _land();
  }

  void _jumpTo(int page) {
    if (_spreads.isEmpty) return;
    if (_zoomed) _resetZoom(animate: false);
    setState(() {
      _settleNow();
      _anchor = page.clamp(0, widget.store.pageCount - 1);
      _index = spreadIndexOf(_spreads, _anchor);
      _anchor = _spreads[_index].first;
      _report();
    });
    _scheduleRequest();
  }

  void _hold(int from, double progress) {
    if (_spreads.length < 2) return;
    setState(() {
      _flipToken++;
      _flip.stop();
      // Re-pair first: a scan found during an earlier hold waits for a landing.
      _from = null;
      _relayout();
      _from = from.clamp(0, _spreads.length - 2);
      _fade = _reduceMotion;
      _flip.value = progress;
      _target = progress;
    });
    _scheduleRequest();
  }

  // Gestures ---------------------------------------------------------------

  /// Outer thirds turn on the tap itself: no recognizer waits for a second
  /// tap there, so quick taps flip quickly. Only the centre third (or the
  /// whole view while zoomed) listens for a double tap, so only the chrome
  /// toggle waits out [kDoubleTapTimeout].
  bool _isCenter(Offset at) {
    final width = _viewSize.width;
    return _zoomed || width <= 0 || (at.dx >= width / 3 && at.dx <= width * 2 / 3);
  }

  void _onTapDown(TapDownDetails details) {
    final first = _centerTapAt;
    _secondTap = (_centerTap?.isActive ?? false) &&
        first != null &&
        _isCenter(details.localPosition) &&
        (details.localPosition - first).distance <= kDoubleTapSlop;
  }

  void _onTapUp(TapUpDetails details) {
    final at = details.localPosition;
    if (_secondTap) {
      _secondTap = false;
      _cancelCenterTap();
      _onDoubleTap(at);
      return;
    }
    if (!_isCenter(at)) {
      _cancelCenterTap();
      _turn(at.dx < _viewSize.width / 2 ? -1 : 1);
      return;
    }
    _cancelCenterTap();
    _centerTapAt = at;
    _centerTap = Timer(kDoubleTapTimeout, () {
      _centerTapAt = null;
      if (mounted) widget.onCenterTap?.call();
    });
  }

  void _cancelCenterTap() {
    _centerTap?.cancel();
    _centerTap = null;
    _centerTapAt = null;
  }

  void _onDoubleTap(Offset at) {
    if (_zoomed) {
      _resetZoom(animate: true);
      return;
    }
    if (_from != null) return;
    const scale = 2.5;
    final end = Matrix4.identity()
      ..translateByDouble(-at.dx * (scale - 1), -at.dy * (scale - 1), 0, 1)
      ..scaleByDouble(scale, scale, 1, 1);
    _animateZoom(end);
  }

  void _resetZoom({required bool animate}) {
    if (animate && !_reduceMotion) {
      _animateZoom(Matrix4.identity());
    } else {
      _zoomAnim.stop();
      _zoom.value = Matrix4.identity();
    }
  }

  void _animateZoom(Matrix4 end) {
    if (_reduceMotion) {
      _zoom.value = end;
      _scheduleRequest();
      return;
    }
    final tween = Matrix4Tween(begin: _zoom.value, end: end);
    final curve = CurvedAnimation(parent: _zoomAnim, curve: Motion.curve);
    void tick() => _zoom.value = tween.evaluate(curve);
    _zoomAnim
      ..stop()
      ..reset();
    _zoomAnim.addListener(tick);
    _zoomAnim.forward().whenCompleteOrCancel(() {
      _zoomAnim.removeListener(tick);
      _scheduleRequest();
    });
  }

  void _onZoom() {
    final zoomed = _zoom.value.getMaxScaleOnAxis() > 1.01;
    if (zoomed != _zoomed && mounted) setState(() => _zoomed = zoomed);
  }

  void _onInteractionStart(ScaleStartDetails details) {
    _dragCandidate = details.pointerCount == 1 && !_zoomed;
    _dragDx = 0;
    // A new swipe while the last flip is still landing turns from where it lands.
    if (_dragCandidate && _from != null && !_dragging) setState(_settleNow);
  }

  void _onInteractionUpdate(ScaleUpdateDetails details) {
    if (details.pointerCount > 1) {
      if (_dragging) _releaseDrag(0);
      _dragCandidate = false;
      return;
    }
    if (!_dragCandidate) return;
    _dragDx += details.focalPointDelta.dx;
    if (!_dragging) {
      if (_dragDx.abs() < 1) return;
      final forward = _dragDx < 0;
      final target = _index + (forward ? 1 : -1);
      if (target < 0 || target >= _spreads.length) return;
      _dragging = true;
      _fade = _reduceMotion;
      widget.onTurn?.call();
      _flipToken++;
      setState(() => _from = forward ? _index : target);
      _target = forward ? 0 : 1;
      _flip.value = _target;
      _scheduleRequest();
    }
    // Reduced motion: the swipe only decides; the change is a cross-fade.
    if (_fade) return;
    _flip.value = _progressForDrag(_dragDx);
  }

  void _onInteractionEnd(ScaleEndDetails details) {
    if (!_dragging) {
      if (_zoom.value.getMaxScaleOnAxis() < 1.05 && _zoomed) _resetZoom(animate: true);
      _scheduleRequest();
      return;
    }
    _releaseDrag(details.velocity.pixelsPerSecond.dx);
  }

  void _releaseDrag(double velocity) {
    final forward = _target == 0;
    _dragging = false;
    _dragCandidate = false;
    const fling = 350.0;
    if (_fade) {
      final go = _dragDx.abs() > 48 || velocity.abs() > fling;
      _animateTo(go ? (forward ? 1 : 0) : _target, duration: ComicReaderView.fadeDuration);
      return;
    }
    final p = _flip.value;
    final complete = forward
        ? velocity < -fling || (velocity < fling && p > 0.5)
        : velocity > fling || (velocity > -fling && p < 0.5);
    final end = complete ? (forward ? 1.0 : 0.0) : (forward ? 0.0 : 1.0);
    // Finger speed in flip progress per second: the leaf edge travels
    // `cos(start) - cos(end)` leaf widths over the turn (two for a spread,
    // one for a single page or a one-sided spread turn).
    final turn = _turnOf(_from!);
    final travel = turn.width * (math.cos(turn.start) - math.cos(turn.end));
    _animateTo(end, velocity: travel > 0 ? -velocity / travel : 0);
  }

  _Turn _turnOf(int from) {
    final box = Offset.zero & _viewSize;
    final a = layoutSpread(_spreads[from], box, twoUp: _twoUp, aspectOf: _aspectOf);
    if (!_twoUp) return _Turn(0, math.pi / 2, a.whole?.rect.width ?? box.width);
    final b = layoutSpread(_spreads[from + 1], box, twoUp: true, aspectOf: _aspectOf);
    return _Turn.spread(a, b, box.width / 2);
  }

  /// Keeps the leaf's free edge under the finger: its projected x is
  /// `cos(angle)` of the leaf width from the hinge.
  double _progressForDrag(double dx) {
    final turn = _turnOf(_from!);
    final w = turn.width;
    if (w <= 0 || turn.end <= turn.start) return _target;
    final start = _target == 0 ? turn.start : turn.end;
    final lo = math.min(math.cos(turn.start), math.cos(turn.end));
    final hi = math.max(math.cos(turn.start), math.cos(turn.end));
    final c = (math.cos(start) + dx / w).clamp(lo, hi);
    return ((math.acos(c) - turn.start) / (turn.end - turn.start)).clamp(0.0, 1.0);
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) return KeyEventResult.ignored;
    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.arrowRight ||
        key == LogicalKeyboardKey.pageDown ||
        key == LogicalKeyboardKey.space) {
      _turn(1);
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.arrowLeft || key == LogicalKeyboardKey.pageUp) {
      _turn(-1);
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  // Building ---------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return Focus(
      focusNode: _focus,
      autofocus: true,
      onKeyEvent: _onKey,
      child: ColoredBox(
        color: Palette.bg,
        child: SafeArea(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final size = constraints.biggest;
              if (size != _viewSize) {
                _viewSize = size;
                _scheduleRequest();
              }
              return GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTapDown: _onTapDown,
                onTapUp: _onTapUp,
                onTapCancel: () => _secondTap = false,
                child: InteractiveViewer(
                  transformationController: _zoom,
                  minScale: 1,
                  maxScale: 4,
                  panEnabled: _zoomed,
                  scaleEnabled: !_dragging,
                  onInteractionStart: _onInteractionStart,
                  onInteractionUpdate: _onInteractionUpdate,
                  onInteractionEnd: _onInteractionEnd,
                  child: SizedBox.fromSize(
                    size: size,
                    child: AnimatedBuilder(
                      animation: _flip,
                      builder: (context, _) => _stage(Offset.zero & size),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
  }

  Widget _stage(Rect box) {
    if (_spreads.isEmpty) return const SizedBox.shrink();
    final from = _from;
    if (from == null) return Stack(children: _staticFaces(_spreads[_index], box));
    final a = _spreads[from];
    final b = _spreads[from + 1];
    final p = _flip.value.clamp(0.0, 1.0);
    if (_fade) {
      return Stack(
        children: [
          Opacity(opacity: 1 - p, child: Stack(children: _staticFaces(a, box))),
          Opacity(opacity: p, child: Stack(children: _staticFaces(b, box))),
        ],
      );
    }
    return _twoUp ? _spreadFlip(a, b, p, box) : _singleFlip(a, b, p, box);
  }

  List<Widget> _staticFaces(ComicSpread spread, Rect box) {
    final g = layoutSpread(spread, box, twoUp: _twoUp, aspectOf: _aspectOf);
    final whole = g.whole;
    if (whole != null) return [_face(whole)];
    return [
      if (g.left != null) _face(g.left!, gutter: _Gutter.right),
      if (g.right != null) _face(g.right!, gutter: _Gutter.left),
    ];
  }

  /// The right-hand leaf of [a] turns about the spine; past 90° its back is
  /// [b]'s left page. Beneath: [a]'s left page and [b]'s right page.
  ///
  /// A side with no page never turns as blank paper: when [a] has nothing on
  /// the right (a page alone before a double-page scan) the turn runs only
  /// from 90° to 180°, [b]'s left page rising out of the spine while its
  /// right page fades into the empty half; when [b] had nothing on the left
  /// the turn would stop at 90° the same way. Shadows only fall on pages.
  Widget _spreadFlip(ComicSpread a, ComicSpread b, double p, Rect box) {
    final ga = layoutSpread(a, box, twoUp: true, aspectOf: _aspectOf);
    final gb = layoutSpread(b, box, twoUp: true, aspectOf: _aspectOf);
    final range = _Turn.spread(ga, gb, box.width / 2);
    final angle = range.start + (range.end - range.start) * p;
    final front = angle < math.pi / 2;
    final leaf = front ? ga.right : gb.left;
    final under = front ? gb.right : ga.left;
    // A one-sided turn starts or ends edge-on at the spine; its shadow and
    // the page it uncovers ease in from nothing there.
    final rising = ga.right == null ? (p * 4).clamp(0.0, 1.0) : 1.0;
    final sinking = gb.left == null ? ((1 - p) * 4).clamp(0.0, 1.0) : 1.0;
    final children = <Widget>[];
    if (ga.left != null) {
      // Covered by the landing leaf as p → 1; with no leaf to land, it fades.
      final opacity = gb.left == null ? (1 - p) * 2 : (front ? 1.0 : (1 - p) * 6);
      children.add(_face(ga.left!, gutter: _gutterFor(a), opacity: opacity.clamp(0.0, 1.0)));
    }
    if (gb.right != null) {
      final opacity = ga.right == null ? p * 4 : (front ? p * 6 : 1.0);
      children.add(_face(gb.right!, gutter: _gutterFor(b, right: true), opacity: opacity.clamp(0.0, 1.0)));
    }
    if (leaf == null) return Stack(children: children);
    final turn = front ? angle : math.pi - angle;
    final hinge = front ? Alignment.centerLeft : Alignment.centerRight;
    final matrix = _leafMatrix(front ? turn : -turn, leaf.rect.width);
    if (under != null) {
      children.add(
        _CastShadow(
          clip: under.rect,
          edge: _projectedEdge(leaf.rect, hinge, matrix, freeRight: front),
          towardRight: front,
          strength: math.sin(turn) * rising * sinking,
          width: leaf.rect.width * 0.45,
        ),
      );
    }
    children.add(
      _leaf(
        leaf,
        hinge: hinge,
        matrix: matrix,
        turn: turn,
        gutter: front ? _gutterFor(a, right: true) : _gutterFor(b),
      ),
    );
    return Stack(children: children);
  }

  /// A single page hinges on its left edge and lifts away to the page beneath.
  /// The page beneath shows only where the leaf's free edge has swept past,
  /// so a taller page never ghosts in around a shorter leaf (a double-page
  /// scan) still lying flat.
  Widget _singleFlip(ComicSpread a, ComicSpread b, double p, Rect box) {
    final ga = layoutSpread(a, box, twoUp: false, aspectOf: _aspectOf).whole!;
    final gb = layoutSpread(b, box, twoUp: false, aspectOf: _aspectOf).whole!;
    final turn = p * math.pi / 2;
    final matrix = _leafMatrix(turn, ga.rect.width);
    final edge = _projectedEdge(ga.rect, Alignment.centerLeft, matrix, freeRight: true);
    return Stack(
      children: [
        Positioned.fill(
          child: ClipRect(
            clipper: _RightOf(p < 1 ? edge : double.negativeInfinity),
            child: Stack(children: [_face(gb)]),
          ),
        ),
        _CastShadow(
          clip: gb.rect,
          edge: edge,
          towardRight: true,
          strength: math.sin(turn),
          width: ga.rect.width * 0.45,
        ),
        if (p < 1) _leaf(ga, hinge: Alignment.centerLeft, matrix: matrix, turn: turn),
      ],
    );
  }

  _Gutter _gutterFor(ComicSpread s, {bool right = false}) =>
      s.full ? _Gutter.none : (right ? _Gutter.left : _Gutter.right);

  /// Camera about six leaf widths away: the free edge swells by under a
  /// fifth at 90°, enough depth without a fisheye door swing.
  Matrix4 _leafMatrix(double angle, double width) => Matrix4.identity()
    ..setEntry(3, 2, 0.17 / math.max(width, 1))
    ..rotateY(angle);

  double _projectedEdge(Rect rect, Alignment hinge, Matrix4 m, {required bool freeRight}) {
    final origin = rect.topLeft + hinge.alongSize(rect.size);
    final full = Matrix4.translationValues(origin.dx, origin.dy, 0)
      ..multiply(m)
      ..multiply(Matrix4.translationValues(-origin.dx, -origin.dy, 0));
    final edge = Offset(freeRight ? rect.right : rect.left, rect.center.dy);
    return MatrixUtils.transformPoint(full, edge).dx;
  }

  Widget _leaf(
    ComicFace face, {
    required Alignment hinge,
    required Matrix4 matrix,
    required double turn,
    _Gutter gutter = _Gutter.none,
  }) {
    return Positioned.fromRect(
      key: const ValueKey('leaf'),
      rect: face.rect,
      child: Transform(
        alignment: hinge,
        transform: matrix,
        child: Stack(
          fit: StackFit.expand,
          children: [
            _PageFace(store: widget.store, face: face, gutter: gutter),
            CustomPaint(painter: _LeafShade(turn: turn, hingeLeft: hinge == Alignment.centerLeft)),
          ],
        ),
      ),
    );
  }

  /// Beneath faces fade in over the first stretch of a flip so a larger page
  /// never peeks out around a smaller leaf that is still lying flat.
  Widget _face(ComicFace face, {_Gutter gutter = _Gutter.none, double opacity = 1}) =>
      Positioned.fromRect(
        key: ValueKey('face ${face.page} ${face.source.left}'),
        rect: face.rect,
        child: Opacity(
          opacity: opacity,
          child: _PageFace(store: widget.store, face: face, gutter: gutter),
        ),
      );
}

/// The angles a flip sweeps (0 = lying on the right, π = on the left) and
/// the width of the leaf whose free edge follows the finger.
@immutable
class _Turn {
  const _Turn(this.start, this.end, this.width);

  /// Only sides with a page turn: no front skips 0°–90°, no back 90°–180°.
  factory _Turn.spread(SpreadGeometry a, SpreadGeometry b, double fallbackWidth) => _Turn(
    a.right == null && b.left != null ? math.pi / 2 : 0,
    b.left == null && a.right != null ? math.pi / 2 : math.pi,
    (a.right ?? b.left)?.rect.width ?? fallbackWidth,
  );

  final double start;
  final double end;
  final double width;
}

enum _Gutter { none, left, right }

/// Everything right of [x].
class _RightOf extends CustomClipper<Rect> {
  const _RightOf(this.x);
  final double x;

  @override
  Rect getClip(Size size) => Rect.fromLTRB(x.clamp(0.0, size.width), 0, size.width, size.height);

  @override
  bool shouldReclip(_RightOf old) => old.x != x;
}

/// One page (or half of a double-page scan) as a cached raster, or a quiet
/// placeholder while it loads.
class _PageFace extends StatelessWidget {
  const _PageFace({required this.store, required this.face, required this.gutter});
  final ComicPageStore store;
  final ComicFace face;
  final _Gutter gutter;

  @override
  Widget build(BuildContext context) {
    final image = store.imageOf(face.page);
    final error = store.errorOf(face.page);
    return RepaintBoundary(
      child: Stack(
        fit: StackFit.expand,
        children: [
          _PageImage(image: image, source: face.source, gutter: gutter),
          if (image == null && error != null)
            Center(
              child: IconButton(
                tooltip: '$error Tap to retry.',
                onPressed: () => store.retry(face.page),
                icon: const Icon(Icons.refresh, size: 20, color: Palette.muted),
              ),
            )
          else if (image == null && face.source.left == 0)
            const Center(
              child: SizedBox.square(
                dimension: 16,
                child: CircularProgressIndicator(strokeWidth: 1.5, color: Palette.subtle),
              ),
            ),
        ],
      ),
    );
  }
}

/// Owns a clone of the store's image so eviction can never pull a frame's
/// pixels away mid-paint.
class _PageImage extends StatefulWidget {
  const _PageImage({required this.image, required this.source, required this.gutter});
  final ui.Image? image;
  final Rect source;
  final _Gutter gutter;

  @override
  State<_PageImage> createState() => _PageImageState();
}

class _PageImageState extends State<_PageImage> {
  ui.Image? _image;

  @override
  void initState() {
    super.initState();
    _image = widget.image?.clone();
  }

  @override
  void didUpdateWidget(_PageImage old) {
    super.didUpdateWidget(old);
    if (!identical(old.image, widget.image)) {
      _image?.dispose();
      _image = widget.image?.clone();
    }
  }

  @override
  void dispose() {
    _image?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => CustomPaint(
    painter: _FacePainter(_image, widget.source, widget.gutter),
  );
}

class _FacePainter extends CustomPainter {
  _FacePainter(this.image, this.source, this.gutter);
  final ui.Image? image;
  final Rect source;
  final _Gutter gutter;

  @override
  void paint(Canvas canvas, Size size) {
    final dst = Offset.zero & size;
    final image = this.image;
    if (image == null) {
      canvas.drawRect(dst, Paint()..color = Palette.panel);
    } else {
      final w = image.width.toDouble();
      final h = image.height.toDouble();
      canvas.drawImageRect(
        image,
        Rect.fromLTRB(source.left * w, source.top * h, source.right * w, source.bottom * h),
        dst,
        Paint()..filterQuality = FilterQuality.medium,
      );
    }
    if (gutter == _Gutter.none) return;
    // The fold: darkest at the spine, gone a few percent into the page.
    final toLeft = gutter == _Gutter.right;
    final reach = size.width * 0.08;
    final band = toLeft
        ? Rect.fromLTRB(size.width - reach, 0, size.width, size.height)
        : Rect.fromLTRB(0, 0, reach, size.height);
    canvas.drawRect(
      band,
      Paint()
        ..shader = ui.Gradient.linear(
          Offset(toLeft ? size.width : 0, 0),
          Offset(toLeft ? size.width - reach : reach, 0),
          const [Color(0x59000000), Color(0x1F000000), Color(0x00000000)],
          const [0, 0.3, 1],
        ),
    );
  }

  @override
  bool shouldRepaint(_FacePainter old) =>
      !identical(old.image, image) || old.source != source || old.gutter != gutter;
}

/// Light falls off as the leaf rises toward vertical, most at the hinge
/// where the paper curls into the spine.
class _LeafShade extends CustomPainter {
  _LeafShade({required this.turn, required this.hingeLeft});
  final double turn;
  final bool hingeLeft;

  @override
  void paint(Canvas canvas, Size size) {
    final rise = 1 - math.cos(turn);
    final curl = math.sin(turn);
    final base = 0.5 * rise;
    final hinge = (base + 0.22 * curl).clamp(0.0, 0.85);
    final edge = (base * 0.75).clamp(0.0, 0.85);
    canvas.drawRect(
      Offset.zero & size,
      Paint()
        ..shader = ui.Gradient.linear(
          Offset(hingeLeft ? 0 : size.width, 0),
          Offset(hingeLeft ? size.width : 0, 0),
          [
            Color.fromRGBO(0, 0, 0, hinge),
            Color.fromRGBO(0, 0, 0, base),
            Color.fromRGBO(0, 0, 0, edge),
          ],
          const [0, 0.3, 1],
        ),
    );
    // A soft sheen along the free edge as it catches the light.
    final sheen = 0.06 * curl;
    if (sheen <= 0) return;
    final reach = size.width * 0.18;
    final from = hingeLeft ? size.width : 0.0;
    final to = hingeLeft ? size.width - reach : reach;
    canvas.drawRect(
      Rect.fromLTRB(math.min(from, to), 0, math.max(from, to), size.height),
      Paint()
        ..shader = ui.Gradient.linear(
          Offset(from, 0),
          Offset(to, 0),
          [Color.fromRGBO(255, 255, 255, sheen), const Color(0x00FFFFFF)],
        ),
    );
  }

  @override
  bool shouldRepaint(_LeafShade old) => old.turn != turn || old.hingeLeft != hingeLeft;
}

/// The shadow the raised leaf throws onto the page it is uncovering.
class _CastShadow extends StatelessWidget {
  const _CastShadow({
    required this.clip,
    required this.edge,
    required this.towardRight,
    required this.strength,
    required this.width,
  });
  final Rect clip;
  final double edge;
  final bool towardRight;
  final double strength;
  final double width;

  @override
  Widget build(BuildContext context) => Positioned.fill(
    child: IgnorePointer(
      child: CustomPaint(
        painter: _CastShadowPainter(clip, edge, towardRight, strength, width),
      ),
    ),
  );
}

class _CastShadowPainter extends CustomPainter {
  _CastShadowPainter(this.clip, this.edge, this.towardRight, this.strength, this.width);
  final Rect clip;
  final double edge;
  final bool towardRight;
  final double strength;
  final double width;

  @override
  void paint(Canvas canvas, Size size) {
    if (strength <= 0.001) return;
    final reach = width * strength;
    final far = towardRight ? edge + reach : edge - reach;
    final band = Rect.fromLTRB(math.min(edge, far), clip.top, math.max(edge, far), clip.bottom)
        .intersect(clip);
    if (band.width <= 0 || band.height <= 0) return;
    final alpha = (0.55 * strength).clamp(0.0, 0.55);
    canvas.drawRect(
      band,
      Paint()
        ..shader = ui.Gradient.linear(
          Offset(edge, 0),
          Offset(far, 0),
          [Color.fromRGBO(0, 0, 0, alpha), Color.fromRGBO(0, 0, 0, alpha * 0.35), const Color(0x00000000)],
          const [0, 0.35, 1],
        ),
    );
  }

  @override
  bool shouldRepaint(_CastShadowPainter old) =>
      old.edge != edge || old.strength != strength || old.clip != clip || old.width != width;
}
