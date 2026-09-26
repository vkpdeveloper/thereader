import { Outlet } from '@tanstack/react-router';
import { AppProvider } from './lib/store';

export function Root() {
  return (
    <AppProvider>
      <Outlet />
    </AppProvider>
  );
}
