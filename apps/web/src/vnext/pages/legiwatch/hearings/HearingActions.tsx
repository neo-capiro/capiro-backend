/**
 * LegiWatch V2 Wave 1 (W1-7, W1-8) — hearing actions and calendar export.
 *
 * Every action routes into an EXISTING Capiro workflow rather than a new one:
 *
 *   Create brief   → Meri drafts a grounded brief from the hearing record
 *                    (apps/api); the user refines it with the in-editor Meri
 *                    assistant and Workspace stores it through its own
 *                    `POST /workspace-api/drafts` (CreateBriefDialog)
 *   Stage outreach → the Engagement outreach surface, resumed with the prefill
 *   Save moment /
 *   Save to client → tenant-scoped saved references
 *
 * Each action reports idle / submitting / created / failed honestly. A failed
 * call never renders as success.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useImpersonation } from '../../../../state/impersonation.js';
import { meriEffectiveIdentityKey } from '../../../../components/chat/meri-route-guards.js';
import { useNavigate } from 'react-router-dom';
import { LwButton } from '../lib/primitives.js';
import {
  downloadIcs,
  useCalendarExport,
  useSaveItem,
  useStageOutreach,
  w1Error,
} from '../lib/wave1-api.js';
import { CreateBriefDialog } from './CreateBriefDialog.js';

export type ActionStatus =
  | { kind: 'idle' }
  | { kind: 'submitting'; action: string }
  | { kind: 'done'; action: string; message: string; href?: string }
  | { kind: 'failed'; action: string; message: string };

export interface ActionRefs {
  insightId?: string;
  segmentId?: string;
  clientId?: string;
}

/**
 * The action bar plus the live status region.
 *
 * `pendingAction` lets the Client Relevance panel's recommended actions drive
 * the same handlers as the buttons here, so there is one implementation of each
 * action rather than two that can drift.
 */
