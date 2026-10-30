import { parseNativeMemoryArguments } from './native-memory-command.js';
import { parseNativeMailArguments } from '../execution-capability/native-mail-command.js';
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
export interface NativeObjectReference {
  objectId: string; versionId: string; sha256: string; bytes: number; scopes: NativeScope[];
}
export interface NativeArtifactFileArguments extends Record<string, unknown> { clientId: string; conversationId: string }
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
  if (keys.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor || !('value' in descriptor) || !descriptor.enumerable;
  })) throw invalid(field);
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

/** ObjectReference.versionId is an opaque storage version, not an ArtifactVersion UUID. */
export function parseObjectReference(value: unknown, field = 'object'): NativeObjectReference {
  const v = record(value, ['objectId', 'versionId', 'sha256', 'bytes', 'scopes'], field);
  if (typeof v.objectId !== 'string' || !UUID.test(v.objectId.toLowerCase())) throw invalid(`${field}.objectId`);
  if (typeof v.versionId !== 'string' || v.versionId.length < 1) throw invalid(`${field}.versionId`);
  if (typeof v.sha256 !== 'string' || !HEX64.test(v.sha256)) throw invalid(`${field}.sha256`);
  if (!Number.isSafeInteger(v.bytes) || (v.bytes as number) < 0) throw invalid(`${field}.bytes`);
  if (!Array.isArray(v.scopes) || v.scopes.length < 1) throw invalid(`${field}.scopes`);
  const scopes = Array.from(v.scopes, (scope, index) => parseScope(scope, `${field}.scopes[${index}]`));
  if (new Set(scopes.map(scope => canonicalizeCoreRetainedJson(scope))).size !== scopes.length) throw invalid(`${field}.scopes`);
  return { objectId: v.objectId, versionId: v.versionId, sha256: v.sha256, bytes: v.bytes as number, scopes };
}

export function parseArtifactFileAttachments(value: unknown, field = 'attachments'): NativeObjectReference[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw invalid(field);
  const objects = Array.from(value, (item, index) => parseObjectReference(item, `${field}[${index}]`));
  if (new Set(objects.map(object => object.objectId.toLowerCase())).size !== objects.length) throw invalid(field);
  return objects;
}

export function parseArtifactFileArguments(value: unknown, field = 'arguments'): NativeArtifactFileArguments {
  const args = record(value, ['clientId', 'conversationId'], field);
  return { clientId: uuid(args.clientId, `${field}.clientId`), conversationId: uuid(args.conversationId, `${field}.conversationId`) };
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) throw invalid(field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid(field);
  return value as Record<string, unknown>;
}

function taskDueDay(value: unknown, field: string): string {
  const day = dateTime(value, field, true);
  if (new Date(Date.parse(day)).toISOString() !== day || Date.parse(day) % 86_400_000 !== 0) throw invalid(field);
  return day;
}

export function parseTaskCreateArguments(value: unknown, field = 'arguments'): Record<string, unknown> {
  const args = record(value, ['title', 'clientId', 'dueDate'], field);
  const title = text(args.title, `${field}.title`, 1, 240);
  if (title.trim() !== title) throw invalid(`${field}.title`);
  if (args.clientId !== null) uuid(args.clientId, `${field}.clientId`);
  if (args.dueDate !== null) taskDueDay(args.dueDate, `${field}.dueDate`);
  return args;
}

/** Exact commands-0.2 TaskUpdateArguments: null/empty raw fields are omitted,
 * never converted to clearing a date or an invented revision precondition. */
