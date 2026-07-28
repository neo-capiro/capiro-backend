/*
 * Phase 4 — Watch in-editor UX. Replaces WatchRail's strategy-level block with
 * the prototype's exact WatchPanel (extracted from the locked prototype's
 * bundled JSX — every literal below, spacing, and copy string is measured
 * from it, not approximated), wired to Phase 3's authoritative review-state
 * API instead of the prototype's static fixture. No separate strategy-scoped
 * review page: everything happens here, inside the strategy's Meri panel.
 */
import { useEffect, useRef, useState } from 'react';
import { App } from 'antd';
import { Icon, btnPrimary, chipBtn } from '../strategy-ui.js';
import {
  useAcceptAllWatchProposals,
  useAcceptWatchProposal,
  useCreateMission,
  useDismissWatchProposal,
  useRevalidateWatch,
  useUpdateMission,
  useWatchReviewState,
} from '../api.js';
import { errorMessage } from '../../../lib/error-message.js';
import { httpStatus, WATCH_MISSION_NAME } from './agent-utils.js';
import { useQueryClient } from '@tanstack/react-query';
import { relativeTime } from '../constants.js';
import type { WatchProposalCard, WatchRecheckResult } from '../types.js';

/** Same query key shape api.ts's watchStateKey uses — duplicated here (not
 *  exported) only to invalidate it after a mission create/pause/resume, which
 *  is not itself a Watch-review write. */
function watchStateKey(strategyId: string) {
  return ['strategy', 'watch-state', strategyId] as const;
}

/** One calm, transient line per dropped proposal — never a red error (plan §4:
 *  "deleted-step drops must not show a red error or require dismissal"). */
function DroppedNotice({
  dropped,
  onClear,
}: {
  dropped: WatchRecheckResult['dropped'];
  onClear: () => void;
}) {
  if (dropped.length === 0) return null;
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        margin: '0 12px 9px',
        padding: '8px 10px',
        borderRadius: 8,
        background: 'var(--bg-surface-2)',
        border: '1px solid var(--border-1)',
        fontSize: 'var(--text-2xs)',
        color: 'var(--ink-2)',
        lineHeight: 1.5,
      }}
    >
      <div style={{ flex: 1 }}>
        {dropped.map((d, i) => (
          <div key={i}>{d.reason}</div>
        ))}
      </div>
      <button
        onClick={onClear}
        aria-label="Dismiss"
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}
      >
        <Icon name="x" size={12} color="var(--ink-4)" />
      </button>
    </div>
  );
}

