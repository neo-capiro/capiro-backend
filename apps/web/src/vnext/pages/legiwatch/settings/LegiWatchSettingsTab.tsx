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
import { lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { LwPill, LwSeg, LwButton } from '../lib/primitives.js';
import { LwStateLoading, LwStateUnavailable } from '../states/SystemStates.js';
import {
  useSavedViews,
  useWatchPresets,
  useSetWatchPresetStatus,
  w2Error,
  SAVED_VIEW_SURFACE_LABEL,
  SIGNAL_FAMILY_LABEL,
  type WatchPreset,
} from '../lib/wave2-api.js';
import { CreateWatchOverlay } from '../overlays/CreateWatchOverlay.js';
import { isWatchlistSetup, watchlistSetupPath } from '../lib/watchlist-navigation.js';
import { ReportWorkspace } from '../reports/ReportWorkspace.js';
import { useReportsFlag } from '../reports/report-api.js';
import { CapiroModal } from '../../../components/overlays/index.js';

const WatchlistSetup = lazy(async () => ({ default: (await import('./WatchlistSetup.js')).WatchlistSetup }));

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

/** This tab's own /me cache key. The save writes THIS key, not just ['me'] —
 *  reading one key and invalidating another is what LW-QA-022 was. */
const SETTINGS_ME_KEY = ['lw-vnext', 'settings-me'] as const;

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
  const [params] = useSearchParams();
  if (isWatchlistSetup(params)) {
    return <Suspense fallback={<LwStateLoading rows={4} />}><WatchlistSetup /></Suspense>;
  }
  return <LegiWatchPreferences />;
}

function LegiWatchPreferences() {
  const reportFlag = useReportsFlag(), [recordRulesOpen, setRecordRulesOpen] = useState(false);
  const [searchParams] = useSearchParams();
  const scope = searchParams.get('client') ?? '';
  const api = useApi();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [savedFlash, setSavedFlash] = useState(false);

  const me = useQuery({
    queryKey: SETTINGS_ME_KEY,
    queryFn: async () => (await api.get<MeWithLegiWatchPrefs>(`/api/me?_=${Date.now()}`)).data,
    staleTime: 0,
  });

  const prefs = useMemo<ResolvedPrefs>(() => normalize(me.data?.user?.legiwatchPrefs), [me.data]);

  /**
   * LW-QA-022. Two things make a preference stick:
   *
   *  1. The PATCH response is written STRAIGHT into this tab's own cache key.
   *     The tab reads ['lw-vnext','settings-me'] but the save used to invalidate
   *     only the global ['me'] query, so the segmented control — a fully
   *     controlled component — snapped back to the pre-save value even though
   *     the row had been written.
   *  2. The outgoing document is rebuilt from the CACHE inside mutationFn, not
   *     from the `prefs` snapshot captured at render time. PATCH /api/me replaces
   *     `legiwatch_prefs` wholesale, so a second change made before a refetch
   *     used to resend — and silently revert — the first one.
   *
   * `mutationKey` + `scope` serialize the PATCHes: with a whole-document replace,
   * two in-flight writes landing out of order would clobber each other.
   */
  const save = useMutation({
    mutationKey: [...SETTINGS_ME_KEY, 'save'],
    scope: { id: SETTINGS_ME_KEY.join(':') },
    mutationFn: async (change: LegiWatchPrefs) => {
      const cached = qc.getQueryData<MeWithLegiWatchPrefs>(SETTINGS_ME_KEY);
      const next = { ...normalize(cached?.user?.legiwatchPrefs), ...change };
      return (await api.patch<MeWithLegiWatchPrefs>('/api/me', { legiwatchPrefs: next })).data;
    },
    onMutate: (change) => {
      // Optimistic, so a rapid second click already builds on the new base.
      const cached = qc.getQueryData<MeWithLegiWatchPrefs>(SETTINGS_ME_KEY);
      if (!cached) return;
      qc.setQueryData<MeWithLegiWatchPrefs>(SETTINGS_ME_KEY, {
        ...cached,
        user: { ...cached.user, legiwatchPrefs: { ...normalize(cached.user?.legiwatchPrefs), ...change } },
      });
    },
    onSuccess: (data) => {
      if (data?.user) qc.setQueryData(SETTINGS_ME_KEY, data);
      void qc.invalidateQueries({ queryKey: SETTINGS_ME_KEY, refetchType: 'active' });
      void qc.invalidateQueries({ queryKey: ['me'] });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2200);
    },
    // The server is the authority: on failure drop the optimistic value rather
    // than leaving the control showing a preference that was never stored.
    onError: () => {
      void qc.invalidateQueries({ queryKey: SETTINGS_ME_KEY, refetchType: 'active' });
    },
  });

  const setPref = <K extends keyof LegiWatchPrefs>(key: K, value: LegiWatchPrefs[K]) => {
    save.mutate({ [key]: value } as LegiWatchPrefs);
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
      {reportFlag.enabled && <section className="lw-card" style={{ padding: 18 }}><h2 className="lw-card__title">Published bill records</h2><p>Review folder targets and staff channels for action and amendment alerts.</p><LwButton onClick={() => setRecordRulesOpen(true)}>Manage published-record alerts</LwButton>{recordRulesOpen && <CapiroModal open title="Reports and updates" width={1200} onClose={() => setRecordRulesOpen(false)}><ReportWorkspace initialTab="alerts" /></CapiroModal>}</section>}
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
          <LwButton size="36" onClick={() => navigate(watchlistSetupPath(scope))}>
            Open watchlist / monitoring setup
          </LwButton>
        </div>
      </section>

      <SavedViewsSummaryCard />
      <WatchPresetsCard />
    </div>
  );
}

