/*
 * Stage F Watch-mode rail affordance (rendered in the editor rail when
 * canShowWatchRail — features.agenticMeri AND features.strategyWatcher, the
 * server's guard pair — and no node is selected). Surfaces the strategy's
 * default Watch mission ("Keep this strategy on track", created on demand and
 * activated draft→active), a Run-check-now button (POST missions/:id/run-check
 * — findings render inline), and a count badge of open proposed change-sets
 * linking to the review queue. Minimal by design: the Watcher itself runs
 * server-side on the F2 scheduler; this is only the on/off + on-demand surface.
 *
 * SEAM (documented, deliberately unbuilt): a meeting-completion trigger — "a
 * client meeting attached to this strategy just ended, run a check" — belongs
 * here once the meetings association lands (deferred with it). It would be a
 * third trigger source next to the cadence scheduler and this manual button;
 * nothing in this component assumes triggers are only manual/scheduled.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App } from 'antd';
import { Chip, Icon, chipBtn, fieldLbl } from '../strategy-ui.js';
import {
  useChangeSets,
  useCreateMission,
  useMissions,
  useRunCheck,
  useUpdateMission,
} from '../api.js';
import { errorMessage } from '../../../lib/error-message.js';
import { WATCH_MISSION_NAME, findWatchMission } from './agent-utils.js';
import { FindingsList } from './ReviewQueue.js';
import type { RunCheckResult } from '../types.js';

export function WatchRail({
  strategyId,
  focus,
  onFocused,
}: {
  strategyId: string;
  /**
   * Phase 1 §3 Step 3: the header's Watch chip opens the panel here rather than
   * navigating to the separate review queue. Scrolls this block into view and
   * outlines it briefly. Phase 4 replaces the block itself.
   */
  focus?: boolean;
  onFocused?: () => void;
}) {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const missions = useMissions(strategyId);
  const createMission = useCreateMission();
  const updateMission = useUpdateMission();
  const runCheck = useRunCheck();
  const proposed = useChangeSets({ strategyId, status: 'proposed' });
  const [lastCheck, setLastCheck] = useState<RunCheckResult | null>(null);
  const blockRef = useRef<HTMLDivElement>(null);
  const [flagged, setFlagged] = useState(false);

  // Reveal-on-request. Acknowledged immediately so a second chip click focuses
  // again, and the outline clears on a timer that is cancelled on unmount.
  useEffect(() => {
    if (!focus) return;
    blockRef.current?.scrollIntoView({ block: 'nearest' });
    setFlagged(true);
    onFocused?.();
    const t = window.setTimeout(() => setFlagged(false), 2200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const mission = findWatchMission(missions.data ?? [], strategyId);
  const watching = mission?.state === 'active';
  const busy = createMission.isPending || updateMission.isPending;
  const proposedCount = proposed.data?.length ?? 0;

  const activate = (missionId: string) => {
    // nextRunAt=now makes the mission immediately claimable by the scheduler.
    updateMission.mutate(
      { id: missionId, input: { state: 'active', nextRunAt: new Date().toISOString() } },
      { onError: (err) => message.error(errorMessage(err, 'Could not activate Watch mode.')) },
    );
  };

  const onToggle = () => {
    if (!mission) {
      // Create-if-absent, then activate (missions start as draft).
      createMission.mutate(
        { strategyId, name: WATCH_MISSION_NAME, cadence: 'daily' },
        {
          onSuccess: (m) => {
            if (m) activate(m.id);
          },
          onError: (err) => message.error(errorMessage(err, 'Could not enable Watch mode.')),
        },
      );
      return;
    }
    if (watching) {
      updateMission.mutate(
        { id: mission.id, input: { state: 'paused' } },
        { onError: (err) => message.error(errorMessage(err, 'Could not pause Watch mode.')) },
      );
    } else {
      activate(mission.id);
    }
  };

  const onRunCheck = () => {
    if (!mission) return;
    setLastCheck(null);
    runCheck.mutate(mission.id, {
      onSuccess: (result) => setLastCheck(result),
      onError: (err) => message.error(errorMessage(err, 'The check could not be run.')),
    });
  };

  return (
    <div
      ref={blockRef}
      style={{
        borderTop: '1px solid var(--border-1)',
        paddingTop: 12,
        ...(flagged
          ? {
              outline: '2px solid var(--accent)',
              outlineOffset: 4,
              borderRadius: 6,
              transition: 'outline-color 0.2s',
            }
          : null),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
        <Icon name="radar" size={14} color="var(--ink-2)" />
        <span
          style={{
            fontSize: 'var(--text-xs)',
            fontWeight: 700,
            color: 'var(--ink-2)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Watch mode
        </span>
        <span style={{ flex: 1 }} />
        {mission &&
          (watching ? <Chip tone="success">Watching</Chip> : <Chip tone="ink">Paused</Chip>)}
      </div>

      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)', lineHeight: 1.5, marginBottom: 9 }}>
        Meri checks this plan against deadlines and the reference calendars and proposes changes
        for your review — nothing is applied without approval.
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button style={chipBtn} disabled={busy || missions.isLoading} onClick={onToggle}>
          {busy
            ? 'Saving…'
            : !mission
              ? 'Enable Watch'
              : watching
                ? 'Pause watching'
                : 'Resume watching'}
        </button>
        {watching && (
          <button style={chipBtn} disabled={runCheck.isPending} onClick={onRunCheck}>
            {runCheck.isPending ? 'Checking…' : 'Run check now'}
          </button>
        )}
      </div>

      {lastCheck && (
        <div style={{ marginTop: 10 }}>
          <div style={fieldLbl}>Last check</div>
          {lastCheck.findings.length > 0 ? (
            <FindingsList findings={lastCheck.findings} />
          ) : (
            <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)' }}>
              No issues found — the plan looks on track.
            </div>
          )}
          {lastCheck.changeSetIds.length > 0 && (
            <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-2)', marginTop: 5 }}>
              {lastCheck.changeSetIds.length} change proposal
              {lastCheck.changeSetIds.length === 1 ? '' : 's'} queued for review.
            </div>
          )}
        </div>
      )}

      {proposedCount > 0 && (
        <button
          onClick={() => navigate('/strategies/agents/review')}
          style={{
            marginTop: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            textAlign: 'left',
            background: 'var(--accent-soft)',
            border: '1px solid #C6D4F4',
            borderRadius: 8,
            padding: '8px 11px',
            cursor: 'pointer',
          }}
        >
          <span
            style={{
              minWidth: 20,
              height: 20,
              borderRadius: 10,
              background: 'var(--accent)',
              color: '#fff',
              display: 'grid',
              placeItems: 'center',
              fontSize: 'var(--text-2xs)',
              fontWeight: 700,
              padding: '0 5px',
            }}
          >
            {proposedCount}
          </span>
          <span style={{ flex: 1, fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--accent-ink)' }}>
            Proposed change{proposedCount === 1 ? '' : 's'} awaiting review
          </span>
          <Icon name="arrow" size={13} color="var(--accent-ink)" />
        </button>
      )}
    </div>
  );
}
