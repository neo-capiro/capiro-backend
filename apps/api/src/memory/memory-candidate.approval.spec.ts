import { ForbiddenException } from '@nestjs/common';
import { MemoryCandidateService } from './memory-candidate.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryIngestService } from './memory-ingest.service.js';
import type { AppConfig } from '../config/config.schema.js';
import type { ConfigService } from '@nestjs/config';

/**
 * Segregation of duties on the live `POST /memory/candidates/:id/approve` route.
 *
 * The route is guarded by `@Roles('user_admin')`, which proves the caller is an
 * admin but says nothing about independence — before this gate, an admin could
 * propose a firm-scope institutional claim and ratify it alone in the next call,
 * because `getPendingOrThrow` never even read `proposed_by`.
 *
 * These tests stop at the gate on purpose: the assertion is that approval is
 * refused *before* any memory write is attempted, which is observable as
 * `withTenant` having been called exactly once (the candidate load).
 */
function makeService(candidate: { id: string; payload: unknown; proposedBy: string; scope: string }) {
  const findFirst = jest.fn(async () => candidate);
  const withTenant = jest.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({ memoryCandidate: { findFirst } }),
  );
  const prisma = { withTenant } as unknown as PrismaService;
  const ingest = {} as unknown as MemoryIngestService;
  const config = { get: jest.fn(() => undefined) } as unknown as ConfigService<AppConfig, true>;
  const service = new MemoryCandidateService(prisma, ingest, config);
  return { service, withTenant };
}

const PAYLOAD = { key: 'firm-position:fy27', value: 'The firm supports the plus-up.' };

describe('MemoryCandidateService.approve — independent reviewer', () => {
  it('refuses a firm-scope proposer approving their own candidate, before any write', async () => {
    const { service, withTenant } = makeService({
      id: 'cand-1',
      payload: PAYLOAD,
      proposedBy: 'admin-1',
      scope: 'firm',
    });

    await expect(service.approve('tenant-1', 'cand-1', 'admin-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(withTenant).toHaveBeenCalledTimes(1); // candidate load only — no commit, no markDecided
  });

  it('refuses a client-scope proposer approving their own candidate', async () => {
    const { service, withTenant } = makeService({
      id: 'cand-2',
      payload: PAYLOAD,
      proposedBy: 'admin-1',
      scope: 'client',
    });

    await expect(service.approve('tenant-1', 'cand-2', 'admin-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(withTenant).toHaveBeenCalledTimes(1);
  });

  it('lets an independent reviewer past the gate on the same firm candidate', async () => {
    const { service } = makeService({
      id: 'cand-3',
      payload: PAYLOAD,
      proposedBy: 'admin-1',
      scope: 'firm',
    });

    // A different approver must NOT be refused by the independence gate. The call
    // still fails further downstream (clio_memory is not stubbed here), so assert
    // specifically that the failure is not the independence refusal.
    await expect(
      service.approve('tenant-1', 'cand-3', 'admin-2'),
    ).rejects.not.toBeInstanceOf(ForbiddenException);
  });

  it('leaves personal-scope self-approval alone — nobody else can review it', async () => {
    const { service } = makeService({
      id: 'cand-4',
      payload: PAYLOAD,
      proposedBy: 'user-1',
      scope: 'personal',
    });

    await expect(
      service.approve('tenant-1', 'cand-4', 'user-1'),
    ).rejects.not.toBeInstanceOf(ForbiddenException);
  });
});
