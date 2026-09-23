import 'package:flutter/material.dart';

import '../../app_scope.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import '../../data/api/api_client.dart';
import '../../data/models/settings.dart';
import '../shared/cloud_status.dart';
import '../shared/states.dart';
import 'theme_section.dart';

/// Library API address, theme, cloud sync status, storage facts, and a short
/// note on privacy. No accounts, no tokens: the API URL is the only
/// configuration. This is the only screen that reports upload or sync state.
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final TextEditingController _url = TextEditingController();
  String? _checkResult;
  _Tone _checkTone = _Tone.neutral;
  bool _checking = false;
  bool _seeded = false;
  bool _syncing = false;
  bool _retrying = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_seeded) {
      _seeded = true;
      _url.text = AppScope.of(context).settings.settings.apiBaseUrl;
    }
  }

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  Future<void> _check() async {
    final services = AppScope.of(context);
    setState(() {
      _checking = true;
      _checkResult = null;
    });
    ApiClient? client;
    try {
      client = ApiClient(baseUrl: _url.text);
      await services.settings.setApiBaseUrl(client.baseUri.toString());
      final h = await client.health();
      if (!mounted) return;
      setState(() {
        _checkResult = h.ok
            ? 'Connected · ${h.service}'
            : 'Responded, but status was not ok.';
        _checkTone = h.ok ? _Tone.good : _Tone.warn;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _checkResult = e.message;
        _checkTone = _Tone.bad;
      });
    } finally {
      client?.close();
      if (mounted) setState(() => _checking = false);
    }
  }

  Future<void> _syncNow() async {
    final sync = AppScope.of(context).sync;
    if (sync == null || _syncing) return;
    setState(() => _syncing = true);
    try {
      await sync.syncNow();
    } finally {
      if (mounted) setState(() => _syncing = false);
    }
  }

  Future<void> _retryUploads() async {
    final imports = AppScope.of(context).imports;
    if (imports == null || _retrying) return;
    setState(() => _retrying = true);
    try {
      await imports.retryPending();
    } finally {
      if (mounted) setState(() => _retrying = false);
    }
  }

  Future<void> _useDefault() async {
    _url.text = AppSettings.defaultApiBaseUrl;
    setState(() => _checkResult = null);
    await AppScope.of(
      context,
    ).settings.setApiBaseUrl(AppSettings.defaultApiBaseUrl);
  }

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    final text = Theme.of(context).textTheme;
    final imports = services.imports;
    final sync = services.sync;
    return ListenableBuilder(
      listenable: Listenable.merge([
        services.settings,
        ?imports,
        ?sync,
      ]),
      builder: (context, _) {
        final s = services.settings.settings;
        final colors = context.colors;
        final isDefault = s.apiBaseUrl == AppSettings.defaultApiBaseUrl;
        final syncing = sync != null && (sync.isSyncing || _syncing);
        // Uploads continue after `busy` clears; find the active one by entry.
        final activeUpload = imports == null
            ? null
            : services.library.entries.where((e) => imports.isUploading(e.id)).firstOrNull;
        final failedUploads = imports == null
            ? const <String>[]
            : [for (final e in services.library.entries) ?imports.errorFor(e.id)];
        final uploading = imports != null && (imports.busy || activeUpload != null || _retrying);
        return ListView(
          physics: const BouncingScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(
            Space.gutter,
            Space.md,
            Space.gutter,
            Space.xxl,
          ),
          children: [
            ScreenHeader(title: 'Settings', style: text.displaySmall),
            const SizedBox(height: Space.xl),
            const Eyebrow('Library API'),
            const SizedBox(height: Space.sm),
            TextField(
              controller: _url,
              keyboardType: TextInputType.url,
              autocorrect: false,
              enableSuggestions: false,
              textInputAction: TextInputAction.done,
              style: text.bodyMedium?.copyWith(
                fontFamily: 'monospace',
                fontSize: 13,
              ),
              decoration: const InputDecoration(
                hintText: AppSettings.defaultApiBaseUrl,
              ),
              onSubmitted: (_) => _check(),
              onChanged: (_) => setState(() => _checkResult = null),
            ),
            const SizedBox(height: Space.sm),
            Text(
              isDefault
                  ? 'Books come from The Reader library. Enter another Reader API URL to use your own.'
                  : 'Books come from this Reader API. Downloads already on this device stay readable.',
              style: text.bodySmall,
            ),
            const SizedBox(height: Space.md),
            Wrap(
              spacing: Space.sm,
              runSpacing: Space.sm,
              children: [
                QuietButton(
                  label: _checking ? 'Checking' : 'Save and check /health',
                  onPressed: _checking ? null : _check,
                ),
                if (!isDefault)
                  QuietButton(
                    label: 'Use default',
                    onPressed: _checking ? null : _useDefault,
                  ),
              ],
            ),
            if (_checkResult != null) ...[
              const SizedBox(height: Space.sm),
              Text(
                _checkResult!,
                style: text.bodySmall?.copyWith(color: _checkTone.color(colors)),
              ),
            ],
            const SizedBox(height: Space.xl),
            ThemeSection(
              selectedId: services.settings.reader.themeId,
              onSelect: services.settings.setThemeId,
            ),
            if (sync != null || imports != null) ...[
              const SizedBox(height: Space.xl),
              const Eyebrow('Cloud sync'),
              const SizedBox(height: Space.sm),
              Text(
                sync != null
                    ? 'Reading position, reading time and reader preferences sync through your Reader API, so your other devices pick up where you left off.'
                    : 'Imported books upload to your Reader API so they are available on your other devices.',
                style: text.bodySmall,
              ),
              const SizedBox(height: Space.md),
              if (sync != null) ...[
                _StatusRow(
                  'Last sync',
                  sync.isSyncing
                      ? 'Syncing now'
                      : sync.lastSyncedAt == null
                      ? 'Never'
                      : formatRelativeTime(sync.lastSyncedAt!),
                ),
                _StatusRow(
                  'Waiting',
                  sync.pendingCount == 0
                      ? 'Nothing. Everything is in sync.'
                      : sync.pendingCount == 1
                      ? '1 change not yet synced'
                      : '${sync.pendingCount} changes not yet synced',
                  tone: sync.pendingCount == 0 ? _Tone.plain : _Tone.warn,
                ),
                _StatusRow('Reading time', formatReadingTime(sync.totalReadingMilliseconds)),
                if (sync.error != null)
                  _StatusRow('Problem', sync.error!, tone: _Tone.bad),
              ],
              if (imports != null) ...[
                _StatusRow(
                  'Uploads',
                  activeUpload != null
                      ? imports.uploadFraction == null
                            ? 'Uploading ${activeUpload.book.title}'
                            : 'Uploading ${activeUpload.book.title} · ${(imports.uploadFraction! * 100).round()}%'
                      : imports.busy
                      ? 'Importing'
                      : imports.pendingCount == 0
                      ? 'All imported books are in the cloud.'
                      : imports.pendingCount == 1
                      ? '1 book waiting to upload. It is readable here and retries automatically.'
                      : '${imports.pendingCount} books waiting to upload. They are readable here and retry automatically.',
                  tone: imports.pendingCount == 0 || imports.busy ? _Tone.plain : _Tone.warn,
                ),
                if (imports.error != null)
                  _StatusRow('Import problem', imports.error!, tone: _Tone.bad),
                if (failedUploads.isNotEmpty)
                  _StatusRow(
                    'Upload problem',
                    failedUploads.length == 1
                        ? failedUploads.first
                        : '${failedUploads.first} (${failedUploads.length} books affected)',
                    tone: _Tone.bad,
                  ),
              ],
              const SizedBox(height: Space.sm),
              Wrap(
                spacing: Space.sm,
                runSpacing: Space.sm,
                children: [
                  if (sync != null)
                    QuietButton(
                      label: syncing ? 'Syncing' : 'Sync now',
                      icon: Icons.cloud_sync_outlined,
                      onPressed: syncing ? null : _syncNow,
                    ),
                  if (imports != null && (imports.pendingCount > 0 || failedUploads.isNotEmpty))
                    QuietButton(
                      label: uploading ? 'Uploading' : 'Retry uploads',
                      onPressed: uploading ? null : _retryUploads,
                    ),
                ],
              ),
            ],
            const SizedBox(height: Space.xl),
            const Eyebrow('Storage'),
            const SizedBox(height: Space.sm),
            Text(
              services.library.bookStore.description,
              style: text.bodyMedium?.copyWith(color: colors.muted),
            ),
            const SizedBox(height: Space.xl),
            const Eyebrow('About'),
            const SizedBox(height: Space.sm),
            Text(
              sync != null
                  ? 'The Reader · personal EPUB reader. Downloaded files stay on this device. Reading position, reading time and preferences sync through your Reader API.'
                  : 'The Reader · personal EPUB reader. Reading progress and preferences stay on this device.',
              style: text.bodySmall,
            ),
          ],
        );
      },
    );
  }
}

/// Status colouring resolved against the active theme at build time.
enum _Tone {
  neutral,
  plain,
  good,
  warn,
  bad;

  Color color(AppColors c) => switch (this) {
        neutral => c.muted,
        plain => c.fg,
        good => c.green,
        warn => c.orange,
        bad => c.error,
      };
}

class _StatusRow extends StatelessWidget {
  const _StatusRow(this.label, this.value, {this.tone = _Tone.plain});
  final String label;
  final String value;
  final _Tone tone;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final color = tone.color(context.colors);
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.sm),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 110, child: Text(label, style: text.bodySmall)),
          Expanded(child: Text(value, style: text.bodySmall?.copyWith(color: color))),
        ],
      ),
    );
  }
}