export function StrategyWatchPanel({
  strategyId,
  focus,
  onFocused,
}: {
  strategyId: string;
  /** Phase 1 §3 Step 3: the header's Watch chip reveals + revalidates this block. */
  focus?: boolean;
  onFocused?: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const state = useWatchReviewState(strategyId, true);
  const revalidate = useRevalidateWatch(strategyId);
  const accept = useAcceptWatchProposal(strategyId);
  const dismiss = useDismissWatchProposal(strategyId);
  const acceptAll = useAcceptAllWatchProposals(strategyId);
  const createMission = useCreateMission();
  const updateMission = useUpdateMission();

  const [whyId, setWhyId] = useState<string | null>(null);
  const [dropped, setDropped] = useState<WatchRecheckResult['dropped']>([]);
  const blockRef = useRef<HTMLDivElement>(null);
  const [flagged, setFlagged] = useState(false);

  useEffect(() => {
    if (!focus) return;
    blockRef.current?.scrollIntoView({ block: 'nearest' });
    setFlagged(true);
    onFocused?.();
    // Panel placement (plan §4): the chip click ALSO invokes revalidation —
    // getState alone can be a stale read; this is the "I care about freshness
    // right now" signal, same as a manual Check now.
    revalidate.mutate(undefined, { onSuccess: (s) => setDropped(s.lastRecheck?.dropped ?? []) });
    const t = window.setTimeout(() => setFlagged(false), 2200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const afterMissionWrite = () => void qc.invalidateQueries({ queryKey: watchStateKey(strategyId) });

  const mission = state.data?.mission ?? null;
  const watching = mission?.state === 'active';
  const proposals = state.data?.proposals ?? [];
  const pending = proposals.length;
  // One shared "the panel is not currently actionable" flag — covers the
  // explicit revalidate (chip focus / Check now) AND the two accept paths,
  // which each trigger their own authoritative recheck server-side.
  const revalidating = revalidate.isPending || accept.isPending || acceptAll.isPending;
  const missionBusy = createMission.isPending || updateMission.isPending;

  const activate = (missionId: string) => {
    // "Update to weekly only when the user explicitly enables/resumes Watch in
    // this new UI" (plan §7) — this IS that moment, for a fresh mission and a
    // legacy daily one alike.
    updateMission.mutate(
      { id: missionId, input: { state: 'active', cadence: 'weekly', nextRunAt: new Date().toISOString() } },
      {
        onSuccess: afterMissionWrite,
        onError: (err) => message.error(errorMessage(err, 'Could not activate Watch mode.')),
      },
    );
  };

  const onToggleWatch = () => {
    if (!mission) {
      createMission.mutate(
        { strategyId, name: WATCH_MISSION_NAME, cadence: 'weekly' },
        {
          onSuccess: (m) => (m ? activate(m.id) : undefined),
          onError: (err) => message.error(errorMessage(err, 'Could not enable Watch mode.')),
        },
      );
      return;
    }
    if (watching) {
      updateMission.mutate(
        { id: mission.id, input: { state: 'paused' } },
        {
          onSuccess: afterMissionWrite,
          onError: (err) => message.error(errorMessage(err, 'Could not pause Watch mode.')),
        },
      );
    } else {
      activate(mission.id);
    }
  };

  const onRunCheck = () => {
    revalidate.mutate(undefined, {
      onSuccess: (s) => setDropped(s.lastRecheck?.dropped ?? []),
      onError: (err) => message.error(errorMessage(err, 'The check could not be run.')),
    });
  };

  const onAccept = (p: WatchProposalCard) => {
    accept.mutate(p.id, {
      onSuccess: (res) => setDropped(res.recheck.dropped),
      onError: (err) => {
        // Stale-head: reconcile in place, never navigate or dead-end (plan §4).
        if (httpStatus(err) === 409) {
          revalidate.mutate(undefined, { onSuccess: (s) => setDropped(s.lastRecheck?.dropped ?? []) });
          return;
        }
        message.error(errorMessage(err, 'Could not accept this proposal.'));
      },
    });
  };

  const onDismiss = (p: WatchProposalCard) => {
    dismiss.mutate(p.id, {
      onError: (err) => message.error(errorMessage(err, 'Could not dismiss this proposal.')),
    });
  };

  const onAcceptAll = () => {
    if (!state.data) return;
    acceptAll.mutate(
      { expectedVersionId: state.data.headVersionId, proposalIds: proposals.map((p) => p.id) },
      {
        onSuccess: (res) => setDropped(res.recheck.dropped),
        onError: (err) => {
          if (httpStatus(err) === 409) {
            revalidate.mutate(undefined, { onSuccess: (s) => setDropped(s.lastRecheck?.dropped ?? []) });
            return;
          }
          message.error(errorMessage(err, 'Could not accept these proposals.'));
        },
      },
    );
  };

  if (state.isLoading || !state.data) return null;

  const cadenceLabel = mission?.cadence === 'daily' ? 'Daily' : 'Weekly';
  const lastRunLabel = mission?.lastRunAt ? relativeTime(mission.lastRunAt) : '';

  return (
    <div
      ref={blockRef}
      data-testid="sp-watch-panel"
      style={{
        border: pending ? '1.5px solid var(--accent)' : '1px solid var(--border-1)',
        borderRadius: 11,
        background: pending ? 'var(--bg-surface)' : 'var(--bg-surface-2)',
        overflow: 'hidden',
        flexShrink: 0,
        marginBottom: 14,
        boxShadow: flagged ? '0 0 0 4px var(--accent-glow)' : 'none',
        transition: 'box-shadow .25s',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 12px',
          borderBottom: pending ? '1px solid var(--border-1)' : 'none',
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: watching ? 'var(--success)' : 'var(--ink-4)',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 'var(--text-2xs)',
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--ink-2)',
            flexShrink: 0,
          }}
        >
          Watch mode
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)', textAlign: 'right' }}>
          {revalidating ? 'Checking…' : `This strategy · ${cadenceLabel}`}
        </span>
      </div>

      {pending === 0 ? (
        <div style={{ padding: '10px 12px', fontSize: 'var(--text-xs)', color: 'var(--ink-3)', lineHeight: 1.5 }}>
          {watching
            ? 'Nothing to review — last check found no conflicts with the calendars, your firm phases, or step dependencies.'
            : "Paused for this strategy. Meri won't check it against calendar changes."}
          <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
            <button onClick={onToggleWatch} disabled={missionBusy} style={chipBtn}>
              {missionBusy ? 'Saving…' : watching ? 'Pause for this strategy' : 'Resume watching'}
            </button>
            {watching && (
              <button onClick={onRunCheck} disabled={revalidating} style={chipBtn}>
                {revalidating ? 'Checking…' : 'Check now'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 12px 7px' }}>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-1)', fontWeight: 700, flex: 1 }}>
              {pending} proposed change{pending > 1 ? 's' : ''} for your review
            </span>
            {lastRunLabel && (
              <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)', flexShrink: 0 }}>
                {lastRunLabel}
              </span>
            )}
            {revalidating && (
              <span style={{ fontSize: 'var(--text-2xs)', fontWeight: 700, color: 'var(--accent)' }}>
                Re-checking…
              </span>
            )}
          </div>

          <DroppedNotice dropped={dropped} onClear={() => setDropped([])} />

          <div
            data-testid="sp-watch-scroller"
            style={{
              maxHeight: 372,
              overflowY: 'auto',
              padding: '0 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: 9,
              opacity: revalidating ? 0.55 : 1,
              transition: 'opacity .2s',
            }}
          >
            {proposals.map((p) => {
              const outOfOrder = p.badges.includes('out_of_order');
              const updated = p.badges.includes('updated');
              return (
                <div
                  key={p.id}
                  style={{
                    border: '1px solid var(--border-2)',
                    borderRadius: 9,
                    padding: '10px 11px',
                    background: 'var(--bg-surface)',
                    flexShrink: 0,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <span
                      style={{
                        fontSize: 'var(--text-2xs)',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--ink-4)',
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {p.sourceLabel}
                      {p.sourceDate ? ` · ${relativeTime(p.sourceDate)}` : ''}
                    </span>
                    {outOfOrder && (
                      <span
                        style={{
                          fontSize: 9.5,
                          fontWeight: 800,
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          whiteSpace: 'nowrap',
                          lineHeight: 1.4,
                          color: 'var(--critical)',
                          background: '#FDECEC',
                          borderRadius: 5,
                          padding: '2px 6px',
                          flexShrink: 0,
                        }}
                      >
                        Out of order
                      </span>
                    )}
                    {updated && (
                      <span
                        style={{
                          fontSize: 9.5,
                          fontWeight: 800,
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          whiteSpace: 'nowrap',
                          lineHeight: 1.4,
                          color: 'var(--accent-ink)',
                          background: 'var(--accent-soft)',
                          borderRadius: 5,
                          padding: '2px 6px',
                          flexShrink: 0,
                        }}
                      >
                        Updated
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--ink-1)', lineHeight: 1.3 }}>
                    {p.title}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-2)', lineHeight: 1.5, marginTop: 4 }}>
                    {p.proposal}
                  </div>
                  {updated && (
                    <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--accent-ink)', marginTop: 5 }}>
                      Re-checked against your last accept — still valid, timing recalculated.
                    </div>
                  )}
                  {whyId === p.id && (
                    <div
                      style={{
                        fontSize: 'var(--text-xs)',
                        color: 'var(--accent-ink)',
                        background: 'var(--accent-soft)',
                        borderRadius: 7,
                        padding: '7px 9px',
                        marginTop: 7,
                        lineHeight: 1.5,
                      }}
                    >
                      {p.why} Accepting changes {p.impact} — the remaining proposals are re-checked against the
                      new plan before you review them.
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 9 }}>
                    <button
                      onClick={() => onAccept(p)}
                      disabled={revalidating}
                      style={{ ...btnPrimary, padding: '6px 12px', fontSize: 'var(--text-xs)', borderRadius: 7 }}
                    >
                      Accept
                    </button>
                    <button
                      onClick={() => onDismiss(p)}
                      disabled={revalidating || dismiss.isPending}
                      style={{ ...chipBtn, borderRadius: 7 }}
                    >
                      Dismiss
                    </button>
                    <span style={{ flex: 1 }} />
                    <button
                      onClick={() => setWhyId((w) => (w === p.id ? null : p.id))}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        fontSize: 'var(--text-2xs)',
                        fontWeight: 700,
                        color: 'var(--accent)',
                      }}
                    >
                      {whyId === p.id ? 'Hide' : 'Why?'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ padding: '10px 12px 11px', borderTop: '1px solid var(--border-1)', marginTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <button
                onClick={onAcceptAll}
                disabled={revalidating}
                style={{ ...chipBtn, fontWeight: 700, color: 'var(--accent-ink)', borderColor: 'var(--accent)' }}
              >
                Accept all {pending}
              </button>
              <button onClick={onToggleWatch} disabled={revalidating || missionBusy} style={chipBtn}>
                Pause for this strategy
              </button>
            </div>
            <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)', lineHeight: 1.45, marginTop: 8 }}>
              Nothing is applied until you accept. After each accept Meri re-checks the rest against the updated
              plan, so proposals never go stale.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
