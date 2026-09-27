import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

interface Toast {
  id: number;
  message: string;
  action?: { label: string; onClick: () => void };
  leaving?: boolean;
}

interface ToastApi {
  show(message: string, options?: { action?: Toast['action']; durationMs?: number }): void;
}

const ToastContext = createContext<ToastApi>({ show: () => undefined });

/** Floating snackbar (mobile `SnackBar`, floating behaviour): one at a time, newest wins. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timers = useRef<number[]>([]);
  const nextId = useRef(1);

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  const dismiss = useCallback((id: number) => {
    setToast((t) => (t && t.id === id ? { ...t, leaving: true } : t));
    timers.current.push(window.setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), 220));
  }, []);

  const show = useCallback<ToastApi['show']>(
    (message, options) => {
      clearTimers();
      const id = nextId.current++;
      setToast({ id, message, action: options?.action });
      timers.current.push(window.setTimeout(() => dismiss(id), options?.durationMs ?? 4000));
    },
    [dismiss],
  );

  useEffect(() => clearTimers, []);
  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toast && (
          <div key={toast.id} className={toast.leaving ? 'toast is-leaving' : 'toast'}>
            <span>{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  toast.action?.onClick();
                  dismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
