import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import { useMe } from '../../../lib/me.js';
import { isTenantAdmin } from '@capiro/shared';
import {
  trackerKeys,
  trackerPaths,
  type AlertPrefsPayload,
  type WatchlistPayload,
  type SeedSuggestions,
} from './tracker-api.js';
import {
  intelTrackerPaths,
  adaptWatchlist,
  adaptPrefs,
  watchlistToIntel,
  prefsToIntel,
  type IntelWatchlist,
  type IntelAlertPrefs,
  type IntelCompiled,
} from './intel-tracker-api.js';
import type { ToastItem } from './tracker-components.js';
type Notifications = { error: (text: string) => unknown };
export function useWatchlistConfig(
  clientId: string,
  configuring: boolean,
  message: Notifications,
  pushToast: (item: Omit<ToastItem, 'id'>) => void,
) {
  const api = useApi();
  const qc = useQueryClient();
  const activePanel = configuring ? 'config' : 'board';
  const [otpOpen, setOtpOpen] = useState(false);
  const { enabled: trackerV2, ready: flagsReady } = useIntelFeature('tracker_v2');
  // P1-02: firm-wide targeting is admin-only server-side. Mirror that here so a
  // non-admin sees a read-only card instead of typing edits that will 403. While
  // /me is still loading `role` is undefined — assume editable so an admin never
  // sees a flash of read-only; the server is the authority regardless.
  // An ABSENT role (still loading, a failed /me, or an older cached shape) means
  // "cannot determine" — treat it as editable rather than locking an admin out of
  // their own targeting over a transient read. The server still enforces the rule.
  const meQuery = useMe();
  const myRole = meQuery.data?.role;
  const canEditTargeting = myRole ? isTenantAdmin(myRole) : true;
  // P1-02: targeting is SHARED firm-wide and autosaved, so the save must be
  // legible — "Saving…/Saved at HH:MM/failed + Retry/someone else changed this" —
  // rather than a silent debounce with one generic error toast.
  type SaveState =
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved'; at: string }
    | { kind: 'error'; message: string }
    | { kind: 'conflict'; message: string };
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  /** The in-flight payload, so Retry has something to send. */
  const lastPayloadRef = useRef<WatchlistPayload | null>(null);
  /** Server truth BEFORE the in-flight save; promoted to `undoRef` on success. */
  const preSaveRef = useRef<WatchlistPayload | null>(null);
  /** One level of undo — deliberately not a stack (Gate B e-9). */
  const undoRef = useRef<WatchlistPayload | null>(null);

  const otpState = useRef<{
    masked: string;
    devCode?: string;
    phone: string;
    onVerified: () => void;
  } | null>(null);

  const issueAreasQuery = useQuery<{ issueAreas: string[] }>({
    queryKey: trackerKeys.issueAreas(),
    queryFn: async () =>
      trackerV2
        ? (await api.get<{ issueAreas: string[] }>(intelTrackerPaths.issueAreas())).data
        : (await api.get<{ issueAreas: string[] }>(trackerPaths.issueAreas())).data,
    staleTime: 60 * 60_000,
    enabled: flagsReady,
  });
  const watchlistQuery = useQuery<WatchlistPayload>({
    queryKey: trackerKeys.watchlist(clientId),
    queryFn: async () =>
      trackerV2
        ? adaptWatchlist(
            (await api.get<IntelWatchlist>(intelTrackerPaths.watchlist(clientId))).data,
          )
        : (await api.get<WatchlistPayload>(trackerPaths.watchlist(clientId))).data,
    enabled: activePanel === 'config' && flagsReady,
  });
  const prefsQuery = useQuery<AlertPrefsPayload>({
    queryKey: trackerKeys.alertPrefs(clientId),
    queryFn: async () =>
      trackerV2
        ? adaptPrefs((await api.get<IntelAlertPrefs>(intelTrackerPaths.alertPrefs(clientId))).data)
        : (await api.get<AlertPrefsPayload>(trackerPaths.alertPrefs(clientId))).data,
    enabled: activePanel === 'config' && flagsReady,
  });
  // P0-04 b-7/c-8: which surfaces each typed-term type feeds — a static preview
  // the Configure editor shows next to the type picker. intel-api only (the
  // legacy tracker has no equivalent), and only needed while Configure is open.
  const compiledQuery = useQuery<IntelCompiled>({
    queryKey: trackerKeys.compiled(clientId),
    queryFn: async () => (await api.get<IntelCompiled>(intelTrackerPaths.compiled(clientId))).data,
    enabled: activePanel === 'config' && flagsReady && trackerV2,
    staleTime: 60 * 60_000,
  });
  // Suggestions to seed the watchlist from the client profile (capability tags +
  // sector → issue area). Excludes anything already configured.
  const seedQuery = useQuery<SeedSuggestions>({
    queryKey: trackerKeys.seed(clientId),
    queryFn: async () =>
      trackerV2
        ? (await api.get<SeedSuggestions>(intelTrackerPaths.seedSuggestions(clientId))).data
        : (await api.get<SeedSuggestions>(trackerPaths.seedSuggestions(clientId))).data,
    enabled: activePanel === 'config' && flagsReady,
    staleTime: 5 * 60_000,
  });

  const allIssueAreas = issueAreasQuery.data?.issueAreas ?? [];
  const saveWatchlistMutation = useMutation({
    mutationFn: async (w: WatchlistPayload) =>
      trackerV2
        ? adaptWatchlist(
            (
              await api.put<IntelWatchlist>(
                intelTrackerPaths.watchlist(clientId),
                watchlistToIntel(w),
              )
            ).data,
          )
        : // State Legislation Platform (DD5) is intel-api-only — the legacy
          // WatchlistDto has no `jurisdictions` field and the API's global
          // ValidationPipe runs forbidNonWhitelisted:true, so forwarding it
          // here would 400 the save. Strip before hitting the legacy endpoint.
          (
            await api.put<WatchlistPayload>(trackerPaths.watchlist(clientId), {
              issueAreas: w.issueAreas,
              tags: w.tags,
            })
          ).data,
    onMutate: (w) => {
      lastPayloadRef.current = w;
      preSaveRef.current =
        qc.getQueryData<WatchlistPayload>(trackerKeys.watchlist(clientId)) ?? null;
      setSaveState({ kind: 'saving' });
    },
    onSuccess: (data) => {
      // The state that was persisted BEFORE this save is what Undo restores.
      undoRef.current = preSaveRef.current;
      setSaveState({
        kind: 'saved',
        at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
      // Seed the cache with the server-normalized value so the Configure form
      // (and recs) reflect what was actually persisted.
      qc.setQueryData(trackerKeys.watchlist(clientId), data);
      // LegiWatch's cold-start gate reads the canonical service through its
      // own lightweight query. A successful setup must unlock that gate too.
      void qc.invalidateQueries({ queryKey: ['lw-vnext', 'watchlist-peek', clientId] });
      void qc.invalidateQueries({ queryKey: trackerKeys.recommendations(clientId) });
      // Refresh seed suggestions only AFTER the save persists — otherwise the
      // refetch races the debounced PUT and returns stale (still-importable) rows.
      void qc.invalidateQueries({ queryKey: trackerKeys.seed(clientId) });
    },
    onError: (e: unknown) => {
      const res = (
        e as { response?: { status?: number; data?: { code?: string; message?: string } } }
      ).response;
      if (res?.status === 409 && res.data?.code === 'WATCHLIST_VERSION_CONFLICT') {
        // P1-02: another analyst saved first. Do NOT auto-merge — refetch their
        // version and say so. The Configure resync adopts it once isPending clears,
        // so this user's unsaved edits are replaced, which is the honest outcome.
        setSaveState({
          kind: 'conflict',
          message: res.data.message ?? 'Someone else changed this client’s targeting.',
        });
        void qc.invalidateQueries({ queryKey: trackerKeys.watchlist(clientId) });
        return;
      }
      if (res?.status === 403 && res.data?.code === 'TARGETING_EDIT_FORBIDDEN') {
        // P1-02: not an admin. Surface the server's own wording rather than a
        // generic failure, and do not offer Retry — retrying cannot succeed.
        setSaveState({
          kind: 'conflict',
          message: res.data.message ?? 'Only an admin can change firm-wide targeting.',
        });
        return;
      }
      setSaveState({ kind: 'error', message: 'Could not save targeting.' });
    },
  });
  /** Retry the failed save against the CURRENT server version, not the stale one. */
  const retrySaveWatchlist = () => {
    const p = lastPayloadRef.current;
    if (!p) return;
    const version = qc.getQueryData<WatchlistPayload>(trackerKeys.watchlist(clientId))?.version;
    saveWatchlistMutation.mutate({ ...p, version: version ?? p.version });
  };
  /**
   * Restore the previously persisted targeting through the same versioned PUT, at
   * the CURRENT version — so an undo still 409s if someone else has saved since
   * (which is the point), but does not 409 merely because it is an undo.
   */
  const undoSaveWatchlist = () => {
    const p = undoRef.current;
    if (!p) return;
    undoRef.current = null;
    const version = qc.getQueryData<WatchlistPayload>(trackerKeys.watchlist(clientId))?.version;
    saveWatchlistMutation.mutate({ ...p, version: version ?? p.version });
  };
  const savePrefsMutation = useMutation({
    mutationFn: async (p: AlertPrefsPayload) =>
      trackerV2
        ? adaptPrefs(
            (
              await api.put<IntelAlertPrefs>(
                intelTrackerPaths.alertPrefs(clientId),
                prefsToIntel(p),
              )
            ).data,
          )
        : // Same DD5 rationale as saveWatchlistMutation — the legacy AlertPrefsDto
          // has no `jurisdictions` field and would 400 under forbidNonWhitelisted.
          (
            await api.put<AlertPrefsPayload>(trackerPaths.alertPrefs(clientId), {
              triggers: p.triggers,
              materiality: p.materiality,
              emailEnabled: p.emailEnabled,
              emailAddress: p.emailAddress,
              emailCadence: p.emailCadence,
              smsEnabled: p.smsEnabled,
              smsPhone: p.smsPhone,
              smsPhoneVerified: p.smsPhoneVerified,
              smsCadence: p.smsCadence,
              quietHoursStart: p.quietHoursStart,
              quietHoursEnd: p.quietHoursEnd,
            })
          ).data,
    onSuccess: (data) => qc.setQueryData(trackerKeys.alertPrefs(clientId), data),
    onError: () => message.error('Could not save alert preferences'),
  });

  const smsStartMutation = useMutation({
    mutationFn: async (phone: string) =>
      (
        await api.post(
          trackerV2 ? intelTrackerPaths.smsStart(clientId) : trackerPaths.smsStart(clientId),
          { phone },
        )
      ).data as {
        dormant: boolean;
        masked: string;
        devCode?: string;
      },
  });
  const smsConfirmMutation = useMutation({
    mutationFn: async ({ phone, code }: { phone: string; code: string }) =>
      (
        await api.post(
          trackerV2 ? intelTrackerPaths.smsConfirm(clientId) : trackerPaths.smsConfirm(clientId),
          { phone, code },
        )
      ).data,
  });
  const testAlertMutation = useMutation({
    mutationFn: async (channels: ('email' | 'sms' | 'in_app')[]) =>
      (
        await api.post(
          trackerV2 ? intelTrackerPaths.testAlert(clientId) : trackerPaths.testAlert(clientId),
          { channels },
        )
      ).data as {
        channel: string;
        status: string;
        detail?: string;
      }[],
  });

  const requestVerify = (phone: string, onVerified: () => void) => {
    smsStartMutation.mutate(phone, {
      onSuccess: (res) => {
        otpState.current = { masked: res.masked, devCode: res.devCode, phone, onVerified };
        setOtpOpen(true);
      },
      onError: () => message.error('Could not start phone verification'),
    });
  };
  const confirmOtp = (code: string) => {
    const st = otpState.current;
    if (!st) return;
    smsConfirmMutation.mutate(
      { phone: st.phone, code },
      {
        onSuccess: () => {
          st.onVerified();
          setOtpOpen(false);
          pushToast({ text: 'Phone verified ✓' });
          void qc.invalidateQueries({ queryKey: trackerKeys.alertPrefs(clientId) });
        },
        onError: (e) =>
          message.error(
            (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
              'Incorrect code',
          ),
      },
    );
  };
  const fireTest = (channels: ('email' | 'sms' | 'in_app')[]) => {
    testAlertMutation.mutate(channels, {
      onSuccess: (res) => {
        const label: Record<string, string> = { in_app: 'In-app', email: 'Email', sms: 'SMS' };
        // P1-05: report EVERY requested channel's real outcome. The old code kept only
        // sent|suppressed and fell back to ['In-app'], so an email failure or skip
        // produced a success toast naming only In-app.
        pushToast({
          kind: 'test',
          results: res.map((r) => ({
            channel: label[r.channel] ?? r.channel,
            status: r.status,
            detail: r.detail,
          })),
        });
      },
      onError: () => message.error('Could not send test alert'),
    });
  };

  return {
    trackerV2,
    flagsReady,
    canEditTargeting,
    issueAreasQuery,
    watchlistQuery,
    prefsQuery,
    compiledQuery,
    seedQuery,
    allIssueAreas,
    saveState,
    saveWatchlistMutation,
    savePrefsMutation,
    retrySaveWatchlist,
    undoSaveWatchlist,
    undoRef,
    requestVerify,
    confirmOtp,
    fireTest,
    otpState,
    otpOpen,
    smsConfirmMutation,
    closeOtp: () => setOtpOpen(false),
  };
}
