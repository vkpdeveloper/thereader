import { useNavigate, useRouter } from '@tanstack/react-router';
import type { ArticleSummary, LibraryEntry } from '../types';

/** Back to wherever the user came from, or Library for a fresh deep link. */
export function useGoBack(fallback: '/library' | '/browse' = '/library') {
  const router = useRouter();
  const navigate = useNavigate();
  return () => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: fallback, replace: true });
  };
}

/** Book page for an entry; `?entry=` keeps imported and other-origin books addressable. */
export function bookLink(entry: LibraryEntry) {
  return { to: '/book/$id' as const, params: { id: entry.book.id }, search: { entry: entry.id } };
}

/** Reader for a library entry. */
export function readLink(entry: LibraryEntry) {
  return { to: '/read/$entryId' as const, params: { entryId: entry.id } };
}

/** Reader for a saved article. */
export function articleLink(article: Pick<ArticleSummary, 'id'>) {
  return { to: '/article/$id' as const, params: { id: article.id } };
}
