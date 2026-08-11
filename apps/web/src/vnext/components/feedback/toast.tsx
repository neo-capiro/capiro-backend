import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * vNext transient notifications.
 *
 * Replaces `AntApp.useApp().message` in the vNext Strategies pages, which was
 * one of the two remaining antd couplings on this surface (the other was the
 * ant-design icon package, now `components/icons`).
 *
 * Deliberately narrow: `success` and `error` are the only variants the call
 * sites use. Do not grow this into antd's full `message` API without a design
 * reference — the design system has no toast frame today.
 */

type ToastTone = 'success' | 'error';

interface Toast {
  id: number;
  tone: ToastTone;
  text: string;
}

export interface CapiroToastApi {
  success: (text: string) => void;
  error: (text: string) => void;
}

const DISMISS_AFTER_MS = 4000;

const ToastContext = createContext<CapiroToastApi | null>(null);

/**
 * No-op fallback used when a component calls `useCapiroToast()` outside a
 * provider — most commonly in a unit test that renders a page in isolation.
 *
 * Toasts are non-critical feedback, so dropping them is strictly better than
 * throwing and taking the page down with it. The real app always has the
 * provider: `VNextApp` mounts it above the router.
 */
const NOOP_TOASTS: CapiroToastApi = { success: () => {}, error: () => {} };

export function useCapiroToast(): CapiroToastApi {
  return useContext(ToastContext) ?? NOOP_TOASTS;
}

export function CapiroToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, text: string) => {
      const id = (nextId.current += 1);
      setToasts((current) => [...current, { id, tone, text }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DISMISS_AFTER_MS),
      );
    },
    [dismiss],
  );

  // Clear pending timers on unmount so a dismissal cannot fire into a dead tree.
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const api = useMemo<CapiroToastApi>(
    () => ({
      success: (text: string) => push('success', text),
      error: (text: string) => push('error', text),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="capiro-toast-region">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`capiro-toast capiro-toast--${toast.tone} capiro-elevation-widget`}
            // Errors interrupt; successes wait their turn.
            role={toast.tone === 'error' ? 'alert' : 'status'}
            aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
          >
            <span className="capiro-toast__text">{toast.text}</span>
            <button
              type="button"
              className="capiro-toast__dismiss"
              aria-label="Dismiss notification"
              onClick={() => dismiss(toast.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
