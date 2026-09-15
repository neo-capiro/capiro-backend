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
    const engagement = {
      listMailThreads: jest.fn(async () => []),
      getOutreachRecord: jest.fn(async () => ({})),
    };
    return { service: new ClientAdvocacyMatterService(prisma as never, engagement as never), tx, prisma, engagement };
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

  describe('mergeMatters — provenance preservation', () => {
    test('copies evidence/provenance columns (relationship_type, confidence, provenance, evidence_class) through the link move', async () => {
      const { service, tx } = makeService();
      // Both Matters exist for this tenant/client.
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ id: matterId }, { id: otherMatterId }]);

      await service.mergeMatters(ctx, clientId, matterId, otherMatterId);

      const linkCopyCall = tx.$executeRawUnsafe.mock.calls.find((call) =>
        String(call[0]).includes('INSERT INTO client_advocacy_matter_link'),
      );
      expect(linkCopyCall).toBeDefined();
      const sql = String(linkCopyCall![0]);
      // Every provenance column the link table carries must appear in BOTH
      // the INSERT column list and the SELECT list — dropping any of them
      // silently erases per-link evidence badges/rationale on merge.
      for (const col of ['relationship_type', 'confidence', 'provenance', 'evidence_class', 'metadata_jsonb']) {
        expect(sql).toContain(col);
      }
      expect(String(linkCopyCall![0])).toContain('ON CONFLICT (matter_id, link_type, link_key) DO NOTHING');
      // Source Matter is deleted after the move.
      const deleteCall = tx.$executeRawUnsafe.mock.calls.find((call) =>
        String(call[0]).includes('DELETE FROM client_advocacy_matter'),
      );
      expect(deleteCall).toBeDefined();
    });

    test('is a no-op when source and target are the same Matter', async () => {
      const { service, tx } = makeService();

      await service.mergeMatters(ctx, clientId, matterId, matterId);

      expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    test('throws NotFoundException when either Matter is missing from this client', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ id: matterId }]); // only one found

      await expect(service.mergeMatters(ctx, clientId, matterId, otherMatterId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('createMatter', () => {
    test('creates a manually-keyed, non-auto-generated Matter in planning status and returns { id }', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ id: matterId }]);

      const result = await service.createMatter(ctx, clientId, { title: 'New ask' });

      // Contract: callers (AdvocacyMattersTab's POST, createManualRecord's
      // newMatter path) read `result.id`. Returning the bare UUID string
      // left `created.id` undefined on the frontend and broke the
      // open-detail follow-up.
      expect(result).toEqual({ id: matterId });
      const insertCall = tx.$queryRawUnsafe.mock.calls[0]!;
      expect(String(insertCall[0])).toContain("'planning'");
      expect(String(insertCall[0])).toContain('false'); // auto_generated = false
      expect(insertCall).toContain('New ask');
    });
  });

  describe('createManualRecord (§25 "Add advocacy record")', () => {
    const recordInput = { recordType: 'meeting', title: 'Staff meeting on FY27 ask' };

    test('creates an unassigned record as CLIENT_VERIFIED when no matter and no sourceUrl are given', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ id: recordId }]);

      const result = await service.createManualRecord(ctx, clientId, recordInput);

      expect(result).toBe(recordId);
      const insertCall = tx.$queryRawUnsafe.mock.calls[0]!;
      expect(String(insertCall[0])).toContain('INSERT INTO client_advocacy_record');
      expect(insertCall).toContain('CLIENT_VERIFIED');
      expect(insertCall).toContain(null); // matter_id is null — genuinely unassigned
    });

    test('upgrades to PUBLIC_VERIFIED only when a sourceUrl is separately attached (§25)', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ id: recordId }]);

      await service.createManualRecord(ctx, clientId, { ...recordInput, sourceUrl: 'https://example.gov/comment/123' });

      const insertCall = tx.$queryRawUnsafe.mock.calls[0]!;
      expect(insertCall).toContain('PUBLIC_VERIFIED');
      expect(insertCall).not.toContain('CLIENT_VERIFIED');
    });

    test('assigns to an existing Matter and immediately locks it — a manual creation IS the human decision, nothing to correct later', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ id: matterId }]); // assertMatterBelongsToClient
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ id: recordId }]); // the INSERT

      const result = await service.createManualRecord(ctx, clientId, { ...recordInput, matterId });

      expect(result).toBe(recordId);
      const insertCall = tx.$queryRawUnsafe.mock.calls[1]!;
      // matter_locked is a literal `true` in the SQL text itself (this INSERT
      // never conditionally sets it false), not a bound parameter — assert
      // against the query text, not the parameter array.
      expect(String(insertCall[0])).toContain('matter_locked');
      expect(String(insertCall[0])).toMatch(/\$12::uuid,\s*true,\s*\$13::uuid/);
      expect(insertCall).toContain(matterId);
    });

    test('rejects assigning to a Matter that does not belong to this client', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe.mockResolvedValueOnce([]); // assertMatterBelongsToClient finds nothing

      await expect(
        service.createManualRecord(ctx, clientId, { ...recordInput, matterId: otherMatterId }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    test('creates a brand-new Matter in the same call and assigns the record to it', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ id: matterId }]); // createMatter's own INSERT
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ id: recordId }]); // the record INSERT

      const result = await service.createManualRecord(ctx, clientId, {
        ...recordInput,
        newMatter: { title: 'FY27 Ground Robotics Funding' },
      });

      expect(result).toBe(recordId);
      const recordInsertCall = tx.$queryRawUnsafe.mock.calls[1]!;
      expect(recordInsertCall).toContain(matterId); // the newly-created Matter's id
    });

    test('rejects specifying both an existing matterId and a newMatter in the same call', async () => {
      const { service } = makeService();

      await expect(
        service.createManualRecord(ctx, clientId, { ...recordInput, matterId, newMatter: { title: 'Conflicting' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('assignSpecificMatterForRecord (§22/23 follow-up — human-directed Matter assign from a pending Fill finding)', () => {
    const externalKey = 'lda:2027-q1-1234';

    test('attaches to an existing Matter, locking the record in the same call', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([{ matterId: null, locked: false }]) // lock check: not yet locked
        .mockResolvedValueOnce([{ id: matterId }]); // target Matter exists

      const result = await service.assignSpecificMatterForRecord(
        tx,
        ctx,
        clientId,
        externalKey,
        { matterId },
        '2027-01-15',
      );

      expect(result).toBe(matterId);
      const updateCall = tx.$executeRawUnsafe.mock.calls.find((call) =>
        String(call[0]).includes('UPDATE client_advocacy_record'),
      )!;
      expect(String(updateCall[0])).toContain('matter_locked = true');
      expect(updateCall).toContain(matterId);
      expect(updateCall).toContain(externalKey);
    });

    test('throws NotFoundException when the target Matter does not belong to this client', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([{ matterId: null, locked: false }]) // lock check
        .mockResolvedValueOnce([]); // target Matter not found for this tenant/client

      await expect(
        service.assignSpecificMatterForRecord(tx, ctx, clientId, externalKey, { matterId: otherMatterId }, null),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    test('creates a brand-new Matter and assigns/locks the record to it', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([{ matterId: null, locked: false }]) // lock check
        .mockResolvedValueOnce([{ id: matterId }]); // the new Matter's own INSERT

      const result = await service.assignSpecificMatterForRecord(
        tx,
        ctx,
        clientId,
        externalKey,
        { newMatter: { title: 'FY27 autonomous systems funding request' } },
        '2027-01-15',
      );

      expect(result).toBe(matterId);
      const matterInsertCall = tx.$queryRawUnsafe.mock.calls[1]!;
      expect(String(matterInsertCall[0])).toContain('INSERT INTO client_advocacy_matter');
      expect(String(matterInsertCall[0])).toContain("'planning'");
      expect(matterInsertCall).toContain('FY27 autonomous systems funding request');
      // auto_generated is a literal `false` in the SQL text (same
      // convention as ClientAdvocacyMatterService.createMatter above), not
      // a bound parameter.
      expect(String(matterInsertCall[0])).toMatch(/\$6,\s*false,\s*now\(\)/);
      const recordUpdateCall = tx.$executeRawUnsafe.mock.calls.find((call) =>
        String(call[0]).includes('UPDATE client_advocacy_record'),
      )!;
      expect(recordUpdateCall).toContain(matterId);
    });

    test('idempotent: a SECOND call after the record is already locked is a pure no-op — no second Matter, no re-run UPDATE', async () => {
      const { service, tx } = makeService();
      // The record is already locked to `matterId` from a prior successful
      // call — exactly the state a retry (e.g. markAccepted failed after
      // the first call's transaction committed) would observe.
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ matterId, locked: true }]);

      const result = await service.assignSpecificMatterForRecord(
        tx,
        ctx,
        clientId,
        externalKey,
        { newMatter: { title: 'FY27 autonomous systems funding request' } },
        '2027-01-15',
      );

      expect(result).toBe(matterId);
      // Only the lock-check SELECT ran — no second Matter INSERT, no record UPDATE.
      expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
      expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    test('idempotent: repeating "attach to Matter X" after it already succeeded does not re-run the UPDATE', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ matterId, locked: true }]);

      const result = await service.assignSpecificMatterForRecord(
        tx,
        ctx,
        clientId,
        externalKey,
        { matterId },
        '2027-01-15',
      );

      expect(result).toBe(matterId);
      expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
      expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    test('a human assignment locks the record so a later automatic assignMatterForRecord call cannot re-cluster it', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([{ matterId: null, locked: false }]) // lock check for the human assign
        .mockResolvedValueOnce([{ id: matterId }]); // target exists

      await service.assignSpecificMatterForRecord(tx, ctx, clientId, externalKey, { matterId }, '2027-01-15');

      // Simulate the NEXT Fill re-run's best-effort auto-cluster call for
      // the same record — it must see the lock this call just set and stop.
      const { service: service2, tx: tx2 } = makeService();
      tx2.$queryRawUnsafe.mockResolvedValueOnce([{ matterId, locked: true }]);
      const autoClusterResult = await service2.assignMatterForRecord(ctx, clientId, externalKey, {
        recordType: 'federal_lobbying',
        title: 'Support increased funding',
        metadata: {},
        activityDate: null,
      });
      expect(autoClusterResult).toBe(matterId);
      expect(tx2.$executeRawUnsafe).not.toHaveBeenCalled();
    });
  });

  describe('updateMatter — outcome status evidence/confirmation gate', () => {
    test('rejects transitioning into "successful" with no outcome evidence and no confirmation', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([{ status: 'active' }]) // current status
        .mockResolvedValueOnce([{ count: 0 }]); // no outcome_event links

      await expect(
        service.updateMatter(ctx, clientId, matterId, { status: 'successful' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    test('allows transitioning into "successful" when the Matter already has linked outcome evidence', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([{ status: 'outcome_observed' }])
        .mockResolvedValueOnce([{ count: 1 }]);

      await service.updateMatter(ctx, clientId, matterId, { status: 'successful' });

      expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    });

    test('allows transitioning into "successful" with no evidence when confirmOutcome:true is explicit', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([{ status: 'active' }])
        .mockResolvedValueOnce([{ count: 0 }]);

      await service.updateMatter(ctx, clientId, matterId, { status: 'successful', confirmOutcome: true });

      const updateCall = tx.$executeRawUnsafe.mock.calls[0]!;
      expect(updateCall).toContain(true); // confirmOutcomeNow flag bound as $8
    });

    test('an ordinary edit re-submitting the UNCHANGED outcome status is not re-challenged', async () => {
      const { service, tx } = makeService();
      // Stored status already 'successful' (previously confirmed/evidenced);
      // the edit form always submits the selected status, so a title/summary
      // edit carries status:'successful' with confirmOutcome undefined.
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ status: 'successful' }]);

      await service.updateMatter(ctx, clientId, matterId, { title: 'Renamed', status: 'successful' });

      // No evidence SELECT was issued — only the current-status read.
      expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
      expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
      const updateCall = tx.$executeRawUnsafe.mock.calls[0]!;
      // confirmOutcomeNow stays false on a non-transition — we do NOT stamp
      // a fresh outcome_confirmed_at for an edit that didn't change status.
      expect(updateCall).toContain(false);
    });

    test('"outcome_observed" requires no evidence/confirmation', async () => {
      const { service, tx } = makeService();

      await service.updateMatter(ctx, clientId, matterId, { status: 'outcome_observed' });

      // No status/evidence SELECT was issued for a non-outcome-claim status.
      expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    });

    test('legacy status values (open/resolved/stalled) save without an evidence gate', async () => {
      const { service, tx } = makeService();

      await service.updateMatter(ctx, clientId, matterId, { status: 'resolved' });

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

    test('throws NotFoundException when transitioning the status of a Matter that does not exist', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe.mockResolvedValueOnce([]); // current-status read finds nothing

      await expect(
        service.updateMatter(ctx, clientId, matterId, { status: 'successful', confirmOutcome: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    });
  });

  describe('getTimeline (§18/19, cross-Matter chronology)', () => {
    test('merges records and links from different Matters into one chronological list, newest first', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([
          {
            id: 'rec-1', recordType: 'client_submission', title: 'Older record',
            activityDate: new Date('2026-01-10T00:00:00.000Z'), evidenceClass: 'CLIENT_VERIFIED',
            confidence: 1, matterId, matterTitle: 'Matter A',
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'link-1', linkType: 'meeting', label: 'Newer meeting', linkKey: 'meeting-1',
            evidenceClass: 'PRIVATE_ACTIVITY', confidence: 1,
            metadata: { occurredAt: '2026-03-01T00:00:00.000Z' },
            matterId: otherMatterId, matterTitle: 'Matter B',
          },
        ]);

      const result = await service.getTimeline(ctx, clientId);

      expect(result).toHaveLength(2);
      expect(result[0]!.id).toBe('link-1'); // 2026-03-01 sorts before 2026-01-10
      expect(result[0]!.matterTitle).toBe('Matter B');
      expect(result[1]!.id).toBe('rec-1');
      expect(result[1]!.matterTitle).toBe('Matter A');
    });

    test('a genuinely unassigned record still appears, with matterId/matterTitle null, rather than being dropped', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([
          {
            id: 'rec-unassigned', recordType: 'client_submission', title: 'Unassigned record',
            activityDate: new Date('2026-01-10T00:00:00.000Z'), evidenceClass: 'CLIENT_VERIFIED',
            confidence: 1, matterId: null, matterTitle: null,
          },
        ])
        .mockResolvedValueOnce([]);

      const result = await service.getTimeline(ctx, clientId);

      expect(result).toHaveLength(1);
      expect(result[0]!.matterId).toBeNull();
      expect(result[0]!.matterTitle).toBeNull();
    });

    test('a link with no occurredAt (Strategy-shaped metadata) never enters the timeline — never fabricates a date', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'link-strategy', linkType: 'strategy', label: 'FY27 objective', linkKey: 'strategy-1',
            evidenceClass: null, confidence: null,
            metadata: { strategyId: 'strategy-1', causationClaimed: false }, // no occurredAt
            matterId, matterTitle: 'Matter A',
          },
        ]);

      const result = await service.getTimeline(ctx, clientId);

      expect(result).toHaveLength(0);
    });

    test('an undated record sorts last, not first — matches the nulls-last convention used everywhere else in this file', async () => {
      const { service, tx } = makeService();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([
          {
            id: 'rec-dated', recordType: 'client_submission', title: 'Dated', activityDate: new Date('2026-01-10T00:00:00.000Z'),
            evidenceClass: 'CLIENT_VERIFIED', confidence: 1, matterId, matterTitle: 'Matter A',
          },
          {
            id: 'rec-undated', recordType: 'client_submission', title: 'Undated', activityDate: null,
            evidenceClass: 'CLIENT_VERIFIED', confidence: 1, matterId, matterTitle: 'Matter A',
          },
        ])
        .mockResolvedValueOnce([]);

      const result = await service.getTimeline(ctx, clientId);

      expect(result.map((e) => e.id)).toEqual(['rec-dated', 'rec-undated']);
    });
  });
});
