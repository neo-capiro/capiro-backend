/**
 * LegiWatch Settings (PR D / LW-QA-013 settings half) — `/legiwatch?tab=settings`.
 *
 * A REAL LegiWatch subtab: deep-linkable, refresh-safe (URL tab state, same
 * contract as every other module tab), and NOT the global /settings page.
 *
 * Storage reuses EXISTING per-user contracts — no second preference system:
 *   - `PATCH /api/me` (apps/api users.controller UpdateMeDto): real
 *     cross-device per-user persistence. This PR extends it with the LegiWatch
 *     display-preference JSON column (legiwatch_prefs).
 *   - Alert cadence/channel per client stays on its EXISTING per-client
 *     contract (intel-api tracker alert-prefs) — linked, not duplicated here.
 *
 * HONESTY RULES (§13): a preference with no backend contract renders
 * "Not available yet" DISABLED — no localStorage fake persistence. And NO
 * operational controls ever appear here: no phase/CANARY/CUTOVER/kill-switch/
 * capture_all/production_default/Phase 9 rules/readiness counters (negative
 * contract test enforces).
 *
 * Display preference changes SECONDARY rendering only — hearing detail always
 * preserves and shows the OFFICIAL event timezone (lib/hearing-datetime.ts).
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { LwPill, LwSeg, LwButton } from '../lib/primitives.js';
import { LwStateLoading, LwStateUnavailable } from '../states/SystemStates.js';

/** Display-timezone options (§12). 'local' follows the browser; the other two
 *  are the zones Congress actually schedules in. Canonical event truth is
 *  untouched — this only changes secondary display. */
const TIMEZONES = [
  { id: 'local', label: 'Local (browser)' },
  { id: 'America/New_York', label: 'Eastern' },
  { id: 'America/Los_Angeles', label: 'Pacific' },
] as const;
type TimezonePref = (typeof TIMEZONES)[number]['id'];

/** A SINGLE JSON preference doc, stored per-user on the User row. One column
 *  (legiwatch_prefs jsonb) keeps this a small explicit contract instead of a
 *  second preference system; unknown keys survive round-trips. */
export interface LegiWatchPrefs {
  timezone?: string;
  /** Display default only; the responsive rule below 900px overrides it
   *  TEMPORARILY (never persisted as the user's choice). */
  defaultView?: 'calendar' | 'list';
  defaultChamber?: '' | 'House' | 'Senate' | 'Joint';
}

const DEFAULT_PREFS = {
  timezone: 'local',
  defaultView: 'calendar',
  defaultChamber: '',
} satisfies LegiWatchPrefs;

/** A fully-materialized prefs doc — what the UI always renders against. */
type ResolvedPrefs = Required<Pick<LegiWatchPrefs, 'timezone' | 'defaultView' | 'defaultChamber'>>;

interface MeWithLegiWatchPrefs {
  user: { legiwatchPrefs?: LegiWatchPrefs | null } & Record<string, unknown>;
}

function normalize(raw: unknown): ResolvedPrefs {
  const p = (raw ?? {}) as LegiWatchPrefs;
  return {
    ...DEFAULT_PREFS,
    ...p,
    // Only known timezone ids survive normalization; anything else falls back
    // to local (an old/corrupt value never breaks rendering).
    timezone: TIMEZONES.some((t) => t.id === p.timezone) ? (p.timezone as ResolvedPrefs['timezone']) : 'local',
    defaultView: p.defaultView === 'list' ? 'list' : 'calendar',
    defaultChamber:
      p.defaultChamber === 'House' || p.defaultChamber === 'Senate' || p.defaultChamber === 'Joint'
        ? p.defaultChamber
        : '',
  };
}

