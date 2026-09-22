import 'package:flutter/material.dart';

import '../../app_scope.dart';
import '../../core/theme/tokens.dart';
import '../../data/api/api_client.dart';
import '../../data/models/settings.dart';
import '../shared/states.dart';

/// Source selection (sample vs your API), storage facts, and engine status.
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
      await services.settings.setApiBaseUrl(_url.text);
      client = ApiClient(baseUrl: _url.text);
      final h = await client.health();
      setState(() {
        _checkResult = h.ok ? 'Connected · ${h.service}' : 'Responded, but status was not ok.';
        _checkColor = h.ok ? Palette.green : Palette.orange;
      });
    } on ApiException catch (e) {
      setState(() {
        _checkResult = e.message;
        _checkColor = Palette.error;
      });
    } finally {
      client?.close();
      if (mounted) setState(() => _checking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    final text = Theme.of(context).textTheme;
    return ListenableBuilder(
      listenable: services.settings,
      builder: (context, _) {
        final s = services.settings.settings;
        return ListView(
          physics: const BouncingScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(Space.gutter, Space.md, Space.gutter, Space.xxl),
          children: [
            Text('Settings', style: text.displaySmall),
            const SizedBox(height: Space.xl),
            const Eyebrow('Source'),
            const SizedBox(height: Space.sm),
            _ModeTile(
              title: 'Sample mode',
              body: 'Three bundled original samples. Clearly labelled; never substituted for the API.',
              selected: s.mode == AppMode.sample,
              accent: Palette.orange,
              onTap: () => services.settings.setMode(AppMode.sample),
            ),
            const SizedBox(height: Space.sm),
            _ModeTile(
              title: 'Your API',
              body: 'The Reader Worker at the URL below. No login, no keys.',
              selected: s.mode == AppMode.api,
              accent: Palette.green,
              onTap: () => services.settings.setMode(AppMode.api),
            ),
            const SizedBox(height: Space.lg),
            const Eyebrow('API URL'),
            const SizedBox(height: Space.sm),
            TextField(
              controller: _url,
              keyboardType: TextInputType.url,
              autocorrect: false,
              enableSuggestions: false,
              textInputAction: TextInputAction.done,
              style: text.bodyMedium?.copyWith(fontFamily: 'monospace', fontSize: 13),
              decoration: const InputDecoration(hintText: 'http://127.0.0.1:8787'),
              onSubmitted: (_) => _check(),
              onChanged: (_) => setState(() => _checkResult = null),
            ),
            const SizedBox(height: Space.sm),
            Text(
              'Simulator and desktop: http://127.0.0.1:8787 · Android emulator: http://10.0.2.2:8787',
              style: text.bodySmall,
            ),
            const SizedBox(height: Space.md),
            Row(
              children: [
                QuietButton(
                  label: _checking ? 'Checking' : 'Save and check /health',
                  onPressed: _checking ? null : _check,
                ),
                const SizedBox(width: Space.md),
                if (_checkResult != null)
                  Expanded(child: Text(_checkResult!, style: text.bodySmall?.copyWith(color: _checkColor))),
              ],
            ),
            const SizedBox(height: Space.xl),
            const Eyebrow('Storage'),
            const SizedBox(height: Space.sm),
            Text(services.library.bookStore.description, style: text.bodyMedium?.copyWith(color: Palette.muted)),
            const SizedBox(height: Space.xl),
            const Eyebrow('Reader engine'),
            const SizedBox(height: Space.sm),
            for (final engine in services.readerService.engines) ...[
              _ModeTile(
                title: engine.availability.name,
                body: engine.availability.note ?? '',
                selected: s.preferredEngine == engine.id,
                accent: engine.availability.available ? Palette.blue : Palette.subtle,
                onTap: engine.availability.available ? () => services.settings.setPreferredEngine(engine.id) : null,
              ),
              const SizedBox(height: Space.sm),
            ],
            Text(
              'The preferred engine opens books first; if it cannot, the other one is used and the reader tells you.',
              style: text.bodySmall,
            ),
            const SizedBox(height: Space.xl),
            const Eyebrow('About'),
            const SizedBox(height: Space.sm),
            Text('The Reader · personal EPUB reader. Reading progress and preferences stay on this device.',
                style: text.bodySmall),
          ],
        );
      },
    );
  }
}

class _ModeTile extends StatelessWidget {
  const _ModeTile({required this.title, required this.body, required this.selected, required this.accent, required this.onTap});
  final String title;
  final String body;
  final bool selected;
  final Color accent;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Semantics(
      button: true,
      selected: selected,
      child: InkWell(
        onTap: onTap,
        borderRadius: const BorderRadius.all(Radii.lg),
        child: AnimatedContainer(
          duration: Motion.of(context, Motion.fast),
          padding: const EdgeInsets.all(Space.md),
          decoration: BoxDecoration(
            color: selected ? Palette.panel : Colors.transparent,
            border: Border.all(color: selected ? Palette.borderActive : Palette.border),
            borderRadius: const BorderRadius.all(Radii.lg),
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: text.titleMedium?.copyWith(color: onTap == null ? Palette.muted : Palette.fg)),
                    if (body.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(body, style: text.bodySmall),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: Space.md),
              AnimatedContainer(
                duration: Motion.of(context, Motion.fast),
                width: 10,
                height: 10,
                decoration: BoxDecoration(shape: BoxShape.circle, color: selected ? accent : Palette.element),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
