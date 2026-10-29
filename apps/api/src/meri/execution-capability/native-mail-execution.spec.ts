import { BadRequestException } from '@nestjs/common';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { singleMailHash, SingleMailLedger } from '../../engagement/single-mail-ledger.js';
import { nativeCanonicalSha256 as hash, parseApprovalProposal } from '../native-approvals/native-approval.contract.js';
import { receiveNativeMail } from './native-mail-execution.js';
import { nativeMailInput, parseNativeMailArguments } from './native-mail-command.js';

const id = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = Date.parse('2026-10-27T03:00:00.000Z');
function fixture(mode: 'send' | 'reply' | 'reply_all' | 'forward' = 'send', general = false) {
  const state = { now: NOW, member: true, wall: true, mailbox: true, email: 'sender@example.test', revoked: false,
    decision: true, bootstrap: true, selectedClientId: general ? null : id(7), identityRevision: 'a'.repeat(64),
    beforeClaim: () => {}, afterSend: () => {}, loseResponse: false, disposition: 'accepted', row: null as any,
    files: [] as any[], loaded: [] as any[] };
  const ctx: any = { tenantId: id(1), userId: id(2), role: 'standard_user' };
  const binding = { tenantId: id(1), actorId: id(2), conversationId: id(3), runId: id(4), attemptId: id(5), workerId: id(6), writerFence: 1 };
  const args = parseNativeMailArguments({ mode, clientId: general ? null : id(7), senderConnectionId: id(20), senderEmail: state.email,
    to: ['recipient@example.test'], cc: [], bcc: [], subject: 'Reviewed subject', bodyHtml: '<p>Reviewed body</p>', files: [],
    original: mode === 'send' ? null : { threadId: id(21), messageId: id(22), updatedAt: new Date(NOW - 60000).toISOString(),
      bodySha256: mode === 'forward' ? 'f'.repeat(64) : null } });
  const command = { contractVersion: '0.2.0', commandId: id(8), binding, action: 'mail.send', arguments: args, attachments: [],
    scopes: [{ tenantId: id(1), kind: general ? 'private-user' : 'client', resourceId: general ? id(2) : id(7), policyRevision: 'p1' }], idempotencyKey: 'mail-synthetic' };
  const proposal = { proposalId: id(9), command, commandSha256: hash(command), createdAt: new Date(NOW - 10000).toISOString(),
    expiresAt: new Date(NOW + 30000).toISOString(), requiredApprover: { tenantId: id(1), actorId: id(2) } };
  const decision = () => ({ tenantId: id(1), proposalId: proposal.proposalId, commandSha256: proposal.commandSha256, decision: 'approved',
    decidedAt: new Date(NOW - 5000), expiresAt: new Date(proposal.expiresAt), approverUserId: id(2), policyRevision: 'p1',
    bindingActorUserId: id(2), conversationId: id(3), runId: id(4) });
  const tx: any = {
    $queryRaw: jest.fn(async (sql: any, ...values: any[]) => {
      const text = Array.isArray(sql) ? sql.join('?') : sql.sql;
      if (text.includes('clock_timestamp')) return [{ db_now: new Date(state.now) }];
      if (text.includes('FROM single_mail_intents')) return state.row ? [JSON.parse(JSON.stringify(state.row))] : [];
      if (text.includes('SELECT c.id')) return state.wall ? values[1].map((id: string) => ({ id })) : [];
      return [];
    }),
    tenantMembership: { findFirst: async () => state.member ? { role: 'standard_user', tenant: { status: 'active' } } : null },
    clioConversation: { findFirst: async () => ({ id: id(3), tenantId: id(1), userId: id(2), clientId: state.selectedClientId, status: 'active', archivedAt: null, metadata: null }) },
    clioConversationBootstrapReceipt: { findFirst: async () => state.bootstrap ? { requestId: id(90) } : null },
    integrationConnection: { findFirst: async () => state.mailbox ? { id: id(20), accountEmail: state.email } : null },
    engagementAttachment: { findMany: async () => state.files },
    clioMeriApprovalDecision: { findUnique: async () => state.decision ? decision() : null },
    clioMeriApprovalRevocation: { findUnique: async () => state.revoked ? {} : null },
  };
  const prisma: any = { withTenant: async (_: string, run: any) => run(tx) };
  const provider = jest.fn();
  const engagement: any = {
    getSingleMailIntent: jest.fn(async () => new SingleMailLedger(prisma).view(state.row)),
    sendSingleMail: jest.fn(async (_: unknown, input: any, native: any) => {
      state.row = { id: id(10), request_key: input.requestKey, request_hash: singleMailHash({ input, nativeApproval: native.provenance }),
        connection_id: id(20), client_id: args.clientId, state: 'pending', snapshot: { nativeApproval: native.provenance }, receipt: null };
      state.beforeClaim();
      try { await native.authorize(tx, { attachments: state.loaded }); }
      catch (e) { state.row.state = 'failed'; throw e; }
      state.row.state = 'sending'; provider(input); state.row.state = state.disposition;
      if (state.disposition === 'accepted') state.row.receipt = { ok: true, threadId: id(30), messageId: id(31), provider: 'gmail',
        senderConnectionId: args.senderConnectionId, senderEmail: args.senderEmail, signaturePolicy: 'actor', signatureAppended: true,
        ...(args.original ? { operation: args.mode, originalMessageId: args.original.messageId, originalThreadId: args.original.threadId,
          originalUpdatedAt: args.original.updatedAt, ...(args.mode === 'forward' ? { originalBodySha256: args.original.bodySha256 } : {}) } : {}) };
      state.afterSend(); if (state.loseResponse) throw Error('Lost provider response');
    }),
  };
  const approvals: any = { verifyPrepared: jest.fn(async () => ({ selectedClientId: general ? null : id(7), policyRevision: 'p1', expiresAtMs: state.now + 60000 })) };
  const tenant: any = { readApplicationAuthoritySession: async () => ({ readCurrent: async () => ({
    principal: { tenantId: id(1), actorId: id(2) }, expiresAtMs: state.now + 60000, identityRevision: state.identityRevision }) }) };
  const req: any = { headers: { 'x-internal-service-secret': 'synthetic-secret' }, method: 'POST' };
  new ToolServiceSecretGuard({ get: (key: string) => key === 'INTERNAL_SERVICE_SECRET' ? 'synthetic-secret' : 'production' } as any)
    .canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as any);
  const ports = { prisma, engagement, approvals, tenant };
  const run = (mode: 'execute' | 'read') => receiveNativeMail(ports, req, ctx, { proposal, binding }, mode);
  return { state, args, command, proposal, binding, tx, provider, engagement, approvals, run, req };
}

