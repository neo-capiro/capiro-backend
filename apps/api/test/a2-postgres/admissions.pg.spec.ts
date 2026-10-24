import { beforeAll, afterAll, beforeEach, it, expect, jest } from '@jest/globals';
// Only unused import-time collaborators and provider/indexing ports are replaced.
// Actual Prisma, client capacity, all admission services and conversion owners run.
jest.mock('sanitize-html', () => () => {
  throw Error('Unexpected logo/HTML work');
});
jest.mock('../../src/intelligence/entity-resolution.service.js', () => ({
  EntityResolutionService: class {},
  fingerprintName: () => {
    throw Error('Unexpected entity resolution');
  },
}));
jest.mock('../../src/intelligence/client-prepopulation.service.js', () => ({
  ClientPrepopulationService: class {},
}));
jest.mock('../../src/intelligence/sam-entity.service.js', () => ({
  SamEntityEnrichmentService: class {},
}));
jest.mock('../../src/embeddings/client-kb.service.js', () => ({ ClientKbService: class {} }));
jest.mock('../../src/business-development/bizdev-jev.service.js', () => ({
  BIZDEV_JEV_REVIEW_HOOK: 'synthetic-unused-hook',
}));
import {
  admissionsFixture,
  prospect,
  otherProspect,
  archivedClient,
} from './admissions-fixture.js';
import { ctx, tenant, client, foreign, id, release, settled } from './fixture.js';

let h: Awaited<ReturnType<typeof admissionsFixture>>;
beforeAll(async () => {
  h = await admissionsFixture();
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h?.close();
});
const active = async () =>
  (
    await h.sql(
      `SELECT count(*)::int AS count FROM clients WHERE tenant_id=$1 AND status<>'archived'`,
      [tenant],
    )
  ).rows[0].count;
const receiptCommand = (request = 104) => ({
  schemaVersion: 1,
  requestId: id(request),
  prospectId: prospect,
  expectedUpdatedAt: '2026-10-23T00:00:00.000Z',
  mode: 'existing_client',
  clientId: client,
});
const newClientCommand = (request = 105) => ({
  schemaVersion: 1,
  requestId: id(request),
  prospectId: prospect,
  expectedUpdatedAt: '2026-10-23T00:00:00.000Z',
  mode: 'new_client',
  clientName: 'Synthetic first',
  clientWebsite: 'https://example.test',
  clientDescription: null,
});

