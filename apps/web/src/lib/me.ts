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
    // Append-by-default preference + whether a signature exists. The signature
    // HTML itself is loaded on demand via GET /api/me/email-signature.
    emailSignatureEnabled: boolean;
    hasEmailSignature: boolean;
    /** Onboarding v1 (Flow 2B.4): the first-login tour was finished/skipped. */
    tourCompleted: boolean;
    /** LegiWatch orientation was dismissed by this user on any device. */
    legiwatchIntroSeen: boolean;
  };
  tenant: { id: string; slug: string; name: string };
  role: TenantRole;
  /**
   * Billing permission (onboarding v1 "Super Admin"): true for capiro_admin
   * and for user_admins whose membership carries billing_admin. Drives the
   * Billing/AI-usage tab visibility and every purchase/upgrade CTA.
   */
  billingAdmin: boolean;
  /**
   * Per-tenant feature flags the client needs to route/render. `meetingsV2`
   * gates the redesigned Engagement → Meetings module (Day/Month/List, sharing,
   * Library, Documents integration); default false until flipped per tenant.
   */
  features: {
    meetingsV2: boolean;
    /**
     * Async outreach job pipeline (plan W4.4). True only when the global env
     * kill-switch (OUTREACH_ASYNC_GEN / _SEND) is on AND the tenant is canaried in
     * (outreachAsync.enabled). The wizard uses the job-mode UI when true; otherwise
     * it keeps the synchronous generate-batch/send-batch path. Optional so an older
     * cached /me shape degrades to the sync path rather than crashing.
     */
    outreachAsyncGen?: boolean;
    outreachAsyncSend?: boolean;
    /**
     * Engagement Phase 0 trust boundary. When true, outreach drafts are immutable
     * audited versions and real sending goes through durable send intents (version
     * ids only). Optional so an older cached /me degrades to the legacy path
     * rather than crashing.
     */
    versionedOutreach?: boolean;
    /** True when a REAL send requires a PromptSpec v2-or-later draft. */
    externalSendV2Required?: boolean;
    /** New global Meri dock/undock presentation; false keeps the legacy drawer rollback. */
    meriDockUndockUi: boolean;
    /**
     * Strategy Planner (PPBE) module — the Strategies section (library, timeline,
     * editor) served by the api-strategy service. Optional so an older cached /me
     * shape degrades (hidden) rather than crashing. Default false per tenant.
     */
    strategyPlanner?: boolean;
    /** Meri assistant inside the Strategy Planner (draft-from-goal + rail edits); default false. */
    strategyPlannerMeri?: boolean;
    /**
     * Phase-2 agentic Meri surface (context documents, missions, change-sets).
     * env STRATEGY_AGENTS_ENABLED AND per-tenant agenticMeri.enabled — both
     * default OFF. Optional so an older cached /me shape degrades (hidden).
     */
    agenticMeri?: boolean;
    /**
     * Stage E Context Steward extraction (LLM spend). The server's extract
     * route requires contextSteward.enabled ON TOP of agenticMeri
     * (ContextStewardGuard), so the "Extract facts" button gates on BOTH bits.
     * Optional so an older cached /me shape degrades (hidden, never a 403).
     */
    contextSteward?: boolean;
    /**
     * Stage F Strategy Watcher. The server's run-check route requires
     * strategyWatcher.enabled ON TOP of agenticMeri (StrategyWatcherGuard),
     * and the F2 scheduler skips missions quietly for tenants without it —
     * so the Watch rail gates on BOTH bits (a toggle shown on agenticMeri
     * alone would read "Watching" while no check ever runs). Optional so an
     * older cached /me shape degrades (hidden, never a lying toggle).
     */
    strategyWatcher?: boolean;
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
