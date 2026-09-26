import React, { createContext, useContext, useEffect, useState } from 'react';
import localforage from 'localforage';
import { listBooks, getBook, downloadEpub } from './api';
import { setTheme } from './themes';
import type { Book, LibraryEntry, AppSettings } from './types';

const SETTINGS_KEY = 'reader:settings';
const LIBRARY_KEY = 'reader:library';
const blobKey = (id: string) => `reader:book:${id}`;

const defaultSettings: AppSettings = { apiBaseUrl: '', themeId: 'default' };

interface AppContextValue {
  settings: AppSettings;
  setApiBaseUrl: (url: string) => void;
  setThemeId: (id: string) => void;
  library: LibraryEntry[];
  catalog: Book[];
  catalogLoading: boolean;
  catalogError: string | null;
  catalogQuery: string;
  catalogHasMore: boolean;
  refreshCatalog: () => Promise<void>;
  loadMoreCatalog: () => Promise<void>;
  searchCatalog: (q: string) => Promise<void>;
  getBookById: (id: string) => Promise<Book>;
  download: (book: Book, onProgress?: (p: number) => void) => Promise<void>;
  remove: (id: string) => Promise<void>;
  getEntry: (id: string) => LibraryEntry | undefined;
  getBlob: (id: string) => Promise<ArrayBuffer | undefined>;
  saveProgress: (id: string, progress: LibraryEntry['progress']) => Promise<void>;
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [catalog, setCatalog] = useState<Book[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogCursor, setCatalogCursor] = useState<string | null>(null);
  const [catalogHasMore, setCatalogHasMore] = useState(false);

  useEffect(() => {
    async function load() {
      const s = (await localforage.getItem<AppSettings>(SETTINGS_KEY)) ?? defaultSettings;
      const l = (await localforage.getItem<LibraryEntry[]>(LIBRARY_KEY)) ?? [];
      setSettings(s);
      setLibrary(l);
      setTheme(s.themeId);
      setLoaded(true);
    }
    load();
  }, []);

  useEffect(() => {
    if (loaded) localforage.setItem(SETTINGS_KEY, settings);
  }, [settings, loaded]);

  useEffect(() => {
    if (loaded) localforage.setItem(LIBRARY_KEY, library);
  }, [library, loaded]);

  const setApiBaseUrl = (url: string) => setSettings((s) => ({ ...s, apiBaseUrl: url }));
  const setThemeId = (id: string) => {
    setSettings((s) => ({ ...s, themeId: id }));
    setTheme(id);
  };

  const refreshCatalog = async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const data = await listBooks(settings.apiBaseUrl, { q: catalogQuery });
      setCatalog(data.items);
      setCatalogCursor(data.nextCursor);
      setCatalogHasMore(data.nextCursor !== null);
    } catch (e) {
      setCatalogError((e as Error).message);
    } finally {
      setCatalogLoading(false);
    }
  };

  const loadMoreCatalog = async () => {
    if (!catalogCursor || catalogLoading) return;
    setCatalogLoading(true);
    try {
      const data = await listBooks(settings.apiBaseUrl, { q: catalogQuery, cursor: catalogCursor });
      setCatalog((prev) => [...prev, ...data.items]);
      setCatalogCursor(data.nextCursor);
      setCatalogHasMore(data.nextCursor !== null);
    } catch (e) {
      setCatalogError((e as Error).message);
    } finally {
      setCatalogLoading(false);
    }
  };

  const searchCatalog = async (q: string) => {
    setCatalogQuery(q);
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const data = await listBooks(settings.apiBaseUrl, { q });
      setCatalog(data.items);
      setCatalogCursor(data.nextCursor);
      setCatalogHasMore(data.nextCursor !== null);
    } catch (e) {
      setCatalogError((e as Error).message);
    } finally {
      setCatalogLoading(false);
    }
  };

  const getBookById = async (id: string) => getBook(settings.apiBaseUrl, id);

  const download = async (book: Book, onProgress?: (p: number) => void) => {
    const buf = await downloadEpub(settings.apiBaseUrl, book, onProgress);
    await localforage.setItem(blobKey(book.id), new Blob([buf], { type: 'application/epub+zip' }));
    setLibrary((prev) => {
      const idx = prev.findIndex((e) => e.id === book.id);
      const entry: LibraryEntry = idx >= 0
        ? { ...prev[idx], book, downloaded: true }
        : { id: book.id, book, downloaded: true, addedAt: Date.now() };
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = entry;
        return copy;
      }
      return [...prev, entry];
    });
  };

  const remove = async (id: string) => {
    await localforage.removeItem(blobKey(id));
    setLibrary((prev) => prev.filter((e) => e.id !== id));
  };

  const getEntry = (id: string) => library.find((e) => e.id === id);

  const getBlob = async (id: string) => {
    const blob = await localforage.getItem<Blob>(blobKey(id));
    return blob ? await blob.arrayBuffer() : undefined;
  };

  const saveProgress = async (id: string, progress: LibraryEntry['progress']) => {
    setLibrary((prev) => {
      const idx = prev.findIndex((e) => e.id === id);
      if (idx < 0) return prev;
      const copy = [...prev];
      copy[idx] = { ...copy[idx], progress };
      return copy;
    });
  };

  const value: AppContextValue = {
    settings,
    setApiBaseUrl,
    setThemeId,
    library,
    catalog,
    catalogLoading,
    catalogError,
    catalogQuery,
    catalogHasMore,
    refreshCatalog,
    loadMoreCatalog,
    searchCatalog,
    getBookById,
    download,
    remove,
    getEntry,
    getBlob,
    saveProgress,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