describe('native mail command developer boundary', () => {
  it.each(['send', 'reply', 'reply_all', 'forward'] as const)('retains exact %s input and recovers accepted receipt without another send', async mode => {
    const f = fixture(mode), first: any = await f.run('execute');
    expect(first.status).toBe('observed'); expect(first.outcome.result.state).toBe('accepted');
    expect(f.provider).toHaveBeenCalledWith(nativeMailInput(f.args, f.proposal.proposalId));
    f.state.revoked = true; f.state.now += 60000;
    expect(await f.run('read')).toEqual({ state: 'OUTCOME', outcome: first.outcome });
    expect(await f.run('execute')).toEqual(first); expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it.each(['pending', 'sending', 'unknown'] as const)('never redispatches a durable %s attempt', async state => {
    const f = fixture(); await f.run('execute'); f.state.row.state = state; f.state.row.receipt = null;
    expect(await f.run('read')).toEqual({ state: 'UNKNOWN' });
    expect(await f.run('execute')).toEqual({ status: 'indeterminate' }); expect(f.engagement.sendSingleMail).toHaveBeenCalledTimes(1);
  });
  it('reads absence without starting an attempt or inventing an expiry proof', async () => {
    const f = fixture('send', true); f.state.decision = false; f.state.now += 60000;
    expect(await f.run('read')).toBeNull(); expect(f.engagement.sendSingleMail).not.toHaveBeenCalled();
  });
  it.each(['revoked', 'email'] as const)('checks changed %s inside the sole sending claim and reports only committed failure', async kind => {
    const f = fixture(); f.state.beforeClaim = () => { if (kind === 'revoked') f.state.revoked = true; else f.state.email = 'changed@example.test'; };
    const result: any = await f.run('execute'); expect(result.outcome.result.state).toBe('failed'); expect(f.provider).not.toHaveBeenCalled();
    await f.run('execute'); expect(f.engagement.sendSingleMail).toHaveBeenCalledTimes(1);
  });
  it('withholds a retained outcome after current conversation or membership loss', async () => {
    const f = fixture(); await f.run('execute'); f.state.member = false;
    await expect(f.run('read')).rejects.toThrow('authority refused'); expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it('refuses changed command content under the same proposal key', async () => {
    const f = fixture(); await f.run('execute'); f.args.bodyHtml = '<p>Different</p>'; f.proposal.commandSha256 = hash(f.command);
    await expect(f.run('execute')).rejects.toThrow('retained decision'); expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it('does not release an accepted state whose local receipt is absent', async () => {
    const f = fixture(); f.state.afterSend = () => { f.state.row.receipt = null; };
    expect(await f.run('execute')).toEqual({ status: 'indeterminate' }); expect(await f.run('read')).toEqual({ state: 'UNKNOWN' });
  });
  it('recovers a lost acknowledgement from the canonical committed receipt', async () => {
    const f = fixture(); f.state.loseResponse = true;
    expect((await f.run('execute') as any).outcome.result.state).toBe('accepted'); expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it('compares approved outgoing file proof against loaded bytes and current metadata', async () => {
    const f = fixture(); f.args.files = [{ attachmentId: id(40), fileName: 'reviewed.txt', contentType: 'text/plain', bytes: 3, sha256: 'a'.repeat(64) }];
    f.proposal.commandSha256 = hash(f.command);
    f.state.files = [{ id: id(40), fileName: 'reviewed.txt', contentType: 'text/plain', byteSize: 3, calculatedSha256: 'a'.repeat(64) }];
    f.state.loaded = [{ name: 'reviewed.txt', contentType: 'text/plain', bytes: 3, sha256: 'b'.repeat(64) }];
    expect((await f.run('execute') as any).outcome.result.state).toBe('failed'); expect(f.provider).not.toHaveBeenCalled();
  });
  it('accepts exact reviewed file bytes and keeps IDs in the canonical sender input', async () => {
    const f = fixture(); f.args.files = [{ attachmentId: id(40), fileName: 'reviewed.txt', contentType: 'text/plain', bytes: 3, sha256: 'a'.repeat(64) }];
    f.proposal.commandSha256 = hash(f.command);
    f.state.files = [{ id: id(40), fileName: 'reviewed.txt', contentType: 'text/plain', byteSize: 3, calculatedSha256: 'a'.repeat(64) }];
    f.state.loaded = [{ name: 'reviewed.txt', contentType: 'text/plain', bytes: 3, sha256: 'a'.repeat(64) }];
    expect((await f.run('execute') as any).outcome.result.state).toBe('accepted'); expect(f.provider.mock.calls[0][0].attachmentIds).toEqual([id(40)]);
  });
  it('admits the closed v0.2 command and rejects unknown fields, noncanonical recipients and unsupported attachment objects', () => {
    const f = fixture(); expect(parseApprovalProposal(f.proposal).command.action).toBe('mail.send');
    for (const args of [{ ...f.args, senderConnectionId: undefined }, { ...f.args, to: ['Recipient@example.test'] },
      { ...f.args, cc: f.args.to }, { ...f.args, extra: true }]) expect(() => parseNativeMailArguments(args)).toThrow(BadRequestException);
    f.command.attachments = [{}] as never; f.proposal.commandSha256 = hash(f.command);
    expect(() => parseApprovalProposal(f.proposal)).toThrow();
  });
});
