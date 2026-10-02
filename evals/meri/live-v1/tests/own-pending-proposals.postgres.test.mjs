import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createMemoryCandidateOwnerPort } from '../fixture-provisioning/memory-candidate-owner.mjs';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { AUTHORIZED_TENANTS } from '../fixture-provisioning/contract.mjs';
import {
  withOwnedApprovedMemory,
  TENANT,
  CLIENT,
  PROPOSER,
  REVIEWER,
} from './approved-memory-postgres-harness.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const config = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;

it(
  'actual own-proposal SQL returns all six case17 scopes over pages without crossing owner, tenant or wall',
  { skip: !config },
  async () => {
    await withOwnedApprovedMemory(config, async ({ deps, manifest, tx }) => {
      process.env.MEMORY_CLIENT_REVIEW = 'enforce';
      await tx.$executeRawUnsafe(
        "ALTER TABLE clients ADD COLUMN name text DEFAULT 'Synthetic client'",
      );
      await tx.$executeRawUnsafe(
        "UPDATE tenant_memberships SET role='standard_user' WHERE user_id=$1::uuid",
        REVIEWER,
      );
      const { GovernedMemoryCandidateService } = require(
        fileURLToPath(
          new URL(
            '../../../../apps/api/src/memory/governed-memory-candidate.service.ts',
            import.meta.url,
          ),
        ),
      );
      // Read path runs the actual service method against the real Prisma ORM.
      const service = Object.assign(Object.create(GovernedMemoryCandidateService.prototype), {
        governedPrisma: deps.prisma,
      });
      const owner = createMemoryCandidateOwnerPort({ ...deps, actorForTenant: () => REVIEWER });
      const records = manifest.records.filter((row) =>
        /^MEM-PENDING-17-[A-F]$/u.test(row.logicalId),
      );
      assert.equal(records.length, 6);
      for (const record of records) {
        await owner.create(record, {
          tenantId: TENANT,
          physicalId: record.physicalId,
          expectedOwnershipMarkerSha256: record.ownership.markerSha256,
          expectedRowVersion: null,
        });
        assert.equal((await owner.read(record)).payloadSha256, record.payloadSha256);
      }
      const foreign = await buildFixtureManifest({
        fixtureInstanceId: randomUUID(),
        clients: manifest.clients,
      });
      const privateOther = foreign.records.find((row) => row.logicalId === 'MEM-PENDING-17-F');
      await createMemoryCandidateOwnerPort({ ...deps, actorForTenant: () => PROPOSER }).create(
        privateOther,
        {
          tenantId: TENANT,
          physicalId: privateOther.physicalId,
          expectedOwnershipMarkerSha256: privateOther.ownership.markerSha256,
          expectedRowVersion: null,
        },
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO memory_candidate(id,tenant_id,proposed_by,scope,status,source_kind,payload_jsonb)
      VALUES($1::uuid,$2::uuid,$3::uuid,'personal','pending','model_extraction','{}')`,
        randomUUID(),
        AUTHORIZED_TENANTS.T2.id,
        REVIEWER,
      );

      const ctx = { tenantId: TENANT, userId: REVIEWER, role: 'standard_user' };
      const candidates = [];
      let cursor,
        pages = 0;
      do {
        const page = await service.listOwnProposals(ctx, {
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        assert.equal(page.enabled, true);
        candidates.push(...page.candidates);
        cursor = page.nextCursor;
        assert.ok(++pages <= 4, 'bounded keyset traversal');
      } while (cursor);
      assert.equal(candidates.length, 6);
      assert.equal(pages, 3);
      assert.deepEqual(
        candidates.map((row) => row.id).sort(),
        records.map((row) => row.physicalId).sort(),
      );
      const privateId = records.find((row) => row.logicalId.endsWith('-F')).physicalId;
      assert.equal(candidates.find((row) => row.id === privateId).scope, 'personal');
      assert.ok(
        candidates.every((row) => !row.restricted && row.proposal && row.capabilities.withdraw),
      );
      const other = await service.listOwnProposals({ ...ctx, userId: PROPOSER });
      assert.deepEqual(
        other.candidates.map((row) => row.id),
        [privateOther.physicalId],
      );

      await tx.$executeRawUnsafe('UPDATE clients SET memory_wall=true WHERE id=$1::uuid', CLIENT);
      const walled = await service.listOwnProposals(ctx);
      assert.equal(walled.candidates.length, 6);
      assert.ok(
        walled.candidates
          .filter((row) => row.clientId === CLIENT)
          .every((row) => row.restricted && row.proposal === null && row.clientName === null),
      );
      assert.equal(
        walled.candidates.find((row) => row.id === privateId).proposal.value,
        'Synthetic pending proposal MEM-PENDING-17-F',
      );
    });
  },
);
