import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { OutreachStateRepository } from '../persistence/outreach-state.repository.js';
import type { OutreachCommandEngineService } from '../services/outreach-command-engine.service.js';
import { OutreachCommandProposalService } from '../services/outreach-command-proposal.service.js';
import { parseOutreachCommandBatch, parseOutreachCommandEnvelope } from './outreach-command.contract.js';
import { OutreachCommandError } from './outreach-command-errors.js';

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  tenantSlug: 'test',
  userId: '00000000-0000-4000-8000-000000000002',
  clerkUserId: 'user_test',
  role: 'standard_user',
} as TenantContext;

function expectDomainError(run: () => unknown, code: string, httpStatus: number) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OutreachCommandError);
    expect(error).toMatchObject({ code, httpStatus });
    return;
  }
  throw new Error(`Expected ${code}`);
}

function largeValidCriteriaCommand(seed: number) {
  const values = Array.from({ length: 100 }, (_, index) =>
    `${String(seed).padStart(2, '0')}-${String(index).padStart(3, '0')}-${'x'.repeat(112)}`,
  );
  return {
    type: 'SET_TARGET_CRITERIA',
    schemaVersion: 1,
    payload: {
      value: {
        notes: 'n'.repeat(4000),
        governmentLevels: ['federal'],
        chambers: ['house', 'senate'],
        committees: values,
        agencies: values.map((value) => `a${value.slice(1)}`),
        states: values.map((value) => `s${value.slice(1)}`),
        relationshipPreference: 'any',
        includeStaff: true,
        includePrincipals: true,
      },
    },
  };
}

describe('Outreach V3 public command boundaries', () => {
  it('maps malformed command envelopes to the frozen bounded 400 contract', () => {
    expectDomainError(
      () => parseOutreachCommandEnvelope({ type: 'NOT_A_COMMAND', schemaVersion: 1, payload: {} }),
      'OUTREACH_COMMAND_INVALID',
      400,
    );
    expectDomainError(
      () => parseOutreachCommandEnvelope({ type: 'SET_GOAL', schemaVersion: 1, payload: { value: 12 } }),
      'OUTREACH_COMMAND_INVALID',
      400,
    );
  });

  it('maps malformed batch envelopes to the frozen bounded 400 contract', () => {
    expectDomainError(
      () => parseOutreachCommandBatch({ expectedStateVersion: 1, commands: [] }),
      'OUTREACH_COMMAND_INVALID',
      400,
    );
  });

  it('rejects an oversized direct batch before mutation', () => {
    const commands = Array.from({ length: 20 }, (_, index) => largeValidCriteriaCommand(index));
    expectDomainError(
      () =>
        parseOutreachCommandBatch({
          batchId: '00000000-0000-4000-8000-000000000100',
          expectedStateVersion: 1,
          commands,
        }),
      'OUTREACH_COMMAND_BATCH_TOO_LARGE',
      413,
    );
  });

  it('rejects an oversized proposal before opening a database transaction', async () => {
    const prisma = {
      withTenantUser: jest.fn(async () => {
        throw new Error('database transaction should not open');
      }),
    } as unknown as PrismaService;
    const service = new OutreachCommandProposalService(
      prisma,
      {} as OutreachStateRepository,
      {} as OutreachCommandEngineService,
    );
    const commands = Array.from({ length: 20 }, (_, index) => largeValidCriteriaCommand(index));

    await expect(
      service.createProposal(ctx, '00000000-0000-4000-8000-000000000010', {
        expectedStateVersion: 1,
        commands,
      }),
    ).rejects.toMatchObject({
      code: 'OUTREACH_COMMAND_BATCH_TOO_LARGE',
      httpStatus: 413,
    });
    expect(prisma.withTenantUser).not.toHaveBeenCalled();
  });
});
