import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useIntelFeature } from '../../../../lib/intel-feature-flags.js';
import {
  adaptPrefs,
  adaptWatchlist,
  intelTrackerPaths,
  prefsToIntel,
  watchlistToIntel,
  type IntelAlertPrefs,
  type IntelCompiled,
  type IntelWatchlist,
} from '../../../../pages/clients/tracker/intel-tracker-api.js';
import type {
  AlertPrefsPayload,
  SeedSuggestions,
  WatchlistPayload,
} from '../../../../pages/clients/tracker/tracker-api.js';
import { trackerKeys, trackerPaths } from '../../../../pages/clients/tracker/tracker-api.js';
import { TrackerConfigPanel } from '../../../../pages/clients/tracker/TrackerConfigPanel.js';

/**
 * Native vNext host for the shared targeting editor. The editor itself is
 * presentation-neutral and owns the complete round-trip contract; this host
 * supplies only the tenant-scoped reads and writes. Keeping that boundary here
 * prevents the LegiWatch bundle from importing the legacy TrackerSurface (and
 * its antd/CSS graph).
 */
export function WatchlistEditorVNext({ clientId, clientName }: { clientId: string; clientName: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const { enabled: trackerV2, ready } = useIntelFeature('tracker_v2');
  const watchlist = useQuery<WatchlistPayload>({
    queryKey: trackerKeys.watchlist(clientId),
    enabled: ready,
    queryFn: async () =>
      trackerV2
        ? adaptWatchlist((await api.get<IntelWatchlist>(intelTrackerPaths.watchlist(clientId))).data)
        : (await api.get<WatchlistPayload>(trackerPaths.watchlist(clientId))).data,
    retry: false,
  });
  const prefs = useQuery<AlertPrefsPayload>({
    queryKey: trackerKeys.alertPrefs(clientId),
    enabled: ready,
    queryFn: async () =>
      trackerV2
        ? adaptPrefs((await api.get<IntelAlertPrefs>(intelTrackerPaths.alertPrefs(clientId))).data)
        : (await api.get<AlertPrefsPayload>(trackerPaths.alertPrefs(clientId))).data,
    retry: false,
  });
  const issueAreas = useQuery<{ issueAreas: string[] }>({
    queryKey: trackerKeys.issueAreas(),
    enabled: ready,
    queryFn: async () =>
      (await api.get<{ issueAreas: string[] }>(trackerV2 ? intelTrackerPaths.issueAreas() : trackerPaths.issueAreas())).data,
    staleTime: 60 * 60_000,
    retry: false,
  });
  const seed = useQuery<SeedSuggestions>({
    queryKey: trackerKeys.seed(clientId),
    enabled: ready,
    queryFn: async () =>
      (await api.get<SeedSuggestions>(trackerV2 ? intelTrackerPaths.seedSuggestions(clientId) : trackerPaths.seedSuggestions(clientId))).data,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const compiled = useQuery<IntelCompiled>({
    queryKey: trackerKeys.compiled(clientId),
    enabled: ready && trackerV2,
    queryFn: async () => (await api.get<IntelCompiled>(intelTrackerPaths.compiled(clientId))).data,
    staleTime: 60 * 60_000,
    retry: false,
  });
  const saveWatchlist = useMutation({
    mutationFn: async (value: WatchlistPayload) =>
      trackerV2
        ? adaptWatchlist((await api.put<IntelWatchlist>(intelTrackerPaths.watchlist(clientId), watchlistToIntel(value))).data)
        : (await api.put<WatchlistPayload>(trackerPaths.watchlist(clientId), {
            issueAreas: value.issueAreas,
            tags: value.tags,
          })).data,
    onSuccess: (value) => {
      qc.setQueryData(trackerKeys.watchlist(clientId), value);
      void qc.invalidateQueries({ queryKey: ['lw-vnext', 'watchlist-peek', clientId] });
      void qc.invalidateQueries({ queryKey: trackerKeys.seed(clientId) });
    },
  });
  const savePrefs = useMutation({
    mutationFn: async (value: AlertPrefsPayload) =>
      trackerV2
        ? adaptPrefs((await api.put<IntelAlertPrefs>(intelTrackerPaths.alertPrefs(clientId), prefsToIntel(value))).data)
        : (await api.put<AlertPrefsPayload>(trackerPaths.alertPrefs(clientId), value)).data,
    onSuccess: (value) => qc.setQueryData(trackerKeys.alertPrefs(clientId), value),
  });

  if (watchlist.isError || prefs.isError || issueAreas.isError) {
    return (
      <div role="alert" className="lw-state">
        <p>Configuration could not be loaded. Your existing watchlist and alert preferences have not changed.</p>
        <button type="button" className="lw-btn" onClick={() => { void watchlist.refetch(); void prefs.refetch(); void issueAreas.refetch(); }}>
          Retry configuration
        </button>
      </div>
    );
  }
  if (!watchlist.data || !prefs.data || !issueAreas.data || watchlist.isLoading || prefs.isLoading || issueAreas.isLoading) {
    return <div className="lw-state">Loading configuration…</div>;
  }
  return (
    <TrackerConfigPanel
      allIssueAreas={issueAreas.data.issueAreas ?? []}
      clientName={clientName}
      watchlist={watchlist.data}
      prefs={prefs.data}
      seed={seed.data}
      onSaveWatchlist={(value) => saveWatchlist.mutate(value)}
      onSavePrefs={(value) => savePrefs.mutate(value)}
      onRequestVerify={async (_phone, onVerified) => onVerified()}
      onTestAlert={() => undefined}
      saving={saveWatchlist.isPending}
      termSurfaces={compiled.data?.termSurfaces}
      typedTermsEnabled={trackerV2}
      jurisdictionsEnabled={trackerV2}
      canEditTargeting
    />
  );
}
