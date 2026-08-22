import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { OutreachTemplateRepository, type OutreachTemplateApplicationRow } from './outreach-template.repository.js';

const ctx: TenantContext = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  tenantSlug: 'test',
  userId: '00000000-0000-4000-8000-000000000002',
  clerkUserId: 'user_test',
  role: 'standard_user',
} as TenantContext;

function fakePostgresUniqueViolation(): Error & { code: string } {
  // Shape of a real node-postgres error for a unique_violation, as Prisma's
  // raw-query error surfaces it — this is exactly what a losing concurrent
  // `usePublished()` call sees when it loses the (tenant, actor, request_key)
  // race (closeout runbook 3.8).
  const error = new Error(
    'Unique constraint failed on the constraint: `outreach_v3_template_applications_tenant_id_applied_by_us_key`',
  ) as Error & { code: string };
  error.code = '23505';
  return error;
}

function winningApplicationRow(overrides?: Partial<OutreachTemplateApplicationRow>): OutreachTemplateApplicationRow {
  return {
    id: randomUUID(),
    templateId: randomUUID(),
    templateVersionId: randomUUID(),
    sessionId: randomUUID(),
    requestKey: randomUUID(),
    requestFingerprint: 'f'.repeat(64),
    templateContentHash: 'a'.repeat(64),
    resultingStateVersion: 2,
    receiptJsonb: {},
    createdAt: new Date('2026-08-22T00:00:00Z'),
    ...overrides,
  };
}

describe('OutreachTemplateRepository.recordApplication — idempotent replay under a real concurrent race', () => {
  it('the LOSING concurrent insert catches the unique violation, looks up the winner, and returns replayed:true with the WINNER exact fields — never a raw database error', async () => {
    const repository = new OutreachTemplateRepository();
    const winner = winningApplicationRow();
    const queryRaw = jest
      .fn()
      // First call: the losing INSERT ... RETURNING, which the real DB
      // rejects with 23505 because another concurrent request already
      // committed the same (tenant, actor, request_key).
      .mockRejectedValueOnce(fakePostgresUniqueViolation())
      // Second call: recordApplication()'s internal findApplicationByRequestKey()
      // lookup of the row that actually won the race.
      .mockResolvedValueOnce([winner]);
    const executeRaw = jest.fn(async () => 1);
    const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw } as unknown as Parameters<
      OutreachTemplateRepository['recordApplication']
    >[0];

    const result = await repository.recordApplication(tx, ctx, {
      applicationId: randomUUID(),
      template: { id: winner.templateId } as never,
      version: { id: winner.templateVersionId, contentHash: winner.templateContentHash } as never,
      sessionId: 'a-different-session-this-loser-would-have-used',
      requestKey: winner.requestKey,
      requestFingerprint: winner.requestFingerprint, // SAME logical request as the winner
      commandBatch: [],
      resultingStateVersion: 999, // this loser's own (never-committed) result — must NOT leak through
      receipt: { fake: 'loser-receipt' },
    });

    expect(result.replayed).toBe(true);
    expect(result.application).toBe(winner);
    expect(result.application.sessionId).toBe(winner.sessionId);
    expect(result.application.resultingStateVersion).toBe(winner.resultingStateVersion);
    // The provenance INSERT must never run for the loser — only the winner's
    // original recordApplication() call gets to write provenance.
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('a genuinely different request racing on the SAME request key gets a safe 409, not a silent replay of unrelated work', async () => {
    const repository = new OutreachTemplateRepository();
    const winner = winningApplicationRow({ requestFingerprint: 'a'.repeat(64) });
    const queryRaw = jest
      .fn()
      .mockRejectedValueOnce(fakePostgresUniqueViolation())
      .mockResolvedValueOnce([winner]);
    const tx = { $queryRaw: queryRaw, $executeRaw: jest.fn(async () => 1) } as unknown as Parameters<
      OutreachTemplateRepository['recordApplication']
    >[0];

    await expect(
      repository.recordApplication(tx, ctx, {
        applicationId: randomUUID(),
        template: { id: winner.templateId } as never,
        version: { id: winner.templateVersionId, contentHash: winner.templateContentHash } as never,
        sessionId: randomUUID(),
        requestKey: winner.requestKey,
        requestFingerprint: 'b'.repeat(64), // DIFFERENT fingerprint — a genuinely different request
        commandBatch: [],
        resultingStateVersion: 3,
        receipt: {},
      }),
    ).rejects.toMatchObject({ code: 'OUTREACH_TEMPLATE_REQUEST_REUSE' } satisfies Partial<OutreachCommandError>);
  });

  it('a non-unique-violation database error is never swallowed as a replay', async () => {
    const repository = new OutreachTemplateRepository();
    const realError = new Error('connection terminated unexpectedly');
    const tx = {
      $queryRaw: jest.fn().mockRejectedValueOnce(realError),
      $executeRaw: jest.fn(async () => 1),
    } as unknown as Parameters<OutreachTemplateRepository['recordApplication']>[0];

    await expect(
      repository.recordApplication(tx, ctx, {
        applicationId: randomUUID(),
        template: { id: randomUUID() } as never,
        version: { id: randomUUID(), contentHash: 'a'.repeat(64) } as never,
        sessionId: randomUUID(),
        requestKey: randomUUID(),
        requestFingerprint: 'a'.repeat(64),
        commandBatch: [],
        resultingStateVersion: 1,
        receipt: {},
      }),
    ).rejects.toBe(realError);
  });
});
