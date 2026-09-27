import { useCallback, useEffect, useState } from 'react';
import type { StorageInfo } from '../services/contract';
import { useServices, useStore } from '../services/react';

/**
 * Browser storage usage and the persistence grant, refreshed whenever the
 * number of downloaded books changes. Null until the first estimate arrives.
 */
export function useStorageInfo(): { info: StorageInfo | null; refresh: () => void } {
  const services = useServices();
  const lib = useStore(services.library);
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const refresh = useCallback(() => {
    services.storage.info().then(setInfo, () => setInfo(null));
  }, [services.storage]);
  const readyCount = lib.entries.filter((e) => e.download.status === 'ready').length;
  useEffect(refresh, [refresh, readyCount]);
  return { info, refresh };
}
