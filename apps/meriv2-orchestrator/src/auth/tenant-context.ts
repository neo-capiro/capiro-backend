// Auth-extraction Option N (DECISIONS D8, approved 2026-07-06): the narrow
// tenant context now lives in @capiro/auth, shared with apps/workspace. This
// file is a re-export seam so every existing import path in this service keeps
// working unchanged. The change-control policy on auth still applies — edits
// happen in packages/auth, with Neo's approval.
export type { AuthTenantContext as OrchestratorTenantContext } from '@capiro/auth';