export function parseTaskUpdateArguments(value: unknown, field = 'arguments'): Record<string, unknown> {
  const args = record(value, ['taskId', 'mode', 'patch'], field);
  uuid(args.taskId, `${field}.taskId`);
  if (args.mode !== 'unconditional_patch') throw invalid(`${field}.mode`);
  const patch = plainObject(args.patch, `${field}.patch`), keys = Object.keys(patch);
  if (keys.length < 1 || keys.some(key => !['title', 'status', 'dueDate'].includes(key))) throw invalid(`${field}.patch`);
  record(patch, keys, `${field}.patch`);
  if (Object.hasOwn(patch, 'title')) {
    const title = text(patch.title, `${field}.patch.title`, 1, 240);
    if (title.trim() !== title) throw invalid(`${field}.patch.title`);
  }
  if (Object.hasOwn(patch, 'status') && !['todo', 'in_progress', 'done', 'blocked', 'canceled'].includes(patch.status as string))
    throw invalid(`${field}.patch.status`);
  if (Object.hasOwn(patch, 'dueDate')) taskDueDay(patch.dueDate, `${field}.patch.dueDate`);
  return args;
}

function parseCommand(value: unknown, field: string): NativeCommand {
  const v = record(value, ['contractVersion', 'commandId', 'binding', 'action', 'arguments', 'attachments', 'scopes', 'idempotencyKey'], field);
  const document = v.contractVersion === '0.2.0' && v.action === 'document.draft';
  const taskUpdate = v.contractVersion === '0.2.0' && v.action === 'task.update';
  const mail = v.contractVersion === '0.2.0' && v.action === 'mail.send';
  if (!document && !taskUpdate && !mail && v.contractVersion !== '0.1.0') throw invalid(`${field}.contractVersion`);
  if (!document && !taskUpdate && !mail && !ACTIONS.includes(v.action as (typeof ACTIONS)[number])) throw invalid(`${field}.action`);
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
  if (taskUpdate || v.action === 'task.create') {
    if (v.attachments.length !== 0) throw invalid(`${field}.attachments`);
    args = taskUpdate ? parseTaskUpdateArguments(args, `${field}.arguments`) : parseTaskCreateArguments(args, `${field}.arguments`);
  }
  if (v.action === 'memory.propose') {
    if (v.attachments.length !== 0) throw invalid(field + '.attachments');
    args = parseNativeMemoryArguments(args);
  }
  if (mail) {
    if (v.attachments.length !== 0) throw invalid(`${field}.attachments`);
    args = parseNativeMailArguments(args);
  }
  const binding = parseRunBinding(v.binding, `${field}.binding`);
  let attachments = v.attachments;
  if (v.action === 'artifact.file') {
    args = parseArtifactFileArguments(args, `${field}.arguments`);
    const objects = parseArtifactFileAttachments(attachments, `${field}.attachments`);
    if (args.conversationId !== binding.conversationId || scopes.some(scope => scope.tenantId !== binding.tenantId) ||
        objects.some(object => object.scopes.some(scope => scope.tenantId !== binding.tenantId)))
      throw invalid(`${field}.filingProvenance`);
    attachments = objects;
  }
  return {
    contractVersion: document || taskUpdate || mail ? '0.2.0' : '0.1.0', commandId: uuid(v.commandId, `${field}.commandId`),
    binding, action: v.action as string,
    arguments: args, attachments, scopes,
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
  if (['document.draft', 'task.update'].includes(proposal.command.action) && [proposal.createdAt, proposal.expiresAt]
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

/* ============================================================================
 * SCRUM-222 browser consequential-action approvals.
 *
 * Mirrors Meri's accepted preparation contract exactly
 * (meri-greenfield packages/contracts/runtime-0.2/browser-approval-preparation.mjs
 * at Parent10 da3013631f, and apps/control/commands/approval-metadata/readback.mjs).
 * The host captures `meri-browser-approval-request/3`; Meri retains the same
 * subject/input/window as `meri-browser-approval-preparation/1` and serves it
 * back through the existing internal readback. Core owns only the human
 * decision, the one-time consumption and the result settlement.
 *
 * FOUR INDEPENDENT DIGESTS, never forced equal:
 *   C = metadata command envelope        -> readback.commandSha256 (internal)
 *   A = {arguments:A,attachments:[]}     -> record.inputSha256   (internal)
 *   S = subject                          -> preparation.subjectSha256 = Core decision.commandSha256
 *   I = input                            -> S.inputSha256
 * ========================================================================== */

export const BROWSER_ACTION = 'browser.action';
export const BROWSER_OPERATION = Object.freeze({ id: 'browser_action', version: '0.2.0' });
export const BROWSER_KIND_VERSION = '0.1.0';
export const BROWSER_ACTION_SCHEMA = 'meri-browser-action/1';
export const BROWSER_PREPARATION_SCHEMA = 'meri-browser-approval-preparation/1';
export const BROWSER_RECEIPT_SCHEMA = 'meri-browser-approval-receipt/1';
export const BROWSER_STATUS_SCHEMA = 'meri-browser-approval-status/1';
export const BROWSER_READBACK_SCHEMA = 'meri-browser-approval-readback/1';
/** A browser preparation is served only with real run custody (never initial-binding). */
export const BROWSER_RUN_STATES = Object.freeze(['queued', 'starting', 'running', 'paused', 'waiting-for-approval', 'completed']);

export interface NativeBrowserSubject {
  schema: typeof BROWSER_ACTION_SCHEMA;
  binding: NativeRunBinding;
  server: string;
  tool: string;
  toolUseId: string;
  inputSha256: string;
  pageOrigin: string;
  policySha256: string;
}

export interface NativeBrowserPreparation {
  schema: typeof BROWSER_PREPARATION_SCHEMA;
  subject: NativeBrowserSubject;
  subjectSha256: string;
  input: Record<string, unknown>;
  requestedAtMs: number;
  expiresAtMs: number;
}

/** The stored metadata record's fields Core relies on (readback.metadata.record). */
export interface NativeBrowserRecord {
  commandId: string;
  idempotencyKey: string;
  scopes: NativeScope[];
  createdAt: string;
  expiresAt: string;
  requiredApprover: NativeIdentity;
  binding: NativeRunBinding;
  inputSha256: string;
  proposalId: string;
}

/** The actual current run projection served with the preparation (readback.run). */
export interface NativeBrowserRunCustody {
  binding: NativeRunBinding;
  state: string;
  scopes: NativeScope[];
  policyRevision: string;
}

export interface NativeBrowserPrepared {
  preparation: NativeBrowserPreparation;
  record: NativeBrowserRecord;
  run: NativeBrowserRunCustody;
}

export interface NativeBrowserApprovalReceipt {
  schema: typeof BROWSER_RECEIPT_SCHEMA;
  subjectSha256: string;
  proposalId: string;
  toolUseId: string;
  decision: NativeApprovalDecision;
  consumption: { consumed: true; consumptionId: string; consumedAtMs: number };
}

/** Non-permissive answer for a repeat, restart or ambiguous consumption. */
export interface NativeBrowserApprovalReadback {
  schema: typeof BROWSER_READBACK_SCHEMA;
  proposalId: string;
  subjectSha256: string;
  toolUseId: string;
  permissive: false;
  unknown: boolean;
  consumption: { state: string; consumedAtMs: number; completedAtMs: number | null; result: unknown } | null;
  /** Status reads only: the retained decision facts, still never a grant. */
  decision?: NativeApprovalDecision | null;
  revoked?: boolean;
}

function bounded(value: unknown, field: string, max: number): string {
  const text = typeof value === 'string' ? value : '';
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) throw invalid(field);
  return text;
}

function hex64(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HEX64.test(value)) throw invalid(field);
  return value;
}

/** Meri normalizes with `new URL(value).origin`; Core accepts only an already-canonical origin. */
function canonicalOrigin(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 512) throw invalid(field);
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(field); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password ||
      url.hash || url.pathname !== '/' || url.search || url.origin !== value) throw invalid(field);
  return value;
}

