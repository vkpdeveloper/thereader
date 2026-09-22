import '../../app_scope.dart';
import '../../data/models/library.dart';

/// Wording helpers for the cloud side of a book. Cloud state is shown only in
/// Settings; Library and the book page never render upload or sync status.
/// [uploadPhaseFor] stays so removing a book can say whether an upload is at
/// stake.

/// "3 h 12 min", "12 min", "Under a minute", or "No reading time yet".
String formatReadingTime(int milliseconds) {
  if (milliseconds <= 0) return 'No reading time yet';
  final minutes = milliseconds ~/ 60000;
  if (minutes < 1) return 'Under a minute';
  final hours = minutes ~/ 60;
  final rest = minutes % 60;
  if (hours == 0) return '$minutes min';
  return rest == 0 ? '$hours h' : '$hours h $rest min';
}

/// "Just now", "4 min ago", "2 h ago", "Yesterday", or a short date.
String formatRelativeTime(DateTime at, {DateTime? now}) {
  final t = now ?? DateTime.now();
  final d = t.difference(at);
  if (d.inSeconds < 45) return 'Just now';
  if (d.inMinutes < 60) return '${d.inMinutes} min ago';
  if (d.inHours < 24) return '${d.inHours} h ago';
  if (d.inHours < 48) return 'Yesterday';
  final local = at.toLocal();
  return '${local.year}-${local.month.toString().padLeft(2, '0')}-${local.day.toString().padLeft(2, '0')}';
}

/// Cloud state of one entry, derived from the import service.
enum UploadPhase { none, uploading, pending, failed }

UploadPhase uploadPhaseFor(AppServices services, LibraryEntry entry) {
  final imports = services.imports;
  if (imports == null) return UploadPhase.none;
  if (imports.isUploading(entry.id)) return UploadPhase.uploading;
  if (imports.errorFor(entry.id) != null) return UploadPhase.failed;
  if (imports.isPending(entry.id)) return UploadPhase.pending;
  return UploadPhase.none;
}
