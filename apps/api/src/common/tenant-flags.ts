/**
 * Per-tenant Meri feature flags (assistant-parity cross-cutting convention).
 *
 * Flags live under tenants.settings_jsonb.clioFeatureFlags, e.g.
 *   { "clioFeatureFlags": { "runAnalysis": true } }
 * and compose with env kill-switches: a feature is active only when its env
 * switch is on AND the tenant flag resolves true (each feature picks its own
 * tenant default — pilot features default false, GA features default true).
 * Pure so it unit-tests under `src/**.spec.ts`.
 */

import {
  resolveEntitlements,
  ENTITLEMENT_FEATURES,
  ALWAYS_ENTITLED,
  type EntitlementFeature,
} from '@capiro/shared';

export function tenantFeatureEnabled(
  settings: unknown,
  flag: string,
  defaultValue: boolean,
): boolean {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const flags = (settings as Record<string, unknown>).clioFeatureFlags;
    if (flags && typeof flags === 'object' && !Array.isArray(flags)) {
      const value = (flags as Record<string, unknown>)[flag];
      if (typeof value === 'boolean') return value;
    }
  }
  return defaultValue;
}

/**
 * MeriV2 surface flags (Phase 0). Govern whether an existing surface PROXIES to
 * the meriv2-orchestrator instead of running its in-process path. Both default
 * OFF and are ANDed with the global MERIV2_ENABLED env kill-switch, so MeriV2
 * stays dormant until a human flips BOTH the env switch and a per-tenant flag
 * (the < 5s rollback in SC0.4 is flipping either back off).
 */
export const MERIV2_FLAGS = {
  inEditorAssistant: 'meriv2.inEditorAssistant',
  workspaceGen: 'meriv2.workspaceGen',
  // C4: the full Meri chat surface. When ON (and MERIV2_ENABLED), apps/api's
  // chat route proxies to the orchestrator's /meri-api/chat loop instead of
  // running the in-process MeriService path.
  fullChat: 'meriv2.fullChat',
} as const;

export type MeriV2FlagKey = (typeof MERIV2_FLAGS)[keyof typeof MERIV2_FLAGS];

/** Global env kill-switch for MeriV2. Default OFF — only the literal 'true' enables. */
export function meriV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MERIV2_ENABLED === 'true';
}

/**
 * A MeriV2 surface flag is active when the env kill-switch is on AND the
 * per-tenant flag resolves true. GA (2026-07): the tenant flag defaults ON, so
 * a tenant without an explicit flag is on MeriV2 whenever MERIV2_ENABLED is set
 * — opt out with an explicit `false`. MERIV2_ENABLED off → dormant everywhere.
 */
export function meriV2FlagEnabled(
  settings: unknown,
  flag: MeriV2FlagKey,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return meriV2Enabled(env) && tenantFeatureEnabled(settings, flag, true);
}

/**
 * Meeting Notetaker (docs/plans/meeting-notetaker-bot-plan.md). Governs whether a
 * tenant's users can dispatch the Recall.ai bot to join/transcribe meetings.
 * Modeled on the MeriV2 surface flags: ANDed with a global env kill-switch
 * (NOTETAKER_ENABLED). Ran as an opt-in canary (capiro-internal only) through
 * 2026-07-13; promoted to GA that day (Ninja's call, made with the item-F
 * compliance gap — DPA/subprocessor listing/consent-copy legal review/trial-tier
 * upgrade — still open) so the tenant default flips true, same GA shape as
 * meriV2FlagEnabled above. A tenant can still be carved OUT by writing an
 * explicit `false` into its settings_jsonb (same SQL UPDATE path used for the
 * original canary flip) — the per-tenant flag is now an opt-out, not an opt-in.
 */
export const NOTETAKER_FLAG = 'notetaker.enabled' as const;

/** Global env kill-switch for the notetaker. Default OFF — only the literal 'true' enables. */
export function notetakerEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NOTETAKER_ENABLED === 'true';
}

/**
 * The notetaker is active for a tenant when the env kill-switch is on AND the
 * per-tenant `notetaker.enabled` flag does not resolve false (tenant default
 * true — GA). Either the env switch off, or an explicit per-tenant `false`,
 * keeps it dormant.
 */
export function notetakerEnabled(settings: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return notetakerEnvEnabled(env) && tenantFeatureEnabled(settings, NOTETAKER_FLAG, true);
}

