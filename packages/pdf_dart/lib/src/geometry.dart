part of pdf_extractor;

typedef _Matrix = List<double>;
const _identity = <double>[1, 0, 0, 1, 0, 0];
_Matrix _translation(double x, double y) => [1, 0, 0, 1, x, y];
_Matrix _mul(_Matrix a, _Matrix b) => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
void _validMatrix(_Matrix a) {
  if (a.any((n) => !n.isFinite || n.abs() > 1e12)) _limit();
}

(double, double) _point(_Matrix a, double x, double y) =>
    (a[0] * x + a[2] * y + a[4], a[1] * x + a[3] * y + a[5]);
Rect _rect(_Matrix a, double x, double y, double width, double height) {
  final x0 = a[0] * x + a[2] * y + a[4], y0 = a[1] * x + a[3] * y + a[5];
  final x1 = a[0] * (x + width) + a[2] * y + a[4],
      y1 = a[1] * (x + width) + a[3] * y + a[5];
  final x2 = a[0] * x + a[2] * (y + height) + a[4],
      y2 = a[1] * x + a[3] * (y + height) + a[5];
  final x3 = a[0] * (x + width) + a[2] * (y + height) + a[4],
      y3 = a[1] * (x + width) + a[3] * (y + height) + a[5];
  final left = math.min(math.min(x0, x1), math.min(x2, x3)),
      top = math.min(math.min(y0, y1), math.min(y2, y3));
  return Rect(
    left,
    top,
    math.max(math.max(x0, x1), math.max(x2, x3)) - left,
    math.max(math.max(y0, y1), math.max(y2, y3)) - top,
  );
}

Rect _union(Rect a, Rect b) {
  final x = math.min(a.x, b.x), y = math.min(a.y, b.y);
  return Rect(
    x,
    y,
    math.max(a.x + a.width, b.x + b.width) - x,
    math.max(a.y + a.height, b.y + b.height) - y,
  );
}

bool _intersects(Rect a, Rect b) =>
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height;
bool _contained(Rect a, Rect b, double pad) =>
    a.x >= b.x - pad &&
    a.y >= b.y - pad &&
    a.x + a.width <= b.x + b.width + pad &&
    a.y + a.height <= b.y + b.height + pad;
Rect _expand(Rect r, double n) =>
    Rect(r.x - n, r.y - n, r.width + n * 2, r.height + n * 2);
void _finiteRect(Rect r) {
  if ([r.x, r.y, r.width, r.height].any((n) => !n.isFinite || n.abs() > 1e9))
    _limit();
}

String _fnum(double n) => n.toStringAsFixed(3);
String _rgb(double r, double g, double b) =>
    '#${[r, g, b].map((v) => (v.clamp(0, 1) * 255 + .5).floor().toRadixString(16).padLeft(2, '0')).join()}';
final _safeLinkPattern = RegExp(r'^(https?://|mailto:)', caseSensitive: false);
bool _safeLink(String s) => s.isNotEmpty && _safeLinkPattern.hasMatch(s.trim());
