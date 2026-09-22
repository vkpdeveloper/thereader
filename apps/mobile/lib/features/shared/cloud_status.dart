import 'package:flutter/material.dart';

import '../../app_scope.dart';
import '../../core/theme/tokens.dart';
import '../../data/models/library.dart';

/// Wording and small widgets for the cloud side of a book: whether its
/// bytes are still waiting to go up, and what the account-wide sync is doing.
/// Everything here reads from `AppServices.imports` / `AppServices.sync` and
/// renders nothing when those services are absent (fixture tests, web).

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

/// One-line cloud summary for the library header. Quiet by design: it
/// renders nothing while everything is uploaded and in sync. Subscribes to
/// both services itself so hosts may keep it const.
class CloudSummaryLine extends StatelessWidget {
  const CloudSummaryLine({super.key});

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    return ListenableBuilder(
      listenable: Listenable.merge([?services.imports, ?services.sync]),
      builder: (context, _) => _build(context, services),
    );
  }

  Widget _build(BuildContext context, AppServices services) {
    final imports = services.imports;
    final sync = services.sync;
    final text = Theme.of(context).textTheme;

    String? message;
    Color color = Palette.muted;
    VoidCallback? retry;
    double? fraction;
    var showBar = false;

    // `busy` covers the picker and local copy only; uploads run afterwards
    // and are visible per entry, so look for one in the library.
    final uploading = imports == null
        ? null
        : services.library.entries.where((e) => imports.isUploading(e.id)).firstOrNull;
    final failed = imports == null
        ? null
        : services.library.entries.where((e) => imports.errorFor(e.id) != null).firstOrNull;

    if (uploading != null) {
      fraction = imports!.uploadFraction;
      final pct = fraction == null ? '' : ' · ${(fraction * 100).round()}%';
      final more = imports.pendingCount > 1 ? ' · ${imports.pendingCount - 1} more waiting' : '';
      message = 'Uploading ${uploading.book.title}$pct$more';
      showBar = true;
    } else if (imports != null && imports.busy) {
      message = 'Importing';
      showBar = true;
    } else if (imports != null && imports.error != null) {
      message = 'Import failed. ${imports.error}';
      color = Palette.error;
    } else if (failed != null) {
      message = 'Upload failed for ${failed.book.title}. ${imports!.errorFor(failed.id)}';
      color = Palette.error;
      retry = imports.retryPending;
    } else if (imports != null && imports.pendingCount > 0) {
      final n = imports.pendingCount;
      message = n == 1 ? '1 upload waiting' : '$n uploads waiting';
      retry = imports.retryPending;
    } else if (sync != null && sync.isSyncing) {
      message = 'Syncing';
    } else if (sync != null && sync.error != null) {
      message = 'Sync failed. ${sync.error}';
      color = Palette.error;
      retry = sync.syncNow;
    } else if (sync != null && sync.pendingCount > 0) {
      final n = sync.pendingCount;
      message = n == 1 ? '1 change not yet synced' : '$n changes not yet synced';
      retry = sync.syncNow;
    }

    if (message == null) return const SizedBox.shrink();

    return Semantics(
      liveRegion: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                color == Palette.error ? Icons.cloud_off_outlined : Icons.cloud_outlined,
                size: 14,
                color: color,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  message,
                  style: text.bodySmall?.copyWith(color: color),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (retry != null) ...[
                const SizedBox(width: Space.sm),
                _InlineLink(label: 'Retry', onTap: retry),
              ],
            ],
          ),
          if (showBar) ...[
            const SizedBox(height: 6),
            ClipRRect(
              borderRadius: BorderRadius.circular(1),
              child: LinearProgressIndicator(value: fraction, minHeight: 2),
            ),
          ],
        ],
      ),
    );
  }
}

/// Tiny cloud glyph for a grid tile: present only while a book is still
/// on its way up, or failed to get there.
class UploadGlyph extends StatelessWidget {
  const UploadGlyph({super.key, required this.entry});
  final LibraryEntry entry;

  @override
  Widget build(BuildContext context) {
    final phase = uploadPhaseFor(AppScope.of(context), entry);
    final (icon, color, label) = switch (phase) {
      UploadPhase.none => (null, Palette.subtle, ''),
      UploadPhase.uploading => (Icons.cloud_upload_outlined, Palette.muted, 'Uploading to cloud'),
      UploadPhase.pending => (Icons.cloud_queue_outlined, Palette.subtle, 'Upload waiting'),
      UploadPhase.failed => (Icons.cloud_off_outlined, Palette.error, 'Upload failed'),
    };
    if (icon == null) return const SizedBox.shrink();
    return Semantics(
      label: label,
      child: Tooltip(message: label, child: Icon(icon, size: 14, color: color)),
    );
  }
}

class _InlineLink extends StatelessWidget {
  const _InlineLink({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: const BorderRadius.all(Radii.sm),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
          child: Text(label, style: Theme.of(context).textTheme.labelLarge?.copyWith(color: Palette.fg)),
        ),
      ),
    );
  }
}
