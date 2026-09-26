import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { Root } from './App';
import { AppShell } from './components/AppShell';
import { NotFound } from './routes/notFound';
import { LibraryScreen } from './routes/library';
import { BrowseScreen } from './routes/browse';
import { SettingsScreen } from './routes/settings';
import { BookScreen } from './routes/book';
import { ReaderScreen } from './routes/reader';

const rootRoute = createRootRoute({ component: Root, notFoundComponent: NotFound });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/library', replace: true });
  },
});

/** Pathless layout: sidebar / tab row around the three destinations. */
const shellRoute = createRoute({ getParentRoute: () => rootRoute, id: 'shell', component: AppShell });

const libraryRoute = createRoute({ getParentRoute: () => shellRoute, path: 'library', component: LibraryScreen });
const browseRoute = createRoute({ getParentRoute: () => shellRoute, path: 'browse', component: BrowseScreen });
const settingsRoute = createRoute({ getParentRoute: () => shellRoute, path: 'settings', component: SettingsScreen });

export interface BookSearch {
  /** Library entry id, for imported books or editions from another API origin. */
  entry?: string;
}

/** A catalog book at the current origin; `?entry=` pins a library entry. */
const bookRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'book/$id',
  validateSearch: (search: Record<string, unknown>): BookSearch =>
    typeof search.entry === 'string' && search.entry ? { entry: search.entry } : {},
  component: BookScreen,
});

const readRoute = createRoute({ getParentRoute: () => rootRoute, path: 'read/$entryId', component: ReaderScreen });

/** Paths from the first web prototype keep working. */
const legacyApp = createRoute({
  getParentRoute: () => rootRoute,
  path: 'app/$',
  beforeLoad: ({ params }) => {
    const rest = (params as { _splat?: string })._splat ?? '';
    const to = rest.startsWith('browse') ? '/browse' : rest.startsWith('settings') ? '/settings' : '/library';
    throw redirect({ to, replace: true });
  },
});
const legacyAppIndex = createRoute({
  getParentRoute: () => rootRoute,
  path: 'app',
  beforeLoad: () => {
    throw redirect({ to: '/library', replace: true });
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  shellRoute.addChildren([libraryRoute, browseRoute, settingsRoute]),
  bookRoute,
  readRoute,
  legacyAppIndex,
  legacyApp,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
