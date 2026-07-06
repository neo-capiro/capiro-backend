// Auth-extraction Option N (DECISIONS D8): TenantGuard now lives in
// @capiro/auth (verbatim port of the previously-identical clone that lived
// here). Re-export seam — existing import paths keep working. Change-control
// on auth still applies; edits happen in packages/auth with Neo's approval.
export { TenantGuard } from '@capiro/auth';
