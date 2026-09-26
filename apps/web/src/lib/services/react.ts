import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { AppServices, Observable } from './contract';

const ServicesContext = createContext<AppServices | null>(null);

export function ServicesProvider({ services, children }: { services: AppServices; children?: ReactNode }) {
  return createElement(ServicesContext.Provider, { value: services }, children);
}

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices() must be used inside <ServicesProvider>.');
  return services;
}

/** Subscribes to a store; re-renders when it publishes a new snapshot. */
export function useStore<T>(store: Observable<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