function millis(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalid(field);
  return value as number;
}

/** Bytes of the canonical JSON, as Meri bounds the display copy at 65536. */
function displayCopy(value: unknown, field: string): Record<string, unknown> {
  const copy = plainObject(value, field);
  if (Buffer.byteLength(canonicalizeCoreRetainedJson(copy), 'utf8') > 65_536) throw invalid(field);
  return copy;
}

function scopeList(value: unknown, field: string, tenantId: string): NativeScope[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw invalid(field);
  const scopes = Array.from(value, (item, index) => parseScope(item, `${field}[${index}]`));
  if (scopes.some((scope) => scope.tenantId !== tenantId)) throw invalid(field);
  if (new Set(scopes.map((scope) => canonicalizeCoreRetainedJson(scope))).size !== scopes.length) throw invalid(field);
  return scopes;
}

export function parseBrowserSubject(value: unknown, field = 'subject'): NativeBrowserSubject {
  const v = record(value, ['schema', 'binding', 'server', 'tool', 'toolUseId', 'inputSha256', 'pageOrigin', 'policySha256'], field);
  if (v.schema !== BROWSER_ACTION_SCHEMA) throw invalid(`${field}.schema`);
  return {
    schema: BROWSER_ACTION_SCHEMA,
    binding: parseRunBinding(v.binding, `${field}.binding`),
    server: bounded(v.server, `${field}.server`, 256),
    tool: bounded(v.tool, `${field}.tool`, 256),
    toolUseId: bounded(v.toolUseId, `${field}.toolUseId`, 256),
    inputSha256: hex64(v.inputSha256, `${field}.inputSha256`),
    pageOrigin: canonicalOrigin(v.pageOrigin, `${field}.pageOrigin`),
    policySha256: hex64(v.policySha256, `${field}.policySha256`),
  };
}