export function HearingActions({
  hearingId,
  hearingTitle,
  clientId,
  hasTranscript,
  canSaveMoment,
  pendingAction,
  onPendingHandled,
}: {
  hearingId: string;
  hearingTitle: string;
  /** '' when the lens is All Clients. */
  clientId: string;
  /** Decides whether a brief is a recap (transcript) or a preparation (none yet). */
  hasTranscript: boolean;
  canSaveMoment: boolean;
  pendingAction: { action: string; refs: ActionRefs } | null;
  onPendingHandled: () => void;
}) {
  const navigate = useNavigate();
  const { orgId, userId } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  const identityKey = meriEffectiveIdentityKey(actAsTenantSlug, orgId, userId);
  const selectionKey = JSON.stringify([identityKey, hearingId, clientId]);
  // Object identity also invalidates A → B → A changes while a call is pending.
  const selectionToken = useMemo(() => ({ key: selectionKey }), [selectionKey]);
  const currentSelectionRef = useRef<typeof selectionToken | null>(selectionToken);
  currentSelectionRef.current = selectionToken;
  useEffect(() => {
    currentSelectionRef.current = selectionToken;
    return () => {
      currentSelectionRef.current = null;
    };
  }, [selectionToken]);
  const stageOutreach = useStageOutreach(hearingId);
  const saveItem = useSaveItem(hearingId);
  const [status, setStatus] = useState<ActionStatus>({ kind: 'idle' });
  const [briefDialog, setBriefDialog] = useState<{ clientId: string } | null>(null);
  // Mirrors `briefDialog` for a stale in-flight save to check against: closing
  // the dialog (Cancel, hearing/identity change) or opening a new one changes
  // this before a still-running save's `onSaved` can fire, so that closure's
  // own captured `briefDialog` reference no longer matches and it is ignored.
  const briefDialogRef = useRef(briefDialog);
  briefDialogRef.current = briefDialog;
  const actionGenerationRef = useRef(0);
  const statusSelectionRef = useRef(selectionToken);
  useEffect(() => {
    if (statusSelectionRef.current === selectionToken) return;
    statusSelectionRef.current = selectionToken;
    setStatus({ kind: 'idle' });
  }, [selectionToken]);
  // A brief drafted under one hearing or identity must never be saved under another.
  useEffect(() => {
    setBriefDialog(null);
  }, [hearingId, identityKey]);

  const run = (action: string, refs: ActionRefs) => {
    const effectiveClientId = refs.clientId || clientId;
    // A server-recommended `ask_meri` lands in the same dialog: Meri is inside it.
    if (action === 'ask_meri' || action === 'create_brief') {
      setBriefDialog({ clientId: effectiveClientId || '' });
      return;
    }
    const generation = ++actionGenerationRef.current;
    const isCurrentAction = () =>
      currentSelectionRef.current === selectionToken && generation === actionGenerationRef.current;
    setStatus({ kind: 'submitting', action });

    const fail = (err: unknown) => {
      if (isCurrentAction()) setStatus({ kind: 'failed', action, message: w1Error(err) });
    };

    switch (action) {
      case 'stage_outreach':
        if (!effectiveClientId) {
          setStatus({
            kind: 'failed',
            action,
            message: 'Select a client before staging outreach.',
          });
          return;
        }
        // Promise completion survives StrictMode's initial effect resubscribe;
        // the selection/generation guard still rejects stale private results.
        void stageOutreach
          .mutateAsync({
            clientId: effectiveClientId,
            insightId: refs.insightId,
            segmentId: refs.segmentId,
          })
          .then((prefill) => {
            if (!isCurrentAction()) return;
            const contextId = crypto.randomUUID();
            try {
              sessionStorage.setItem(
                'lw:outreach-context',
                JSON.stringify({ id: contextId, prefill, createdAt: Date.now() }),
              );
            } catch {
              setStatus({
                kind: 'failed',
                action,
                message: 'The hearing details could not be saved for outreach. Please try again.',
              });
              return;
            }
            const qs = new URLSearchParams({
              source: 'legiwatch',
              contextId,
              hearingId,
              client: effectiveClientId,
            });
            setStatus({
              kind: 'done',
              action,
              // Explicit: staged, not sent.
              message: 'Outreach staged for your review. Nothing has been sent.',
              // The outreach list lives at /engagement/outreach — the only
              // registered route tree is /engagement/* (App.tsx). A bare
              // /outreach 404s.
              href: `/engagement/outreach?${qs.toString()}`,
            });
          }, fail);
        return;

      case 'save_moment':
      case 'save_to_client': {
        const kind =
          action === 'save_moment'
            ? ('moment' as const)
            : refs.insightId
              ? ('finding' as const)
              : ('hearing' as const);
        if (kind === 'moment' && !refs.segmentId) {
          setStatus({
            kind: 'failed',
            action,
            message: 'Select a transcript moment to save.',
          });
          return;
        }
        saveItem.mutate(
          {
            kind,
            segmentId: refs.segmentId,
            insightId: refs.insightId,
            clientId: effectiveClientId || undefined,
          },
          {
            onSuccess: () => {
              if (!isCurrentAction()) return;
              setStatus({
                kind: 'done',
                action,
                message: kind === 'moment' ? 'Moment saved.' : 'Saved to your workspace.',
              });
            },
            onError: fail,
          },
        );
        return;
      }

      default:
        setStatus({ kind: 'failed', action, message: `Unknown action: ${action}` });
    }
  };

  // Recommended actions in the relevance panel dispatch through the same
  // handlers, so there is one implementation per action.
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (!pendingAction || handled.current === pendingAction) return;
    handled.current = pendingAction;
    run(pendingAction.action, pendingAction.refs);
    onPendingHandled();
    // `run` is recreated each render; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAction]);

  return (
    <section className="lw-card" style={{ padding: 18 }} aria-label="Actions">
      <div className="lw-card__head">
        <h2 className="lw-card__title">Actions</h2>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <LwButton onClick={() => run('create_brief', {})}>Create brief</LwButton>
        <LwButton
          onClick={() => run('stage_outreach', {})}
          disabled={!clientId}
          title={clientId ? undefined : 'Select a client to stage outreach.'}
        >
          Stage outreach
        </LwButton>
        <LwButton
          onClick={() => run('save_to_client', {})}
          disabled={!clientId}
          title={clientId ? undefined : 'Select a client to save this hearing.'}
        >
          Save to client
        </LwButton>
        <CalendarExportControl hearingId={hearingId} hearingTitle={hearingTitle} />
      </div>

      {/* One live region for every action outcome. */}
      <div aria-live="polite" style={{ marginTop: 12, minHeight: 20 }}>
        {status.kind === 'submitting' ? (
          <span className="lw-card__meta">Working…</span>
        ) : status.kind === 'done' ? (
          <span className="lw-card__meta">
            {status.message}{' '}
            {status.href ? (
              <button
                type="button"
                className="lw-backlink"
                style={{ padding: 0 }}
                onClick={() => navigate(status.href!)}
              >
                Open →
              </button>
            ) : null}
          </span>
        ) : status.kind === 'failed' ? (
          <span
            role="alert"
            className="lw-card__meta"
            style={{ color: 'var(--lw-danger, #b42318)' }}
          >
            {status.message}
          </span>
        ) : null}
      </div>

      {canSaveMoment ? null : (
        <p className="lw-card__meta" style={{ marginTop: 8, fontSize: 12 }}>
          Saving a transcript moment needs a transcript; none is available for this proceeding.
        </p>
      )}

      {briefDialog ? (
        <CreateBriefDialog
          hearingId={hearingId}
          hearingTitle={hearingTitle}
          initialClientId={briefDialog.clientId}
          hasTranscript={hasTranscript}
          onClose={() => setBriefDialog(null)}
          onSaved={(draftId) => {
            // A save that resolves after this exact dialog session was closed
            // or superseded (hearing/identity change, Cancel, or a new
            // Create-brief) must not clobber whatever status is now current.
            if (currentSelectionRef.current !== selectionToken || briefDialogRef.current !== briefDialog) {
              return;
            }
            setBriefDialog(null);
            setStatus({
              kind: 'done',
              action: 'create_brief',
              message: 'Brief saved to Workspace.',
              href: `/workspace/draft/${encodeURIComponent(draftId)}`,
            });
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Calendar export (W1-8). The `.ics` is first class: the bytes come from the
 * server unmodified, so the file the user saves is the one the ICS tests cover.
 * Google and Outlook open the server-built standards-compliant URLs.
 */
export function CalendarExportControl({
  hearingId,
  hearingTitle,
}: {
  hearingId: string;
  hearingTitle: string;
}) {
  const [open, setOpen] = useState(false);
  // Only fetched once the user asks — no ICS body on every detail render.
  const [dateOnlyReminder, setDateOnlyReminder] = useState(false);
  const exportQuery = useCalendarExport(hearingId, open, dateOnlyReminder);

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <LwButton onClick={() => setOpen((v) => !v)}>Export calendar</LwButton>
      {open ? (
        <div
          role="group"
          aria-label={`Calendar export for ${hearingTitle}`}
          className="lw-card"
          style={{
            position: 'absolute',
            zIndex: 20,
            top: 'calc(100% + 6px)',
            left: 0,
            padding: 10,
            minWidth: 220,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
        >
          <label>
            <input
              type="checkbox"
              checked={dateOnlyReminder}
              onChange={(e) => setDateOnlyReminder(e.target.checked)}
            />{' '}
            Use a date-only reminder when no exact start time is published
          </label>
          {exportQuery.isLoading ? (
            <span className="lw-card__meta">Preparing export…</span>
          ) : exportQuery.isError || !exportQuery.data ? (
            <span role="alert" className="lw-card__meta">
              The calendar export could not be generated. {w1Error(exportQuery.error)}
            </span>
          ) : (
            <>
              <LwButton
                onClick={() => {
                  downloadIcs(exportQuery.data!);
                  setOpen(false);
                }}
              >
                Download .ics
              </LwButton>
              <a
                className="lw-btn"
                href={exportQuery.data.googleUrl}
                target="_blank"
                rel="noreferrer noopener"
                onClick={() => setOpen(false)}
              >
                Google Calendar ↗
              </a>
              <a
                className="lw-btn"
                href={exportQuery.data.outlookUrl}
                target="_blank"
                rel="noreferrer noopener"
                onClick={() => setOpen(false)}
              >
                Outlook ↗
              </a>
              {exportQuery.data.allDay ? (
                // Honest about why there is no time on the entry.
                <span className="lw-card__meta" style={{ fontSize: 12 }}>
                  No start time has been announced, so this exports as an all-day entry.
                </span>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </span>
  );
}
