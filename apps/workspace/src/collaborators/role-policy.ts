// ============================================================================
// Workspace collaboration role matrix (authoritative).
// ----------------------------------------------------------------------------
// Collaboration is on the WORK PRODUCT (the WsDraft, surfaced in the UI as
// "this document"). The draft owner (WsDraft.ownerId) is the implicit Owner.
// Every other person/email with access is a WsCollaborator row carrying a WsRole.
//
//   owner     — everything + invite + change roles (synthetic; not a row).
//   editor    — edit, hold edit-lock, approve/reject Meri suggestions, resolve
//               comments, export, comment.
//   reviewer  — comment + approve/reject Meri suggestions + resolve comments +
//               export. NO edit, NO lock.
//   commenter — comment + reply only.
//   viewer    — read + export only.
//
// These are PURE predicates over the resolved role; the services call them and
// throw ForbiddenException on a false result. Keeping the matrix in one place
// makes it auditable and impossible to drift between mutations.
// ============================================================================

import type { WsRole } from '../../generated/prisma-client/index.js';

/** The resolved role of an actor on a draft — a WsRole, the synthetic Owner, or
 *  null when the actor has no access at all. */
export type ResolvedRole = 'owner' | WsRole | null;

/** Edit the draft/documents + acquire/take-over the edit-lock. Owner + editor. */
export function canEdit(role: ResolvedRole): boolean {
  return role === 'owner' || role === 'editor';
}

/** Resolve comments + approve/reject Meri suggestions. Owner + editor + reviewer. */
export function canReview(role: ResolvedRole): boolean {
  return role === 'owner' || role === 'editor' || role === 'reviewer';
}

/** Create comments / replies. Any role EXCEPT viewer (and anyone with access). */
export function canComment(role: ResolvedRole): boolean {
  return role === 'owner' || role === 'editor' || role === 'reviewer' || role === 'commenter';
}

/** Read + export. Any role with access (including viewer). */
export function canRead(role: ResolvedRole): boolean {
  return role !== null;
}

/** Invite collaborators + change/remove roles. Owner only. */
export function canManageCollaborators(role: ResolvedRole): boolean {
  return role === 'owner';
}
