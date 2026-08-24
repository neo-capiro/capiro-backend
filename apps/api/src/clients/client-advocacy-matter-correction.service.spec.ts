import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClientAdvocacyMatterService } from './client-advocacy-matter.service.js';

/**
 * Focused unit coverage for the Matter correction UX added in the closeout
 * PR: manual reassign/detach/not-advocacy on individual records, the
 * matter_locked protection against automatic re-clustering, Matter create,
 * and the outcome-status evidence/confirmation gate. Uses the same
 * $queryRawUnsafe/$executeRawUnsafe mock shape as the raw-SQL service body
 * (see client-advocacy-matter.service.ts) — NOT $queryRaw/$executeRaw,
 * which this service never calls.
 */
describe('ClientAdvocacyMatterService — correction UX', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const userId = 'user-1';
  const ctx = { tenantId, userId } as never;
  const clientId = '22222222-2222-2222-2222-222222222222';
  const matterId = '33333333-3333-3333-3333-333333333333';
  const otherMatterId = '44444444-4444-4444-4444-444444444444';
  const recordId = '55555555-5555-5555-5555-555555555555';

  const makeService = () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async (_query: string, ..._args: unknown[]) => [] as unknown[]),
      $executeRawUnsafe: jest.fn(async (_query: string, ..._args: unknown[]) => 1),
      client: { findFirst: jest.fn(async () => ({ id: clientId })) },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, run: (tenantTx: typeof tx) => Promise<unknown>) => run(tx)),
    };
    return { service: new ClientAdvocacyMatterService(prisma as never), tx, prisma };
  };

  describe('assignMatterForRecord respects matter_locked', () => {
    test('does not touch a locked record — leaves its current matter_id untouched', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ matterId: otherMatterId, locked: true }]);

      const result = await service.assignMatterForRecord(ctx, clientId, 'ext-key-1', {
        recordType: 'federal_lobbying',
        title: 'Support increased funding',
        metadata: {},
        activityDate: null,
      });

      expect(result).toBe(otherMatterId);
      // Only the lock-check SELECT ran — no resolveMatterId INSERT/SELECT,
      // no UPDATE of client_advocacy_record.matter_id.
      expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
      expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    test('a locked, detached record (matterId null) stays unassigned rather than being re-clustered', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ matterId: null, locked: true }]);

      const result = await service.assignMatterForRecord(ctx, clientId, 'ext-key-2', {
        recordType: 'federal_lobbying',
        title: 'Some ask',
        metadata: {},
        activityDate: null,
      });

      expect(result).toBeNull();
      expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    test('an unlocked record still auto-clusters normally', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([{ matterId: null, locked: false }]) // lock check
        .mockResolvedValueOnce([{ id: matterId }]); // resolveMatterId exact-key match

      const result = await service.assignMatterForRecord(ctx, clientId, 'ext-key-3', {
        recordType: 'federal_lobbying',
        title: 'Some ask',
        metadata: { peCode: '0605053A' },
        activityDate: null,
      });

      expect(result).toBe(matterId);
      expect(tx.$executeRawUnsafe).toHaveBeenCalled(); // matter_id UPDATE + touchMatterActivity
    });
  });

  describe('reassignRecord', () => {
    test('reassigns to an existing target Matter and locks the record', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([{ id: otherMatterId }]) // target exists
        .mockResolvedValueOnce([{ matterId }]); // source matter lookup

      await service.reassignRecord(ctx, clientId, recordId, otherMatterId);

      const updateCall = tx.$executeRawUnsafe.mock.calls.find((call) =>
        String(call[0]).includes('UPDATE client_advocacy_record'),
      );
      expect(updateCall).toBeDefined();
      expect(String(updateCall![0])).toContain('matter_locked = true');
      expect(updateCall).toContain(otherMatterId);
    });

    test('throws NotFoundException when the target Matter does not exist', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe.mockResolvedValueOnce([]); // target does not exist

      await expect(service.reassignRecord(ctx, clientId, recordId, otherMatterId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    test('throws NotFoundException when the record does not exist', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([{ id: otherMatterId }]) // target exists
        .mockResolvedValueOnce([]); // record not found

      await expect(service.reassignRecord(ctx, clientId, recordId, otherMatterId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('detachRecord', () => {
    test('sets matter_id NULL and matter_locked true', async () => {
      const { service, tx } = makeService();

      await service.detachRecord(ctx, clientId, recordId);

      const updateCall = tx.$executeRawUnsafe.mock.calls[0]!;
      expect(String(updateCall[0])).toContain('matter_id = NULL');
      expect(String(updateCall[0])).toContain('matter_locked = true');
    });

    test('throws NotFoundException when zero rows changed', async () => {
      const { service, tx } = makeService();
      tx.$executeRawUnsafe.mockResolvedValueOnce(0);

      await expect(service.detachRecord(ctx, clientId, recordId)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('markRecordNotAdvocacy', () => {
    test('sets not_advocacy true, detaches, and locks; persists the reason', async () => {
      const { service, tx } = makeService();

      await service.markRecordNotAdvocacy(ctx, clientId, recordId, 'Attendee was not government staff');

      const updateCall = tx.$executeRawUnsafe.mock.calls[0]!;
      expect(String(updateCall[0])).toContain('not_advocacy = true');
      expect(String(updateCall[0])).toContain('matter_id = NULL');
      expect(updateCall).toContain('Attendee was not government staff');
    });
  });

  describe('createMatter', () => {
    test('creates a manually-keyed, non-auto-generated Matter in planning status', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ id: matterId }]);

      const result = await service.createMatter(ctx, clientId, { title: 'New ask' });

      expect(result).toBe(matterId);
      const insertCall = tx.$queryRawUnsafe.mock.calls[0]!;
      expect(String(insertCall[0])).toContain("'planning'");
      expect(String(insertCall[0])).toContain('false'); // auto_generated = false
      expect(insertCall).toContain('New ask');
    });
  });

  describe('updateMatter — outcome status evidence/confirmation gate', () => {
    test('rejects "successful" with no outcome evidence and no confirmation', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ count: 0 }]); // no outcome_event links

      await expect(
        service.updateMatter(ctx, clientId, matterId, { status: 'successful' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    test('allows "successful" when the Matter already has linked outcome evidence', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ count: 1 }]);

      await service.updateMatter(ctx, clientId, matterId, { status: 'successful' });

      expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    });

    test('allows "successful" with no evidence when confirmOutcome:true is explicit', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ count: 0 }]);

      await service.updateMatter(ctx, clientId, matterId, { status: 'successful', confirmOutcome: true });

      const updateCall = tx.$executeRawUnsafe.mock.calls[0]!;
      expect(updateCall).toContain(true); // confirmOutcomeNow flag bound as $8
    });

    test('"outcome_observed" requires no evidence/confirmation', async () => {
      const { service, tx } = makeService();

      await service.updateMatter(ctx, clientId, matterId, { status: 'outcome_observed' });

      // No evidence SELECT was issued for a non-outcome-claim status.
      expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    });

    test('throws NotFoundException when the Matter does not exist', async () => {
      const { service, tx } = makeService();
      tx.$executeRawUnsafe.mockResolvedValueOnce(0);

      await expect(
        service.updateMatter(ctx, clientId, matterId, { title: 'Renamed' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
