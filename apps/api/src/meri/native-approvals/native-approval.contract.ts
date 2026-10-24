import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { BadRequestException } from '@nestjs/common';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';

/**
 * Closed parsers for the P-INT-10 native approval operations, mirroring Meri
 * `packages/contracts/meri.schema.json` (Identity, Scope, RunBinding, Command,
 * ApprovalProposal, ApprovalDecision) at meri-greenfield 497479c7 and the
 * receipt checks in `apps/control/intents/native-approvals.mjs`. Every object
 * is closed and every field required. Core identities are UUIDs, so tenantId
 * and actorId must be lowercase UUIDs here although Meri's schema allows any
 * 1..128 string.
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SCOPE_KINDS = ['tenant', 'client', 'mailbox', 'memory', 'document', 'private-user', 'public'] as const;
const ACTIONS = ['memory.propose', 'task.create', 'artifact.file'] as const;

export interface NativeIdentity { tenantId: string; actorId: string }
export interface NativeScope { tenantId: string; kind: string; resourceId: string; policyRevision: string }
export interface NativeRunBinding {
  tenantId: string; actorId: string; conversationId: string; runId: string;
  attemptId: string; workerId: string; writerFence: number;
}
export interface NativeCommand {
  contractVersion: '0.1.0' | '0.2.0'; commandId: string; binding: NativeRunBinding; action: string;
  arguments: Record<string, unknown>; attachments: unknown[]; scopes: NativeScope[]; idempotencyKey: string;
}
export interface NativeApprovalProposal {
  proposalId: string; command: NativeCommand; commandSha256: string;
  createdAt: string; expiresAt: string; requiredApprover: NativeIdentity;
}
export interface NativeApprovalDecision {
  proposalId: string; commandSha256: string; decision: 'approved' | 'rejected';
  decidedAt: string; expiresAt: string; approver: NativeIdentity; policyRevision: string;
}
export interface NativeApprovalReceipt {
  decision: NativeApprovalDecision | null; checkedAtMs: number; revoked: boolean;
}

const invalid = (field: string) => new BadRequestException(`Invalid native approval input: ${field}`);

function record(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) throw invalid(field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid(field);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))) throw invalid(field);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw invalid(field);
  return value;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(field);
  return value;
}

function dateTime(value: unknown, field: string, requireZ = false): string {
  if (typeof value !== 'string' || !DATE_TIME.test(value) || (requireZ && !value.endsWith('Z'))) throw invalid(field);
  if (!Number.isFinite(Date.parse(value))) throw invalid(field);
  return value;
}

export function parseIdentity(value: unknown, field: string): NativeIdentity {
  const v = record(value, ['tenantId', 'actorId'], field);
  return { tenantId: uuid(v.tenantId, `${field}.tenantId`), actorId: uuid(v.actorId, `${field}.actorId`) };
}

export function parseRunBinding(value: unknown, field: string): NativeRunBinding {
  const v = record(value, ['tenantId', 'actorId', 'conversationId', 'runId', 'attemptId', 'workerId', 'writerFence'], field);
  if (!Number.isSafeInteger(v.writerFence) || (v.writerFence as number) < 1) throw invalid(`${field}.writerFence`);
  return {
    tenantId: uuid(v.tenantId, `${field}.tenantId`), actorId: uuid(v.actorId, `${field}.actorId`),
    conversationId: uuid(v.conversationId, `${field}.conversationId`), runId: uuid(v.runId, `${field}.runId`),
    attemptId: uuid(v.attemptId, `${field}.attemptId`), workerId: uuid(v.workerId, `${field}.workerId`),
    writerFence: v.writerFence as number,
  };
}

export function parseScope(value: unknown, field: string): NativeScope {
  const v = record(value, ['tenantId', 'kind', 'resourceId', 'policyRevision'], field);
  if (!SCOPE_KINDS.includes(v.kind as (typeof SCOPE_KINDS)[number])) throw invalid(`${field}.kind`);
  return {
    tenantId: text(v.tenantId, `${field}.tenantId`, 1, 128), kind: v.kind as string,
    resourceId: text(v.resourceId, `${field}.resourceId`, 1, 256),
    policyRevision: text(v.policyRevision, `${field}.policyRevision`, 1, 128),
  };
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) throw invalid(field);
  return value as Record<string, unknown>;
}

function parseCommand(value: unknown, field: string): NativeCommand {
  const v = record(value, ['contractVersion', 'commandId', 'binding', 'action', 'arguments', 'attachments', 'scopes', 'idempotencyKey'], field);
  const document = v.contractVersion === '0.2.0' && v.action === 'document.draft';
  if (!document && v.contractVersion !== '0.1.0') throw invalid(`${field}.contractVersion`);
  if (!document && !ACTIONS.includes(v.action as (typeof ACTIONS)[number])) throw invalid(`${field}.action`);
  if (!Array.isArray(v.attachments)) throw invalid(`${field}.attachments`);
  v.attachments.forEach((item, index) => plainObject(item, `${field}.attachments[${index}]`));
  if (!Array.isArray(v.scopes) || v.scopes.length < 1) throw invalid(`${field}.scopes`);
  const scopes = v.scopes.map((item, index) => parseScope(item, `${field}.scopes[${index}]`));
  if (new Set(scopes.map((scope) => canonicalizeCoreRetainedJson(scope))).size !== scopes.length) throw invalid(`${field}.scopes`);
  let args = plainObject(v.arguments, `${field}.arguments`);
  if (document) {
    args = record(v.arguments, ['preparationSha256', 'artifactRequestSha256', 'sourceContextSha256', 'baseVersionId', 'title', 'format'], `${field}.arguments`);
    for (const key of ['preparationSha256', 'artifactRequestSha256', 'sourceContextSha256'])
      if (typeof args[key] !== 'string' || !HEX64.test(args[key] as string)) throw invalid(`${field}.arguments.${key}`);
    if (args.baseVersionId !== null) uuid(args.baseVersionId, `${field}.arguments.baseVersionId`);
    const title = text(args.title, `${field}.arguments.title`, 1, 200);
    if (title.trim() !== title || args.format !== 'docx' || v.attachments.length !== 0) throw invalid(`${field}.arguments`);
  }
  return {
    contractVersion: document ? '0.2.0' : '0.1.0', commandId: uuid(v.commandId, `${field}.commandId`),
    binding: parseRunBinding(v.binding, `${field}.binding`), action: v.action as string,
    arguments: args, attachments: v.attachments, scopes,
    idempotencyKey: text(v.idempotencyKey, `${field}.idempotencyKey`, 1, 128),
  };
}

/** SHA-256 of the RFC 8785 canonical JSON, as Meri's `canonicalSha256`. */
export function nativeCanonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalizeCoreRetainedJson(value), 'utf8').digest('hex');
}