/**
 * Watch presets management (W2-4) — the create wizard's counterpart. Every
 * preset created via "Create watch" ends up here, where its lifecycle
 * (active/paused/archived) can actually be changed and its definition edited,
 * replacing what was previously a create-only, disabled dead end (GAPS LW-G9).
 */
function WatchPresetsCard() {
  const navigate = useNavigate();
  const presets = useWatchPresets();
  const setStatus = useSetWatchPresetStatus();
  const [editing, setEditing] = useState<WatchPreset | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  return (
    <section className="lw-card" aria-label="Watch presets" style={{ padding: 18 }}>
      <div className="lw-card__head">
        <h2 className="lw-card__title">Watch presets</h2>
      </div>
      {presets.isLoading ? (
        <p className="lw-card__meta" style={{ fontSize: 13 }}>
          Loading watch presets…
        </p>
      ) : presets.isError ? (
        <p role="alert" className="lw-card__meta" style={{ fontSize: 13 }}>
          Watch presets could not be loaded. {w2Error(presets.error)}
        </p>
      ) : presets.data && presets.data.rows.length === 0 ? (
        <p className="lw-card__meta" style={{ fontSize: 13 }}>
          No watch presets yet. Use the "Create watch" button on the LegiWatch header to define one.
        </p>
      ) : (
        <>
          {statusError ? (
            <p role="alert" className="lw-card__meta" style={{ fontSize: 13, color: 'var(--lw-danger, #b42318)' }}>
              {statusError}
            </p>
          ) : null}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {presets.data?.rows.map((preset) => (
              <li
                key={preset.id}
                className="lw-card"
                style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <LwPill
                    tone={preset.status === 'active' ? 'success' : preset.status === 'paused' ? 'warning' : 'gray'}
                    size="22"
                  >
                    {preset.status.toUpperCase()}
                  </LwPill>
                  <strong style={{ fontSize: 14 }}>{preset.name}</strong>
                </div>
                <p className="lw-card__meta" style={{ margin: 0, fontSize: 12 }}>
                  {preset.signalFamilies.map((f) => SIGNAL_FAMILY_LABEL[f]).join(', ')} ·{' '}
                  {preset.conditions.length} trigger{preset.conditions.length === 1 ? '' : 's'}
                  {preset.clientIds.length
                    ? ` · ${preset.clientIds.length} client${preset.clientIds.length === 1 ? '' : 's'}`
                    : ''}
                </p>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <LwButton onClick={() => setEditing(preset)} disabled={preset.status === 'archived'}>
                    Edit
                  </LwButton>
                  {preset.status === 'active' ? (
                    <LwButton
                      onClick={() =>
                        setStatus.mutate(
                          { id: preset.id, status: 'paused' },
                          { onSuccess: () => setStatusError(null), onError: (err) => setStatusError(w2Error(err)) },
                        )
                      }
                      disabled={setStatus.isPending}
                    >
                      Pause
                    </LwButton>
                  ) : preset.status === 'paused' ? (
                    <LwButton
                      onClick={() =>
                        setStatus.mutate(
                          { id: preset.id, status: 'active' },
                          { onSuccess: () => setStatusError(null), onError: (err) => setStatusError(w2Error(err)) },
                        )
                      }
                      disabled={setStatus.isPending}
                    >
                      Resume
                    </LwButton>
                  ) : null}
                  {preset.status !== 'archived' ? (
                    <LwButton
                      onClick={() =>
                        setStatus.mutate(
                          { id: preset.id, status: 'archived' },
                          { onSuccess: () => setStatusError(null), onError: (err) => setStatusError(w2Error(err)) },
                        )
                      }
                      disabled={setStatus.isPending}
                    >
                      Archive
                    </LwButton>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {editing ? (
        <CreateWatchOverlay
          editPreset={editing}
          onClose={() => setEditing(null)}
          onConfigure={(clientId) => {
            setEditing(null);
            navigate(watchlistSetupPath(clientId));
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * A real summary — replacing the "no persistence backend" placeholder
 * (GAPS LW-G8). Full management (apply/rename/duplicate/share/default/delete)
 * lives in the header's "Saved views" overlay; this card is a lightweight
 * count-by-surface plus a way in, not a second full editor.
 */
function SavedViewsSummaryCard() {
  const navigate = useNavigate();
  const personal = useSavedViews({ scope: 'personal' });
  const shared = useSavedViews({ scope: 'tenant' });

  const bySurface = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of [...(personal.data?.rows ?? []), ...(shared.data?.rows ?? [])]) {
      counts.set(row.surface, (counts.get(row.surface) ?? 0) + 1);
    }
    return counts;
  }, [personal.data, shared.data]);

  return (
    <section className="lw-card" aria-label="Saved views" style={{ padding: 18 }}>
      <div className="lw-card__head">
        <h2 className="lw-card__title">Saved views</h2>
      </div>
      {personal.isLoading || shared.isLoading ? (
        <p className="lw-card__meta" style={{ fontSize: 13 }}>
          Loading saved views…
        </p>
      ) : personal.isError || shared.isError ? (
        <p role="alert" className="lw-card__meta" style={{ fontSize: 13 }}>
          Saved views could not be loaded.{' '}
          {w2Error(personal.error ?? shared.error)}
        </p>
      ) : bySurface.size === 0 ? (
        <p className="lw-card__meta" style={{ fontSize: 13 }}>
          No saved views yet. Save a hearings, feed, bills, or committee view from its own
          "Saved views" control to see it here.
        </p>
      ) : (
        <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 13 }}>
          {[...bySurface.entries()].map(([surface, count]) => (
            <li key={surface}>
              {SAVED_VIEW_SURFACE_LABEL[surface as keyof typeof SAVED_VIEW_SURFACE_LABEL] ?? surface}:{' '}
              {count} view{count === 1 ? '' : 's'}
            </li>
          ))}
        </ul>
      )}
      <LwButton size="36" onClick={() => navigate('/legiwatch?tab=hearings')}>
        Manage saved views
      </LwButton>
    </section>
  );
}
