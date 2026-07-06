// Auth-extraction Option N (DECISIONS D8): ClerkService now lives in
// @capiro/auth (verbatim port of the previously-identical clone that lived
// here). Re-export seam — existing import paths keep working. Change-control
// on auth still applies; edits happen in packages/auth with Neo's approval.
export { ClerkService, type ClerkSessionClaims } from '@capiro/auth';