export function parseApprovalProposal(value: unknown, field = 'proposal'): NativeApprovalProposal {
  const v = record(value, ['proposalId', 'command', 'commandSha256', 'createdAt', 'expiresAt', 'requiredApprover'], field);
  const proposal: NativeApprovalProposal = {
    proposalId: uuid(v.proposalId, `${field}.proposalId`),
    command: parseCommand(v.command, `${field}.command`),
    commandSha256: typeof v.commandSha256 === 'string' && HEX64.test(v.commandSha256) ? v.commandSha256 : (() => { throw invalid(`${field}.commandSha256`); })(),
    createdAt: dateTime(v.createdAt, `${field}.createdAt`),
    expiresAt: dateTime(v.expiresAt, `${field}.expiresAt`, true),
    requiredApprover: parseIdentity(v.requiredApprover, `${field}.requiredApprover`),
  };
  // Meri assertProposalIntegrity: hash binds the actual command, expiry follows
  // creation, and the required approver belongs to the command's tenant.
  if (nativeCanonicalSha256(v.command) !== proposal.commandSha256) throw invalid(`${field}.commandSha256`);
  if (proposal.command.action === 'document.draft' && [proposal.createdAt, proposal.expiresAt]
      .some(value => new Date(Date.parse(value)).toISOString() !== value)) throw invalid(`${field}.timestamp`);
  if (Date.parse(proposal.expiresAt) <= Date.parse(proposal.createdAt)) throw invalid(`${field}.expiresAt`);
  if (proposal.requiredApprover.tenantId !== proposal.command.binding.tenantId) throw invalid(`${field}.requiredApprover`);
  return proposal;
}

export interface ApprovalRecordInput {
  proposal: NativeApprovalProposal; decision: 'approved' | 'rejected';
  approver: NativeIdentity; binding: NativeRunBinding;
}

export function parseApprovalRecordInput(value: unknown): ApprovalRecordInput {
  const v = record(value, ['proposal', 'decision', 'approver', 'binding'], 'body');
  if (v.decision !== 'approved' && v.decision !== 'rejected') throw invalid('decision');
  return {
    proposal: parseApprovalProposal(v.proposal), decision: v.decision,
    approver: parseIdentity(v.approver, 'approver'), binding: parseRunBinding(v.binding, 'binding'),
  };
}

export interface ApprovalDecisionInput { proposalId: string; commandSha256: string; binding: NativeRunBinding }

export function parseApprovalDecisionInput(value: unknown): ApprovalDecisionInput {
  const v = record(value, ['proposalId', 'commandSha256', 'binding'], 'body');
  if (typeof v.commandSha256 !== 'string' || !HEX64.test(v.commandSha256)) throw invalid('commandSha256');
  return { proposalId: uuid(v.proposalId, 'proposalId'), commandSha256: v.commandSha256, binding: parseRunBinding(v.binding, 'binding') };
}

/** Revocation carries the approver identity Meri sends; decision reads keep their
 * original three-field request. The service compares this identity with the
 * authenticated Core actor and the stored decision before writing a fact. */
export interface ApprovalRevokeInput extends ApprovalDecisionInput { approver: NativeIdentity }

export function parseApprovalRevokeInput(value: unknown): ApprovalRevokeInput {
  const v = record(value, ['proposalId', 'commandSha256', 'approver', 'binding'], 'body');
  if (typeof v.commandSha256 !== 'string' || !HEX64.test(v.commandSha256)) throw invalid('commandSha256');
  return {
    proposalId: uuid(v.proposalId, 'proposalId'), commandSha256: v.commandSha256,
    approver: parseIdentity(v.approver, 'approver'), binding: parseRunBinding(v.binding, 'binding'),
  };
}

export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalizeCoreRetainedJson(a) === canonicalizeCoreRetainedJson(b);
}
