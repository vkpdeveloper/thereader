import { useState } from 'react';
import { useApp } from '../lib/store';
import { ScreenHeader, Eyebrow, QuietButton } from '../components/ui';
import { health } from '../lib/api';
import { presetNames } from '../lib/themes';

export default function Settings() {
  const { settings, setApiBaseUrl, setThemeId } = useApp();
  const [url, setUrl] = useState(settings.apiBaseUrl);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [tone, setTone] = useState<'good' | 'bad' | 'neutral'>('neutral');

  const check = async () => {
    setChecking(true);
    setResult(null);
    try {
      const h = await health(url);
      setApiBaseUrl(url);
      setResult(h.ok ? `Connected · ${h.service}` : 'Server is not healthy');
      setTone(h.ok ? 'good' : 'bad');
    } catch (e) {
      setResult((e as Error).message);
      setTone('bad');
    } finally {
      setChecking(false);
    }
  };

  const useDefault = () => {
    setUrl('');
    setApiBaseUrl('');
    setResult(null);
  };

  const color = tone === 'good' ? 'var(--green)' : tone === 'bad' ? 'var(--pink)' : 'var(--muted)';

  return (
    <div className="screen">
      <ScreenHeader title="Settings" />

      <Eyebrow>Library API</Eyebrow>
      <input
        className="input"
        type="url"
        placeholder="https://reader.ordinity.com"
        value={url}
        onChange={(e) => { setUrl(e.target.value); setResult(null); }}
      />
      <div style={{ display: 'flex', gap: 'var(--space-sm)', marginTop: 'var(--space-md)', flexWrap: 'wrap' }}>
        <QuietButton primary onClick={check} disabled={checking}>
          {checking ? 'Checking' : 'Save and check'}
        </QuietButton>
        {settings.apiBaseUrl && (
          <QuietButton onClick={useDefault}>Use default</QuietButton>
        )}
      </div>
      {result && <p className="body-small" style={{ color, marginTop: 'var(--space-sm)' }}>{result}</p>}

      <div style={{ marginTop: 'var(--space-xl)' }}>
        <Eyebrow>Theme</Eyebrow>
        <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap', marginTop: 'var(--space-sm)' }}>
          {Object.entries(presetNames).map(([id, name]) => (
            <button
              key={id}
              className={`chip ${settings.themeId === id ? 'active' : ''}`}
              onClick={() => setThemeId(id)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 'var(--space-xl)' }}>
        <Eyebrow>About</Eyebrow>
        <p className="body-small" style={{ marginTop: 'var(--space-sm)' }}>
          The Reader · personal EPUB reader
        </p>
      </div>
    </div>
  );
}
