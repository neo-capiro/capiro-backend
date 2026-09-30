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
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { LwPill, LwSeg, LwButton } from '../lib/primitives.js';
import { LwStateLoading, LwStateUnavailable } from '../states/SystemStates.js';
import { isWatchlistSetup, watchlistSetupPath } from '../lib/watchlist-navigation.js';
import {
  useLwNotificationPreferences,
  useSaveLwNotificationPreferences,
  w1Error,
} from '../lib/wave1-api.js';
import { ReportWorkspace } from '../reports/ReportWorkspace.js';
import { useReportsFlag } from '../reports/report-api.js';
import { AgendaRulesPanel } from './AgendaRulesPanel.js';
import { CapiroModal } from '../../../components/overlays/index.js';

const WatchlistSetup = lazy(async () => ({
  default: (await import('./WatchlistSetup.js')).WatchlistSetup,
}));

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
    timezone: TIMEZONES.some((t) => t.id === p.timezone)
      ? (p.timezone as ResolvedPrefs['timezone'])
      : 'local',
    defaultView: p.defaultView === 'list' ? 'list' : 'calendar',
    defaultChamber:
      p.defaultChamber === 'House' || p.defaultChamber === 'Senate' || p.defaultChamber === 'Joint'
        ? p.defaultChamber
        : '',
  };
}

/**
 * Committee email alerts — REAL per-user opt-in over
 * GET/PUT /api/legiwatch/live-hearings/notification-preferences.
 * Default OFF; delivery targets the signed-in account address only. A backend
 * refusal (e.g. no usable account email) renders its message verbatim.
 */
function CommitteeEmailOptIn() {
  const prefs = useLwNotificationPreferences();
  const save = useSaveLwNotificationPreferences();
  const [error, setError] = useState<string | null>(null);

  const enabled = prefs.data?.committeeEmailEnabled ?? false;
  const email = prefs.data?.emailAddress ?? null;

  return (
    <div
      aria-label="Committee email alerts"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        rowGap: 6,
        fontSize: 13,
        maxWidth: 640,
        alignItems: 'center',
        marginBottom: 14,
        paddingBottom: 14,
        borderBottom: '1px solid var(--lw-border, #e5e5e5)',
      }}
    >
      <span>
        Email me about followed committees
        <span style={{ display: 'block', fontSize: 12, color: 'var(--lw-meta)' }}>
          {prefs.isLoading
            ? 'Loading your email preference…'
            : prefs.isError
              ? 'Your current preference could not be read — no change has been made.'
              : enabled && email
                ? `On — alerts go to ${email}`
                : email
                  ? `Off — alerts would go to ${email}`
                  : 'Off — your account has no usable email address'}
        </span>
        {error ? (
          <span role="alert" style={{ display: 'block', fontSize: 12, color: 'var(--lw-danger, #b42318)' }}>
            {error}
          </span>
        ) : null}
        {save.isSuccess && !error ? (
          <span role="status" aria-live="polite" style={{ display: 'block', fontSize: 12, color: 'var(--lw-success, #067647)' }}>
            Saved
          </span>
        ) : null}
      </span>
      <LwButton
        size="36"
        disabled={prefs.isLoading || save.isPending || prefs.isError}
        onClick={() => {
          setError(null);
          save.mutate(
            { committeeEmailEnabled: !enabled },
            { onError: (err) => setError(w1Error(err)) },
          );
        }}
      >
        {save.isPending ? 'Saving…' : enabled ? 'Turn off' : 'Turn on'}
      </LwButton>
      {prefs.isError ? (
        <span role="alert" style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--lw-danger, #b42318)' }}>
          Your committee email preference could not be loaded. {w1Error(prefs.error)}{' '}
          <button type="button" className="lw-backlink" onClick={() => void prefs.refetch()}>
            Retry
          </button>
        </span>
      ) : null}
    </div>
  );
}

export function LegiWatchSettingsTab() {
  const [params] = useSearchParams();
  if (isWatchlistSetup(params)) {
    return (
      <Suspense fallback={<LwStateLoading rows={4} />}>
        <WatchlistSetup />
      </Suspense>
    );
  }
  return <LegiWatchPreferences />;
}

