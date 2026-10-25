import { ConflictException, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  nativeCanonicalSha256, parseArtifactFileArguments, parseArtifactFileAttachments, parseRunBinding,
  parseTaskCreateArguments, parseTaskUpdateArguments, sameJson, UUID,
  type NativeApprovalProposal,
} from './native-approval.contract.js';

const unavailable = () => new ServiceUnavailableException('Approval metadata unavailable');
const mismatch = () => new ConflictException('Approval proposal does not match its prepared record');
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => ![...required, ...optional].includes(key))) throw mismatch();
  return value;
}

/** Mirror the canonical Meri commands-0.2 codecs at this HTTP boundary. Metadata
 * retains the raw request, not normalized arguments; trusted resolution is
 * immutable preparation evidence, never current permission to access a client. */
function normalizedInput(proposal: NativeApprovalProposal, request: unknown, commandContext: unknown) {
  const c = proposal.command;
  let args: Record<string, unknown>;
  let attachments: unknown[] = [];
  if (c.action === 'document.draft') {
    const context = closed(commandContext, ['binding', 'scopes']);
    if (!sameJson(context, { binding: c.binding, scopes: c.scopes })) throw mismatch();
    if (!sameJson(request, c.arguments)) throw mismatch();
    args = c.arguments;
  } else if (c.action === 'task.create') {
    const context = closed(commandContext, ['binding', 'clientResolution']);
    if (!sameJson(context.binding, c.binding)) throw mismatch();
    const raw = closed(request, ['title'], ['clientId', 'dueDate']);
    for (const key of ['title', 'clientId', 'dueDate']) {
      if (key === 'title' || (Object.hasOwn(raw, key) && raw[key] !== null)) {
        if (typeof raw[key] !== 'string' || [...raw[key] as string].length > 16_384) throw mismatch();
      }
    }
    const reference = typeof raw.clientId === 'string' ? raw.clientId.trim() || null : null;
    let clientId: string | null = null;
    if (reference !== null) {
      const resolution = closed(context.clientResolution, ['reference', 'clientId']);
      if (reference.length > 80 || resolution.reference !== reference || typeof resolution.clientId !== 'string' ||
          !UUID.test(resolution.clientId.toLowerCase())) throw mismatch();
      clientId = resolution.clientId.toLowerCase();
      if (UUID.test(reference.toLowerCase()) && reference.toLowerCase() !== clientId) throw mismatch();
    } else if (context.clientResolution !== null) throw mismatch();
    const date = typeof raw.dueDate === 'string' ? raw.dueDate.trim() || null : null;
    args = parseTaskCreateArguments({ title: (raw.title as string).trim(), clientId,
      dueDate: date === null ? null : date.length === 10 ? `${date}T00:00:00.000Z` : date });
  } else if (c.action === 'task.update') {
    const context = closed(commandContext, ['binding']);
    if (!sameJson(context.binding, c.binding)) throw mismatch();
    const raw = closed(request, ['taskId'], ['title', 'status', 'dueDate']);
    if (typeof raw.taskId !== 'string') throw mismatch();
    const patch: Record<string, string> = {};
    for (const key of ['title', 'status', 'dueDate']) {
      if (!Object.hasOwn(raw, key) || raw[key] === null) continue;
      if (typeof raw[key] !== 'string') throw mismatch();
      const value = (raw[key] as string).trim();
      if (!value) continue;
      patch[key] = key === 'status' ? (value.toLowerCase() === 'open' ? 'todo' : value.toLowerCase())
        : key === 'dueDate' && value.length === 10 ? `${value}T00:00:00.000Z` : value;
    }
    args = parseTaskUpdateArguments({ taskId: raw.taskId.trim().toLowerCase(), mode: 'unconditional_patch', patch });
  } else if (c.action === 'artifact.file') {
    const context = closed(commandContext, ['binding', 'destination']);
    const destination = closed(context.destination, ['clientId', 'conversationId']);
    const raw = closed(request, ['clientId', 'conversationId', 'objects']);
    if (!sameJson(context.binding, c.binding)) throw mismatch();
    for (const key of ['clientId', 'conversationId']) {
      if (typeof destination[key] !== 'string' || !UUID.test((destination[key] as string).toLowerCase()) ||
          typeof raw[key] !== 'string' || (raw[key] as string).toLowerCase() !== (destination[key] as string).toLowerCase()) throw mismatch();
    }
    args = parseArtifactFileArguments({ clientId: (destination.clientId as string).toLowerCase(),
      conversationId: (destination.conversationId as string).toLowerCase() });
    const objects = parseArtifactFileAttachments(raw.objects);
    if (args.conversationId !== c.binding.conversationId ||
        objects.some(object => !sameJson(object.scopes, c.scopes))) throw mismatch();
    attachments = objects;
  } else throw mismatch();
  if (!sameJson(args, c.arguments) || !sameJson(attachments, c.attachments)) throw mismatch();
  return { arguments: args, attachments };
}

/** The initial binding proves preparation custody. Later generations, a started
 * turn, or its admission expiry do not revoke an explicit Core approval. */
