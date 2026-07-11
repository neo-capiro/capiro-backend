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
 * (NOTETAKER_ENABLED) and defaulting OFF per-tenant, so the feature stays dormant
 * until a human flips BOTH the env switch and the per-tenant flag. The
 * belt-and-suspenders gate is deliberate — this drives an external media
 * processor (Recall) that records third parties, so it must not go live by
 * accident. Per-tenant canary flip is via SQL UPDATE on tenants.settings_jsonb
 * (same path used for the MeriV2 flips) until an admin surface is added.
 */
export const NOTETAKER_FLAG = 'notetaker.enabled' as const;

/** Global env kill-switch for the notetaker. Default OFF — only the literal 'true' enables. */
export function notetakerEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NOTETAKER_ENABLED === 'true';
}

/**
 * The notetaker is active for a tenant only when the env kill-switch is on AND
 * the per-tenant `notetaker.enabled` flag resolves true (tenant default false).
 * Either side OFF → the feature is dormant.
 */
export function notetakerEnabled(settings: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return notetakerEnvEnabled(env) && tenantFeatureEnabled(settings, NOTETAKER_FLAG, false);
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
