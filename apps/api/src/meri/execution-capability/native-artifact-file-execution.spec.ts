import { createHash } from 'node:crypto';
import { PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { EngagementService } from '../../engagement/engagement.service.js';
import { EngagementRuntimePolicyService } from '../../engagement/runtime/engagement-runtime-policy.service.js';
import { ClientDocumentWriterService } from '../../client-documents/client-document-writer.service.js';
import { MeriClientFilingService } from '../meri-client-filing.service.js';
import { MeriController } from '../meri.controller.js';
import { MeriService } from '../meri.service.js';
import { NativeApprovalService } from '../native-approvals/native-approval.service.js';
import { NativeApprovalController } from '../native-approvals/native-approval.controller.js';
import { NativeExecutionService } from '../native-approvals/native-execution.service.js';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { nativeCanonicalSha256 as hash } from '../native-approvals/native-approval.contract.js';
import { MeriExecutionReceiverService } from './meri-execution-receiver.service.js';

const id = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = Date.parse('2026-10-25T00:00:00.000Z');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const config = { get: (key: string) => key === 'INTERNAL_SERVICE_SECRET' ? 'synthetic-secret' : key === 'NODE_ENV' ? 'production' : true };
function clone<T>(value: T): T {
  if (value instanceof Date) return new Date(value) as T;
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as T;
  return value;
}
function fixture(count = 2) {
  const state = { now: NOW, member: true, tenantActive: true, role: 'standard_user', wall: true, session: true,
    conversation: true, selectedClientId: id(7) as string | null, conversationOwner: id(2), principalTenant: id(1),
    revoked: false, decisionPresent: true, failPut: 0, failCreate: 0, failComplete: false, failCommit: false,
    scans: ['clean', 'pending'], afterPut: undefined as undefined | (() => void),
    beforeRelease: undefined as undefined | (() => void), afterRegistrationWrite: undefined as undefined | (() => void),
    afterCommit: undefined as undefined | (() => Promise<void>) };
  const ctx: any = { tenantId: id(1), userId: id(2), role: 'standard_user' };
  const binding = { tenantId: id(1), actorId: id(2), conversationId: id(3), runId: id(4), attemptId: id(5), workerId: id(6), writerFence: 1 };
  const scopes = [{ tenantId: id(1), kind: 'client', resourceId: id(7), policyRevision: 'policy1' }];
  const bytes = Array.from({ length: count }, (_, index) => Buffer.from(`Synthetic approved file ${index + 1}`));
  const objects = bytes.map((buffer, index) => ({ objectId: id(100 + index), versionId: `storage-version/${index + 1}`,
    sha256: sha(buffer), bytes: buffer.length, scopes: clone(scopes) }));
  const command: any = { contractVersion: '0.1.0', commandId: id(8), binding, action: 'artifact.file',
    arguments: { clientId: id(7), conversationId: id(3) }, attachments: objects, scopes, idempotencyKey: 'filing-fixture' };
  const proposal = { proposalId: id(9), command, commandSha256: hash(command), createdAt: new Date(NOW - 10000).toISOString(),
    expiresAt: new Date(NOW + 30000).toISOString(), requiredApprover: { tenantId: id(1), actorId: id(2) } };
  const decision: any = { tenantId: id(1), proposalId: id(9), commandSha256: proposal.commandSha256, decision: 'approved',
    decidedAt: new Date(NOW - 5000), expiresAt: new Date(proposal.expiresAt), approverUserId: id(2), policyRevision: 'policy1',
    bindingActorUserId: id(2), conversationId: id(3), runId: id(4) };
  const stages = new Map<string, any>(bytes.map((data, index) => [id(200 + index), { id: id(200 + index), tenantId: id(1), userId: id(2),
    messageId: null, filename: `file-${index + 1}.txt`, mediaType: 'text/plain', byteSize: data.length, data }]));
  const documents = new Map<string, any>(), receipts = new Map<string, any>(), committedReceipts = new Map<string, any>();
  const committedDocuments = new Map<string, any>();
  const storage = new Map<string, { bytes: Buffer; type: string; checksum: string }>();
  let queue = Promise.resolve(), creates = 0, puts = 0, scanCalls = 0;
  const copyMap = (map: Map<string, any>) => new Map([...map].map(([key, value]) => [key, clone(value)]));
  const restore = (target: Map<string, any>, source: Map<string, any>) => { target.clear(); source.forEach((value, key) => target.set(key, value)); };
  const matches = (row: any, where: any) => Object.entries(where).every(([key, value]: [string, any]) =>
    value && typeof value === 'object' && 'in' in value ? value.in.includes(row[key]) : row[key] === value);
  const tx: any = {
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql.join('?');
      if (text.includes('clock_timestamp')) return [{ db_now: new Date(state.now) }];
      if (text.includes('SELECT c.id')) return state.wall ? (values[1] as string[]).map(id => ({ id })) : [];
      return [];
    }),
    $executeRaw: jest.fn(async () => 1),
    tenantMembership: { findFirst: jest.fn(async ({ where }: any) => state.member && where.tenantId === ctx.tenantId && where.userId === ctx.userId
      ? { role: state.role, tenant: { status: state.tenantActive ? 'active' : 'archived' } } : null) },
    clioConversation: { findFirst: jest.fn(async ({ where }: any) => state.conversation && where.id === binding.conversationId &&
      where.tenantId === ctx.tenantId && where.userId === state.conversationOwner
      ? { id: binding.conversationId, tenantId: ctx.tenantId, userId: state.conversationOwner,
        clientId: state.selectedClientId, status: 'active', archivedAt: null, metadata: null } : null) },
    clioMeriApprovalDecision: { findUnique: jest.fn(async () => state.decisionPresent ? decision : null) },
    clioMeriApprovalRevocation: { findUnique: jest.fn(async () => state.revoked ? {} : null) },
    clioMeriExecutionConsumption: {
      findUnique: jest.fn(async () => receipts.get('receipt') ?? null),
      create: jest.fn(async ({ data }: any) => { if (receipts.has('receipt')) throw Error('duplicate claim');
        const row = { ...data, state: 'CLAIMED', result: null, completedAt: null }; receipts.set('receipt', row); return row; }),
      updateMany: jest.fn(async ({ where, data }: any) => { const row = receipts.get('receipt');
        if (state.failComplete || !row || !matches(row, where)) return { count: 0 };
        Object.assign(row, clone(data)); return { count: 1 }; }),
    },
    clioAttachment: {
      findMany: jest.fn(async ({ where }: any) => [...stages.values()].filter(row => matches(row, where))),
      findFirst: jest.fn(async ({ where }: any) => [...stages.values()].find(row => matches(row, where)) ?? null),
      create: jest.fn(async ({ data }: any) => { if (stages.has(data.id)) throw Error('Duplicate staged original');
        const row = { ...clone(data), createdAt: new Date(state.now) }; stages.set(row.id, row); state.afterRegistrationWrite?.(); return row; }),
    },
    engagementAttachment: {
      findFirst: jest.fn(async ({ where }: any) => [...documents.values()].find(row => matches(row, where)) ?? null),
      findMany: jest.fn(async ({ where, take }: any) => [...documents.values()].filter(row => matches(row, where)).slice(0, take)),
      create: jest.fn(async ({ data }: any) => { creates++; if (state.failCreate === creates) throw Error('Database insert uncertain');
        if (documents.has(data.id)) throw Error('duplicate document');
        const row = { indexedAt: null, supersededByAttachmentId: null, ...clone(data) }; documents.set(row.id, row); return row; }),
    },
  };
  const prisma: any = { withTenant: jest.fn(async (tenantId: string, run: (tx: any) => Promise<any>) => {
    expect(tenantId).toBe(ctx.tenantId);
    const predecessor = queue; let unlock!: () => void; queue = new Promise<void>(resolve => { unlock = resolve; }); await predecessor;
    const beforeDocuments = copyMap(documents), beforeReceipts = copyMap(receipts), beforeStages = copyMap(stages);
    let result: any;
    try { result = await run(tx);
      if (state.failCommit && documents.size > beforeDocuments.size) throw Error('Database commit uncertain');
      restore(committedReceipts, copyMap(receipts)); restore(committedDocuments, copyMap(documents));
    } catch (error) { restore(documents, beforeDocuments); restore(receipts, beforeReceipts); restore(stages, beforeStages); throw error; }
    finally { unlock(); }
    await state.afterCommit?.();
    return result;
  }) };
  const s3 = { send: jest.fn(async (command: any) => {
    expect(committedReceipts.get('receipt')?.state).toBe('CLAIMED');
    if (command instanceof HeadObjectCommand) { const row = storage.get(command.input.Key!); if (!row) throw Error('Missing object');
      return { ContentLength: row.bytes.length, ContentType: row.type, ChecksumSHA256: row.checksum }; }
    expect(command).toBeInstanceOf(PutObjectCommand); puts++;
    expect(command.input.IfNoneMatch).toBe('*');
    const buffer = Buffer.from(command.input.Body); expect(command.input.ChecksumSHA256).toBe(Buffer.from(sha(buffer), 'hex').toString('base64'));
    if (storage.has(command.input.Key)) throw Object.assign(Error('Already written'), { name: 'PreconditionFailed' });
    storage.set(command.input.Key, { bytes: buffer, type: command.input.ContentType, checksum: command.input.ChecksumSHA256 });
    state.afterPut?.(); if (state.failPut === puts) throw Error('Storage response lost after PUT'); return {};
  }) };
  const scanner = { scanRequired: true, providerName: 'synthetic-scanner', getStatus: jest.fn(async () => state.scans[scanCalls++] ?? 'clean') };
  const clientKb = { indexAttachmentFireAndForget: jest.fn((_tenant: string, attachmentId: string) => {
    expect(committedDocuments.has(attachmentId)).toBe(true);
  }) };
  const engagement = Object.assign(Object.create(EngagementService.prototype), {
    prisma: { withTenant: () => { throw Error('Unexpected nested document transaction'); } }, bucket: 'synthetic-bucket', s3, scanner, clientKb,
    attachmentContent: { detectContentType: () => 'text/plain', contentTypeConflicts: () => false, sha256: sha },
  });
  const runtime = new EngagementRuntimePolicyService({ serviceName: 'api', processMode: 'active', backgroundOwner: 'api',
    externalActions: 'enabled', callbacksEnabled: true, recallWebhookEnabled: true });
  const filing = new MeriClientFilingService(prisma, new ClientDocumentWriterService(engagement, runtime));
  const metadata = { verify: jest.fn(async () => { if (receipts.get('receipt')?.state === 'COMPLETED') state.beforeRelease?.(); }) };
  const current = { read: jest.fn(async () => ({ principal: { tenantId: state.principalTenant, actorId: ctx.userId },
    conversationId: binding.conversationId, selectedClientId: state.selectedClientId, expiresAtMs: state.now + 60000 })) };
  const approvals = new NativeApprovalService(prisma, metadata as never, current as never);
  const tenant: any = { readApplicationAuthoritySession: jest.fn(async () => ({ readCurrent: jest.fn(async () => {
    if (!state.session) throw new ForbiddenException('Session revoked');
    return { principal: { tenantId: state.principalTenant, actorId: ctx.userId }, identityRevision: 'a'.repeat(64), expiresAtMs: state.now + 60000 };
  }) })) };
  const service = new MeriExecutionReceiverService(prisma, engagement, null, approvals, tenant, filing);
  const req: any = { headers: { 'x-internal-service-secret': 'synthetic-secret' }, method: 'POST', path: '/api/clio/approvals/native/execute' };
  new ToolServiceSecretGuard(config as never).canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as never);
  const body: any = { proposal, binding, attachments: objects.map((object, index) => ({ attachmentId: id(200 + index), object: clone(object) })) };
  const readBody = { proposal, binding };
  const originalService = Object.create(MeriService.prototype) as MeriService;
  const upload = { buffer: bytes[0]!, mimetype: 'text/plain', originalname: 'approved.txt', size: bytes[0]!.length };
  const registrationContext = () => JSON.stringify({ proposal, binding, object: objects[0] });
  const rehash = () => { proposal.commandSha256 = hash(command); decision.commandSha256 = proposal.commandSha256; };
  const seedClaim = () => { const row = { tenantId: ctx.tenantId, proposalId: proposal.proposalId, idempotencyKey: command.idempotencyKey,
    commandSha256: proposal.commandSha256, argumentsSha256: hash({ arguments: command.arguments, attachments: command.attachments }),
    jti: null, state: 'CLAIMED', result: null, completedAt: null }; receipts.set('receipt', row); committedReceipts.set('receipt', clone(row)); };
  return { state, ctx, binding, command, objects, bytes, proposal, decision, stages, documents, receipts, committedReceipts, storage,
    tx, prisma, s3, scanner, clientKb, metadata, service, originalService, upload, registrationContext, req, body, readBody, rehash, seedClaim,
    register: (file = upload) => service.nativeAttachmentRegistration(req, ctx, registrationContext(),
      internal => originalService.registerNativeAttachment(ctx, file, internal)),
    execute: () => service.nativeApproved(req, ctx, body, 'execute'), read: () => service.nativeApproved(req, ctx, readBody, 'read') };
}

