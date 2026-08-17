/**
 * Engagement-scoped toast (design README §13 "Toast" / §14 "Toasts auto-
 * dismiss; the timer is reset, not stacked."): bottom-center dark pill, a
 * SINGLE active toast — setting a new one clears the previous timer first
 * rather than appending to a stack.
 *
 * This is deliberately its own, narrow implementation, not a retheme of an
 * existing one:
 *   - AntD's `message` (still used throughout the rest of Engagement's
 *     canonical components) stacks top-center and isn't styled to spec.
 *   - `CapiroToastProvider` (vnext/components/feedback/toast.tsx, built for
 *     Strategies) is the closest existing vNext infrastructure, but per its
 *     own header comment it's deliberately generic and is wrong on exactly
 *     the three axes the design calls out: position (top-right, not bottom-
 *     center), shape (bordered card with an accent stripe, not a dark solid
 *     pill), and behavior (stacks an array of toasts, not a single
 *     timer-reset message). Changing that shared provider to match this
 *     module's literal spec would also change Strategies/Dashboard/Meri,
 *     which is out of scope for an Engagement-only reskin.
 *
 * Scope: new vNext-authored Engagement code (VNextReportsTracker.tsx today)
 * calls `useEngagementToast()` directly. Canonical/shared components (the
 * migrated SendMeriModal/ShareConfirmation, etc.) keep their existing AntD
 * `message` calls as-is — retrofitting every existing call site across a
 * shared file is a separate, larger effort than "build the toast component"
 * calls for.
 */
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
import { X } from 'lucide-react';

export interface EngagementToastApi {
  show: (text: string) => void;
}

const EngagementToastContext = createContext<EngagementToastApi | null>(null);

/** Outside the provider (e.g. a unit test rendering a child in isolation),
 *  dropping the toast is strictly better than throwing. */
const NOOP_TOAST: EngagementToastApi = { show: () => {} };

export function useEngagementToast(): EngagementToastApi {
  return useContext(EngagementToastContext) ?? NOOP_TOAST;
}

const DISMISS_AFTER_MS = 4000;

export function EngagementToastProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setText(null);
  }, []);

  const show = useCallback((next: string) => {
    // README §13: "Setting a new toast clears the previous timer first" —
    // a single active toast, never a stacked array.
    if (timer.current) clearTimeout(timer.current);
    setText(next);
    timer.current = setTimeout(() => {
      timer.current = null;
      setText(null);
    }, DISMISS_AFTER_MS);
  }, []);

  // Clear a pending timer on unmount so it cannot fire into a dead tree.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const api = useMemo<EngagementToastApi>(() => ({ show }), [show]);

  return (
    <EngagementToastContext.Provider value={api}>
      {children}
      {text ? (
        <div className="uui-eng-toast" role="status" aria-live="polite">
          <span>{text}</span>
          <button type="button" aria-label="Dismiss notification" onClick={dismiss}>
            <X size={16} />
          </button>
        </div>
      ) : null}
    </EngagementToastContext.Provider>
  );
}
