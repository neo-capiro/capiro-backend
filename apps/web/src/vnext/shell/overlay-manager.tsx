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
 * Shell overlay coordinator for the Figma interaction contract (`730:2573`):
 *
 * - OVERLAYS  — only one shell overlay may be open at a time;
 * - DISMISSAL — Escape and outside click close, and no destructive action fires;
 * - FOCUS     — keyboard focus returns to the invoking control.
 *
 * Only shell chrome overlays (search, notifications, profile, sidebar flyouts,
 * client context) register here. Page-level modals keep their own lifecycle.
 */
export type ShellOverlayId =
  | 'search'
  | 'profile'
  | 'notifications'
  | 'directory'
  | 'intelligence'
  | 'client-context'
  | 'dashboard-customize';

interface ShellOverlayContextValue {
  openId: ShellOverlayId | null;
  open: (id: ShellOverlayId, trigger: HTMLElement | null) => void;
  close: (id?: ShellOverlayId) => void;
  toggle: (id: ShellOverlayId, trigger: HTMLElement | null) => void;
}

const ShellOverlayContext = createContext<ShellOverlayContextValue | null>(null);

export function ShellOverlayProvider({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<ShellOverlayId | null>(null);
  // The control that invoked the overlay, so focus can be restored on close.
  const triggerRef = useRef<HTMLElement | null>(null);

  const restoreFocus = useCallback(() => {
    const trigger = triggerRef.current;
    triggerRef.current = null;
    // Focus restoration is deliberately deferred so it runs after the overlay
    // has unmounted; focusing a node that is about to be removed is a no-op.
    if (trigger?.isConnected) {
      window.requestAnimationFrame(() => trigger.focus());
    }
  }, []);

  const open = useCallback((id: ShellOverlayId, trigger: HTMLElement | null) => {
    triggerRef.current = trigger;
    setOpenId(id);
  }, []);

  const close = useCallback(
    (id?: ShellOverlayId) => {
      setOpenId((current) => {
        if (current === null) return null;
        if (id !== undefined && current !== id) return current;
        restoreFocus();
        return null;
      });
    },
    [restoreFocus],
  );

  const toggle = useCallback(
    (id: ShellOverlayId, trigger: HTMLElement | null) => {
      setOpenId((current) => {
        if (current === id) {
          restoreFocus();
          return null;
        }
        triggerRef.current = trigger;
        return id;
      });
    },
    [restoreFocus],
  );

  // DISMISSAL: a single document-level Escape listener for every shell overlay.
  useEffect(() => {
    if (openId === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openId, close]);

  const value = useMemo<ShellOverlayContextValue>(
    () => ({ openId, open, close, toggle }),
    [openId, open, close, toggle],
  );

  return <ShellOverlayContext.Provider value={value}>{children}</ShellOverlayContext.Provider>;
}

export function useShellOverlays(): ShellOverlayContextValue {
  const context = useContext(ShellOverlayContext);
  if (!context) {
    throw new Error('useShellOverlays must be used inside ShellOverlayProvider');
  }
  return context;
}

/**
 * Wires one overlay: reports whether it is open, and closes it on outside
 * pointer-down. The returned ref must wrap both the trigger and the panel so a
 * click on the trigger is not treated as an outside click.
 */
export function useShellOverlay(id: ShellOverlayId) {
  const { openId, open, close, toggle } = useShellOverlays();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isOpen = openId === id;

  useEffect(() => {
    if (!isOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        close(id);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [isOpen, id, close]);

  return {
    isOpen,
    containerRef,
    open: (trigger: HTMLElement | null) => open(id, trigger),
    close: () => close(id),
    toggle: (trigger: HTMLElement | null) => toggle(id, trigger),
  };
}
