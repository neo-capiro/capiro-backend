/** Current collaboration replies, never access grants, write recovery or mail-delivery proof. */
import {
  array,
  bool,
  literal,
  nullable,
  object,
  receive,
  refuse,
  row,
  snapshot,
  text,
  timestamp,
  workspaceUuid,
  type Json,
  type ReceiveResult,
  type Rule,
} from './json-receiving.js';
import type { NewsletterReview } from './newsletter-receiving.js';

export type NewsletterReviewRole = NewsletterReview['role'];
export type NewsletterNotificationMode = 'all' | 'mentions' | 'none';
export interface NewsletterReviewer {
  userId: string;
  name: string;
  email: string;
  role: NewsletterReviewRole;
  notifications: NewsletterNotificationMode;
}
export interface NewsletterPendingInvitation {
  id: string;
  email: string;
  role: Exclude<NewsletterReviewRole, 'owner'>;
  accountRole: 'member' | 'admin';
  message: string;
  expiresAt: string;
}
/** Loaded team and pending requests. No document ID or completeness receipt is echoed. */
export interface NewsletterReviewerTeam {
  role: NewsletterReviewRole;
  currentUserId: string;
  items: NewsletterReviewer[];
  available: Array<{ clerkUserId: string; name: string; email: string }>;
  pending: NewsletterPendingInvitation[];
  invitationEmailAvailable: boolean;
  canInviteAccounts: boolean;
}
export interface NewsletterInvitationResult extends NewsletterReviewerTeam {
  invitation: { id: string; email: string; status: 'pending' | 'ready' | 'cancelled' };
}
/** A requested reply may resolve to a different root; availability is not delivery. */
export interface NewsletterThreadNotifications {
  rootId: string | null;
  userIds: string[];
  items: Array<Pick<NewsletterReviewer, 'userId' | 'name' | 'email'>>;
  editable: boolean;
  emailAvailable: boolean;
}
export type NewsletterAccountInvitationStatus =
  | 'checking'
  | 'sending'
  | 'invited'
  | 'reused'
  | 'member_ready'
  | 'role_conflict'
  | 'admin_required'
  | 'waiting'
  | 'expired'
  | 'revoked'
  | 'cancelled'
  | 'failed'
  | 'outcome_unknown';
/** Main's firm-account request, distinct from newsletter access and SES delivery. */
export interface NewsletterAccountInvitationReceipt {
  id: string;
  status: NewsletterAccountInvitationStatus;
  accountRole: NewsletterPendingInvitation['accountRole'];
  message: string;
  canRetry: boolean;
}

// Compose the existing JSON rules; unknown fields must not smuggle capability/receipt claims.
function exact(fields: Record<string, Rule>): Rule {
  return (value, path) => {
    object(fields)(value, path);
    for (const key of Object.keys(row(value, path)))
      if (!Object.prototype.hasOwnProperty.call(fields, key)) refuse(`${path}.${key}`);
  };
}
const boundedText =
  (max: number): Rule =>
  (value, path) => {
    text(value, path);
    if ((value as string).length > max) refuse(path, 'limit_exceeded');
  };
const userId: Rule = (value, path) => {
  boundedText(200)(value, path);
  if (!(value as string).trim()) refuse(path);
};
const access = literal('viewer', 'commenter', 'editor');
const role = literal('owner', 'viewer', 'commenter', 'editor');
const accountRole = literal('member', 'admin');
const person = { userId, name: text, email: text };
const teamFields = {
  role,
  currentUserId: userId,
  // The member lookup takes 500; its synthetic owner may be outside that page.
  items: array(exact({ ...person, role, notifications: literal('all', 'mentions', 'none') }), 501),
  available: array(exact({ clerkUserId: userId, name: text, email: text }), 500),
  pending: array(
    exact({
      id: workspaceUuid,
      email: boundedText(320),
      role: access,
      accountRole,
      message: boundedText(2000),
      expiresAt: timestamp,
    }),
    50,
  ),
  invitationEmailAvailable: bool,
  canInviteAccounts: bool,
};
function bindActor(value: Json, expected: unknown, fields: Record<string, Rule>) {
  const binding = row(snapshot(expected), '$expected');
  exact(fields)(binding, '$expected');
  if (row(value, '$').currentUserId !== binding.currentUserId)
    refuse('$.currentUserId', 'identity_mismatch');
  return binding;
}

/** Bind the echoed actor; the caller still owns the un-echoed document/scope lifetime. */
export function parseNewsletterReviewerTeam(
  value: unknown,
  expected: { currentUserId: string },
): ReceiveResult<NewsletterReviewerTeam> {
  return receive(value, exact(teamFields), (value) => {
    bindActor(value, expected, { currentUserId: userId });
  });
}
/** The new invitation ID is server-produced. No request-key echo or delivery result exists. */
export function parseNewsletterInvitationResult(
  value: unknown,
  expected: { currentUserId: string; email: string },
): ReceiveResult<NewsletterInvitationResult> {
  return receive(
    value,
    exact({
      ...teamFields,
      invitation: exact({
        id: workspaceUuid,
        email: boundedText(320),
        status: literal('pending', 'ready', 'cancelled'),
      }),
    }),
    (value) => {
      const binding = bindActor(value, expected, {
        currentUserId: userId,
        email: boundedText(320),
      });
      // Matches inviteByEmail's normalization of the original submitted address.
      if (
        row(row(value, '$').invitation!, '$.invitation').email !==
        (binding.email as string).trim().toLowerCase()
      )
        refuse('$.invitation.email', 'identity_mismatch');
    },
  );
}
/** No document/actor echo: a parsed choice list cannot establish current access. */
export function parseNewsletterThreadNotifications(
  value: unknown,
): ReceiveResult<NewsletterThreadNotifications> {
  return receive(
    value,
    exact({
      rootId: nullable(workspaceUuid),
      userIds: array(userId, 100),
      items: array(exact(person), 501),
      editable: bool,
      emailAvailable: bool,
    }),
  );
}
/** canRetry is the server's value, never inferred from the status alone. */
export function parseNewsletterAccountInvitationReceipt(
  value: unknown,
  expected: { invitationId: string },
): ReceiveResult<NewsletterAccountInvitationReceipt> {
  return receive(
    value,
    exact({
      id: workspaceUuid,
      status: literal(
        'checking',
        'sending',
        'invited',
        'reused',
        'member_ready',
        'role_conflict',
        'admin_required',
        'waiting',
        'expired',
        'revoked',
        'cancelled',
        'failed',
        'outcome_unknown',
      ),
      accountRole,
      message: text,
      canRetry: bool,
    }),
    (value) => {
      const binding = row(snapshot(expected), '$expected');
      exact({ invitationId: workspaceUuid })(binding, '$expected');
      if (
        (row(value, '$').id as string).toLowerCase() !==
        (binding.invitationId as string).toLowerCase()
      )
        refuse('$.id', 'identity_mismatch');
    },
  );
}
