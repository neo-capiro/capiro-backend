jest.mock('../auth/application-current.service.js', () => ({
  ApplicationCurrentService: class {},
}));
jest.mock('./meri-action-proposal.service.js', () => ({ MeriActionProposalService: class {} }));
import { NoteActionService } from './note-action.service.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import {
  assertNoteActionAccess,
  NOTE_ACTION,
  NOTE_ACTION_SCOPE_KEY,
  type NoteActionAccess,
} from './note-action.contract.js';

const id = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222',
  meetingId = '33333333-3333-4333-8333-333333333333';
const ctx = { tenantId: id, userId: other } as TenantContext;
const scope = {
  conversationId: id,
  selectedClientId: null,
  identityRevision: 'a'.repeat(64),
  membershipRevision: 'b'.repeat(64),
  contextRevision: 'c'.repeat(64),
};
const request = { body: 'Deployment follow-up', clientId: id };

function fixture(verified = true) {
  let current = { ...scope, clientIds: [id] },
    status = 'succeeded',
    revoked = false,
    afterCreate = async () => {},
    disposition = 'executed';
  const req = {
    headers: {
      'x-meri-deadline-at': String(Date.now() + 30000),
      'x-internal-service-secret': 'synthetic-only-secret',
    },
  } as unknown as Request;
  if (verified)
    new ToolServiceSecretGuard({
      get: (key: string) =>
        key === 'INTERNAL_SERVICE_SECRET'
          ? 'synthetic-only-secret'
          : key === 'NODE_ENV'
            ? 'test'
            : true,
    } as never).verifyRequest(req);
  const currentOwner = {
    read: jest.fn(async (_ctx, _req, body) => {
      if (
        revoked ||
        _ctx.tenantId !== ctx.tenantId ||
        (body.expect &&
          Object.entries(body.expect).some(
            ([key, value]) => current[key as keyof typeof current] !== value,
          ))
      )
        throw Error('Changed current authority');
      return { ...current };
    }),
  };
  const noteRead = async (access: NoteActionAccess) => {
    await assertNoteActionAccess(access, id, NOTE_ACTION, request, {
      [NOTE_ACTION_SCOPE_KEY]: scope,
    }, status === 'succeeded', true);
    return {
      proposalId: id,
      status,
      policyOutcome: disposition === 'pending_approval' ? 'WARN' : 'PASS',
      request: { bodyHash: 'h', bodyLength: 19, clientId: id },
      context: scope,
      receipt: status === 'succeeded' ? { destination: 'client_document', noteId: id } : null,
    };
  };
  const proposals = {
    create: jest.fn(async (_ctx, body, _turn, _legiwatch, _client, _bizdev, _legdoc, _watch, access: NoteActionAccess) => {
      await assertNoteActionAccess(access, id, NOTE_ACTION, body.input, undefined, false, false);
      await afterCreate();
      // Only an executed save can advance the caller's own revisions.
      if (disposition === 'executed') current = { ...current, membershipRevision: 'd'.repeat(64) };
      return { disposition, proposal: { proposalId: id } };
    }),
    readNote: jest.fn(async (_ctx, _id, access: NoteActionAccess) => noteRead(access)),
  };
  const engagement = { getMeeting: jest.fn(async () => ({ id: meetingId, clientId: id })) };
  const owner = new NoteActionService(currentOwner as never, proposals as never, engagement as never);
  return {
    owner,
    proposals,
    engagement,
    req,
    set: (value: Partial<typeof current>) => {
      current = { ...current, ...value };
    },
    revoke: () => {
      revoked = true;
    },
    setStatus: (value: string) => {
      status = value;
    },
    setDisposition: (value: string) => {
      disposition = value;
    },
    afterEffect: (fn: () => Promise<void>) => {
      afterCreate = fn;
    },
  };
}

