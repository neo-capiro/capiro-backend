import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { reviewDatabase } from './client-profile-fill-review.postgres-fixture.js';
import { readReviewSnapshot, reviewHash } from './client-profile-fill-review-snapshot.js';
import { ClientProfileFillFindingReview } from './client-profile-fill-finding-review.js';
import { clientIntelligenceReads } from '../intelligence/client-read-cache.js';
import { ClientProfileFillService } from './client-profile-fill.service.js';
import { ClientsService } from './clients.service.js';
import { ClientPeopleService } from './client-people.service.js';
import { ClientCapabilitiesService } from './client-capabilities.service.js';
import { ClientFacilitiesService } from './client-facilities.service.js';
import { ClientMappingV1Review } from '../intelligence/client-mapping-v1-review.js';
import { ClientAdvocacyMatterService } from './client-advocacy-matter.service.js';
import type { ReviewCommand } from './client-profile-fill-review-store.js';

const url = process.env.FILL_REVIEW_TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'reviewed finding application through actual PostgreSQL owners',
  () => {
    let store: Awaited<ReturnType<typeof reviewDatabase>>,
      ctx: TenantContext,
      clientId: string,
      runId: string;
    let reviewer: ClientProfileFillFindingReview;
    let matters: ClientAdvocacyMatterService;
    const index = jest.fn(),
      warn = jest.fn();
    beforeAll(async () => {
      store = await reviewDatabase(url!);
    }, 60000);
    afterAll(async () => {
      await store?.db.$disconnect();
    });
    beforeEach(async () => {
      index.mockReset();
      warn.mockReset();
      const tenantId = randomUUID(),
        userId = randomUUID();
      clientId = randomUUID();
      runId = randomUUID();
      ctx = {
        tenantId,
        userId,
        clerkUserId: 'synthetic-' + userId,
        tenantSlug: 'synthetic-' + tenantId,
        role: 'user_admin',
      };
      await store.db.tenant.create({
        data: { id: tenantId, slug: ctx.tenantSlug, name: 'Synthetic', status: 'active' },
      });
      await store.db.user.create({
        data: { id: userId, clerkUserId: ctx.clerkUserId, email: userId + '@example.invalid' },
      });
      await store.db.tenantMembership.create({
        data: { tenantId, userId, role: ctx.role, status: 'active' },
      });
      await store.db.client.create({
        data: { id: clientId, tenantId, name: 'Synthetic', status: 'active' },
      });
      await store.db.$executeRawUnsafe(
        `INSERT INTO client_profile_fill_run (id,tenant_id,client_id,created_by_user_id,status)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'completed')`,
        runId,
        tenantId,
        clientId,
        userId,
      );
      const scoped = Object.assign(Object.create(store.scoped), {
        withTenant: (tenant: string, fn: Parameters<typeof store.scoped.withTenantUser>[2]) =>
          store.scoped.withTenantUser(tenant, ctx.userId, fn),
      });
      const kb = {
        indexClientProfileFireAndForget: index,
        indexPersonFireAndForget: index,
        indexFacilityFireAndForget: index,
      };
      const clients = new ClientsService(
        scoped,
        { get: (key: string) => (key === 'AWS_REGION_DEFAULT' ? 'us-east-1' : undefined) } as never,
        {} as never,
        {} as never,
        {} as never,
        kb as never,
      );
      const people = new ClientPeopleService(scoped, kb as never);
      const facilities = new ClientFacilitiesService(scoped, kb as never);
      jest
        .spyOn(facilities as any, 'geocodeFacilityFireAndForget')
        .mockImplementation(() => undefined);
      const capabilities = new ClientCapabilitiesService(
        scoped,
        { embedCapabilityFireAndForget: index } as never,
        {} as never,
      );
      const mappings = new ClientMappingV1Review(scoped, {
        awardBearingMappingSource: () => false,
        prepopulation: () => undefined,
        clientReads: () => clientIntelligenceReads(scoped),
      });
      const intelligence = {
        createManualMappingInTransaction: mappings.createManualMappingInTransaction.bind(mappings),
      };
      const fill = new ClientProfileFillService(
        scoped,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        intelligence as never,
        clients,
        people,
        facilities,
        capabilities,
        {} as never,
        {} as never,
      );
      matters = new ClientAdvocacyMatterService(scoped, {} as never);
      reviewer = new ClientProfileFillFindingReview(scoped, fill, matters, {
        warn,
        safeError: () => 'Synthetic failure',
        getRun: async () => ({ id: runId }),
        confirmedMappingKeys: async () => new Set(),
      });
    });
    const finding = async (
      kind: string,
      targetKey: string,
      proposedValue: unknown,
      currentValue: unknown = null,
    ) => {
      const id = randomUUID();
      await store.db.$executeRawUnsafe(
        `INSERT INTO client_profile_fill_finding
      (id,run_id,tenant_id,client_id,kind,target_key,source,fact_kind,current_value_jsonb,proposed_value_jsonb,confidence,content_hash)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,'public_web','recommendation',$7::jsonb,$8::jsonb,0.8,$9)`,
        id,
        runId,
        ctx.tenantId,
        clientId,
        kind,
        targetKey,
        JSON.stringify(currentValue),
        JSON.stringify(proposedValue),
        reviewHash({ id, proposedValue }),
      );
      return id;
    };
    const snapshot = () => readReviewSnapshot(store.scoped, ctx, clientId, runId);
    const command = async (ids?: string[]): Promise<ReviewCommand> => {
      const review = await snapshot();
      return {
        requestId: randomUUID(),
        expectedClientRevision: review.clientRevision,
        findings: review.findings
          .filter((f) => !ids || ids.includes(f.id))
          .map((f) => ({ id: f.id, revision: f.revision })),
      };
    };
    const apply = (input: ReviewCommand) => reviewer.applyFindings(ctx, clientId, runId, input);
    const status = async (id: string) =>
      (
        await store.db.$queryRawUnsafe<Array<{ status: string }>>(
          'SELECT status FROM client_profile_fill_finding WHERE id=$1::uuid',
          id,
        )
      )[0]?.status;

    test('only selected findings use canonical writers and concurrent replay creates no duplicates', async () => {
      const selected = await Promise.all([
        finding('profile_field', 'website', 'https://approved.example/'),
        finding('person', 'contact', { name: 'Synthetic Person' }),
        finding('facility', 'office', { name: 'Synthetic Office' }),
        finding('capability', 'product', { name: 'Synthetic Product' }),
        finding('lda_identity', 'lda', { externalId: '123', externalName: 'Synthetic LDA' }),
      ]);
      const omitted = await finding('profile_field', 'description', 'Unselected');
      const input = await command(selected);
      const result = await Promise.all([apply(input), apply(input)]);
      expect(result.map((r) => r.replayed).sort()).toEqual([false, true]);
      expect(result[0]!.applied.sort()).toEqual(selected.sort());
      expect(result[0]!.errors).toEqual([]);
      expect(await status(omitted)).toBe('pending');
      expect(
        (await store.db.client.findUnique({ where: { id: clientId } }))?.description,
      ).toBeNull();
      for (const table of [
        'client_people',
        'client_facilities',
        'client_capabilities',
        'client_intel_mapping',
      ]) {
        const [row] = await store.db.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT count(*)::int AS count FROM ${table} WHERE client_id=$1::uuid`,
          clientId,
        );
        expect(row?.count).toBe(1);
      }
      expect(await store.db.auditLog.count({ where: { id: input.requestId } })).toBe(1);
    });
    test.each(['client', 'person'] as const)(
      'a newer %s revision prevents stale application',
      async (kind) => {
        await finding('profile_field', 'website', 'https://approved.example/');
        const person = await store.db.clientPerson.create({
          data: { tenantId: ctx.tenantId, clientId, name: 'Before' },
        });
        const input = await command();
        if (kind === 'client')
          await store.db.client.update({
            where: { id: clientId },
            data: { description: 'Newer human edit' },
          });
        else
          await store.db.clientPerson.update({
            where: { id: person.id },
            data: { name: 'Newer human edit' },
          });
        await expect(apply(input)).resolves.toMatchObject({ status: 'refused', applied: [] });
        expect(index).not.toHaveBeenCalled();
      },
    );
    test('changed evidence or selected inputs cannot be accepted using an old review', async () => {
      const id = await finding('profile_field', 'website', 'https://approved.example/');
      const input = await command();
      await store.db.$executeRawUnsafe(
        `UPDATE client_profile_fill_finding SET evidence_jsonb='[{"label":"changed"}]'::jsonb WHERE id=$1::uuid`,
        id,
      );
      await expect(apply(input)).resolves.toMatchObject({ status: 'refused', applied: [] });
      expect(await status(id)).toBe('pending');
    });
    test('a refused request remains refused on replay, even after the client changes again', async () => {
      await finding('profile_field', 'website', 'https://approved.example/');
      const input = await command();
      await store.db.client.update({
        where: { id: clientId },
        data: { description: 'Newer edit' },
      });
      const result = await apply(input);
      expect(result.status).toBe('refused');
      await store.db.client.update({ where: { id: clientId }, data: { description: null } });
      expect(await apply(input)).toEqual({ ...result, replayed: true });
      expect((await store.db.client.findUnique({ where: { id: clientId } }))?.website).toBeNull();
    });
    test('restoring identical finding content does not revive an older review token', async () => {
      const id = await finding('profile_field', 'website', 'https://approved.example/');
      const input = await command();
      await store.db.$executeRawUnsafe(
        `UPDATE client_profile_fill_finding SET updated_at=clock_timestamp() WHERE id=$1::uuid`,
        id,
      );
      expect((await apply(input)).status).toBe('refused');
      expect(await status(id)).toBe('pending');
    });
    test('a failed finding rolls back its domain write while reporting other successes', async () => {
      const good = await finding('profile_field', 'website', 'https://approved.example/');
      const bad = await finding('profile_field', 'description', 'rollback-only');
      await store.db
        .$executeRawUnsafe(`ALTER TABLE audit_logs ADD CONSTRAINT synthetic_finding_failure CHECK
      (after_jsonb->'value' IS DISTINCT FROM '"rollback-only"'::jsonb)`);
      try {
        const input = await command(),
          result = await apply(input);
        expect(result.applied).toEqual([good]);
        expect(result.errors.map((e) => e.findingId)).toEqual([bad]);
        expect(await status(good)).toBe('accepted');
        expect(await status(bad)).toBe('pending');
        expect(
          (await store.db.client.findUnique({ where: { id: clientId } }))?.description,
        ).toBeNull();
        expect(await apply(input)).toEqual({ ...result, replayed: true });
      } finally {
        await store.db.$executeRawUnsafe(
          'ALTER TABLE audit_logs DROP CONSTRAINT synthetic_finding_failure',
        );
      }
    });
    test('receipt failure rolls back all selected writes and never indexes uncommitted content', async () => {
      const id = await finding('profile_field', 'website', 'https://approved.example/'),
        input = await command();
      await store.db.$executeRawUnsafe(
        `ALTER TABLE audit_logs ADD CONSTRAINT synthetic_receipt_failure CHECK(id<>'${input.requestId}'::uuid)`,
      );
      try {
        await expect(apply(input)).rejects.toBeDefined();
        expect(await status(id)).toBe('pending');
        expect((await store.db.client.findUnique({ where: { id: clientId } }))?.website).toBeNull();
        expect(index).not.toHaveBeenCalled();
      } finally {
        await store.db.$executeRawUnsafe(
          'ALTER TABLE audit_logs DROP CONSTRAINT synthetic_receipt_failure',
        );
      }
    });
    test.each(['wall', 'archive', 'membership', 'role', 'tenant'] as const)(
      'current %s changes block application and receipt recovery',
      async (kind) => {
        await finding('profile_field', 'website', 'https://approved.example/');
        const input = await command();
        await apply(input);
        if (kind === 'wall')
          await store.db.client.update({ where: { id: clientId }, data: { memoryWall: true } });
        if (kind === 'archive')
          await store.db.client.update({ where: { id: clientId }, data: { status: 'archived' } });
        if (kind === 'membership')
          await store.db.tenantMembership.updateMany({
            where: { tenantId: ctx.tenantId, userId: ctx.userId },
            data: { status: 'removed' },
          });
        if (kind === 'role')
          await store.db.tenantMembership.updateMany({
            where: { tenantId: ctx.tenantId, userId: ctx.userId },
            data: { role: 'standard_user' },
          });
        if (kind === 'tenant')
          await store.db.tenant.update({
            where: { id: ctx.tenantId },
            data: { status: 'suspended' },
          });
        await expect(apply(input)).rejects.toMatchObject({
          status: kind === 'wall' || kind === 'archive' ? 404 : 403,
        });
      },
    );
    test('receipt replay binds the original selection and never adopts changed inputs', async () => {
      await finding('profile_field', 'website', 'https://approved.example/');
      const input = await command();
      await apply(input);
      await expect(
        apply({ ...input, expectedClientRevision: 'a'.repeat(64) }),
      ).rejects.toMatchObject({ status: 409 });
    });
    test('a failed post-commit index cannot change the saved successful result', async () => {
      await finding('profile_field', 'website', 'https://approved.example/');
      const input = await command();
      index.mockImplementationOnce(() => {
        throw Error('synthetic index outage');
      });
      const result = await apply(input);
      expect(result.applied).toHaveLength(1);
      expect(result.errors).toEqual([]);
      expect(await apply(input)).toEqual({ ...result, replayed: true });
      expect(index).toHaveBeenCalledTimes(1);
    });
    test('review snapshots cannot read another client or run', async () => {
      await finding('profile_field', 'website', 'https://approved.example/');
      const other = await store.db.client.create({
        data: { tenantId: ctx.tenantId, name: 'Other' },
      });
      await expect(readReviewSnapshot(store.scoped, ctx, other.id, runId)).rejects.toMatchObject({
        status: 404,
      });
    });
    test('explicit new Matter and finding acceptance commit once with exact target replay', async () => {
      const id = await finding('advocacy_record', 'record', {
        externalKey: 'synthetic-record',
        title: 'Synthetic advocacy',
        recordType: 'federal_lobbying',
        sourceType: 'lda',
      });
      const input = await command(),
        target = { newMatter: { title: 'Approved Matter' } };
      const result = await reviewer.applyAdvocacyFindingToMatter(
        ctx,
        clientId,
        runId,
        id,
        target,
        input,
      );
      expect(result.errors).toEqual([]);
      expect(result.applied).toEqual([id]);
      expect(
        (await reviewer.applyAdvocacyFindingToMatter(ctx, clientId, runId, id, target, input))
          .replayed,
      ).toBe(true);
      const [row] = await store.db.$queryRawUnsafe<Array<{ count: number }>>(
        'SELECT count(*)::int AS count FROM client_advocacy_matter WHERE client_id=$1::uuid',
        clientId,
      );
      expect(row?.count).toBe(1);
      await expect(
        reviewer.applyAdvocacyFindingToMatter(
          ctx,
          clientId,
          runId,
          id,
          { newMatter: { title: 'Changed' } },
          input,
        ),
      ).rejects.toMatchObject({ status: 409 });
    });
    test('regulatory outcomes and accepted status survive replay without duplicate outcome events', async () => {
      const matterId = randomUUID();
      await store.db.$executeRawUnsafe(
        `INSERT INTO client_advocacy_matter (id,tenant_id,client_id,title,external_key)
      VALUES ($1::uuid,$2::uuid,$3::uuid,'Synthetic Matter','synthetic')`,
        matterId,
        ctx.tenantId,
        clientId,
      );
      const id = await finding('regulatory_outcome', 'outcome', {
        matterId,
        documentNumber: '2026-synthetic',
        docketId: 'Synthetic docket',
      });
      const input = await command(),
        result = await apply(input);
      expect(result.applied).toEqual([id]);
      expect(result.errors).toEqual([]);
      await apply(input);
      expect(await store.db.outcomeEvent.count({ where: { clientId } })).toBe(1);
      const [links] = await store.db.$queryRawUnsafe<Array<{ count: number }>>(
        'SELECT count(*)::int AS count FROM client_advocacy_matter_link WHERE matter_id=$1::uuid',
        matterId,
      );
      expect(links?.count).toBe(1);
    });
    test('missing or foreign Matter rolls back the record and leaves the finding pending', async () => {
      const id = await finding('advocacy_record', 'record', {
        externalKey: 'synthetic-record',
        title: 'Synthetic advocacy',
        recordType: 'federal_lobbying',
        sourceType: 'lda',
      });
      const result = await reviewer.applyAdvocacyFindingToMatter(
        ctx,
        clientId,
        runId,
        id,
        { matterId: randomUUID() },
        await command(),
      );
      expect(result.applied).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(await status(id)).toBe('pending');
      const [row] = await store.db.$queryRawUnsafe<Array<{ count: number }>>(
        'SELECT count(*)::int AS count FROM client_advocacy_record WHERE client_id=$1::uuid',
        clientId,
      );
      expect(row?.count).toBe(0);
    });
    test('accepted and rejected findings report their actual state without a second write', async () => {
      const accepted = await finding('profile_field', 'website', 'https://approved.example/');
      await apply(await command());
      const rejected = await finding('profile_field', 'description', 'Rejected');
      await store.db.$executeRawUnsafe(
        `UPDATE client_profile_fill_finding SET status='rejected',reviewed_by=$2::uuid,reviewed_at=now() WHERE id=$1::uuid`,
        rejected,
        ctx.userId,
      );
      const result = await apply(await command());
      expect(result.applied).toEqual([]);
      expect(result.alreadyApplied).toEqual([accepted]);
      expect(result.errors.map((e) => e.findingId)).toEqual([rejected]);
      expect(await status(rejected)).toBe('rejected');
    });
    test('explicit assignment keeps existing human reassign and detach corrections available', async () => {
      const id = await finding('advocacy_record', 'record', {
        externalKey: 'synthetic-record',
        title: 'Synthetic advocacy',
        recordType: 'federal_lobbying',
        sourceType: 'lda',
      });
      await reviewer.applyAdvocacyFindingToMatter(
        ctx,
        clientId,
        runId,
        id,
        { newMatter: { title: 'Initial' } },
        await command(),
      );
      const target = randomUUID();
      await store.db.$executeRawUnsafe(
        `INSERT INTO client_advocacy_matter (id,tenant_id,client_id,title,external_key)
      VALUES ($1::uuid,$2::uuid,$3::uuid,'Corrected','correction')`,
        target,
        ctx.tenantId,
        clientId,
      );
      const [record] = await store.db.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM client_advocacy_record WHERE client_id=$1::uuid',
        clientId,
      );
      await matters.reassignRecord(ctx, clientId, record!.id, target);
      await matters.detachRecord(ctx, clientId, record!.id);
      const [after] = await store.db.$queryRawUnsafe<
        Array<{ matter_id: string | null; matter_locked: boolean }>
      >('SELECT matter_id,matter_locked FROM client_advocacy_record WHERE id=$1::uuid', record!.id);
      expect(after).toEqual({ matter_id: null, matter_locked: true });
      expect(await status(id)).toBe('accepted');
    });
  },
);
