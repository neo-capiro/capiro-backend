/**
 * F09 (2026-09-10 remediation plan §7) — dirty step-form leave guard.
 *
 * A dirty step edit must not be silently discarded by ANY transition that
 * unmounts the form: Cancel editing, inspector close, selecting another step,
 * Add step, strategy navigation, or browser Back/Forward.
 *
 * Router integration note: the app uses <BrowserRouter> (react-router-dom
 * 6.30). useBlocker() requires a data router (createBrowserRouter) which the
 * plan explicitly says NOT to adopt just for this. The supported interception
 * point on BrowserRouter is the history object exposed through
 * UNSAFE_NavigationContext: while dirty we wrap navigator.push/replace so an
 * in-app navigation first asks (Keep editing / Discard changes), and we
 * install the native beforeunload guard for browser-level exits (Back/Forward
 * buttons, reload, tab close) which cannot be intercepted in-page.
 *
 * Tab switches (Step → Meri) do NOT unmount the form (the Step tab stays
 * mounted while hidden) and never pass through this guard — that behavior is
 * intentional and preserved.
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  UNSAFE_NavigationContext,
  useLocation,
  useNavigate,
  type NavigateOptions,
  type To,
} from 'react-router-dom';

export interface StepFormGuardState {
  /** A dirty draft exists and the guard is armed. */
  dirty: boolean;
  /** A leave was requested and is waiting on the Keep/Discard answer. */
  pending: boolean;
  /** True while a save mutation is in flight (blocks close/discard). */
  saving: boolean;
  /** Arm/disarm the guard (the form's dirty computation). */
  setDirty: (dirty: boolean) => void;
  setSaving: (saving: boolean) => void;
  /**
   * Wrap a UI action that would unmount the form. Clean → run immediately.
   * Dirty → record it as pending and let the dialog resolve it.
   */
  requestLeave: (action: () => void) => void;
  /** Keep editing: dismiss the dialog, values/selection/URL unchanged. */
  keepEditing: () => void;
  /** Discard: run the recorded pending action exactly once. */
  discardChanges: () => void;
}

export function useStepFormGuard(): StepFormGuardState {
  const navigator = useContext(UNSAFE_NavigationContext).navigator;
  const location = useLocation();
  const navigate = useNavigate();
  const [dirty, setDirtyState] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingAction = useRef<(() => void) | null>(null);
  const blockedTx = useRef<(() => void) | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const savingRef = useRef(saving);
  savingRef.current = saving;

  const setDirty = useCallback((value: boolean) => setDirtyState(value), []);

  const requestLeave = useCallback((action: () => void) => {
    if (savingRef.current) return; // While saving, block conflicting actions.
    if (!dirtyRef.current) {
      action();
      return;
    }
    pendingAction.current = action;
    setPending(true);
  }, []);

  const keepEditing = useCallback(() => {
    pendingAction.current = null;
    setPending(false);
  }, []);

  const discardChanges = useCallback(() => {
    if (savingRef.current) return;
    const action = pendingAction.current;
    pendingAction.current = null;
    setPending(false);
    setDirtyState(false);
    // The form is being discarded — run the recorded action exactly once.
    action?.();
  }, []);

  /*
   * Intercept in-app navigations (push/replace on the router's history).
   * Only armed while dirty; unwraps the moment the guard disarms so normal
   * navigation is untouched. A blocked transaction is replayed by Discard.
   */
  useEffect(() => {
    if (!dirty || saving) return;
    const originalPush: (to: To, state?: unknown, opts?: NavigateOptions) => void =
      navigator.push.bind(navigator);
    const originalReplace: (to: To, state?: unknown, opts?: NavigateOptions) => void =
      navigator.replace.bind(navigator);

    const intercept =
      (original: (to: To, state?: unknown, opts?: NavigateOptions) => void) =>
      (to: To, state?: unknown, opts?: NavigateOptions) => {
        if (!dirtyRef.current) {
          original(to, state);
          return;
        }
        /*
         * Tab-only transitions (Step ↔ Meri on the SAME step) never unmount
         * the form — the Step tab stays mounted while hidden. The plan
         * explicitly preserves that behavior, so a ?tab=-only change is
         * allowed through without a prompt.
         */
        const toSearch =
          typeof to === 'string'
            ? (to.split('?')[1] ?? '')
            : typeof to === 'object' && to !== null
              ? String((to as { search?: unknown }).search ?? '').replace(/^\?/, '')
              : '';
        const nextParams = new URLSearchParams(toSearch);
        const currentParams = new URLSearchParams(location.search);
        const keys = new Set([...nextParams.keys(), ...currentParams.keys()]);
        let tabOnly = true;
        for (const key of keys) {
          if (key === 'tab') continue;
          if (nextParams.get(key) !== currentParams.get(key)) {
            tabOnly = false;
            break;
          }
        }
        if (tabOnly) {
          original(to, state);
          return;
        }
        // Remember the transaction; the dialog resolves it.
        blockedTx.current = () => original(to, state, opts);
        pendingAction.current = blockedTx.current;
        setPending(true);
      };

    navigator.push = intercept(originalPush);
    navigator.replace = intercept(originalReplace);
    return () => {
      navigator.push = originalPush;
      navigator.replace = originalReplace;
    };
  }, [dirty, saving, navigator, location]);

  // Native browser exits (Back/Forward buttons, reload, tab close) cannot be
  // intercepted in-page — install beforeunload only while a dirty draft
  // exists, remove it on save/discard (plan §7 item 7).
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      // Legacy requirement for the confirmation dialog to appear.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // On a successful save the caller disarms the guard; nothing further here.
  void navigate;
  return { dirty, pending, saving, setDirty, setSaving, requestLeave, keepEditing, discardChanges };
}

/**
 * The Keep editing / Discard changes dialog (plan §7 item 5): initial focus on
 * Keep editing, keyboard/focus behavior preserved. Follows the established
 * st-modal__guard pattern from StrategiesModalShell.
 */
export function StepFormGuardDialog({
  onKeepEditing,
  onDiscard,
  saving,
}: {
  onKeepEditing: () => void;
  onDiscard: () => void;
  saving: boolean;
}) {
  const keepRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    keepRef.current?.focus();
  }, []);
  return (
    <div className="st-modal__guard" role="alertdialog" aria-label="Discard unsaved changes?">
      <span>
        <strong>Discard unsaved changes?</strong> Your edits to this step are not saved.
      </span>
      <span className="st-modal__guard-actions">
        <button
          type="button"
          className="capiro-button capiro-button--secondary capiro-button--compact"
          ref={keepRef}
          onClick={onKeepEditing}
        >
          Keep editing
        </button>
        <button
          type="button"
          className="capiro-button capiro-button--primary capiro-button--compact"
          disabled={saving}
          onClick={onDiscard}
        >
          Discard changes
        </button>
      </span>
    </div>
  );
}