/**
 * Meetings & Meri redesign (docs/plans/2026-07-10-meetings-meri-v2-redesign-plan.md).
 * Gates the rebuilt Engagement → Meetings module (Day/Month/List, private-until-
 * shared sharing, Meeting Library, Documents integration) so it can be flipped on
 * per tenant after parity verification instead of a big-bang cutover.
 *
 * UNLIKE the notetaker / MeriV2 flags, this is a PURE presentation swap — it drives
 * no external processor and carries no consent/compliance risk — so it deliberately
 * has NO env kill-switch (adding one would mean a config-schema + task-def env change,
 * which we avoid given the known CDK↔task-def drift). A per-tenant flag alone is the
 * right lever: default OFF, flipped via the capiro-admin flag surface (the same
 * settings_jsonb.clioFeatureFlags path used for every other rollout). Surfaced to
 * the web via GET /me so the client can route to the new module.
 */
export const MEETINGS_V2_FLAG = 'meetingsV2.enabled' as const;

/** Whether a tenant is on the redesigned Meetings module (per-tenant, default OFF). */
export function meetingsV2Enabled(settings: unknown): boolean {
  return tenantFeatureEnabled(settings, MEETINGS_V2_FLAG, false);
}

export const MERI_DOCK_UNDOCK_UI_FLAG = 'meriDockUndockUi.enabled' as const;

/** Whether a tenant receives the new global Meri dock/undock presentation (default OFF). */
export function meriDockUndockUiEnabled(settings: unknown): boolean {
  return tenantFeatureEnabled(settings, MERI_DOCK_UNDOCK_UI_FLAG, false);
}

/**
 * Strategy Planner (PPBE) module (docs Strategy Planner Phase 1 plan). Gates the
 * new Strategies section (library, timeline, editor) served by the standalone
 * api-strategy service at /strategy-api/*. Like meetingsV2, this is a PURE
 * presentation/feature flag with NO env kill-switch — default OFF, flipped per
 * tenant via the settings_jsonb.clioFeatureFlags path, surfaced to the web via
 * GET /me. The api-strategy service enforces the same flag server-side.
 */
export const STRATEGY_PLANNER_FLAG = 'strategyPlanner.enabled' as const;

/** Whether a tenant is on the Strategy Planner module (per-tenant, default OFF). */
export function strategyPlannerEnabled(settings: unknown): boolean {
  return tenantFeatureEnabled(settings, STRATEGY_PLANNER_FLAG, false);
}

/**
 * Gates Meri inside the Strategy Planner (draft-from-goal + rail assistant +
 * reference-editor assist; G5). UNLIKE the surface flag, this is ANDed with a
 * global env kill-switch STRATEGY_MERI_ENABLED (mirrors MERIV2_ENABLED /
 * meriV2Enabled) so LLM creation stays dormant until BOTH the env switch is on
 * AND the per-tenant flag resolves true — the <5s rollback is flipping either
 * back off. Per-tenant flag default OFF (pilot).
 */
export const STRATEGY_PLANNER_MERI_FLAG = 'strategyPlannerMeri.enabled' as const;

/** The per-tenant Meri flag alone (no env AND) — used where only the tenant opt-in matters. */
export function strategyPlannerMeriEnabled(settings: unknown): boolean {
  return tenantFeatureEnabled(settings, STRATEGY_PLANNER_MERI_FLAG, false);
}

/** Global env kill-switch for Strategy-Planner Meri. Default OFF — only the literal 'true' enables. */
export function strategyMeriEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STRATEGY_MERI_ENABLED === 'true';
}

/**
 * Strategy-Planner Meri is active for a tenant only when the env kill-switch is
 * on AND the per-tenant flag resolves true (both default OFF). This is the
 * value surfaced to the web (GET /me) and mirrored server-side by api-strategy.
 */
export function strategyMeriActive(settings: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return strategyMeriEnvEnabled(env) && strategyPlannerMeriEnabled(settings);
}

/**
 * Gates agentic Meri inside the Strategy Planner (Phase 2 agentic phases).
 * Mirrors the strategyPlannerMeri quartet: ANDed with a global env kill-switch
 * STRATEGY_AGENTS_ENABLED so the agentic surface stays dormant until BOTH the
 * env switch is on AND the per-tenant flag resolves true — the <5s rollback is
 * flipping either back off. Per-tenant flag default OFF (pilot). The
 * api-strategy service enforces the same pair server-side
 * (StrategyFlagsService.isAgenticFlagEnabled / AgenticGuard).
 */
export const AGENTIC_MERI_FLAG = 'agenticMeri.enabled' as const;

/** The per-tenant agentic-Meri flag alone (no env AND) — used where only the tenant opt-in matters. */
export function agenticMeriEnabled(settings: unknown): boolean {
  return tenantFeatureEnabled(settings, AGENTIC_MERI_FLAG, false);
}

/** Global env kill-switch for Strategy-Planner agentic Meri. Default OFF — only the literal 'true' enables. */
export function strategyAgentsEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STRATEGY_AGENTS_ENABLED === 'true';
}

