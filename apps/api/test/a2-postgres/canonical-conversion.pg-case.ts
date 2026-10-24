import { expect, it, jest } from '@jest/globals';
import { HttpException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { requireOwnerClient } from '../../src/clients/client-ordered-owner.access.js';
import {
  parseProspectConversion,
  prospectConversionDigest,
} from '../../src/business-development/prospect-conversion.types.js';
import type { admissionsFixture } from './admissions-fixture.js';
import { prospect } from './admissions-fixture.js';
import { actor, client, ctx, id, settled, tenant } from './fixture.js';

type Fixture = Awaited<ReturnType<typeof admissionsFixture>>;
function barrier() {
  let enter!: () => void, release!: () => void;
  return {
    reached: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    proceed: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}
async function bounded<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Canonical interleaving operation timed out')),
          3500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function queuedRemoval(h: Fixture) {
  const until = Date.now() + 3500;
  while (Date.now() < until) {
    const rows = await h.sql(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND application_name='a2-fixture-admin' AND wait_event_type='Lock'
      AND query LIKE 'DELETE FROM tenant_memberships WHERE%'`);
    if (rows.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Expected member removal lock wait was not observed');
}

/** Real SQL/Prisma/owners; wrappers only pause after completed real queries.
 * No authority, canonical-match result, transaction or write is fabricated. */
export function canonicalConversionCase(get: () => Fixture) {
  it('refuses a canonical match while the client owner holds its row, then observes member removal', async () => {
    const h = get(),
      canonical = id(170),
      ownerGate = barrier(),
      conversionGate = barrier();
    const command = parseProspectConversion(prospect, {
      schemaVersion: 1,
      requestId: id(171),
      prospectId: prospect,
      expectedUpdatedAt: '2026-10-23T00:00:00.000Z',
      mode: 'new_client',
      clientName: 'Synthetic first',
      clientWebsite: null,
      clientDescription: null,
    });
    await h.sql(
      `INSERT INTO canonical_entities(id,canonical_name,normalized_name,entity_type)
      VALUES($1,'Synthetic canonical organization','synthetic canonical organization','organization')`,
      [canonical],
    );
    await h.sql('UPDATE clients SET canonical_entity_id=$1 WHERE id=$2', [canonical, client]);
    await h.sql('UPDATE business_development_prospects SET canonical_entity_id=$1 WHERE id=$2', [
      canonical,
      prospect,
    ]);
    const owner = settled(
      h.prisma.withTenant(tenant, (tx) =>
        requireOwnerClient(
          new Proxy(tx, {
            get(target, property) {
              if (property !== '$queryRaw') return Reflect.get(target, property);
              return async (...args: Parameters<typeof tx.$queryRaw>) => {
                const result = await target.$queryRaw(...args);
                const sql = Array.isArray(args[0]) ? args[0].join('?') : '';
                if (sql.includes('FROM clients') && sql.includes('FOR UPDATE')) {
                  ownerGate.enter();
                  await ownerGate.proceed;
                }
                return result;
              };
            },
          }),
          ctx,
          client,
        ),
      ),
    );
    let conversion: ReturnType<typeof settled> | undefined;
    let removal: ReturnType<typeof settled> | undefined;
    let failure: unknown;
    const actual = h.prisma.withTenant.bind(h.prisma);
    const intercept = jest.spyOn(h.prisma, 'withTenant');
    try {
      await bounded(ownerGate.reached);
      intercept.mockImplementationOnce((tenantId, work, options) =>
        actual(
          tenantId,
          (tx) =>
            work(
              new Proxy(tx, {
                get(target, property) {
                  if (property !== 'client') return Reflect.get(target, property);
                  return new Proxy(target.client, {
                    get(delegate, method) {
                      if (method !== 'findFirst') return Reflect.get(delegate, method);
                      return async (args: Prisma.ClientFindFirstArgs) => {
                        const result = await delegate.findFirst(args);
                        if (args.where?.canonicalEntityId === canonical) {
                          conversionGate.enter();
                          await conversionGate.proceed;
                        }
                        return result;
                      };
                    },
                  });
                },
              }),
            ),
          options,
        ),
      );
      conversion = settled(h.prospects.convertCommand(ctx, prospect, command));
      await bounded(conversionGate.reached);
      removal = settled(
        h.sql('DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2', [tenant, actor]),
      );
      await queuedRemoval(h);
      // Keep the real client row locked until refusal settles. The old fallback
      // would wait on that row; no compatible membership SHARE queue is assumed.
      conversionGate.release();
      const refused = await bounded(conversion);
      expect(refused.error).toBeInstanceOf(HttpException);
      expect((refused.error as HttpException).getResponse()).toMatchObject({
        schemaVersion: 1,
        code: 'PROSPECT_NEW_CLIENT_REFUSED',
        requestId: command.requestId,
        prospectId: prospect,
        payloadDigest: prospectConversionDigest(command),
        status: 409,
      });
      const deleted = await bounded(removal);
      expect(deleted.error).toBeUndefined();
      expect(deleted.value).toMatchObject({ rowCount: 1 });
      ownerGate.release();
    } catch (error) {
      failure = error;
    } finally {
      ownerGate.release();
      conversionGate.release();
      intercept.mockRestore();
    }
    // Drain every transaction even after a failed synchronization assertion.
    const [owned, converted, removed] = await Promise.all([owner, conversion, removal]);
    if (failure) throw failure;
    expect(converted?.error).toMatchObject({ status: 409 });
    expect((converted?.error as HttpException).getResponse()).toMatchObject({
      code: 'PROSPECT_NEW_CLIENT_REFUSED',
      requestId: id(171),
    });
    expect(removed).toBeDefined();
    expect(removed?.error).toBeUndefined();
    expect(owned.error).toMatchObject({ status: 403 });
    expect(
      (
        await h.sql('SELECT linked_client_id FROM business_development_prospects WHERE id=$1', [
          prospect,
        ])
      ).rows[0].linked_client_id,
    ).toBeNull();
    for (const table of [
      'prospect_conversion_receipts',
      'business_development_prospect_activity',
      'audit_logs',
    ])
      expect((await h.sql(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0);
    expect(
      (
        await h.sql(
          `SELECT count(*)::int AS count FROM clients WHERE tenant_id=$1 AND status<>'archived'`,
          [tenant],
        )
      ).rows[0].count,
    ).toBe(1);
  });
}
