import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type {
  OutreachProposalRow,
  OutreachSessionRow,
  OutreachStateRepository,
} from '../persistence/outreach-state.repository.js';
import {
  parseOutreachCommandEnvelope,
  type ApplyOutreachCommandBatchInput,
} from '../state/outreach-command.contract.js';
import { hashNormalizedOutreachCommands } from '../state/outreach-command-normalization.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import type { OutreachCommandEngineService } from './outreach-command-engine.service.js';
import { OutreachCommandProposalService } from './outreach-command-proposal.service.js';

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  tenantSlug: 'test',
  userId: '00000000-0000-4000-8000-000000000002',
  clerkUserId: 'user_test',
  role: 'standard_user',
} as TenantContext;

const session: OutreachSessionRow = {
  id: '00000000-0000-4000-8000-000000000010',
  tenantId: ctx.tenantId,
  createdByUserId: ctx.userId,
  status: 'active',
  currentStateVersion: 1,
  title: null,
  createdAt: new Date('2026-08-08T00:00:00Z'),
  updatedAt: new Date('2026-08-08T00:00:00Z'),
  archivedAt: null,
};

const proposalId = '00000000-0000-4000-8000-000000000020';
const commands = [
  parseOutreachCommandEnvelope({
    type: 'SET_GOAL',
    schemaVersion: 1,
    payload: { value: 'Protect the program' },
  }),
];

const proposal: OutreachProposalRow = {
  id: proposalId,
  tenantId: ctx.tenantId,
  sessionId: session.id,
  createdByUserId: ctx.userId,
  source: 'user',
  expectedStateVersion: 1,
  commandsJsonb: commands,
  commandsHash: hashNormalizedOutreachCommands(commands),
  status: 'pending',
  createdAt: new Date('2026-08-08T00:01:00Z'),
  decidedAt: null,
  decidedByUserId: null,
  appliedStateVersion: null,
  rejectionCode: null,
};

function buildHarness(overrides?: {
  session?: OutreachSessionRow;
  proposal?: OutreachProposalRow;
}) {
  const tx = {
    $executeRaw: jest.fn(async () => 1),
  };
  const prisma = {
    withTenantUser: jest.fn(
      async (_tenantId: string, _userId: string, fn: (value: unknown) => unknown) => fn(tx),
    ),
  } as unknown as PrismaService;

  const repository = {
    lockOwnedSession: jest.fn(async () => overrides?.session ?? session),
    lockOwnedProposal: jest.fn(async () => overrides?.proposal ?? proposal),
    markProposalApplied: jest.fn(async () => undefined),
    appendEvent: jest.fn(async () => ({ id: 'event' })),
    rejectProposal: jest.fn(async () => undefined),
    createProposal: jest.fn(async () => proposal),
    listOwnedProposals: jest.fn(async () => [proposal]),
  } as unknown as OutreachStateRepository;

  const parseNormalizeAndValidateBatch = jest.fn(
    (input: ApplyOutreachCommandBatchInput) => input,
  );
  const applyBatchWithinTx = jest.fn(async () => ({
    status: 'applied' as const,
    batchId: 'server-batch',
    stateVersion: 2,
    specHash: 'a'.repeat(64),
    changed: true,
    commandCount: 1,
    replayed: false,
  }));
  const commandEngine = {
    parseNormalizeAndValidateBatch,
    applyBatchWithinTx,
  } as unknown as OutreachCommandEngineService;

  return {
    service: new OutreachCommandProposalService(prisma, repository, commandEngine),
    tx,
    repository: repository as unknown as {
      markProposalApplied: jest.Mock;
      appendEvent: jest.Mock;
      createProposal: jest.Mock;
    },
    parseNormalizeAndValidateBatch,
    applyBatchWithinTx,
  };
}

describe('OutreachCommandProposalService', () => {
  it('uses a server-owned apply batch id rather than the public proposal id', async () => {
    const harness = buildHarness();

    await expect(harness.service.applyProposal(ctx, session.id, proposalId)).resolves.toMatchObject({
      stale: false,
      proposalId,
    });

    expect(harness.parseNormalizeAndValidateBatch).toHaveBeenCalledTimes(1);
    const input = harness.parseNormalizeAndValidateBatch.mock.calls[0]?.[0] as ApplyOutreachCommandBatchInput;
    expect(input.batchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(input.batchId).not.toBe(proposalId);
    expect(input.expectedStateVersion).toBe(1);
    expect(input.commands).toEqual(commands);

    expect(harness.applyBatchWithinTx).toHaveBeenCalledTimes(1);
    expect(harness.repository.markProposalApplied).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      proposalId,
      2,
    );
    expect(harness.repository.appendEvent).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.objectContaining({ id: session.id }),
      expect.objectContaining({
        eventType: 'proposal_applied',
        safeMetadata: expect.objectContaining({
          proposalId,
          commandBatchId: input.batchId,
        }),
      }),
    );
  });

  it('persists a still-pending stale proposal supersession before returning conflict', async () => {
    const staleSession = { ...session, currentStateVersion: 2 };
    const harness = buildHarness({ session: staleSession });

    await expect(harness.service.applyProposal(ctx, session.id, proposalId)).rejects.toMatchObject({
      code: 'OUTREACH_PROPOSAL_STALE',
      httpStatus: 409,
    } satisfies Partial<OutreachCommandError>);

    expect(harness.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(harness.applyBatchWithinTx).not.toHaveBeenCalled();
    expect(harness.repository.appendEvent).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.objectContaining({ id: session.id }),
      expect.objectContaining({ eventType: 'proposal_superseded' }),
    );
  });

  it('surfaces an eagerly superseded proposal as stale rather than generic decided', async () => {
    const superseded = {
      ...proposal,
      status: 'superseded',
      decidedAt: new Date('2026-08-08T00:02:00Z'),
      rejectionCode: 'state_advanced',
    } satisfies OutreachProposalRow;
    const harness = buildHarness({
      session: { ...session, currentStateVersion: 2 },
      proposal: superseded,
    });

    await expect(harness.service.applyProposal(ctx, session.id, proposalId)).rejects.toMatchObject({
      code: 'OUTREACH_PROPOSAL_STALE',
      httpStatus: 409,
      safeMetadata: { currentStateVersion: 2 },
    } satisfies Partial<OutreachCommandError>);
    expect(harness.tx.$executeRaw).not.toHaveBeenCalled();
    expect(harness.applyBatchWithinTx).not.toHaveBeenCalled();
  });

  it('rejects a semantically invalid sponsor proposal before durable creation', async () => {
    const harness = buildHarness();

    await expect(
      harness.service.createProposal(ctx, session.id, {
        expectedStateVersion: 1,
        commands: [
          {
            type: 'SET_SPONSOR_SCOPE',
            schemaVersion: 1,
            payload: {
              kind: 'multi_client',
              label: null,
              clientRefs: [{ clientId: '00000000-0000-4000-8000-000000000030' }],
            },
          },
        ],
      }),
    ).rejects.toBeDefined();

    expect(harness.repository.createProposal).not.toHaveBeenCalled();
  });

  it('does not stamp a proposal applied when the command transaction fails', async () => {
    const harness = buildHarness();
    harness.applyBatchWithinTx.mockRejectedValueOnce(new Error('transaction failed'));

    await expect(harness.service.applyProposal(ctx, session.id, proposalId)).rejects.toThrow(
      'transaction failed',
    );
    expect(harness.repository.markProposalApplied).not.toHaveBeenCalled();
  });
});
