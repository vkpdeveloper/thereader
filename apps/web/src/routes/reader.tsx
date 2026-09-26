import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from '@tanstack/react-router';
import { ReactReader } from 'react-reader';
import { useApp } from '../lib/store';
import { LoadingLine, StateMessage } from '../components/ui';

const readerStyles: any = {
  container: { background: 'var(--paper)' },
  titleArea: { background: 'var(--paper)', color: 'var(--ink)' },
  arrow: { color: 'var(--ink)' },
  arrowHover: { color: 'var(--fg)' },
};

export default function Reader() {
  const { id } = useParams({ from: '/reader/$id' });
  const { getEntry, getBlob, saveProgress } = useApp();
  const entry = getEntry(id);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [location, setLocation] = useState<string | number>(entry?.progress?.cfi ?? 0);
  const renditionRef = useRef<any>(null);
  const cfiRef = useRef<string | null>(entry?.progress?.cfi ?? null);
  const pctRef = useRef<number>(entry?.progress?.totalProgression ?? 0);

  useEffect(() => {
    async function load() {
      try {
        const buf = await getBlob(id);
        if (!buf) {
          setError('This book has not been downloaded.');
          setLoading(false);
          return;
        }
        const blob = new Blob([buf], { type: 'application/epub+zip' });
        const objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    }
    load();
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, getBlob]);

  const getRendition = (rendition: any) => {
    renditionRef.current = rendition;
    const root = getComputedStyle(document.documentElement);
    const paper = root.getPropertyValue('--paper').trim() || '#000000';
    const ink = root.getPropertyValue('--ink').trim() || '#ededed';
    rendition.themes.register('reader', {
      body: { color: ink, background: paper },
      '*': { color: ink },
      a: { color: 'var(--blue)' },
    });
    rendition.themes.select('reader');
    rendition.on('relocated', (loc: any) => {
      pctRef.current = typeof loc.percentage === 'number' ? loc.percentage : loc.start?.percentage ?? 0;
      cfiRef.current = loc.start?.cfi ?? null;
      saveProgress(id, {
        cfi: cfiRef.current,
        totalProgression: pctRef.current,
        updatedAt: Date.now(),
      });
    });
  };

  const locationChanged = (loc: string) => {
    setLocation(loc);
    cfiRef.current = loc;
  };

  if (!entry) {
    return (
      <div className="reader-layout">
        <StateMessage title="Book not found" body="This book is not in your library." action="Browse" />
      </div>
    );
  }

  if (loading) return <LoadingLine label="Opening" />;
  if (error) return (
    <div className="reader-layout">
      <div className="screen">
        <p className="body" style={{ color: 'var(--pink)' }}>{error}</p>
        <Link to="/book/$id" params={{ id }}>
          <button className="btn btn-primary" style={{ marginTop: 'var(--space-md)' }}>Book details</button>
        </Link>
      </div>
    </div>
  );

  return (
    <div className="reader-layout">
      <div className="reader-bar" style={{ justifyContent: 'space-between' }}>
        <Link to="/book/$id" params={{ id }} style={{ color: 'inherit' }}>← Back</Link>
        <span className="title" style={{ color: 'var(--ink)' }}>{entry.book.title}</span>
        <span />
      </div>
      <div className="reader-content">
        {url && (
          <ReactReader
            url={url}
            title={entry.book.title}
            location={location}
            locationChanged={locationChanged}
            getRendition={getRendition}
            showToc
            readerStyles={readerStyles}
            epubOptions={{ flow: 'scrolled', width: '100%', height: '100%' }}
          />
        )}
      </div>
    </div>
  );
}
