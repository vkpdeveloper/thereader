import 'package:flutter/material.dart';

import '../../app_scope.dart';
import '../../core/theme/tokens.dart';
import '../../data/api/api_client.dart';
import '../../data/models/settings.dart';
import '../shared/states.dart';

/// Library API address, storage facts, and a short note on privacy.
/// No accounts, no tokens: the API URL is the only configuration.
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final TextEditingController _url = TextEditingController();
  String? _checkResult;
  Color _checkColor = Palette.muted;
  bool _checking = false;
  bool _seeded = false;

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
        _checkColor = h.ok ? Palette.green : Palette.orange;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _checkResult = e.message;
        _checkColor = Palette.error;
      });
    } finally {
      client?.close();
      if (mounted) setState(() => _checking = false);
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
    return ListenableBuilder(
      listenable: services.settings,
      builder: (context, _) {
        final s = services.settings.settings;
        final isDefault = s.apiBaseUrl == AppSettings.defaultApiBaseUrl;
        return ListView(
          physics: const BouncingScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(
            Space.gutter,
            Space.md,
            Space.gutter,
            Space.xxl,
          ),
          children: [
            Text('Settings', style: text.displaySmall),
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
                style: text.bodySmall?.copyWith(color: _checkColor),
              ),
            ],
            const SizedBox(height: Space.xl),
            const Eyebrow('Storage'),
            const SizedBox(height: Space.sm),
            Text(
              services.library.bookStore.description,
              style: text.bodyMedium?.copyWith(color: Palette.muted),
            ),
            const SizedBox(height: Space.xl),
            const Eyebrow('About'),
            const SizedBox(height: Space.sm),
            Text(
              'The Reader · personal EPUB reader. Reading progress and preferences stay on this device.',
              style: text.bodySmall,
            ),
          ],
        );
      },
    );
  }
}