/**
 * Agentic Meri is active for a tenant only when the env kill-switch is on AND
 * the per-tenant flag resolves true (both default OFF). This is the value
 * surfaced to the web (GET /me) and mirrored server-side by api-strategy.
 */
export function agenticMeriActive(settings: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return strategyAgentsEnvEnabled(env) && agenticMeriEnabled(settings);
}

/**
 * Context Steward fact extraction (Stage E) — the LLM-spend extract route is
 * gated server-side by api-strategy's ContextStewardGuard on
 * (STRATEGY_AGENTS_ENABLED env AND per-tenant contextSteward.enabled), ON TOP
 * of the agenticMeri umbrella. This mirrors that pair so GET /me can surface a
 * `contextSteward` feature bit the web uses to gate the "Extract facts" button
 * (without it, agenticMeri-only tenants see a button that 403s on every click).
 */
export const CONTEXT_STEWARD_FLAG = 'contextSteward.enabled' as const;

/** The per-tenant Context Steward flag alone (no env AND) — default OFF. */
export function contextStewardEnabled(settings: unknown): boolean {
  return tenantFeatureEnabled(settings, CONTEXT_STEWARD_FLAG, false);
}

/**
 * The Context Steward is active for a tenant only when the agentic env
 * kill-switch is on AND the per-tenant flag resolves true (both default OFF).
 * Surfaced to the web (GET /me); api-strategy enforces the same pair
 * server-side (ContextStewardGuard via isAgenticFlagEnabled).
 */
export function contextStewardActive(settings: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return strategyAgentsEnvEnabled(env) && contextStewardEnabled(settings);
}

/**
 * Strategy Watcher (Stage F) — the Watch-mode surface is gated server-side by
 * api-strategy on (STRATEGY_AGENTS_ENABLED env AND per-tenant
 * strategyWatcher.enabled), ON TOP of the agenticMeri umbrella:
 * StrategyWatcherGuard on the run-check route and a per-occurrence flag check
 * in the F2 scheduler. This mirrors that pair so GET /me can surface a
 * `strategyWatcher` feature bit the web uses to gate the Watch rail — without
 * it, agenticMeri-only tenants get a Watch toggle whose scheduled checks skip
 * quietly forever and a "Run check now" button that 403s on every click (the
 * exact lying-UI pattern the Stage E contextSteward bit exists to prevent).
 */
export const STRATEGY_WATCHER_FLAG = 'strategyWatcher.enabled' as const;

/** The per-tenant Strategy Watcher flag alone (no env AND) — default OFF. */
export function strategyWatcherEnabled(settings: unknown): boolean {
  return tenantFeatureEnabled(settings, STRATEGY_WATCHER_FLAG, false);
}

/**
 * The Strategy Watcher is active for a tenant only when the agentic env
 * kill-switch is on AND the per-tenant flag resolves true (both default OFF).
 * Surfaced to the web (GET /me); api-strategy enforces the same pair
 * server-side (StrategyWatcherGuard + the scheduler's per-occurrence check).
 */
export function strategyWatcherActive(settings: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return strategyAgentsEnvEnabled(env) && strategyWatcherEnabled(settings);
}

/**
 * Meri proactive-alert importance floor (2026-07-12). The Meri chat bell + the
 * "🔔 Scheduled briefings" banner are both fed by MeriService.listAlerts, which
 * historically returned EVERY pending clio_proactive_alert with no importance
 * floor — so routine "client quiet 30+ days" notices (priority 'normal') sat
 * next to time-sensitive "meeting in <48h, no prep" items (priority 'high'),
 * which read as noise. When this flag is ON (the DEFAULT), listAlerts surfaces
 * only the high-importance priority band — the exact set MeriInboxBanner's
 * priorityClass already renders as the red "critical" style, so nothing that
 * showed red disappears and nothing that showed 'notable'/'info' survives.
 * Reversible per tenant to `false` for the old verbose behavior. This is a pure
 * READ filter: no env kill-switch, no emitter change — the alerts are still
 * written, just not shown, so flipping the flag off restores them instantly.
 */
export const MERI_ALERTS_IMPORTANT_ONLY_FLAG = 'meriAlertsImportantOnly' as const;

/**
 * The priorities that count as "important" for the Meri alert inbox. Kept in
 * one place and mirrors MeriInboxBanner.priorityClass's red "critical" band
 * (high | critical | urgent) so the API floor and the UI styling never drift.
 */
export const MERI_ALERT_IMPORTANT_PRIORITIES = ['high', 'critical', 'urgent'] as const;