function LegiWatchPreferences() {
  const reportFlag = useReportsFlag(),
    [recordRulesOpen, setRecordRulesOpen] = useState(false);
  const [searchParams] = useSearchParams();
  const scope = searchParams.get('client') ?? '';
  const api = useApi();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [savedFlash, setSavedFlash] = useState(false);
  const savedFlashTimer = useRef<number | null>(null);
  const preferencesMounted = useRef(false);

  useEffect(() => {
    preferencesMounted.current = true;
    return () => {
      preferencesMounted.current = false;
      if (savedFlashTimer.current !== null) window.clearTimeout(savedFlashTimer.current);
      savedFlashTimer.current = null;
    };
  }, []);

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
        user: {
          ...cached.user,
          legiwatchPrefs: { ...normalize(cached.user?.legiwatchPrefs), ...change },
        },
      });
    },
    onSuccess: (data) => {
      if (data?.user) qc.setQueryData(SETTINGS_ME_KEY, data);
      void qc.invalidateQueries({ queryKey: SETTINGS_ME_KEY, refetchType: 'active' });
      void qc.invalidateQueries({ queryKey: ['me'] });
      if (!preferencesMounted.current) return;
      setSavedFlash(true);
      if (savedFlashTimer.current !== null) window.clearTimeout(savedFlashTimer.current);
      savedFlashTimer.current = window.setTimeout(() => {
        savedFlashTimer.current = null;
        setSavedFlash(false);
      }, 2200);
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
        <div className="lw-card" style={{ padding: 18 }}>
          <LwStateLoading rows={4} />
        </div>
      </div>
    );
  }

  // Show Monitoring overview even on /api/me error;
  // only hide Display/Notifications with an inline error banner
  const isError = me.isError;

  return (
    <div className="lw-body lw-settings" aria-label="LegiWatch settings">
      <section className="lw-card" aria-label="Monitoring overview" style={{ padding: 18 }}>
        <h1 className="lw-card__title">Monitoring</h1>
        <p style={{ margin: '6px 0 14px', maxWidth: 720 }}>
          Review the monitoring categories available for this client. This overview does not infer
          active coverage or delivery from data that has not been loaded.
        </p>
        <div aria-label="Monitoring categories" style={{ display: 'grid', gap: 10 }}>
          <div id="monitoring-watchlists">
            <strong>Saved watchlists</strong>
            <p style={{ margin: '3px 0', color: 'var(--lw-meta)' }}>Topics, terms, and jurisdictions are managed in the client watchlist editor. Open the watchlist editor to view and edit saved items.</p>
            <a href={watchlistSetupPath(scope)}>Inspect saved watchlists</a>
          </div>
          <div id="monitoring-news-statutes">
            <strong>News and statute monitors</strong>
            <p style={{ margin: '3px 0', color: 'var(--lw-meta)' }}>Status is not loaded here; inspect the client watchlist to see configured targets.</p>
            <a href={watchlistSetupPath(scope)}>Inspect news and statute targets</a>
          </div>
          <div id="monitoring-follows">
            <strong>Hearing and committee follows</strong>
            <p style={{ margin: '3px 0', color: 'var(--lw-meta)' }}>Hearing follows and committee subscriptions are configured on those tabs.</p>
            <a href="/legiwatch?tab=hearings">Inspect hearings</a>{' · '}
            <a href="/legiwatch?tab=committees">Inspect committees</a>{' · '}
            <a href="#monitoring-record-hearing">Record a hearing</a>
          </div>
          <div id="monitoring-agenda">
            <strong>Agenda and published-record rules</strong>
            <p style={{ margin: '3px 0', color: 'var(--lw-meta)' }}>Open the controls below to see whether rules are configured for this session.</p>
            <a href="#monitoring-agenda-rules">Inspect agenda rules</a>{' · '}
            {reportFlag.enabled ? <a href="#monitoring-published-records">Inspect published-record rules</a> : <span style={{ color: 'var(--lw-meta)' }}>Published-record rules are not available in this workspace</span>}
          </div>
          {reportFlag.enabled ? (
            <div id="monitoring-keyword-workflow">
              <strong>Keyword and workflow rules</strong>
              <p style={{ margin: '3px 0', color: 'var(--lw-meta)' }}>Inspect the enabled reports workspace for configured rules; no counts are shown here.</p>
              <a href="#monitoring-published-records">Open keyword and workflow controls</a>
            </div>
          ) : null}
        </div>
      </section>
      <section id="monitoring-agenda-rules" aria-label="Agenda rules">
        <AgendaRulesPanel />
      </section>
      {reportFlag.enabled && (
        <section id="monitoring-published-records" className="lw-card" style={{ padding: 18 }}>
          <h2 className="lw-card__title">Published-record and workflow rules</h2>
          <p>Review folder targets and staff channels for action, amendment, keyword, and workflow alerts.</p>
          <LwButton onClick={() => setRecordRulesOpen(true)}>
            Manage published-record alerts
          </LwButton>
          {recordRulesOpen && (
            <CapiroModal
              open
              title="Reports and updates"
              width={1200}
              onClose={() => setRecordRulesOpen(false)}
            >
              <ReportWorkspace initialTab="alerts" />
            </CapiroModal>
          )}
        </section>
      )}
      <section className="lw-card" aria-label="Display preferences" style={{ padding: 18 }}>
        {isError && (
          <div role="alert" style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--lw-danger, #b42318)' }}>
            Preferences could not be loaded — your display settings are unavailable.{' '}
            <LwButton size="36" onClick={() => void me.refetch()}>Retry</LwButton>
          </div>
        )}
        <div className="lw-card__head lw-settings__display-head">
          <h2 className="lw-card__title">Display</h2>
          {save.isSuccess && savedFlash ? (
            <LwPill aria-live="polite" tone="success" size="22">
              SAVED
            </LwPill>
          ) : null}
          {save.isPending ? (
            <LwPill tone="gray" size="22">
              SAVING…
            </LwPill>
          ) : null}
        </div>

        <div className="lw-settings__display-grid">
          <span style={{ color: 'var(--lw-meta)' }}>Preferred timezone</span>
          <div>
            <LwSeg
              ariaLabel="Preferred timezone"
              options={TIMEZONES.map((t) => ({ id: t.id, label: t.label }))}
              value={prefs.timezone}
              onChange={(v) => setPref('timezone', v)}
            />
            <p
              className="lw-settings__display-help"
              style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--lw-meta)' }}
            >
              Changes how times are listed for you. Each hearing still shows its OFFICIAL time and
              zone — this preference never edits the canonical record.
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
            <p
              className="lw-settings__display-help"
              style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--lw-meta)' }}
            >
              On narrow screens the schedule switches to agenda layout for readability; your choice
              here always applies again on a full-size display.
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

      <section id="monitoring-record-hearing" className="lw-card" aria-label="Notifications" style={{ padding: 18 }}>
        {isError && (
          <div role="alert" style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--lw-danger, #b42318)' }}>
            Preferences could not be loaded — your notification settings are unavailable.{' '}
            <LwButton size="36" onClick={() => void me.refetch()}>Retry</LwButton>
          </div>
        )}
        <div className="lw-card__head">
          <h2 className="lw-card__title">Notifications</h2>
          <span className="lw-card__meta">Per client, on each client's tracking configuration</span>
        </div>
        <CommitteeEmailOptIn />
        <p style={{ fontSize: 13, margin: '0 0 10px', color: 'var(--lw-body)' }}>
          Alert triggers, materiality, email/SMS channels and quiet hours are configured per client
          with your client's monitoring model — open the client's tracking settings to change them.
        </p>
        {/* Honest states (§13): the backend has no user-global hearing-start /
            hearing-change / transcript-ready / intelligence-ready delivery yet
            (hearing_subscription.notify_on_start exists per subscription but no
            user-level contract; intel-alert triggers cover bill/PE sources).
            These render DISABLED with the reason — never a fake toggle. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            rowGap: 8,
            fontSize: 13,
            maxWidth: 640,
            alignItems: 'center',
          }}
        >
          <span>Notify when a followed hearing starts</span>
          <span style={{ color: 'var(--lw-meta)', fontSize: 12 }}>
            Not available yet — set per hearing when you schedule it
          </span>
          <span>Hearing schedule changes</span>
          <span style={{ color: 'var(--lw-meta)', fontSize: 12 }}>Not available yet</span>
          <span>Transcript ready</span>
          <span style={{ color: 'var(--lw-meta)', fontSize: 12 }}>Not available yet</span>
          <span>Intelligence / client match ready</span>
          <span style={{ color: 'var(--lw-meta)', fontSize: 12 }}>
            Not available yet — per-client alert prefs exist under each client
          </span>
        </div>
        <div style={{ marginTop: 14 }}>
          <LwButton size="36" onClick={() => navigate(watchlistSetupPath(scope))}>
            Open watchlist / monitoring setup
          </LwButton>
        </div>
      </section>
    </div>
  );
}