describe('native artifact filing execution through document custody', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  it('commits one claim before two original writes and preserves scanner/indexing observations', async () => {
    const f = fixture(), result: any = await f.execute();
    expect(result.status).toBe('observed');
    expect(result.outcome.execution).toMatchObject({ kind: 'native-artifact-file', binding: f.binding, commandSha256: f.proposal.commandSha256 });
    expect(result.outcome.result.commandSha256).toBe(f.proposal.commandSha256);
    expect(result.outcome.result.files).toEqual([
      expect.objectContaining({ object: f.objects[0], status: 'saved', indexingStatus: 'pending', reused: false }),
      expect.objectContaining({ object: f.objects[1], status: 'pending', indexingStatus: 'not_indexed', reused: false, reason: expect.any(String) }),
    ]);
    expect(f.s3.send).toHaveBeenCalledTimes(2); expect(f.storage.size).toBe(2); expect(f.documents.size).toBe(2);
    expect(f.tx.clioMeriExecutionConsumption.create).toHaveBeenCalledTimes(1);
    expect(f.receipts.get('receipt').state).toBe('COMPLETED'); expect(f.clientKb.indexAttachmentFireAndForget).toHaveBeenCalledTimes(1);
    expect([...f.documents.values()].map(row => row.sourceEntityId)).toEqual(f.objects.map(hash));
  });

  it.each(['digest', 'length', 'row-length', 'owner', 'tenant', 'already-sent', 'missing', 'no-bytes'])
    ('preflights every staged source and refuses %s before claim or S3', async kind => {
      const f = fixture(), row = f.stages.get(id(201))!;
      if (kind === 'digest') row.data = Buffer.from('x'.repeat(row.data.length));
      if (kind === 'length') row.data = Buffer.from('short'); if (kind === 'row-length') row.byteSize++;
      if (kind === 'owner') row.userId = id(90); if (kind === 'tenant') row.tenantId = id(90);
      if (kind === 'already-sent') (row as any).messageId = id(90); if (kind === 'missing') f.stages.delete(row.id);
      if (kind === 'no-bytes') (row as any).data = null;
      await expect(f.execute()).rejects.toThrow(); expect(f.receipts.size).toBe(0); expect(f.s3.send).not.toHaveBeenCalled();
    });

  it.each(['duplicate-id', 'duplicate-object', 'missing-object', 'substitution', 'extra-field', 'scope', 'General'])
    ('refuses %s mapping or authority without dispatch', async kind => {
      const f = fixture();
      if (kind === 'duplicate-id') f.body.attachments[1].attachmentId = f.body.attachments[0].attachmentId;
      if (kind === 'duplicate-object') f.body.attachments[1].object = clone(f.objects[0]);
      if (kind === 'missing-object') f.body.attachments.pop();
      if (kind === 'substitution') f.body.attachments[0].object.versionId = 'substituted';
      if (kind === 'extra-field') f.body.attachments[0].versionId = id(90);
      if (kind === 'scope') { f.command.attachments[0].scopes[0].resourceId = id(90); f.body.attachments[0].object = clone(f.command.attachments[0]); f.rehash(); }
      if (kind === 'General') f.state.selectedClientId = null;
      await expect(f.execute()).rejects.toThrow(); expect(f.s3.send).not.toHaveBeenCalled(); expect(f.receipts.size).toBe(0);
    });

  it.each(['member', 'tenant', 'role', 'wall', 'session', 'conversation', 'owner', 'client', 'principal'])
    ('enforces current %s before effects and historical release', async kind => {
      const f = fixture(1), first: any = await f.execute();
      if (kind === 'member') f.state.member = false; if (kind === 'tenant') f.state.tenantActive = false; if (kind === 'role') f.state.role = 'external_observer';
      if (kind === 'wall') f.state.wall = false; if (kind === 'session') f.state.session = false; if (kind === 'conversation') f.state.conversation = false;
      if (kind === 'owner') f.state.conversationOwner = id(90); if (kind === 'client') f.state.selectedClientId = id(90); if (kind === 'principal') f.state.principalTenant = id(90);
      await expect(f.read()).rejects.toThrow(); await expect(f.execute()).rejects.toThrow();
      expect(f.receipts.get('receipt').result).toEqual(first.outcome); expect(f.s3.send).toHaveBeenCalledTimes(1);
      const fresh = fixture(1); Object.assign(fresh.state, f.state);
      await expect(fresh.execute()).rejects.toThrow(); expect(fresh.receipts.size).toBe(0); expect(fresh.s3.send).not.toHaveBeenCalled();
    });

  it.each(['revoked', 'expired', 'rejected', 'missing-decision'])('refuses fresh %s approval before a claim or S3', async kind => {
    const f = fixture(); if (kind === 'revoked') f.state.revoked = true; if (kind === 'expired') f.state.now += 60000;
    if (kind === 'rejected') f.decision.decision = 'rejected'; if (kind === 'missing-decision') f.state.decisionPresent = false;
    await expect(f.execute()).rejects.toThrow(); expect(f.receipts.size).toBe(0); expect(f.s3.send).not.toHaveBeenCalled();
  });

  it('replays immutable completed results after approval expiry, revocation and staging removal', async () => {
    const f = fixture(), first = await f.execute(); f.state.now += 60000; f.state.revoked = true; f.stages.clear();
    expect(await f.execute()).toEqual(first); expect(await f.read()).toEqual({ state: 'OUTCOME', outcome: (first as any).outcome });
    expect(f.s3.send).toHaveBeenCalledTimes(2); expect(f.scanner.getStatus).toHaveBeenCalledTimes(2);
  });

  it.each(['storage-response', 'database-insert', 'database-commit'])('keeps a durable UNKNOWN claim after %s uncertainty', async kind => {
    const f = fixture(); if (kind === 'storage-response') f.state.failPut = 1;
    if (kind === 'database-insert') f.state.failCreate = 1; if (kind === 'database-commit') f.state.failCommit = true;
    expect(await f.execute()).toEqual({ status: 'indeterminate' });
    expect(f.storage.size).toBe(1); expect(f.documents.size).toBe(0); expect(f.receipts.get('receipt').state).toBe('CLAIMED');
    expect(await f.read()).toEqual({ state: 'UNKNOWN' }); expect(await f.execute()).toEqual({ status: 'indeterminate' });
    expect(f.s3.send).toHaveBeenCalledTimes(1);
  });

  it('retains a committed sibling when the next original write becomes uncertain', async () => {
    const f = fixture(); f.state.failPut = 2;
    expect(await f.execute()).toEqual({ status: 'indeterminate' });
    expect(f.documents.size).toBe(1); expect(f.storage.size).toBe(2); expect(f.receipts.get('receipt').state).toBe('CLAIMED');
    expect(f.clientKb.indexAttachmentFireAndForget).toHaveBeenCalledTimes(1);
    f.stages.clear(); f.state.revoked = true; f.state.now += 60000;
    expect(await f.execute()).toEqual({ status: 'indeterminate' }); expect(await f.read()).toEqual({ state: 'UNKNOWN' });
    expect(f.s3.send).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('never dispatches an existing empty claim, expired=%s', async expired => {
    const f = fixture(); f.seedClaim(); f.stages.clear(); if (expired) { f.state.now += 60000; f.state.revoked = true; }
    expect(await f.execute()).toEqual({ status: 'indeterminate' }); expect(await f.read()).toEqual({ state: 'UNKNOWN' });
    expect(f.s3.send).not.toHaveBeenCalled(); expect(f.tx.clioAttachment.findMany).not.toHaveBeenCalled();
  });

  it('reconciles only complete persisted provenance after completion failure without another storage call', async () => {
    const f = fixture(); f.state.failComplete = true;
    expect(await f.execute()).toEqual({ status: 'indeterminate' });
    expect(f.documents.size).toBe(2); expect(f.receipts.get('receipt').state).toBe('CLAIMED');
    f.state.failComplete = false; f.state.now += 60000; f.state.revoked = true; f.stages.clear();
    const result: any = await f.read(); expect(result.state).toBe('OUTCOME');
    expect(result.outcome.result.files.every((file: any) => file.reused)).toBe(true);
    expect(f.receipts.get('receipt').state).toBe('COMPLETED'); expect(f.s3.send).toHaveBeenCalledTimes(2);
  });

  it('allows only the claim winner to dispatch concurrent requests', async () => {
    const f = fixture(); const results: any[] = await Promise.all([f.execute(), f.execute()]);
    expect(results.some(result => result.status === 'observed')).toBe(true);
    expect(results.every(result => ['observed', 'indeterminate'].includes(result.status))).toBe(true);
    expect(f.tx.clioMeriExecutionConsumption.create).toHaveBeenCalledTimes(1); expect(f.s3.send).toHaveBeenCalledTimes(2);
    expect(f.documents.size).toBe(2); expect((await f.read() as any).state).toBe('OUTCOME');
  });

  it('does not resurrect a document after a concurrent read completes the claim before dispatch', async () => {
    const previous = fixture(1); await previous.execute();
    const f = fixture(1); previous.documents.forEach((row, key) => f.documents.set(key, clone(row)));
    f.state.afterCommit = async () => {
      if (f.receipts.get('receipt')?.state !== 'CLAIMED') return;
      f.state.afterCommit = undefined;
      expect((await f.read() as any).state).toBe('OUTCOME');
      f.documents.clear();
    };
    expect(await f.execute()).toEqual({ status: 'indeterminate' });
    expect(f.receipts.get('receipt').state).toBe('COMPLETED'); expect(f.documents.size).toBe(0);
    expect(f.s3.send).not.toHaveBeenCalled(); expect(f.tx.engagementAttachment.create).not.toHaveBeenCalled();
  });

  it.each(['wall-after-put', 'revoke-after-put', 'wall-at-release'])('withholds the result after %s', async kind => {
    const f = fixture(1);
    if (kind === 'wall-after-put') f.state.afterPut = () => { f.state.wall = false; };
    if (kind === 'revoke-after-put') f.state.afterPut = () => { f.state.revoked = true; };
    if (kind === 'wall-at-release') f.state.beforeRelease = () => { f.state.wall = false; };
    expect(await f.execute()).toEqual({ status: 'indeterminate' }); expect(f.s3.send).toHaveBeenCalledTimes(1);
    expect(f.receipts.get('receipt').state).toBe(kind === 'wall-at-release' ? 'COMPLETED' : 'CLAIMED');
    expect(f.documents.size).toBe(kind === 'wall-at-release' ? 1 : 0);
  });

  it.each(['deleted', 'moved', 'owner', 'digest', 'bytes', 'superseded', 'deleting'])('refuses historical %s document provenance', async kind => {
    const f = fixture(1); await f.execute(); const row = [...f.documents.values()][0];
    if (kind === 'deleted') f.documents.clear(); if (kind === 'moved') row.clientId = id(90); if (kind === 'owner') row.uploadedByUserId = id(90);
    if (kind === 'digest') row.calculatedSha256 = '0'.repeat(64); if (kind === 'bytes') row.byteSize++;
    if (kind === 'superseded') row.supersededByAttachmentId = id(90); if (kind === 'deleting') row.lifecycleStatus = 'delete_pending';
    await expect(f.read()).rejects.toThrow(); await expect(f.execute()).rejects.toThrow(); expect(f.s3.send).toHaveBeenCalledTimes(1);
  });

  it.each(['command', 'arguments', 'binding', 'decision', 'object', 'document', 'location', 'completion', 'legacy-jti'])
    ('refuses corrupted stored %s outcome', async kind => {
      const f = fixture(1); await f.execute(); const row = f.receipts.get('receipt');
      if (kind === 'command') row.commandSha256 = '0'.repeat(64); if (kind === 'arguments') row.argumentsSha256 = '0'.repeat(64);
      if (kind === 'binding') row.result.execution.binding.runId = id(90);
      if (kind === 'decision') row.result.execution.approvalDecisionSha256 = '0'.repeat(64);
      if (kind === 'object') row.result.result.files[0].object.versionId = 'substitution';
      if (kind === 'document') row.result.result.files[0].documentId = id(90);
      if (kind === 'location') row.result.result.files[0].location = '/elsewhere';
      if (kind === 'completion') row.result.execution.completedAt = new Date(NOW - 60000).toISOString();
      if (kind === 'legacy-jti') row.jti = id(90);
      await expect(f.read()).rejects.toThrow(); expect(f.s3.send).toHaveBeenCalledTimes(1);
    });

  it('reads an absent outcome without staging or effect, including after expiry', async () => {
    const f = fixture(); f.state.now += 60000; f.stages.clear();
    expect(await f.read()).toBeNull(); expect(f.receipts.size).toBe(0); expect(f.s3.send).not.toHaveBeenCalled();
  });

  it('keeps task execute bodies closed after routing through nativeApproved', async () => {
    const f = fixture(1); f.command.action = 'task.create'; f.command.arguments = { title: 'Task', clientId: id(7), dueDate: null };
    f.command.attachments = []; f.rehash();
    await expect(f.execute()).rejects.toThrow(); expect(f.prisma.withTenant).not.toHaveBeenCalled();
  });

  it('mounts filing execute/read through the existing guarded native routes', async () => {
    const f = fixture(1), module = await Test.createTestingModule({ controllers: [NativeApprovalController], providers: [
      RolesGuard, ToolServiceSecretGuard, { provide: ConfigService, useValue: config },
      { provide: NativeApprovalService, useValue: {} }, { provide: NativeExecutionService, useValue: {} },
      { provide: MeriExecutionReceiverService, useValue: f.service },
    ] }).compile();
    const app = module.createNestApplication(); app.setGlobalPrefix('api');
    app.use((req: any, _res: unknown, next: () => void) => { req.tenantContext = f.ctx; next(); }); await app.init();
    try {
      await request(app.getHttpServer()).post('/api/clio/approvals/native/execute').send(f.body).expect(403);
      const absent = await request(app.getHttpServer()).post('/api/clio/approvals/native/execution/read')
        .set('x-internal-service-secret', 'synthetic-secret').send(f.readBody).expect(200);
      expect(absent.headers['cache-control']).toBe('no-store');
      expect(absent.headers['content-type']).toMatch(/^application\/json/);
      expect(absent.text).toBe('null'); expect(absent.body).toBeNull();
      const result = await request(app.getHttpServer()).post('/api/clio/approvals/native/execute').set('x-internal-service-secret', 'synthetic-secret').send(f.body).expect(200);
      expect(result.headers['cache-control']).toBe('no-store'); expect(result.body.outcome.execution.kind).toBe('native-artifact-file');
      const read = await request(app.getHttpServer()).post('/api/clio/approvals/native/execution/read').set('x-internal-service-secret', 'synthetic-secret').send(f.readBody).expect(200);
      expect(read.body).toEqual({ state: 'OUTCOME', outcome: result.body.outcome }); expect(f.s3.send).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
});

describe('native original registration reuses filing authority', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  it.each(['missing', 'changed'] as const)('does not acknowledge a %s staged original after the write transaction', async mode => {
    const f = fixture(1); f.stages.clear();
    f.state.afterCommit = async () => {
      f.state.afterCommit = undefined;
      if (mode === 'missing') f.stages.clear();
      else for (const row of f.stages.values()) row.data = Buffer.from('different retained bytes');
    };
    await expect(f.register()).rejects.toThrow('registration was not retained');
    expect(f.receipts.size).toBe(0); expect(f.s3.send).not.toHaveBeenCalled();
    if (mode === 'missing') {
      await expect(f.register()).resolves.toMatchObject({ sha256: f.objects[0]!.sha256, bytes: f.bytes[0]!.length });
      expect(f.stages.size).toBe(1);
    }
  });

  it('registers the same approved original once across concurrent retries and a later proposal', async () => {
    const f = fixture(1); f.stages.clear();
    const [first, concurrent] = await Promise.all([f.register(), f.register()]);
    expect(concurrent).toEqual(first); expect(first).toMatchObject({ status: 'pending', sha256: f.objects[0]!.sha256,
      bytes: f.bytes[0]!.length, reason: expect.stringContaining('text extraction was not run') });
    f.proposal.proposalId = id(999); f.decision.proposalId = id(999); f.command.commandId = id(998); f.rehash();
    const repeated = await f.register({ ...f.upload, originalname: 'renamed.txt' });
    expect(repeated).toEqual(first); expect(f.tx.clioAttachment.create).toHaveBeenCalledTimes(1); expect(f.stages.size).toBe(1);
    expect(f.receipts.size).toBe(0); expect(f.s3.send).not.toHaveBeenCalled(); expect(f.scanner.getStatus).not.toHaveBeenCalled();
    expect(f.tx.$queryRaw.mock.calls.some(([sql]: [TemplateStringsArray]) => sql.join('').includes('capiro-meri-native-attachment:'))).toBe(true);
  });

  it('recovers a committed registration after metadata response loss without another row', async () => {
    const f = fixture(1); f.stages.clear();
    f.metadata.verify.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw Error('Response lost'); });
    await expect(f.register()).rejects.toThrow('Response lost'); expect(f.stages.size).toBe(1);
    const retry = await f.register(); expect(retry.id).toBe([...f.stages.keys()][0]);
    expect(f.tx.clioAttachment.create).toHaveBeenCalledTimes(1);
  });

  it.each(['revoked', 'expired', 'member', 'tenant', 'wall', 'session', 'conversation', 'General'])
    ('refuses %s registration without creating a staged original', async kind => {
      const f = fixture(1); f.stages.clear();
      if (kind === 'revoked') f.state.revoked = true; if (kind === 'expired') f.state.now += 60000;
      if (kind === 'member') f.state.member = false; if (kind === 'tenant') f.state.tenantActive = false;
      if (kind === 'wall') f.state.wall = false; if (kind === 'session') f.state.session = false;
      if (kind === 'conversation') f.state.conversation = false; if (kind === 'General') f.state.selectedClientId = null;
      await expect(f.register()).rejects.toThrow(); expect(f.tx.clioAttachment.create).not.toHaveBeenCalled(); expect(f.stages.size).toBe(0);
    });

  it.each(['revoked', 'expired', 'wall'])('rolls registration back after %s changes before commit', async kind => {
    const f = fixture(1); f.stages.clear();
    f.state.afterRegistrationWrite = () => {
      if (kind === 'revoked') f.state.revoked = true; if (kind === 'expired') f.state.now += 60000; if (kind === 'wall') f.state.wall = false;
    };
    await expect(f.register()).rejects.toThrow(); expect(f.tx.clioAttachment.create).toHaveBeenCalledTimes(1); expect(f.stages.size).toBe(0);
  });

  it('withholds a committed upload if current rights change during release metadata I/O', async () => {
    const f = fixture(1); f.stages.clear();
    f.metadata.verify.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { f.state.wall = false; });
    await expect(f.register()).rejects.toThrow(); expect(f.stages.size).toBe(1);
  });

  it.each(['not-json', 'extra', 'missing', 'binding', 'object', 'too-large', 'array'])('rejects %s multipart context before the callback', async kind => {
    const f = fixture(1), context: any = JSON.parse(f.registrationContext()), register = jest.fn(async () => ({}));
    if (kind === 'extra') context.clientId = id(7); if (kind === 'missing') delete context.object;
    if (kind === 'binding') context.binding.runId = id(90); if (kind === 'object') context.object.versionId = 'substituted';
    const raw = kind === 'not-json' ? '{' : kind === 'too-large' ? ' '.repeat(262145) : kind === 'array' ? [] : JSON.stringify(context);
    await expect(f.service.nativeAttachmentRegistration(f.req, f.ctx, raw, register)).rejects.toThrow(); expect(register).not.toHaveBeenCalled();
    expect(f.tx.clioAttachment.create).not.toHaveBeenCalled();
  });

  it('requires verified service identity and exact incoming bytes without any registration ledger', async () => {
    const f = fixture(1); f.stages.clear();
    await expect(f.service.nativeAttachmentRegistration({ headers: f.req.headers } as never, f.ctx, f.registrationContext(), async () => ({}))).rejects.toThrow();
    await expect(f.register({ ...f.upload, buffer: Buffer.from('substitution') })).rejects.toThrow();
    expect(f.stages.size).toBe(0); expect(f.receipts.size).toBe(0);
  });

  it.each([false, true])('mounts optional filing multipart context with ordinary uploads unchanged, observe=%s', async observe => {
    const f = fixture(1); f.stages.clear();
    const ordinary = jest.fn(async () => ({ id: id(300), status: 'parsed' }));
    const meri = Object.assign(f.originalService, { uploadAttachment: ordinary });
    const uploadConfig = { get: (key: string) => observe && key === 'NODE_ENV' ? 'test'
      : observe && key === 'MERI_TOOLS_REQUIRE_SERVICE_SECRET' ? false : config.get(key) };
    const guard = new ToolServiceSecretGuard(uploadConfig as never);
    // Other controller domains are irrelevant; retain the actual upload method,
    // FileInterceptor, role guard, service-identity proof and receiver.
    const dependencies: any[] = Reflect.getMetadata('design:paramtypes', MeriController).slice(1);
    const module = await Test.createTestingModule({ controllers: [MeriController], providers: [
      RolesGuard, { provide: ConfigService, useValue: uploadConfig }, { provide: MeriService, useValue: meri },
      ...dependencies.map(token => ({ provide: token, useValue: token === MeriExecutionReceiverService ? f.service : token === ToolServiceSecretGuard ? guard : {} })),
    ] }).compile();
    const app = module.createNestApplication(); app.setGlobalPrefix('api');
    app.use((req: any, _res: unknown, next: () => void) => { req.tenantContext = f.ctx; next(); }); await app.init();
    try {
      await request(app.getHttpServer()).post('/api/clio/attachments').field('ordinaryField', 'unchanged').attach('file', f.upload.buffer, 'ordinary.txt').expect(201);
      expect(ordinary).toHaveBeenCalledTimes(1);
      await request(app.getHttpServer()).post('/api/clio/attachments').field('filing', f.registrationContext()).attach('file', f.upload.buffer, 'approved.txt').expect(403);
      await request(app.getHttpServer()).post('/api/clio/attachments').set('x-internal-service-secret', 'wrong-secret')
        .field('filing', f.registrationContext()).attach('file', f.upload.buffer, 'approved.txt').expect(403);
      const first = await request(app.getHttpServer()).post('/api/clio/attachments').set('x-internal-service-secret', 'synthetic-secret')
        .field('filing', f.registrationContext()).attach('file', f.upload.buffer, 'approved.txt').expect(201);
      const repeat = await request(app.getHttpServer()).post('/api/clio/attachments').set('x-internal-service-secret', 'synthetic-secret')
        .field('filing', f.registrationContext()).attach('file', f.upload.buffer, 'renamed.txt').expect(201);
      expect(repeat.body).toEqual(first.body); expect(first.body.status).toBe('pending');
      expect(f.tx.clioAttachment.create).toHaveBeenCalledTimes(1); expect(ordinary).toHaveBeenCalledTimes(1);
      await request(app.getHttpServer()).post('/api/clio/attachments').set('x-internal-service-secret', 'synthetic-secret')
        .field('filing', '{').attach('file', f.upload.buffer, 'approved.txt').expect(400);
    } finally { await app.close(); }
  });
});
