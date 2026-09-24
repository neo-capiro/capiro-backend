import { useQuery } from '@tanstack/react-query';
import type { TenantRole } from '@capiro/shared';
import { useApi } from './use-api.js';

export interface MeResponse {
  user: {
    id: string;
    clerkUserId: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    title: string | null;
    emailSignatureEnabled: boolean;
    hasEmailSignature: boolean;
    tourCompleted: boolean;
    legiwatchIntroSeen: boolean;
    /** PR D / LW-QA-013 — per-user LegiWatch display preferences (JSON doc). */
    legiwatchPrefs?: Record<string, unknown> | null;
  };
  tenant: { id: string; slug: string; name: string };
  role: TenantRole;
  billingAdmin: boolean;
  features: {
    meetingsV2: boolean;
    outreachAsyncGen?: boolean;
    outreachAsyncSend?: boolean;
    versionedOutreach?: boolean;
    externalSendV2Required?: boolean;
    /** New global Meri dock/undock presentation; false keeps the legacy drawer rollback. */
    meriDockUndockUi: boolean;
    /**
     * OpenAI Responses reasoning canary. When true the chat stream is served by
     * MeriV3 and the launcher opens the full workspace in a real browser window.
     * Optional so an older cached /me shape fails back to MeriV2.
     */
    meriv3Chat?: boolean;
    strategyPlanner?: boolean;
    strategyPlannerMeri?: boolean;
    agenticMeri?: boolean;
    contextSteward?: boolean;
    strategyWatcher?: boolean;
    /**
     * Engagement vNext tenant access gate (dogfood canary, capiro-internal
     * only for now — see tenant-flags.ts's engagementVNextEnabled). REAL
     * route gating, not the nav-visibility-only `meFeature` mechanism in
     * routeManifest.ts: VNextRouter reads this to decide whether it renders
     * VNextEngagementRoutes at all. Optional so an older cached /me shape
     * (or a still-loading query) fails back to the canonical EngagementPage.
     */
    engagementVNext?: boolean;
    /**
     * Business Development Phase 1 pipeline (Portfolio → Business Development).
     * Optional so an older cached /me shape (or a still-loading query) fails
     * closed: the entry, the page and its queries only render when this is
     * exactly true. The API independently guards every route server-side.
     */
    businessDevelopment?: boolean;
  };
}

export function useMe() {
  const api = useApi();
  return useQuery<MeResponse>({
    queryKey: ['me'],
    queryFn: async () => (await api.get<MeResponse>('/api/me')).data,
    staleTime: 30_000,
    retry: false,
  });
}
