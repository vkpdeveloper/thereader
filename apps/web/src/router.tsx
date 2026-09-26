import { createRootRoute, createRoute, createRouter, Navigate } from '@tanstack/react-router';
import { Root } from './App';
import AppLayout from './routes/app';
import Library from './routes/library';
import Browse from './routes/browse';
import Settings from './routes/settings';
import BookDetail from './routes/book';
import Reader from './routes/reader';

const rootRoute = createRootRoute({
  component: Root,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <Navigate to="/app/library" />,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'app',
  component: AppLayout,
});

const appIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: () => <Navigate to="/app/library" />,
});

const libraryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'library',
  component: Library,
});

const browseRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'browse',
  component: Browse,
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'settings',
  component: Settings,
});

const bookRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'book/$id',
  component: BookDetail,
});

const readerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'reader/$id',
  component: Reader,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  appRoute.addChildren([appIndexRoute, libraryRoute, browseRoute, settingsRoute]),
  bookRoute,
  readerRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
