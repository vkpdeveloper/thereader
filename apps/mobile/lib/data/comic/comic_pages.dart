/// Which archive entries are comic pages, and in what order. The API (cover),
/// the web app (`lib/comic/pages.ts`) and this app apply the same rules; see
/// docs/comics.md.
library;

const _pageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp'];

/// `\` → `/` and no leading slash.
String normalizeEntryName(String name) =>
    name.replaceAll(r'\', '/').replaceFirst(RegExp(r'^/+'), '');

bool isPageName(String name) {
  final normalized = normalizeEntryName(name);
  if (normalized.isEmpty || normalized.endsWith('/')) return false;
  if (normalized.split('/').any((s) => s.startsWith('.') || s == '__MACOSX')) return false;
  final lower = normalized.toLowerCase();
  return _pageExtensions.any(lower.endsWith);
}

final _runs = RegExp(r'[0-9]+|[^0-9]+');

bool _isDigits(String run) {
  final unit = run.codeUnitAt(0);
  return unit >= 48 && unit <= 57;
}

/// Natural order on lower-cased names; code-unit order of the originals breaks ties.
int comparePageNames(String a, String b) {
  final runsA = _runs.allMatches(a.toLowerCase()).map((m) => m[0]!).toList();
  final runsB = _runs.allMatches(b.toLowerCase()).map((m) => m[0]!).toList();
  final shared = runsA.length < runsB.length ? runsA.length : runsB.length;
  for (var i = 0; i < shared; i++) {
    final x = runsA[i];
    final y = runsB[i];
    final digitsX = _isDigits(x);
    final digitsY = _isDigits(y);
    if (digitsX != digitsY) return digitsX ? -1 : 1;
    if (digitsX) {
      final valueX = x.replaceFirst(RegExp(r'^0+'), '');
      final valueY = y.replaceFirst(RegExp(r'^0+'), '');
      final vx = valueX.isEmpty ? '0' : valueX;
      final vy = valueY.isEmpty ? '0' : valueY;
      if (vx.length != vy.length) return vx.length - vy.length;
      final byValue = vx.compareTo(vy);
      if (byValue != 0) return byValue;
      if (x.length != y.length) return x.length - y.length;
    } else {
      final byText = x.compareTo(y);
      if (byText != 0) return byText;
    }
  }
  if (runsA.length != runsB.length) return runsA.length - runsB.length;
  return a.compareTo(b);
}

/// Page names among [names] (already normalized), in reading order.
List<String> orderPages(Iterable<String> names) =>
    names.where(isPageName).toList()..sort(comparePageNames);

/// The `ComicInfo.xml` a repack keeps: the shallowest, then code-unit order.
String? pickComicInfo(Iterable<String> names) {
  final candidates = names
      .where((n) => n.split('/').last.toLowerCase() == 'comicinfo.xml')
      .toList()
    ..sort((a, b) {
      final depth = a.split('/').length - b.split('/').length;
      return depth != 0 ? depth : a.compareTo(b);
    });
  return candidates.isEmpty ? null : candidates.first;
}