export function LegiWatchSettingsTab() {
  const api = useApi();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [savedFlash, setSavedFlash] = useState(false);

  const me = useQuery({
    queryKey: ['lw-vnext', 'settings-me'],
    queryFn: async () => (await api.get<{ user?: { legiwatchPrefs?: unknown } }>(`/api/me?_=${Date.now()}`)).data,
    staleTime: 0,
  });

  const prefs = useMemo<ResolvedPrefs>(() => normalize(me.data?.user?.legiwatchPrefs), [me.data]);

  const save = useMutation({
    mutationFn: async (next: LegiWatchPrefs) =>
      (await api.patch<unknown>('/api/me', { legiwatchPrefs: next })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2200);
    },
  });

  const setPref = <K extends keyof LegiWatchPrefs>(key: K, value: LegiWatchPrefs[K]) => {
    save.mutate({ ...prefs, [key]: value });
  };

  if (me.isLoading) {
    return (
      <div className="lw-body">
        <div className="lw-card" style={{ padding: 18 }}><LwStateLoading rows={4} /></div>
      </div>
    );
  }

  if (me.isError) {
    return (
      <div className="lw-body">
        <div className="lw-card" style={{ padding: 18 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--lw-meta)' }}>
            Preferences could not be loaded — your display settings are unavailable, hearings data is unaffected.
            <LwButton size="36" onClick={() => void me.refetch()}>Retry</LwButton>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="lw-body" aria-label="LegiWatch settings">
      <section className="lw-card" aria-label="Display preferences" style={{ padding: 18 }}>
        <div className="lw-card__head">
          <h2 className="lw-card__title">Display</h2>
          {save.isSuccess && savedFlash ? <LwPill tone="success" size="22">SAVED</LwPill> : null}
          {save.isPending ? <LwPill tone="gray" size="22">SAVING…</LwPill> : null}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', rowGap: 14, fontSize: 13, maxWidth: 640 }}>
          <span style={{ color: 'var(--lw-meta)' }}>Preferred timezone</span>
          <div>
            <LwSeg
              ariaLabel="Preferred timezone"
              options={TIMEZONES.map((t) => ({ id: t.id, label: t.label }))}
              value={prefs.timezone}
              onChange={(v) => setPref('timezone', v)}
            />
            <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--lw-meta)' }}>
              Changes how times are listed for you. Each hearing still shows its OFFICIAL time and zone —
              this preference never edits the canonical record.
            </p>
          </div>

          <span style={{ color: 'var(--lw-meta)' }}>Default hearings view</span>
          <div>
            <LwSeg
              ariaLabel="Default hearings view"
              options={[
                { id: 'calendar', label: 'Calendar' },
                { id: 'list', label: 'List' },
              ]}
              value={prefs.defaultView}
              onChange={(v) => setPref('defaultView', v as 'calendar' | 'list')}
            />
            <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--lw-meta)' }}>
              On narrow screens the schedule switches to agenda layout for readability; your choice here
              always applies again on a full-size display.
            </p>
          </div>

          <span style={{ color: 'var(--lw-meta)' }}>Default chamber filter</span>
          <div>
            <LwSeg
              ariaLabel="Default chamber filter"
              options={[
                { id: '', label: 'All' },
                { id: 'House', label: 'House' },
                { id: 'Senate', label: 'Senate' },
                { id: 'Joint', label: 'Joint' },
              ]}
              value={prefs.defaultChamber}
              onChange={(v) => setPref('defaultChamber', v as LegiWatchPrefs['defaultChamber'])}
            />
          </div>
        </div>
      </section>

      <section className="lw-card" aria-label="Notifications" style={{ padding: 18 }}>
        <div className="lw-card__head">
          <h2 className="lw-card__title">Notifications</h2>
          <span className="lw-card__meta">Per client, on each client's tracking configuration</span>
        </div>
        <p style={{ fontSize: 13, margin: '0 0 10px', color: 'var(--lw-body)' }}>
          Alert triggers, materiality, email/SMS channels and quiet hours are configured per client with
          your client's monitoring model — open the client's tracking settings to change them.
        </p>
        {/* Honest states (§13): the backend has no user-global hearing-start /
            hearing-change / transcript-ready / intelligence-ready delivery yet
            (hearing_subscription.notify_on_start exists per subscription but no
            user-level contract; intel-alert triggers cover bill/PE sources).
            These render DISABLED with the reason — never a fake toggle. */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 8, fontSize: 13, maxWidth: 640, alignItems: 'center' }}>
          <span>Notify when a followed hearing starts</span>
          <span style={{ color: 'var(--lw-meta)', fontSize: 12 }}>Not available yet — set per hearing when you schedule it</span>
          <span>Hearing schedule changes</span>
          <span style={{ color: 'var(--lw-meta)', fontSize: 12 }}>Not available yet</span>
          <span>Transcript ready</span>
          <span style={{ color: 'var(--lw-meta)', fontSize: 12 }}>Not available yet</span>
          <span>Intelligence / client match ready</span>
          <span style={{ color: 'var(--lw-meta)', fontSize: 12 }}>Not available yet — per-client alert prefs exist under each client</span>
        </div>
        <div style={{ marginTop: 14 }}>
          <LwButton size="36" onClick={() => navigate('/legiwatch?tab=bills')}>
            Open watchlist / monitoring setup
          </LwButton>
        </div>
      </section>

      <section className="lw-card" aria-label="Saved views" style={{ padding: 18 }}>
        <div className="lw-card__head">
          <h2 className="lw-card__title">Saved views</h2>
        </div>
        <p style={{ fontSize: 13, margin: '0 0 10px' }}>
          Saved views have no persistence backend yet — the Feed's saved-views strip is omitted rather than
          rendered against nothing.
        </p>
        <LwButton size="36" disabled>Not available yet</LwButton>
      </section>
    </div>
  );
}