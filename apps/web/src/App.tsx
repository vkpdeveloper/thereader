import { useLayoutEffect } from 'react';
import { Outlet } from '@tanstack/react-router';
import { FileLaunchHandler } from './components/FileLaunch';
import { ToastProvider } from './components/toast';
import { applyTheme } from './lib/themes';
import { useServices, useStore } from './lib/services/react';

/** Root: follows the synced theme preset, hosts the snackbar and takes books opened from the OS. */
export function Root() {
  const services = useServices();
  const settings = useStore(services.settings);
  const themeId = settings.reader.themeId;
  useLayoutEffect(() => {
    if (settings.loaded) applyTheme(themeId);
  }, [settings.loaded, themeId]);
  return (
    <ToastProvider>
      <Outlet />
      <FileLaunchHandler />
    </ToastProvider>
  );
}