it('serializes ordinary create versus conversion and two different-prospect conversions at the last slot', async () => {
  for (const mode of ['create-convert', 'two-conversions']) {
    await h.reset();
    const gate = await h.lock('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `client-capacity:${tenant}`,
    ]);
    const pending = Promise.all([
      settled(
        mode === 'create-convert'
          ? h.clients.create(ctx, { name: 'Synthetic manual' })
          : h.prospects.convert(ctx, otherProspect),
      ),
      settled(h.prospects.convert(ctx, prospect)),
    ]);
    try {
      await h.waitForLock('pg_advisory_xact_lock', 2);
    } finally {
      await release(gate);
    }
    const results = await pending;
    expect(results.filter((r) => r.value)).toHaveLength(1);
    expect(results.filter((r) => r.error?.status === 402)).toHaveLength(1);
    expect(await active()).toBe(2);
  }
});
it('serializes CSV against LDA import while preserving per-row outcomes', async () => {
  const results = await Promise.all([
    settled(h.clients.bulkImport(ctx, [{ name: 'Synthetic CSV' }])),
    settled(h.firm.importClients(ctx, [10])),
  ]);
  expect(results.reduce((sum, r) => sum + (r.value?.created ?? 0), 0)).toBe(1);
  expect(await active()).toBe(2);
});
it('serializes restore against create; duplicate restoration consumes once; archive releases capacity', async () => {
  const results = await Promise.all([
    settled(h.clients.update(ctx, archivedClient, { status: 'active' })),
    settled(h.clients.create(ctx, { name: 'Synthetic contender' })),
  ]);
  expect(results.filter((r) => r.value)).toHaveLength(1);
  expect(results.filter((r) => r.error?.status === 402)).toHaveLength(1);
  await h.reset();
  await Promise.all([
    h.clients.update(ctx, archivedClient, { status: 'active' }),
    h.clients.update(ctx, archivedClient, { status: 'active' }),
  ]);
  expect(await active()).toBe(2);
  await h.clients.archive(ctx, archivedClient);
  await h.clients.create(ctx, { name: 'Synthetic replacement' });
  expect(await active()).toBe(2);
});
it('uses fresh billing policy after a row wait', async () => {
  const billing = await h.lock('UPDATE tenants SET client_slots=1 WHERE id=$1', [tenant]);
  const create = settled(h.clients.create(ctx, { name: 'Synthetic blocked' }));
  try {
    await h.waitForLock('FROM tenants');
  } finally {
    await release(billing);
  }
  expect((await create).error).toMatchObject({ status: 402 });
  expect(await active()).toBe(1);
});
it('preserves enforcement-off, comped and trial floor, and refuses a foreign restore', async () => {
  await h.sql('UPDATE tenants SET client_slots=0 WHERE id=$1', [tenant]);
  await h.unenforcedClients.create(ctx, { name: 'Synthetic unenforced' });
  await h.sql(`UPDATE tenants SET billing_status='comped' WHERE id=$1`, [tenant]);
  await h.clients.create(ctx, { name: 'Synthetic comped' });
  await h.sql(`UPDATE tenants SET billing_status='trialing' WHERE id=$1`, [tenant]);
  for (let n = 3; n < 10; n++) await h.clients.create(ctx, { name: `Synthetic trial ${n}` });
  await expect(h.clients.create(ctx, { name: 'Synthetic eleventh' })).rejects.toMatchObject({
    status: 402,
  });
  await expect(
    h.clients.update({ ...ctx, tenantId: foreign }, archivedClient, { status: 'active' }),
  ).rejects.toMatchObject({ status: 404 });
  expect(await active()).toBe(10);
});
it('rolls back actual mapping and conversion-audit failures without consuming capacity', async () => {
  await h.sql(
    `ALTER TABLE client_intel_mapping ADD CONSTRAINT a2_mapping_failure CHECK(source<>'lda')`,
  );
  try {
    expect((await h.firm.importClients(ctx, [10])).created).toBe(0);
  } finally {
    await h.sql('ALTER TABLE client_intel_mapping DROP CONSTRAINT a2_mapping_failure');
  }
  expect(await active()).toBe(1);
  await h.sql(
    `ALTER TABLE audit_logs ADD CONSTRAINT a2_conversion_failure CHECK(action<>'bizdev.prospect.convert')`,
  );
  try {
    await expect(h.prospects.convert(ctx, prospect)).rejects.toThrow();
  } finally {
    await h.sql('ALTER TABLE audit_logs DROP CONSTRAINT a2_conversion_failure');
  }
  expect(await active()).toBe(1);
  expect(
    (
      await h.sql('SELECT linked_client_id FROM business_development_prospects WHERE id=$1', [
        prospect,
      ])
    ).rows[0].linked_client_id,
  ).toBeNull();
  expect(
    (await h.sql('SELECT count(*)::int AS count FROM business_development_prospect_activity'))
      .rows[0].count,
  ).toBe(0);
});
it('commits one exact existing-client receipt with activity and audit, replays without another effect', async () => {
  const [first, replay] = await Promise.all([
    h.prospects.convertCommand(ctx, prospect, receiptCommand()),
    h.prospects.convertCommand(ctx, prospect, receiptCommand()),
  ]);
  expect(replay).toEqual(first);
  expect(await h.prospects.conversionReceipt(ctx, prospect, receiptCommand().requestId)).toEqual(
    first,
  );
  expect(await active()).toBe(1);
  for (const table of [
    'prospect_conversion_receipts',
    'business_development_prospect_activity',
    'audit_logs',
  ])
    expect((await h.sql(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(1);
  await expect(
    h.prospects.convertCommand(ctx, prospect, {
      ...receiptCommand(),
      expectedUpdatedAt: '2026-10-23T00:00:01.000Z',
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it('refuses stale conversion, current wall loss and foreign receipt access', async () => {
  await expect(
    h.prospects.convertCommand(ctx, prospect, {
      ...receiptCommand(),
      expectedUpdatedAt: '2026-10-23T00:00:01.000Z',
    }),
  ).rejects.toMatchObject({ status: 409 });
  await h.prospects.convertCommand(ctx, prospect, receiptCommand());
  await h.sql('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
  await expect(
    h.prospects.conversionReceipt(ctx, prospect, receiptCommand().requestId),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    h.prospects.conversionReceipt(
      { ...ctx, tenantId: foreign },
      prospect,
      receiptCommand().requestId,
    ),
  ).rejects.toMatchObject({ status: 404 });
});
it('holds a current client wall through conversion and rolls back receipt insertion failure', async () => {
  const wall = await h.lock('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
  const convert = settled(h.prospects.convertCommand(ctx, prospect, receiptCommand()));
  try {
    await h.waitForLock('FROM clients');
  } finally {
    await release(wall);
  }
  expect((await convert).error).toMatchObject({ status: 404 });
  await h.sql('UPDATE clients SET memory_wall=false WHERE id=$1', [client]);
  await h.sql(
    `ALTER TABLE prospect_conversion_receipts ADD CONSTRAINT a2_receipt_failure CHECK(request_id<>'${id(104)}'::uuid)`,
  );
  try {
    await expect(h.prospects.convertCommand(ctx, prospect, receiptCommand())).rejects.toThrow();
  } finally {
    await h.sql('ALTER TABLE prospect_conversion_receipts DROP CONSTRAINT a2_receipt_failure');
  }
  expect(
    (
      await h.sql('SELECT linked_client_id FROM business_development_prospects WHERE id=$1', [
        prospect,
      ])
    ).rows[0].linked_client_id,
  ).toBeNull();
  expect((await h.sql('SELECT count(*)::int AS count FROM audit_logs')).rows[0].count).toBe(0);
});

it('creates one new client under concurrent command replay and recovers its exact original receipt', async () => {
  const command = newClientCommand();
  const [first, replay] = await Promise.all([
    h.prospects.convertCommand(ctx, prospect, command),
    h.prospects.convertCommand(ctx, prospect, command),
  ]);
  expect(first.outcome).toBe('created');
  expect(replay).toEqual(first);
  expect(await h.prospects.conversionReceipt(ctx, prospect, command.requestId)).toEqual(first);
  expect(await active()).toBe(2);
  expect(
    (await h.sql('SELECT name,website,description FROM clients WHERE id=$1', [first.clientId]))
      .rows,
  ).toEqual([{ name: 'Synthetic first', website: 'https://example.test', description: null }]);
  expect(
    (await h.sql('SELECT count(*)::int AS count FROM prospect_conversion_receipts')).rows[0].count,
  ).toBe(1);
});
it('new-client capacity and receipt-insert failures roll back the client and prospect together', async () => {
  await h.sql('UPDATE tenants SET client_slots=1 WHERE id=$1', [tenant]);
  await expect(h.prospects.convertCommand(ctx, prospect, newClientCommand())).rejects.toMatchObject(
    { status: 402 },
  );
  expect(await active()).toBe(1);
  expect(
    (
      await h.sql('SELECT linked_client_id FROM business_development_prospects WHERE id=$1', [
        prospect,
      ])
    ).rows[0].linked_client_id,
  ).toBeNull();
  await h.sql('UPDATE tenants SET client_slots=2 WHERE id=$1', [tenant]);
  await h.sql(
    `ALTER TABLE prospect_conversion_receipts ADD CONSTRAINT a2_new_receipt_failure CHECK(request_id<>'${id(105)}'::uuid)`,
  );
  try {
    await expect(h.prospects.convertCommand(ctx, prospect, newClientCommand())).rejects.toThrow();
  } finally {
    await h.sql('ALTER TABLE prospect_conversion_receipts DROP CONSTRAINT a2_new_receipt_failure');
  }
  expect(await active()).toBe(1);
  expect(
    (
      await h.sql('SELECT linked_client_id FROM business_development_prospects WHERE id=$1', [
        prospect,
      ])
    ).rows[0].linked_client_id,
  ).toBeNull();
  expect(
    (await h.sql('SELECT count(*)::int AS count FROM prospect_conversion_receipts')).rows[0].count,
  ).toBe(0);
});
