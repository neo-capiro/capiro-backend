import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';
import {
  MeetingPanelChromeProvider,
  type MeetingPanelChrome,
  type MeetingPanelConfirmOptions,
} from '../../../pages/engagement/meetings/meeting-panel-chrome.js';

/**
 * vNext (os.capiro.ai) provider for the shared Meetings drawer chrome — the
 * counterpart of the canonical `AntdMeetingPanelChrome`. Mounted by
 * VNextMeetingsWorkspace around the drawer and its sibling modals so that the
 * reused canonical components (MeetingDetailPanel, PrepTab/NotesTab/
 * DebriefTab, ShareConfirmation) surface their confirms and toasts through
 * vNext primitives instead of AntD, which may not render on this surface:
 *
 *   - confirm → the shared EngagementDialog shell (focus trap, Escape, scroll
 *     lock — the established window for every other Engagement dialog), with
 *     AntD-parity semantics: the dialog closes when `onOk` resolves and stays
 *     open (with an inline error, per EngagementDialog's own error contract)
 *     if it rejects.
 *   - success/error → `useCapiroToast` (CapiroToastProvider is mounted
 *     app-wide by VNextApp).
 *   - warning → the error tone: the Capiro toast system deliberately has only
 *     success/error variants, and the drawer's one warning ("Add some notes or
 *     a transcript first.") is a blocked-action message, which reads correctly
 *     as the error tone.
 */
export function VNextMeetingPanelChrome({ children }: { children: ReactNode }) {
  const toast = useCapiroToast();
  const [request, setRequest] = useState<MeetingPanelConfirmOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const confirm = useCallback((options: MeetingPanelConfirmOptions) => {
    setRequest(options);
    setBusy(false);
    setFailed(false);
  }, []);

  const chrome = useMemo<MeetingPanelChrome>(
    () => ({
      confirm,
      success: toast.success,
      error: toast.error,
      warning: toast.error,
    }),
    [confirm, toast],
  );

  const close = () => {
    if (busy) return;
    setRequest(null);
    setFailed(false);
  };

  const run = async () => {
    if (!request) return;
    setBusy(true);
    setFailed(false);
    try {
      await request.onOk();
      // AntD `modal.confirm` parity: resolve closes the dialog…
      setRequest(null);
    } catch {
      // …and a rejected onOk keeps it open, now with a visible reason.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <MeetingPanelChromeProvider chrome={chrome}>
      {children}
      <EngagementDialog
        open={request != null}
        eyebrow="Meeting · confirm"
        title={request?.title ?? ''}
        width={480}
        busy={busy}
        busyLabel="Working…"
        error={failed ? 'The action failed. Try again or cancel.' : null}
        onClose={close}
        footer={
          <>
            <button type="button" className="btn" disabled={busy} onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className={request?.danger ? 'btn' : 'btn btn-accent'}
              style={
                request?.danger
                  ? { background: 'var(--eng-error, #b42318)', color: '#fff', border: 'none' }
                  : undefined
              }
              disabled={busy}
              onClick={() => void run()}
            >
              {busy ? 'Working…' : (request?.okText ?? 'Confirm')}
            </button>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--ink-2, #475467)' }}>
          {request?.content}
        </p>
      </EngagementDialog>
    </MeetingPanelChromeProvider>
  );
}
