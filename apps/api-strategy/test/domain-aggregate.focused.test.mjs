import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const data = (text) => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const nest = data(
  'export class BadRequestException extends Error {}; export class ForbiddenException extends Error {};',
);
const { BadRequestException, ForbiddenException } = await import(nest);
const source = await readFile(
  new URL('../src/strategy/domain-aggregate.ts', import.meta.url),
  'utf8',
);
const api = await import(
  data(stripTypeScriptTypes(source.replace("'@nestjs/common'", JSON.stringify(nest))))
);
const {
  observeDomainAggregate: observe,
  aggregateSourceKey: key,
  aggregateQuery,
  requireAggregateActor,
} = api;
const client = '11111111-1111-4111-8111-111111111111';
const cutoff = new Date('2026-11-01T06:00:00Z');
const bearer = 'Bearer synthetic';
const snapshot = (fingerprint = 'same', sources = [{ clientId: client }], n = 301) => ({
  fingerprint,
  sources,
  count: (readable) => (readable.has(key(sources[0])) ? n : 0),
});
test('closed scope rejects caller authority/paging/time inputs and normalizes UUID', () => {
  assert.deepEqual(aggregateQuery({ clientId: client.toUpperCase() }), { clientId: client });
  for (const query of [
    { clientId: '' },
    { clientId: null },
    { clientId: [client] },
    { limit: 100 },
    { tenantId: client },
    { asOf: cutoff.toISOString() },
    { cursor: client },
  ])
    assert.throws(() => aggregateQuery(query), BadRequestException);
});
test('complete full-population and true zero have scope, cutoff, server observation and no cap', async () => {
  for (const count of [0, 301]) {
    let reads = 0,
      checks = 0;
    const result = await observe(
      'planner.overdue_unfinished',
      { clientId: client },
      {
        validate: async () => {
          checks++;
        },
      },
      bearer,
      async () => {
        reads++;
        return snapshot('same', undefined, count);
      },
      cutoff,
    );
    assert.equal(result.count, count);
    assert.equal(result.state, 'complete');
    assert.equal(result.complete, true);
    assert.equal(result.capped, false);
    assert.equal(result.asOf, cutoff.toISOString());
    assert.equal(result.deadline.timed, 'strictly_before_asOf');
    assert.deepEqual(result.scope, { kind: 'client', clientId: client });
    assert.ok(Number.isFinite(Date.parse(result.observedAt)));
    assert.equal(reads, 3);
    assert.equal(checks, 2);
  }
});
test('stable denied sources are excluded globally; selected denied/missing scope is forbidden', async () => {
  const links = {
    validate: async () => {
      throw new ForbiddenException();
    },
  };
  const result = await observe('strategy.active', {}, links, bearer, async () => snapshot());
  assert.equal(result.count, 0);
  assert.equal(result.state, 'complete');
  await assert.rejects(
    () => observe('strategy.active', { clientId: client }, links, bearer, async () => snapshot()),
    ForbiddenException,
  );
});
test('absent source bearer cannot become complete zero', async () => {
  await assert.rejects(
    () =>
      observe('strategy.active', {}, { validate: async () => {} }, undefined, async () =>
        snapshot(),
      ),
    ForbiddenException,
  );
});
test('source revocation and newly granted access both withhold value', async () => {
  for (const initiallyAllowed of [true, false]) {
    let check = 0;
    const result = await observe(
      'strategy.active',
      {},
      {
        validate: async () => {
          if ((++check === 1) !== initiallyAllowed) throw new ForbiddenException();
        },
      },
      bearer,
      async () => snapshot(),
    );
    assert.equal(result.state, 'incomplete');
    assert.equal(result.reason, 'authorization_changed');
    assert.equal(result.count, null);
  }
});
test('population edits in either access pass withhold value', async () => {
  for (const changesOn of [2, 3]) {
    let reads = 0;
    const result = await observe(
      'strategy.active',
      {},
      { validate: async () => {} },
      bearer,
      async () => snapshot(++reads >= changesOn ? 'changed' : 'same'),
    );
    assert.equal(result.reason, 'source_changed');
    assert.equal(result.count, null);
  }
});
test('source outage is unavailable, malformed persisted data is incomplete, never zero', async () => {
  const outage = new Error('synthetic upstream unavailable');
  await assert.rejects(
    () =>
      observe(
        'strategy.active',
        {},
        {
          validate: async () => {
            throw outage;
          },
        },
        bearer,
        async () => snapshot(),
      ),
    (error) => error === outage,
  );
  const result = await observe(
    'strategy.active',
    {},
    { validate: async () => {} },
    bearer,
    async () => {
      throw new BadRequestException();
    },
  );
  assert.equal(result.count, null);
  assert.equal(result.reason, 'invalid_source');
});
test('unsafe count is withheld and General sources need no linked source bearer', async () => {
  const result = await observe(
    'planner.overdue_unfinished',
    {},
    { validate: async () => {} },
    undefined,
    async () => snapshot('same', [{ clientId: null }], Number.MAX_SAFE_INTEGER + 1),
  );
  assert.equal(result.count, null);
  assert.equal(result.reason, 'invalid_source');
});
test('current actor is checked even for zero; Strategy feature qualification is bound', async () => {
  const ctx = { tenantId: client, clerkUserId: 'user_fixture' };
  const calls = [];
  const tx = {
    $queryRaw: async (parts, ...args) => {
      calls.push([parts.join('?'), args]);
      return [{ id: client }];
    },
  };
  await requireAggregateActor(tx, ctx, true);
  assert.deepEqual(calls[0][1], [client, 'user_fixture', true]);
  assert.match(calls[0][0], /FOR SHARE OF m,u,t/);
  assert.match(calls[0][0], /strategyPlanner.enabled/);
  await assert.rejects(
    () => requireAggregateActor({ $queryRaw: async () => [] }, ctx),
    ForbiddenException,
  );
});

test('actual canonical link transport distinguishes upstream401 from denied sources for aggregates', async () => {
  const transportNest = data(`export const Injectable=()=>value=>value;
    export class ForbiddenException extends Error {};
    export class ServiceUnavailableException extends Error {};`);
  const { ForbiddenException: Denied, ServiceUnavailableException: Unavailable } = await import(
    transportNest
  );
  const config = data('export class ConfigService {}');
  const raw = await readFile(
    new URL('../src/planner/planner-links.service.ts', import.meta.url),
    'utf8',
  );
  const url = data(
    stripTypeScriptTypes(
      raw
        .replace('@Injectable()', '')
        .replace("'@nestjs/common'", JSON.stringify(transportNest))
        .replace("'@nestjs/config'", JSON.stringify(config)),
    ),
  );
  const { PlannerLinksService } = await import(url);
  const owner = new PlannerLinksService({ get: () => undefined });
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [401, 403, 404, 503]) {
      globalThis.fetch = async () => new Response(null, { status });
      await assert.rejects(
        () =>
          owner.validate({ clientId: client }, bearer, { distinguishAuthenticationFailure: true }),
        status === 401 || status === 503 ? Unavailable : Denied,
      );
    }
    globalThis.fetch = async () => new Response(null, { status: 401 });
    await assert.rejects(() => owner.validate({ clientId: client }, bearer), Denied);
    globalThis.fetch = async () => {
      throw Error('synthetic network failure');
    };
    await assert.rejects(
      () =>
        owner.validate({ clientId: client }, bearer, { distinguishAuthenticationFailure: true }),
      Unavailable,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
