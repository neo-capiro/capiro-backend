/**
 * LegiWatch V2 Wave 1 (W1-7, W1-8) — hearing actions and calendar export.
 *
 * Every action routes into an EXISTING Capiro workflow rather than a new one:
 *
 *   Ask Meri       → the grounded context packet, handed to the Meri surface
 *   Create brief   → apps/api assembles grounded context, Workspace creates the
 *                    document at its own `POST /workspace-api/drafts`
 *   Stage outreach → the Engagement outreach surface, resumed with the prefill
 *   Save moment /
 *   Save to client → tenant-scoped saved references
 *
 * Each action reports idle / submitting / created / failed honestly. A failed
 * call never renders as success.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LwButton } from '../lib/primitives.js';
import {
  downloadIcs,
  useAskMeri,
  useCalendarExport,
  useCreateBrief,
  useSaveItem,
  useStageOutreach,
  w1Error,
} from '../lib/wave1-api.js';

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
  canCreateBrief,
  canSaveMoment,
  pendingAction,
  onPendingHandled,
}: {
  hearingId: string;
  hearingTitle: string;
  /** '' when the lens is All Clients. */
  clientId: string;
  canCreateBrief: boolean;
  canSaveMoment: boolean;
  pendingAction: { action: string; refs: ActionRefs } | null;
  onPendingHandled: () => void;
}) {
  const navigate = useNavigate();
  const askMeri = useAskMeri(hearingId);
  const createBrief = useCreateBrief(hearingId);
  const stageOutreach = useStageOutreach(hearingId);
  const saveItem = useSaveItem(hearingId);
  const [status, setStatus] = useState<ActionStatus>({ kind: 'idle' });

  const run = (action: string, refs: ActionRefs) => {
    const effectiveClientId = refs.clientId || clientId;
    setStatus({ kind: 'submitting', action });

    const fail = (err: unknown) =>
      setStatus({ kind: 'failed', action, message: w1Error(err) });

    switch (action) {
      case 'ask_meri':
        askMeri.mutate(
          { insightId: refs.insightId, segmentId: refs.segmentId, clientId: effectiveClientId || undefined },
          {
            onSuccess: (packet) => {
              // Hand the grounded packet to the Meri surface, which consumes it
              // exactly once at the deep link's destination (`/meri/new` via
              // the root-route redirect). The status message below is
              // deliberately phrased as "prepared", not "opened": Meri renders
              // its own loud error there if the packet cannot be honored.
              const hearingTitle =
                typeof packet.hearing?.title === 'string' ? packet.hearing.title : undefined;
              try {
                sessionStorage.setItem(
                  'lw:meri-context',
                  JSON.stringify({ hearingId, hearingTitle, packet, createdAt: Date.now() }),
                );
              } catch {
                // A private-mode storage failure must not lose the action; the
                // deep link below still carries the identifiers Meri needs, and
                // Meri fails loudly (no silent newest-thread fallback) when the
                // packet is missing.
              }
              const qs = new URLSearchParams({
                source: 'legiwatch',
                hearingId,
                ...(refs.insightId ? { insightId: refs.insightId } : {}),
                ...(refs.segmentId ? { segmentId: refs.segmentId } : {}),
                ...(effectiveClientId ? { client: effectiveClientId } : {}),
              });
              setStatus({
                kind: 'done',
                action,
                message: 'Hearing context prepared. Finish opening Meri to continue.',
                href: `/meri?${qs.toString()}`,
              });
            },
            onError: fail,
          },
        );
        return;

      case 'create_brief':
        createBrief.mutate(
          {
            clientId: effectiveClientId || undefined,
            ...(refs.insightId ? { insightIds: [refs.insightId] } : {}),
          },
          {
            onSuccess: ({ draftId }) =>
              setStatus({
                kind: 'done',
                action,
                message: 'Brief created in Workspace with its hearing sources attached.',
                href: `/workspace/draft/${encodeURIComponent(draftId)}`,
              }),
            onError: fail,
          },
        );
        return;

      case 'stage_outreach':
        if (!effectiveClientId) {
          setStatus({
            kind: 'failed',
            action,
            message: 'Select a client before staging outreach.',
          });
          return;
        }
        stageOutreach.mutate(
          {
            clientId: effectiveClientId,
            insightId: refs.insightId,
            segmentId: refs.segmentId,
          },
          {
            onSuccess: (prefill) => {
              try {
                sessionStorage.setItem(
                  'lw:outreach-context',
                  JSON.stringify({ prefill, createdAt: Date.now() }),
                );
              } catch {
                /* see the Ask Meri note above */
              }
              const qs = new URLSearchParams({
                source: 'legiwatch',
                hearingId,
                client: effectiveClientId,
              });
              setStatus({
                kind: 'done',
                action,
                // Explicit: staged, not sent.
                message: 'Outreach staged for your review. Nothing has been sent.',
                href: `/outreach?${qs.toString()}`,
              });
            },
            onError: fail,
          },
        );
        return;

      case 'save_moment':
      case 'save_to_client': {
        const kind =
          action === 'save_moment' ? ('moment' as const) : refs.insightId ? ('finding' as const) : ('hearing' as const);
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
            onSuccess: () =>
              setStatus({
                kind: 'done',
                action,
                message: kind === 'moment' ? 'Moment saved.' : 'Saved to your workspace.',
              }),
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
        <LwButton onClick={() => run('ask_meri', {})}>Ask Meri</LwButton>
        <LwButton
          onClick={() => run('create_brief', {})}
          disabled={!canCreateBrief}
          title={
            canCreateBrief
              ? undefined
              : 'A brief needs a transcript; none is available for this proceeding.'
          }
        >
          Create brief
        </LwButton>
        <LwButton
          onClick={() => run('stage_outreach', {})}
          disabled={!clientId}
          title={clientId ? undefined : 'Select a client lens to stage outreach.'}
        >
          Stage outreach
        </LwButton>
        <LwButton
          onClick={() => run('save_to_client', {})}
          disabled={!clientId}
          title={clientId ? undefined : 'Select a client lens to save this hearing to a client.'}
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
          <span role="alert" className="lw-card__meta" style={{ color: 'var(--lw-danger, #b42318)' }}>
            {status.message}
          </span>
        ) : null}
      </div>

      {canSaveMoment ? null : (
        <p className="lw-card__meta" style={{ marginTop: 8, fontSize: 12 }}>
          Saving a transcript moment needs a transcript; none is available for this proceeding.
        </p>
      )}
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
  const exportQuery = useCalendarExport(hearingId, open);

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