/** The retained preparation/1: the host request with only its outer schema tag changed. */
export function parseBrowserPreparation(value: unknown, field = 'request'): NativeBrowserPreparation {
  const v = record(value, ['schema', 'subject', 'subjectSha256', 'input', 'requestedAtMs', 'expiresAtMs'], field);
  if (v.schema !== BROWSER_PREPARATION_SCHEMA) throw invalid(`${field}.schema`);
  const subject = parseBrowserSubject(v.subject, `${field}.subject`);
  const subjectSha256 = hex64(v.subjectSha256, `${field}.subjectSha256`);
  if (nativeCanonicalSha256(subject) !== subjectSha256) throw invalid(`${field}.subjectSha256`);
  const input = displayCopy(v.input, `${field}.input`);
  if (nativeCanonicalSha256(input) !== subject.inputSha256) throw invalid(`${field}.input`);
  const requestedAtMs = millis(v.requestedAtMs, `${field}.requestedAtMs`);
  const expiresAtMs = millis(v.expiresAtMs, `${field}.expiresAtMs`);
  if (requestedAtMs >= expiresAtMs) throw invalid(`${field}.expiresAtMs`);
  return { schema: BROWSER_PREPARATION_SCHEMA, subject, subjectSha256, input, requestedAtMs, expiresAtMs };
}

/** A: the command arguments carried inside C (exactly Meri's browserPreparationArguments). */
export function browserPreparationArguments(preparation: NativeBrowserPreparation): Record<string, unknown> {
  return {
    subject: preparation.subject,
    subjectSha256: preparation.subjectSha256,
    input: preparation.input,
    requestedAtMs: preparation.requestedAtMs,
    expiresAtMs: preparation.expiresAtMs,
  };
}

/** C: Meri's immutable metadata command envelope. Its hash is INTERNAL identity only. */
export function browserMetadataCommand(record: Pick<NativeBrowserRecord,
  'commandId' | 'binding' | 'scopes' | 'idempotencyKey'>, preparation: NativeBrowserPreparation): Record<string, unknown> {
  return {
    contractVersion: BROWSER_KIND_VERSION,
    commandId: record.commandId,
    binding: record.binding,
    action: BROWSER_ACTION,
    arguments: browserPreparationArguments(preparation),
    attachments: [],
    scopes: record.scopes,
    idempotencyKey: record.idempotencyKey,
  };
}

export function browserCommandSha256(record: Pick<NativeBrowserRecord,
  'commandId' | 'binding' | 'scopes' | 'idempotencyKey'>, preparation: NativeBrowserPreparation): string {
  return nativeCanonicalSha256(browserMetadataCommand(record, preparation));
}

/** Internal normalized-input identity: sha256({arguments:A,attachments:[]}). */
export function browserInputSha256(preparation: NativeBrowserPreparation): string {
  return nativeCanonicalSha256({ arguments: browserPreparationArguments(preparation), attachments: [] });
}

