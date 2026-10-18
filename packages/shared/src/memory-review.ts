/**
 * Browser-safe wire contracts for the existing Core memory-review inbox and
 * candidate decision routes. These parsers validate wire shapes only. Core
 * remains the owner of membership, client visibility, grants and capabilities.
 *
 * Sources: MemoryReviewInboxService and MemoryReviewController in apps/api.
 */

export const MEMORY_REVIEW_INBOX_VIEWS = [
  'needs_my_review',
  'submitted_by_me',
  'all_pending',
  'blocked',
  'history',
] as const;
export type MemoryReviewInboxView = (typeof MEMORY_REVIEW_INBOX_VIEWS)[number];

export const MEMORY_REVIEW_STATUSES = [
  'pending',
  'changes_requested',
  'approved',
  'rejected',
  'withdrawn',
  'superseded',
] as const;
export type MemoryReviewStatus = (typeof MEMORY_REVIEW_STATUSES)[number];

export const MEMORY_REVIEW_INBOX_CANDIDATE_KINDS = [
  'standard',
  'correction',
  'restore',
  'contradiction',
] as const;
export const MEMORY_REVIEW_CANDIDATE_KINDS = [
  ...MEMORY_REVIEW_INBOX_CANDIDATE_KINDS,
  'learning_signal_conflict',
] as const;
export type MemoryReviewCandidateKind = (typeof MEMORY_REVIEW_CANDIDATE_KINDS)[number];
export type MemoryReviewInboxCandidateKind = (typeof MEMORY_REVIEW_INBOX_CANDIDATE_KINDS)[number];

/** The existing TenantRole values eligibleReviewers may return. */
export const MEMORY_REVIEW_ELIGIBLE_ROLES = [
  'capiro_admin', 'user_admin', 'standard_user', 'client_portal_user',
] as const;
export type MemoryReviewEligibleRole = (typeof MEMORY_REVIEW_ELIGIBLE_ROLES)[number];

export type MemoryReviewBlockedReason =
  | 'no_reviewer'
  | 'reviewer_unavailable'
  | 'archived_client'
  | null;
export type MemoryReviewNextAction =
  | 'review'
  | 'revise'
  | 'await_reviewer'
  | 'assign_reviewer'
  | 'none';

export interface MemoryReviewIdentity {
  userId: string;
  name: string;
}

export interface MemoryReviewCapabilities {
  open: boolean;
  approve: boolean;
  reject: boolean;
  requestChanges: boolean;
  revise: boolean;
  reassign: boolean;
  withdraw: boolean;
}

export interface MemoryReviewInboxItem {
  candidateId: string;
  reviewRequestId: string;
  candidateKind: MemoryReviewInboxCandidateKind;
  scope: 'firm' | 'client';
  client: { id: string; name: string; status: string | null } | null;
  title: string;
  status: MemoryReviewStatus;
  revisionNumber: number;
  rootCandidateId: string;
  predecessorCandidateId: string | null;
  submittedBy: MemoryReviewIdentity;
  assignedReviewer: MemoryReviewIdentity | null;
  decidedBy: MemoryReviewIdentity | null;
  createdAt: string;
  decidedAt: string | null;
  blockedReason: MemoryReviewBlockedReason;
  nextAction: MemoryReviewNextAction;
  capabilities: MemoryReviewCapabilities;
}

export interface MemoryReviewInboxPage {
  enabled: boolean;
  view: MemoryReviewInboxView;
  items: MemoryReviewInboxItem[];
  nextCursor: string | null;
}

export interface MemoryReviewSection {
  key: string;
  heading: string;
  owner: 'human' | 'engine';
  body: string;
}

export interface MemoryReviewProposal {
  key: string | null;
  value: string | null;
  canonicalItem: {
    type: string;
    slug: string;
    title: string;
    sections: MemoryReviewSection[];
  } | null;
}

