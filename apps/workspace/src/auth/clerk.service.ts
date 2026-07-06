// Auth-extraction Option N (DECISIONS D8): ClerkService now lives in
// @capiro/auth (verbatim port of the previously-identical clone). Re-export
// seam. Change-control on auth still applies; edits in packages/auth w/ approval.
export { ClerkService, type ClerkSessionClaims } from '@capiro/auth';