/** Meri's deterministic selector for one attempt + tool use (a selector, never proof). */
export function browserProposalId(binding: NativeRunBinding, toolUseId: string): string {
  const digest = nativeCanonicalSha256({ kind: 'browser-preparation', binding, toolUseId });
  const variant = ((parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** One durable consumption per tool use, in the existing consumption owner's key space. */
export function browserConsumptionKey(toolUseId: string): string {
  return `browser:${toolUseId}`;
}

/** Stable Core-owned UUID identity of that durable row. */
export function browserConsumptionId(tenantId: string, proposalId: string, toolUseId: string): string {
  const digest = nativeCanonicalSha256(['meri-browser-approval-consumption-v1', tenantId, proposalId, toolUseId]);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export interface BrowserDecisionRequest {
  proposalId: string;
  subjectSha256: string;
  decision: 'approved' | 'rejected';
  approver: NativeIdentity;
  binding: NativeRunBinding;
}

/** Core's record request. The subject is NOT resent: Core re-reads it from the prepared owner. */
export function parseBrowserDecisionRequest(value: unknown): BrowserDecisionRequest {
  const v = record(value, ['proposalId', 'subjectSha256', 'decision', 'approver', 'binding'], 'body');
  if (v.decision !== 'approved' && v.decision !== 'rejected') throw invalid('decision');
  return {
    proposalId: uuid(v.proposalId, 'proposalId'),
    subjectSha256: hex64(v.subjectSha256, 'subjectSha256'),
    decision: v.decision,
    approver: parseIdentity(v.approver, 'approver'),
    binding: parseRunBinding(v.binding, 'binding'),
  };
}

export interface BrowserProposalRequest { proposalId: string; subjectSha256: string; binding: NativeRunBinding }

export function parseBrowserProposalRequest(value: unknown): BrowserProposalRequest {
  const v = record(value, ['proposalId', 'subjectSha256', 'binding'], 'body');
  return {
    proposalId: uuid(v.proposalId, 'proposalId'),
    subjectSha256: hex64(v.subjectSha256, 'subjectSha256'),
    binding: parseRunBinding(v.binding, 'binding'),
  };
}

export interface BrowserResultRequest extends BrowserProposalRequest {
  outcome: 'ok' | 'error';
  result: Record<string, unknown>;
}

/** Effect settlement: evidence about what the browser action did, never a permission. */
export function parseBrowserResultRequest(value: unknown): BrowserResultRequest {
  const v = record(value, ['proposalId', 'subjectSha256', 'binding', 'outcome', 'result'], 'body');
  if (v.outcome !== 'ok' && v.outcome !== 'error') throw invalid('outcome');
  const result = displayCopy(v.result, 'result');
  return {
    proposalId: uuid(v.proposalId, 'proposalId'),
    subjectSha256: hex64(v.subjectSha256, 'subjectSha256'),
    binding: parseRunBinding(v.binding, 'binding'),
    outcome: v.outcome,
    result,
  };
}

/**
 * Validate the internal readback for ONE browser preparation: shape, variant,
 * four independent digests, the complete binding, the canonical scopes and the
 * real run custody. Returns the facts Core is allowed to act on.
 */
export function assertBrowserReadback(raw: unknown, expected: {
  proposalId: string; binding: NativeRunBinding; subjectSha256: string;
}): NativeBrowserPrepared {
  // Exactly {schemaVersion, commandSha256, metadata, run}: there is no top-level action.
  const v = record(raw, ['schemaVersion', 'commandSha256', 'metadata', 'run'], 'readback');
  if (v.schemaVersion !== 1) throw invalid('readback.schemaVersion');
  const metadata = record(v.metadata, ['record', 'commandContext', 'commandSha256'], 'readback.metadata');
  const recordValue = record(metadata.record, ['operation', 'action', 'binding', 'request', 'inputSha256', 'commandId',
    'idempotencyKey', 'proposalId', 'scopes', 'createdAt', 'expiresAt', 'requiredApprover'], 'readback.record');
  const operation = record(recordValue.operation, ['id', 'version'], 'readback.record.operation');
  if (operation.id !== BROWSER_OPERATION.id || operation.version !== BROWSER_OPERATION.version) throw invalid('readback.record.operation');
  if (recordValue.action !== BROWSER_ACTION) throw invalid('readback.record.action');
  const preparation = parseBrowserPreparation(recordValue.request, 'readback.record.request');
  const binding = parseRunBinding(recordValue.binding, 'readback.record.binding');
  const scopes = scopeList(recordValue.scopes, 'readback.record.scopes', binding.tenantId);
  const requiredApprover = parseIdentity(recordValue.requiredApprover, 'readback.record.requiredApprover');
  const record_: NativeBrowserRecord = {
    commandId: uuid(recordValue.commandId, 'readback.record.commandId'),
    idempotencyKey: bounded(recordValue.idempotencyKey, 'readback.record.idempotencyKey', 128),
    scopes,
    createdAt: dateTime(recordValue.createdAt, 'readback.record.createdAt'),
    expiresAt: dateTime(recordValue.expiresAt, 'readback.record.expiresAt'),
    requiredApprover,
    binding,
    inputSha256: hex64(recordValue.inputSha256, 'readback.record.inputSha256'),
    proposalId: uuid(recordValue.proposalId, 'readback.record.proposalId'),
  };
  // Identity: the row Core was asked about is the row Meri retained.
  if (record_.proposalId !== expected.proposalId) throw invalid('readback.record.proposalId');
  if (!sameJson(record_.binding, expected.binding)) throw invalid('readback.record.binding');
  if (!sameJson(preparation.subject.binding, record_.binding)) throw invalid('readback.record.binding');
  if (preparation.subjectSha256 !== expected.subjectSha256) throw invalid('readback.record.request.subjectSha256');
  if (record_.requiredApprover.tenantId !== record_.binding.tenantId) throw invalid('readback.record.requiredApprover');
  if (Date.parse(record_.expiresAt) <= Date.parse(record_.createdAt)) throw invalid('readback.record.expiresAt');

  // The four digests, each recomputed here and never trusted from the response.
  if (browserInputSha256(preparation) !== record_.inputSha256) throw invalid('readback.record.inputSha256');
  const commandSha256 = browserCommandSha256(record_, preparation);
  // C's hash lives on the envelope (top-level and metadata), never on the record.
  if (commandSha256 !== v.commandSha256 || commandSha256 !== metadata.commandSha256) throw invalid('readback.commandSha256');

  // The retained context is exactly the record's canonical authority.
  const context = record(metadata.commandContext, ['binding', 'scopes', 'requiredApprover'], 'readback.metadata.commandContext');
  if (!sameJson(context.binding, record_.binding) || !sameJson(context.scopes, scopes) ||
      !sameJson(context.requiredApprover, requiredApprover)) throw invalid('readback.metadata.commandContext');

  // Real run custody only: full binding, same scopes, an admitted state and the qualification revision.
  const runValue = record(v.run, ['binding', 'state', 'scopes', 'policyRevision'], 'readback.run');
  const run: NativeBrowserRunCustody = {
    binding: parseRunBinding(runValue.binding, 'readback.run.binding'),
    state: bounded(runValue.state, 'readback.run.state', 64),
    scopes: scopeList(runValue.scopes, 'readback.run.scopes', binding.tenantId),
    policyRevision: bounded(runValue.policyRevision, 'readback.run.policyRevision', 256),
  };
  if (!sameJson(run.binding, record_.binding)) throw invalid('readback.run.binding');
  if (!sameJson(run.scopes, scopes)) throw invalid('readback.run.scopes');
  if (!(BROWSER_RUN_STATES as readonly string[]).includes(run.state)) throw invalid('readback.run.state');
  const revisions = new Set(scopes.map((scope) => scope.policyRevision));
  if (revisions.size !== 1 || !revisions.has(run.policyRevision)) throw invalid('readback.run.policyRevision');
  return { preparation, record: record_, run };
}