export interface MemoryReviewTimelineItem {
  candidateId: string;
  reviewRequestId: string;
  revisionNumber: number;
  predecessorCandidateId: string | null;
  supersededById: string | null;
  title: string;
  status: MemoryReviewStatus;
  submittedBy: MemoryReviewIdentity;
  assignedReviewer: MemoryReviewIdentity | null;
  decidedBy: MemoryReviewIdentity | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface MemoryReviewDetail extends MemoryReviewInboxItem {
  proposal: MemoryReviewProposal;
  feedbackReason: string | null;
  eligibleReviewers: Array<MemoryReviewIdentity & { role: MemoryReviewEligibleRole }>;
  timeline: MemoryReviewTimelineItem[];
  controllingMemory: { itemId: string; version: number | null } | null;
  activeMemoryUnchanged: boolean;
}

/** POST /memory/review/candidates/:id/approve (Nest default 201). */
export type MemoryReviewApproveResponse =
  | {
      ok: true;
      candidateId: string;
      candidateKind: 'standard' | 'learning_signal_conflict';
      outcome: 'activated';
      memoryId: string;
    }
  | {
      ok: true;
      candidateId: string;
      candidateKind: 'correction' | 'restore' | 'contradiction';
      outcome: 'activated' | 'duplicate';
      memoryItemId: string;
      controllingItemId: string;
    }
  | {
      ok: true;
      candidateId: string;
      candidateKind: 'correction' | 'restore' | 'contradiction';
      outcome: 'conflict';
      memoryItemId: string;
      controllingItemId: string;
      conflictGroupId: string;
    };

/** POST /memory/review/candidates/:id/reject (Nest default 201). */
export interface MemoryReviewRejectResponse {
  ok: true;
  candidateId: string;
  candidateKind: MemoryReviewCandidateKind;
  outcome: 'rejected';
}

export interface MemoryReviewRejectRequest { reason: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NEXT_ACTIONS = ['review', 'revise', 'await_reviewer', 'assign_reviewer', 'none'] as const;
const BLOCKED_REASONS = ['no_reviewer', 'reviewer_unavailable', 'archived_client'] as const;

function invalid(path: string): never {
  throw new TypeError(`Invalid memory review response at ${path}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(path);
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  return typeof value === 'string' ? value : invalid(path);
}

function nonempty(value: unknown, path: string): string {
  const parsed = string(value, path);
  return parsed.trim() ? parsed : invalid(path);
}

function uuid(value: unknown, path: string): string {
  const parsed = string(value, path);
  return UUID.test(parsed) ? parsed : invalid(path);
}

function nullable<T>(value: unknown, path: string, parse: (value: unknown, path: string) => T): T | null {
  return value === null ? null : parse(value, path);
}

function bool(value: unknown, path: string): boolean {
  return typeof value === 'boolean' ? value : invalid(path);
}

function integer(value: unknown, path: string): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : invalid(path);
}

function iso(value: unknown, path: string): string {
  const parsed = string(value, path);
  const timestamp = new Date(parsed);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === parsed
    ? parsed
    : invalid(path);
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : invalid(path);
}

function array<T>(value: unknown, path: string, parse: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) return invalid(path);
  return value.map((item, index) => parse(item, `${path}[${index}]`));
}

function identity(value: unknown, path: string): MemoryReviewIdentity {
  const row = object(value, path);
  return { userId: uuid(row.userId, `${path}.userId`), name: nonempty(row.name, `${path}.name`) };
}

function inboxItem(value: unknown, path: string): MemoryReviewInboxItem {
  const row = object(value, path);
  const client = row.client === null ? null : object(row.client, `${path}.client`);
  const capabilities = object(row.capabilities, `${path}.capabilities`);
  return {
    candidateId: uuid(row.candidateId, `${path}.candidateId`),
    reviewRequestId: uuid(row.reviewRequestId, `${path}.reviewRequestId`),
    candidateKind: oneOf(row.candidateKind, MEMORY_REVIEW_INBOX_CANDIDATE_KINDS, `${path}.candidateKind`),
    scope: oneOf(row.scope, ['firm', 'client'] as const, `${path}.scope`),
    client: client === null ? null : {
      id: uuid(client.id, `${path}.client.id`),
      name: nonempty(client.name, `${path}.client.name`),
      status: nullable(client.status, `${path}.client.status`, string),
    },
    title: nonempty(row.title, `${path}.title`),
    status: oneOf(row.status, MEMORY_REVIEW_STATUSES, `${path}.status`),
    revisionNumber: integer(row.revisionNumber, `${path}.revisionNumber`),
    rootCandidateId: uuid(row.rootCandidateId, `${path}.rootCandidateId`),
    predecessorCandidateId: nullable(row.predecessorCandidateId, `${path}.predecessorCandidateId`, uuid),
    submittedBy: identity(row.submittedBy, `${path}.submittedBy`),
    assignedReviewer: nullable(row.assignedReviewer, `${path}.assignedReviewer`, identity),
    decidedBy: nullable(row.decidedBy, `${path}.decidedBy`, identity),
    createdAt: iso(row.createdAt, `${path}.createdAt`),
    decidedAt: nullable(row.decidedAt, `${path}.decidedAt`, iso),
    blockedReason: nullable(row.blockedReason, `${path}.blockedReason`, (raw, key) => oneOf(raw, BLOCKED_REASONS, key)),
    nextAction: oneOf(row.nextAction, NEXT_ACTIONS, `${path}.nextAction`),
    capabilities: {
      open: bool(capabilities.open, `${path}.capabilities.open`),
      approve: bool(capabilities.approve, `${path}.capabilities.approve`),
      reject: bool(capabilities.reject, `${path}.capabilities.reject`),
      requestChanges: bool(capabilities.requestChanges, `${path}.capabilities.requestChanges`),
      revise: bool(capabilities.revise, `${path}.capabilities.revise`),
      reassign: bool(capabilities.reassign, `${path}.capabilities.reassign`),
      withdraw: bool(capabilities.withdraw, `${path}.capabilities.withdraw`),
    },
  };
}

export function parseMemoryReviewInboxPage(value: unknown): MemoryReviewInboxPage {
  const row = object(value, 'page');
  return {
    enabled: bool(row.enabled, 'page.enabled'),
    view: oneOf(row.view, MEMORY_REVIEW_INBOX_VIEWS, 'page.view'),
    items: array(row.items, 'page.items', inboxItem),
    nextCursor: nullable(row.nextCursor, 'page.nextCursor', nonempty),
  };
}

function section(value: unknown, path: string): MemoryReviewSection {
  const row = object(value, path);
  return {
    key: string(row.key, `${path}.key`),
    heading: string(row.heading, `${path}.heading`),
    owner: oneOf(row.owner, ['human', 'engine'] as const, `${path}.owner`),
    body: string(row.body, `${path}.body`),
  };
}

function proposal(value: unknown, path: string): MemoryReviewProposal {
  const row = object(value, path);
  const canonical = row.canonicalItem === null ? null : object(row.canonicalItem, `${path}.canonicalItem`);
  return {
    key: nullable(row.key, `${path}.key`, string),
    value: nullable(row.value, `${path}.value`, string),
    canonicalItem: canonical === null ? null : {
      type: string(canonical.type, `${path}.canonicalItem.type`),
      slug: string(canonical.slug, `${path}.canonicalItem.slug`),
      title: string(canonical.title, `${path}.canonicalItem.title`),
      sections: array(canonical.sections, `${path}.canonicalItem.sections`, section),
    },
  };
}

function timelineItem(value: unknown, path: string): MemoryReviewTimelineItem {
  const row = object(value, path);
  return {
    candidateId: uuid(row.candidateId, `${path}.candidateId`),
    reviewRequestId: uuid(row.reviewRequestId, `${path}.reviewRequestId`),
    revisionNumber: integer(row.revisionNumber, `${path}.revisionNumber`),
    predecessorCandidateId: nullable(row.predecessorCandidateId, `${path}.predecessorCandidateId`, uuid),
    supersededById: nullable(row.supersededById, `${path}.supersededById`, uuid),
    title: nonempty(row.title, `${path}.title`),
    status: oneOf(row.status, MEMORY_REVIEW_STATUSES, `${path}.status`),
    submittedBy: identity(row.submittedBy, `${path}.submittedBy`),
    assignedReviewer: nullable(row.assignedReviewer, `${path}.assignedReviewer`, identity),
    decidedBy: nullable(row.decidedBy, `${path}.decidedBy`, identity),
    createdAt: iso(row.createdAt, `${path}.createdAt`),
    decidedAt: nullable(row.decidedAt, `${path}.decidedAt`, iso),
  };
}

export function parseMemoryReviewDetail(value: unknown, expectedCandidateId?: string): MemoryReviewDetail {
  const row = object(value, 'detail');
  const base = inboxItem(row, 'detail');
  if (expectedCandidateId !== undefined && base.candidateId !== expectedCandidateId) {
    invalid('detail.candidateId');
  }
  const controlling = row.controllingMemory === null
    ? null
    : object(row.controllingMemory, 'detail.controllingMemory');
  return {
    ...base,
    proposal: proposal(row.proposal, 'detail.proposal'),
    feedbackReason: nullable(row.feedbackReason, 'detail.feedbackReason', string),
    eligibleReviewers: array(row.eligibleReviewers, 'detail.eligibleReviewers', (raw, path) => {
      const reviewer = object(raw, path);
      return { ...identity(reviewer, path), role: oneOf(reviewer.role, MEMORY_REVIEW_ELIGIBLE_ROLES, `${path}.role`) };
    }),
    timeline: array(row.timeline, 'detail.timeline', timelineItem),
    controllingMemory: controlling === null ? null : {
      itemId: uuid(controlling.itemId, 'detail.controllingMemory.itemId'),
      version: nullable(controlling.version, 'detail.controllingMemory.version', integer),
    },
    activeMemoryUnchanged: bool(row.activeMemoryUnchanged, 'detail.activeMemoryUnchanged'),
  };
}

function decision(value: unknown, expectedCandidateId: string | undefined, path: string) {
  const row = object(value, path);
  if (row.ok !== true) invalid(`${path}.ok`);
  const candidateId = uuid(row.candidateId, `${path}.candidateId`);
  if (expectedCandidateId !== undefined && candidateId !== expectedCandidateId) invalid(`${path}.candidateId`);
  return {
    row,
    candidateId,
    candidateKind: oneOf(row.candidateKind, MEMORY_REVIEW_CANDIDATE_KINDS, `${path}.candidateKind`),
  };
}

export function parseMemoryReviewApproveResponse(
  value: unknown,
  expectedCandidateId?: string,
): MemoryReviewApproveResponse {
  const { row, candidateId, candidateKind } = decision(value, expectedCandidateId, 'approve');
  const outcome = oneOf(row.outcome, ['activated', 'duplicate', 'conflict'] as const, 'approve.outcome');
  if (candidateKind === 'standard' || candidateKind === 'learning_signal_conflict') {
    if (outcome !== 'activated' || row.memoryItemId !== undefined ||
        row.controllingItemId !== undefined || row.conflictGroupId !== undefined) {
      invalid('approve.outcome');
    }
    return { ok: true, candidateId, candidateKind, outcome, memoryId: uuid(row.memoryId, 'approve.memoryId') };
  }
  if (row.memoryId !== undefined) invalid('approve.memoryId');
  const version = {
    ok: true as const,
    candidateId,
    candidateKind,
    memoryItemId: uuid(row.memoryItemId, 'approve.memoryItemId'),
    controllingItemId: uuid(row.controllingItemId, 'approve.controllingItemId'),
  };
  if (outcome === 'conflict') {
    return { ...version, outcome, conflictGroupId: uuid(row.conflictGroupId, 'approve.conflictGroupId') };
  }
  if (row.conflictGroupId !== undefined) invalid('approve.conflictGroupId');
  return { ...version, outcome };
}

export function parseMemoryReviewRejectResponse(
  value: unknown,
  expectedCandidateId?: string,
): MemoryReviewRejectResponse {
  const { row, candidateId, candidateKind } = decision(value, expectedCandidateId, 'reject');
  if (row.outcome !== 'rejected') invalid('reject.outcome');
  return { ok: true, candidateId, candidateKind, outcome: 'rejected' };
}

/** Mirrors Core's required nonblank rejection reason; Core normalizes and caps it. */
export function parseMemoryReviewRejectRequest(value: unknown): MemoryReviewRejectRequest {
  const row = object(value, 'rejectRequest');
  return { reason: nonempty(row.reason, 'rejectRequest.reason') };
}
