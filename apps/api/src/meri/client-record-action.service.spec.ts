jest.mock('../auth/application-current.service.js', () => ({
  ApplicationCurrentService: class {},
}));
jest.mock('./meri-action-proposal.service.js', () => ({ MeriActionProposalService: class {} }));
import { ClientRecordActionService } from './client-record-action.service.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import {
  assertClientRecordAccess,
  CLIENT_RECORD_SCOPE_KEY,
  type ClientRecordAccess,
} from './client-record-action.contract.js';
const id = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222';
const ctx = { tenantId: id, userId: other } as TenantContext;
const scope = {
  conversationId: id,
  selectedClientId: null,
  identityRevision: 'a'.repeat(64),
  membershipRevision: 'b'.repeat(64),
  contextRevision: 'c'.repeat(64),
};
function fixture() {
  let current = { ...scope, clientIds: [id] },
    status = 'proposed',
    revoked = false;
  const request = {
    operation: 'update_client_profile' as const,
    input: { clientId: id, name: 'New' },
  };
  const req = {
    headers: {
      'x-meri-deadline-at': String(Date.now() + 30000),
      'x-internal-service-secret': 'synthetic-only-secret',
    },
  } as unknown as Request;
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
        throw Error('changed');
      return { ...current };
    }),
  };
  const proposals = {
    readClientRecord: jest.fn(async (_ctx, _id, access: ClientRecordAccess) => {
      await assertClientRecordAccess(
        access,
        id,
        request.operation,
        request.input,
        { [CLIENT_RECORD_SCOPE_KEY]: scope },
        status === 'succeeded',
        true,
      );
      return { status, request, context: scope };
    }),
    approveAndExecute: jest.fn(async (_ctx, _id, _unused, access: ClientRecordAccess) => {
      await assertClientRecordAccess(access, id, request.operation, request.input, {
        [CLIENT_RECORD_SCOPE_KEY]: scope,
      });
      status = 'succeeded';
      current = { ...current, membershipRevision: 'd'.repeat(64) };
    }),
    dismiss: jest.fn(),
    create: jest.fn(),
  };
  const owner = new ClientRecordActionService(currentOwner as never, proposals as never);
  return {
    owner,
    proposals,
    currentOwner,
    req,
    set: (value: Partial<typeof current>) => {
      current = { ...current, ...value };
    },
    revoke: () => {
      revoked = true;
    },
  };
}
describe('client record current-owner adapter', () => {
  it('returns the terminal own-edit receipt through a separate fresh read, while an old approval stays invalid', async () => {
    const f = fixture(),
      body = { version: 1, proposalId: id, context: scope, decision: 'approved' };
    expect((await f.owner.decide(ctx, f.req, body)).status).toBe('succeeded');
    expect(
      (await f.owner.read(ctx, f.req, { version: 1, proposalId: id, context: scope })).status,
    ).toBe('succeeded');
    await expect(f.owner.decide(ctx, f.req, body)).rejects.toThrow();
    expect(f.proposals.approveAndExecute).toHaveBeenCalledTimes(1);
  });
  it('does not let fresh observation rescue a changed pending proposal', async () => {
    const f = fixture();
    f.set({ membershipRevision: 'd'.repeat(64) });
    await expect(
      f.owner.read(ctx, f.req, { version: 1, proposalId: id, context: scope }),
    ).rejects.toThrow();
    expect(f.proposals.approveAndExecute).not.toHaveBeenCalled();
  });
  it('withholds a terminal receipt after actual current access denial or target loss', async () => {
    for (const revoke of [false, true]) {
      const f = fixture();
      await f.owner.decide(ctx, f.req, {
        version: 1,
        proposalId: id,
        context: scope,
        decision: 'approved',
      });
      if (revoke) f.revoke();
      else f.set({ clientIds: [] });
      await expect(
        f.owner.read(ctx, f.req, { version: 1, proposalId: id, context: scope }),
      ).rejects.toThrow();
      expect(f.proposals.approveAndExecute).toHaveBeenCalledTimes(1);
    }
  });
  it('answers the retained closed envelope to version 1 and the preflight only to a negotiated version 2', async () => {
    const f = fixture();
    await f.owner.read(ctx, f.req, { version: 1, proposalId: id, context: scope });
    expect(f.proposals.readClientRecord).toHaveBeenLastCalledWith(ctx, id, expect.anything(), false);
    await f.owner.read(ctx, f.req, { version: 2, proposalId: id, context: scope });
    expect(f.proposals.readClientRecord).toHaveBeenLastCalledWith(ctx, id, expect.anything(), true);
    // An envelope version nobody negotiated is refused before any proposal read.
    await expect(
      f.owner.read(ctx, f.req, { version: 3, proposalId: id, context: scope }),
    ).rejects.toThrow();
  });
  it('rejects malformed authority, impersonation and expired request before any proposal call', async () => {
    const f = fixture(),
      body = {
        version: 1,
        context: { conversationId: id, selectedClientId: null },
        request: { operation: 'create_client', input: { name: 'Sample' } },
      };
    for (const key of ['x-capiro-impersonate-tenant', 'x-meri-deadline-at']) {
      f.req.headers[key] = key === 'x-meri-deadline-at' ? '1' : other;
      await expect(f.owner.prepare(ctx, f.req, body)).rejects.toThrow();
      delete f.req.headers[key];
    }
    expect(f.proposals.create).not.toHaveBeenCalled();
  });
});