describe('native note action current-owner adapter', () => {
  it('saves once directly (no approval) and releases the recorded receipt', async () => {
    const f = fixture();
    const result = await f.owner.prepare(ctx, f.req, { version: 1, context: scope, request });
    expect(result.status).toBe('succeeded');
    expect(f.proposals.create).toHaveBeenCalledTimes(1);
    const sent = f.proposals.create.mock.calls[0]![1] as Record<string, any>;
    expect(sent).toMatchObject({ tool: NOTE_ACTION, surface: 'chat', requireApproval: false });
    // The attended conversation is supplied by the owner, never by the caller.
    expect(sent.input.conversationId).toBe(id);
    expect(sent.input.body).toBe('Deployment follow-up');
    expect(f.proposals.create.mock.calls[0]!.slice(2, 8)).toEqual(Array(6).fill(undefined));
    expect(f.proposals.create.mock.calls[0]![8].scope.conversationId).toBe(id);
    expect(f.proposals.readNote).toHaveBeenCalledTimes(1);
  });
  it('resolves a requested meeting through the canonical owner before any effect', async () => {
    const f = fixture();
    const sent = { body: 'Deployment follow-up', meetingId };
    await f.owner.prepare(ctx, f.req, { version: 1, context: scope, request: sent });
    expect(f.engagement.getMeeting).toHaveBeenCalledWith(ctx, meetingId);
    expect((f.proposals.create.mock.calls[0]![1] as Record<string, any>).input.clientId).toBe(id);
    // A meeting whose actual client does not fit the caller's current context is refused
    // before any write: neither a foreign selected client nor an invisible client passes.
    for (const selectedClientId of [other, null]) {
      const g = fixture();
      g.set({ selectedClientId, clientIds: [] } as never);
      await expect(
        g.owner.prepare(ctx, g.req, {
          version: 1,
          context: { ...scope, selectedClientId },
          request: sent,
        }),
      ).rejects.toThrow();
      expect(g.proposals.create).not.toHaveBeenCalled();
    }
    expect(f.proposals.create).toHaveBeenCalledTimes(1);
  });
  it('withholds the receipt after the effect when current authority is revoked', async () => {
    const f = fixture();
    f.afterEffect(async () => f.revoke());
    await expect(
      f.owner.prepare(ctx, f.req, { version: 1, context: scope, request }),
    ).rejects.toThrow();
    expect(f.proposals.create).toHaveBeenCalledTimes(1);
    expect(f.proposals.readNote).not.toHaveBeenCalled();
  });
  it('reports a lost or partial effect as UNKNOWN and never resaves', async () => {
    const f = fixture();
    f.setDisposition('failed');
    f.setStatus('outcome_unknown');
    const result = (await f.owner.prepare(ctx, f.req, { version: 1, context: scope, request })) as any;
    expect(result.status).toBe('outcome_unknown');
    expect(result.receipt).toBeNull();
    expect(f.proposals.create).toHaveBeenCalledTimes(1);
  });
  it('withholds a genuine future WARN or BLOCK truthfully instead of approving it', async () => {
    for (const [disposition, status] of [
      ['pending_approval', 'proposed'],
      ['blocked', 'blocked'],
    ]) {
      const f = fixture();
      f.setDisposition(disposition!);
      f.setStatus(status!);
      const result = (await f.owner.prepare(ctx, f.req, { version: 1, context: scope, request })) as any;
      expect(result.status).toBe(status);
      expect(result.receipt).toBeNull();
      expect(result.policyOutcome).toBe(disposition === 'pending_approval' ? 'WARN' : 'PASS');
      expect(f.proposals.create).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects malformed authority, impersonation, expiry and a stale revision before any proposal call', async () => {
    const f = fixture();
    const body = { version: 1, context: scope, request };
    for (const key of ['x-capiro-impersonate-tenant', 'x-meri-deadline-at']) {
      const previous = f.req.headers[key];
      f.req.headers[key] = key === 'x-meri-deadline-at' ? '1' : other;
      await expect(f.owner.prepare(ctx, f.req, body)).rejects.toThrow();
      if (previous === undefined) delete f.req.headers[key];
      else f.req.headers[key] = previous;
    }
    // A request that never presented the verified service identity is refused outright.
    const unverified = fixture(false);
    await expect(unverified.owner.prepare(ctx, unverified.req, body)).rejects.toThrow();
    expect(unverified.proposals.create).not.toHaveBeenCalled();
    await expect(
      f.owner.prepare(ctx, f.req, {
        version: 1,
        context: { ...scope, contextRevision: 'd'.repeat(64) },
        request,
      }),
    ).rejects.toThrow();
    expect(f.proposals.create).not.toHaveBeenCalled();
  });
  it('reads the recorded result only while the stored scope is still current', async () => {
    const f = fixture();
    const observation = { version: 1, proposalId: id, context: scope };
    expect((await f.owner.read(ctx, f.req, observation)).status).toBe('succeeded');
    f.set({ contextRevision: 'd'.repeat(64) });
    await expect(f.owner.read(ctx, f.req, observation)).rejects.toThrow();
  });
});
