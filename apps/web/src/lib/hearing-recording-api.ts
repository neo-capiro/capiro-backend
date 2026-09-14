import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from './use-api.js';
import { useApiScope } from './use-api-scope.js';

export interface RecordingEpoch {
  id: string;
  startMs: number;
  durableEndMs: number;
  durableSequence: number;
  durableBytes: number;
  state: string;
  complete: boolean;
  reason: string | null;
  decodedDurationMs: number | null;
  playable: boolean;
}
export interface RecordingManifest {
  recordingPolicy: string;
  recording: null | {
    id: string;
    state: string;
    playbackAvailability?: 'available' | 'expired' | 'permission_unavailable';
    originAt: string;
    expiresAt: string;
    transcriptState: string;
    analysisState: string;
    epochs: RecordingEpoch[];
  };
}

export function recordingLoadError(error: unknown) {
  const response = (error as { response?: { status?: number; data?: { code?: string } } })
    ?.response;
  if (response?.status === 401)
    return 'Your session has expired. Sign in again, then retry recording status.';
  if (response?.data?.code === 'RECORDING_ACCESS_UNAVAILABLE')
    return 'Saved-audio access is unavailable. Ask a tenant administrator to check your active membership and saved-audio access, then retry.';
  if (response?.status === 403 || response?.status === 404)
    return 'Recording access is unavailable for this account. Check your current workspace and ask a tenant administrator to review access, then retry.';
  return 'Recording status could not be loaded. Retry to check saved audio; its coverage is not yet known.';
}

export function useHearingRecording(sessionId: string, live: boolean) {
  const api = useApi(),
    scope = useApiScope(),
    qc = useQueryClient();
  const key = ['intel', 'hearing-recording', scope, sessionId];
  const manifest = useQuery({
    queryKey: key,
    queryFn: async () =>
      (
        await api.get<RecordingManifest>(
          `/intel-api/hearings/${encodeURIComponent(sessionId)}/recording`,
        )
      ).data,
    enabled: Boolean(sessionId),
    retry: false,
    refetchInterval: live ? 3000 : 15_000,
  });
  const capability = useQuery({
    queryKey: [...key, 'capability'],
    queryFn: async () =>
      (
        await api.get<{ available: boolean; retentionDays: number | null; reason: string | null }>(
          `/intel-api/hearings/${encodeURIComponent(sessionId)}/recording/capability`,
        )
      ).data,
    enabled: Boolean(sessionId),
    retry: false,
  });
  const enable = useMutation({
    mutationFn: () =>
      api.post(`/intel-api/hearings/${encodeURIComponent(sessionId)}/recording/enable`, {}),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: key });
      await qc.invalidateQueries({ queryKey: ['intel', 'hearing', sessionId] });
    },
  });
  return { manifest, capability, enable, scope };
}

export function recordingSeek(epochs: RecordingEpoch[], time: number) {
  if (!Number.isFinite(time) || time < 0) return null;
  return (
    epochs.find(
      (epoch) =>
        epoch.playable &&
        epoch.decodedDurationMs != null &&
        time >= epoch.startMs &&
        time < Math.min(epoch.durableEndMs, epoch.startMs + epoch.decodedDurationMs),
    ) ?? null
  );
}
