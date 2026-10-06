import { useLayoutEffect } from 'react';
import { Outlet } from '@tanstack/react-router';
import { MediaRelayOrigin } from './components/article/media';
import { FileLaunchHandler } from './components/FileLaunch';
import { ToastProvider } from './components/toast';
import { applyTheme } from './lib/themes';
import { useServices, useStore } from './lib/services/react';

/**
 * Root: follows this device's theme preset, hosts the snackbar, takes books
 * opened from the OS and names the API whose relay shows media that other
 * hosts refuse to serve here.
 */
export function Root() {
  const services = useServices();
  const settings = useStore(services.settings);
  const themeId = settings.reader.themeId;
  useLayoutEffect(() => {
    if (settings.loaded) applyTheme(themeId);
  }, [settings.loaded, themeId]);
  return (
    <MediaRelayOrigin.Provider value={services.settings.currentOrigin()}>
      <ToastProvider>
        <Outlet />
        <FileLaunchHandler />
      </ToastProvider>
    </MediaRelayOrigin.Provider>
  );
}