function initialPreparation(value: unknown, proposal: NativeApprovalProposal): void {
  if (!['task.create', 'task.update', 'artifact.file'].includes(proposal.command.action)) throw mismatch();
  const p = closed(value, ['kind', 'record', 'recordSha256', 'generation', 'latestGeneration', 'started']);
  const r = closed(p.record, ['schemaVersion', 'state', 'binding', 'selectedClientId', 'policyRevision', 'versions',
    'configurationSha256', 'expiresAtMs', 'createdAtMs']);
  const binding = parseRunBinding(r.binding, 'preparation.record.binding');
  const versions = closed(r.versions, ['imageDigest', 'sdk', 'cli', 'contracts', 'skillsDigest', 'checkpointFormat']);
  const digest = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const version = (value: unknown): boolean => typeof value === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value);
  const instant = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  if (p.kind !== 'initial-binding' || r.schemaVersion !== 1 || r.state !== 'ADMITTED' || binding.writerFence !== 1 ||
      !sameJson(binding, proposal.command.binding) ||
      (r.selectedClientId !== null && (typeof r.selectedClientId !== 'string' || !UUID.test(r.selectedClientId))) ||
      typeof r.policyRevision !== 'string' || r.policyRevision.length < 1 || r.policyRevision.length > 256 ||
      !digest(r.configurationSha256) || !digest(p.recordSha256) || nativeCanonicalSha256(r) !== p.recordSha256 ||
      typeof versions.imageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(versions.imageDigest) ||
      !version(versions.sdk) || !version(versions.cli) || versions.contracts !== '0.1.0' ||
      versions.checkpointFormat !== '0.1.0' || !digest(versions.skillsDigest) ||
      !instant(r.createdAtMs) || !instant(r.expiresAtMs) || r.expiresAtMs <= r.createdAtMs ||
      r.createdAtMs > Date.parse(proposal.createdAt) ||
      !Number.isSafeInteger(p.generation) || (p.generation as number) < 1 ||
      !Number.isSafeInteger(p.latestGeneration) || (p.latestGeneration as number) < (p.generation as number) ||
      typeof p.started !== 'boolean') throw mismatch();
  const scopes = [{ tenantId: binding.tenantId, kind: r.selectedClientId === null ? 'private-user' : 'client',
    resourceId: r.selectedClientId ?? binding.actorId, policyRevision: r.policyRevision }];
  if (!sameJson(scopes, proposal.command.scopes)) throw mismatch();
}

function verifyReadback(actual: unknown, proposal: NativeApprovalProposal): void {
  try {
    const initial = object(actual) && Object.hasOwn(actual, 'preparation');
    const a = closed(actual, ['schemaVersion', 'commandSha256', 'metadata', initial ? 'preparation' : 'run']);
    const m = closed(a.metadata, ['record', 'commandContext', 'commandSha256']);
    const r = closed(m.record, ['operation', 'action', 'binding', 'request', 'inputSha256', 'commandId',
      'idempotencyKey', 'proposalId', 'scopes', 'createdAt', 'expiresAt', 'requiredApprover']);
    const c = proposal.command;
    const operation = c.action === 'document.draft' ? 'create_word' : c.action === 'task.create' ? 'create_task'
      : c.action === 'artifact.file' ? 'save_chat_attachments' : 'update_task';
    // An effect may already have committed before its preparation run
    // subsequently failed. Retained metadata remains valid for reconciliation.
    const states = ['queued', 'starting', 'running', 'paused', 'waiting-for-approval', 'completed',
      ...(['task.create', 'task.update', 'artifact.file'].includes(c.action) ? ['failed'] : [])];
    const input = normalizedInput(proposal, r.request, m.commandContext);
    const expected = { operation: { id: operation, version: '0.2.0' }, action: c.action,
      binding: c.binding, request: r.request, inputSha256: nativeCanonicalSha256(input),
      commandId: c.commandId, idempotencyKey: c.idempotencyKey, proposalId: proposal.proposalId,
      scopes: c.scopes, createdAt: proposal.createdAt, expiresAt: proposal.expiresAt, requiredApprover: proposal.requiredApprover };
    if (a.schemaVersion !== 1 || a.commandSha256 !== proposal.commandSha256 || m.commandSha256 !== proposal.commandSha256 ||
        nativeCanonicalSha256(c) !== proposal.commandSha256 || !sameJson(r, expected)) throw mismatch();
    if (initial) return initialPreparation(a.preparation, proposal);
    if (!object(a.run) || !sameJson(a.run.binding, c.binding) || !sameJson(a.run.scopes, c.scopes) ||
        !states.includes(a.run.state as string)) throw mismatch();
  } catch { throw mismatch(); }
}

/** Actual retained native metadata and run custody, through the existing private
 * endpoint. Proposal expiry belongs to approval/execution; completed receipt
 * reads may verify the same immutable metadata after that expiry. */
@Injectable()
export class NativeApprovalMetadataVerifier {
  constructor(@Optional() private readonly config?: ConfigService) {}

  async verify(proposal: NativeApprovalProposal, transaction?: Prisma.TransactionClient): Promise<void> {
    // Keep network I/O outside the caller's proposal lock/database transaction.
    if (transaction) throw unavailable();
    const origin = this.config?.get<string>('MERI_CONTROL_ORIGIN');
    const secret = this.config?.get<string>('INTERNAL_SERVICE_SECRET');
    let base: URL;
    try { base = new URL(origin ?? ''); } catch { throw unavailable(); }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
        base.pathname !== '/' || !secret || /[\r\n]/.test(secret)) throw unavailable();
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 3000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(new URL('/v1/internal/approval-metadata/read', base), {
        method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { 'content-type': 'application/json', 'x-internal-service-secret': secret },
        body: JSON.stringify({ schemaVersion: 1, proposalId: proposal.proposalId, binding: proposal.command.binding }),
      });
      if (response.status !== 200 || !response.body) throw unavailable();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 256 * 1024) throw unavailable();
        chunks.push(next.value);
      }
      const actual = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (abort.signal.aborted) throw unavailable();
      return verifyReadback(actual, proposal);
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer); abort.abort();
      if (reader) await reader.cancel().catch(() => undefined);
    }
  }
}
