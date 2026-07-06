// Auth-extraction Option N (DECISIONS D8, approved 2026-07-06): the narrow
// tenant context now lives in @capiro/auth, shared with the orchestrator. This
// re-export seam preserves every existing import path (WorkspaceTenantContext)
// in this service. Change-control on auth still applies — edits happen in
// packages/auth with Neo's approval.
export type { AuthTenantContext as WorkspaceTenantContext } from '@capiro/auth';