/** Whether a tenant's Meri alert inbox is filtered to important priorities (default ON). */
export function meriAlertsImportantOnly(settings: unknown): boolean {
  return tenantFeatureEnabled(settings, MERI_ALERTS_IMPORTANT_ONLY_FLAG, true);
}

/**
 * Meetings v2 Phase 2 — cross-user collision model (docs/plans/2026-07-11-…).
 * When ON, the client "Shared from meetings" feed groups per-mailbox rows that
 * share a Graph `iCalUId` into ONE record (canonical notes, one row per meeting,
 * a contributor expander for colleagues with their own prep/debrief — spec §7)
 * and merges multi-user notetakers (§4.4). Purely a response-layer grouping;
 * default OFF, flipped per tenant AFTER the meetingsV2 UI is verified. Separate
 * flag from meetingsV2 so it rolls out independently, and rollback = flip off
 * (Option B is non-destructive — nothing to un-merge).
 */
export const MEETINGS_CROSS_USER_FLAG = 'meetingsCrossUser.enabled' as const;

/** Whether a tenant is on the Phase 2 cross-user collision grouping (default OFF). */
export function meetingsCrossUserEnabled(settings: unknown): boolean {
  return tenantFeatureEnabled(settings, MEETINGS_CROSS_USER_FLAG, false);
}

/**
 * Async outreach pipeline UI rollout (plan W4.4). The async job pipeline itself is
 * gated by GLOBAL env kill-switches (OUTREACH_ASYNC_GEN / OUTREACH_ASYNC_SEND); this
 * per-tenant flag is the CANARY lever on top — the wizard uses the job-mode UI for a
 * tenant only when BOTH the env switch is on AND this flag resolves true. Default OFF
 * so flipping the env var alone never changes any tenant's UX until it is explicitly
 * canaried, mirroring the notetaker (env AND per-tenant) belt-and-suspenders. Flipped
 * per tenant via settings_jsonb.clioFeatureFlags (the standard rollout path). Surfaced
 * to the web (ANDed with the env switch) via GET /me `features.outreachAsyncGen/Send`.
 */
export const OUTREACH_ASYNC_FLAG = 'outreachAsync.enabled' as const;

/** Per-tenant async-outreach opt-in (default OFF). ANDed with the env kill-switch by
 *  the caller (GET /me) — this alone does not enable anything. */
export function outreachAsyncFlagEnabled(settings: unknown): boolean {
  return tenantFeatureEnabled(settings, OUTREACH_ASYNC_FLAG, false);
}

/**
 * Rich client-profile outreach context (2026-07-11). When ON, campaign drafts get
 * extra recipient-INVARIANT profile blocks in the cached v2 prefix — the "people
 * this client works with" roster (client_people), the coordinated target-office
 * map (ClientTarget ∪ OfficeRecommendation), and canonical status for the client's
 * OWN tracked bills. Like meetingsV2 this is a PURE context/presentation change
 * (no external processor, no compliance risk, additive SUPPORTING INTELLIGENCE),
 * so it deliberately has NO env kill-switch (avoids a config-schema + task-def env
 * change and the known CDK↔task-def drift). Per-tenant flag alone, default OFF,
 * flipped via settings_jsonb.clioFeatureFlags (the standard rollout path).
 */
export const OUTREACH_CLIENT_PROFILE_FLAG = 'outreachClientProfile.enabled' as const;

/** Whether a tenant gets the rich client-profile context blocks (default OFF). */
export function outreachClientProfileEnabled(settings: unknown): boolean {
  return tenantFeatureEnabled(settings, OUTREACH_CLIENT_PROFILE_FLAG, false);
}

/**
 * Effective feature entitlements for a tenant (Phase 5, §5.1). The tier map
 * (resolveEntitlements) sets the baseline; a per-tenant boolean override at
 * settings_jsonb.clioFeatureFlags['entitlement.<feature>'] can flip a single
 * feature on/off — reusing the SAME boolean reader as every rollout flag
 * (SC 5.1.3, no parallel mechanism). Default per feature = the tier grant, so
 * with today's all-granting tiers this returns every feature true (no-op).
 */
export function entitlementsForTenant(
  settings: unknown,
  planTier: string | null | undefined,
): Record<EntitlementFeature, boolean> {
  const base = resolveEntitlements(planTier);
  const out = {} as Record<EntitlementFeature, boolean>;
  for (const f of ENTITLEMENT_FEATURES) {
    // ALWAYS_ENTITLED features (core memory governance, SC 5.1.4) are never
    // gated — a per-tenant override cannot revoke them, mirroring how
    // resolveEntitlements re-unions them after the tier lookup.
    out[f] = ALWAYS_ENTITLED.includes(f)
      ? true
      : tenantFeatureEnabled(settings, `entitlement.${f}`, base.has(f));
  }
  return out;
}
