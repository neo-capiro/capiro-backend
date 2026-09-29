import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { useApi } from '../../../../lib/use-api.js';
import { useImpersonation } from '../../../../state/impersonation.js';

/** Match the API client's tenant context and the server's private-session owner. */
export function useHearingQueryIdentity() {
  let orgId: string | null = null;
  let userId: string | null = null;
  let isLoaded = false;
  try {
    const auth = useAuth();
    orgId = auth.orgId ?? null;
    userId = auth.userId ?? null;
    isLoaded = Boolean(auth.isLoaded);
  } catch {
    // Pre-auth shells use the anonymous cache partition until Clerk mounts.
  }
  const { actAsTenantSlug } = useImpersonation();
  const ready = Boolean(isLoaded && userId);
  // Distinct tuple fields avoid a tenant slug colliding with an organization ID.
  // Pending/signed-out auth must not reuse the previous signed-in cache entry.
  const identity = ready ? JSON.stringify([orgId ?? null, actAsTenantSlug, userId]) : null;
  return { identity, ready };
}

/** Tenant-visible metadata only. Transcript bodies stay in the recording room. */
export interface SavedHearingSession {
  id: string;
  title: string;
  status: string;
  transcriptSegmentCount: number;
  intelligenceMomentCount: number;
  recordingPath: string;
  association: 'hearing_id' | 'official_source';
  sourceUrl: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface SavedHearingSessionsResponse {
  hearingId: string;
  savedSessionsState: 'available' | 'unavailable';
  sessions: SavedHearingSession[];
}

export function savedHearingSessionPath(id: string): string {
  return `/intelligence/hearing-watch/${encodeURIComponent(id)}`;
}

export function useSavedHearingSessions(hearingId: string) {
  const api = useApi();
  const { identity, ready } = useHearingQueryIdentity();
  return useQuery<SavedHearingSessionsResponse, Error>({
    queryKey: ['lw-w1', 'saved-hearing-sessions', hearingId, identity],
    queryFn: async ({ signal }) => {
      if (!ready) throw new Error('Sign in to check saved hearing sessions.');
      const { data } = await api.get<SavedHearingSessionsResponse>(
        `/api/legiwatch/live-hearings/events/${encodeURIComponent(hearingId)}/sessions`,
        { signal },
      );
      // An older/malformed response is not evidence that no saved session exists.
      if (data?.hearingId !== hearingId || !Array.isArray(data.sessions) ||
          !['available', 'unavailable'].includes(data.savedSessionsState)) {
        throw new Error('Saved hearing sessions could not be verified.');
      }
      return data;
    },
    enabled: Boolean(hearingId) && ready,
    retry: false,
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
}
