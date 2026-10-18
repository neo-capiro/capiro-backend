import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

async function moduleUrl(path, replacements = {}) {
  let source = await readFile(new URL(path, import.meta.url), 'utf8');
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(`from '${from}'`, `from '${to}'`);
  return `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
}

const jcsUrl = await moduleUrl('../../../../packages/shared/src/core-retained-jcs.ts');
const wireUrl = await moduleUrl('./history-release-source.ts', { '@capiro/shared/core-retained-jcs': jcsUrl });
const leafUrl = await moduleUrl('./history-release-selected-client-owner.ts');
const batchUrl = await moduleUrl('./history-release-batch-owner.ts', {
  './history-release-source.js': wireUrl,
  './history-release-selected-client-owner.js': leafUrl,
});
const { readHistoryReleaseSource, HistoryReleaseSourceError } = await import(wireUrl);
const { createHistoryReleaseBatchPort } = await import(batchUrl);

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantId = id(1);
const actorId = id(2);
const clientId = id(3);
const principal = { tenantId, actorId };
const ctx = { tenantId, userId: actorId, tenantSlug: 'tenant', clerkUserId: 'user_1', role: 'standard_user' };
const nowMs = 1_000_000;
const subject = n => ({ conversationId: id(n), clientId, scopes: [{
  tenantId, kind: 'client', resourceId: clientId, policyRevision: 'v1',
}] });
const body = subjects => ({ schemaVersion: 1, observationId: id(10), route: 'list',
  responseSha256: 'a'.repeat(64), subjects });
const denied = error => error instanceof HistoryReleaseSourceError && error.code === 'UNAVAILABLE';

function harness(options = {}) {
  const events = [];
  const req = {
    method: 'POST', path: '/api/clio/application-authority/history-release',
    originalUrl: '/api/clio/application-authority/history-release',
    headers: { authorization: 'Bearer live_native' },
    header: name => options.impersonation && name === 'x-capiro-impersonate-tenant' ? id(88) : undefined,
  };
  const identity = (revision = 'c'.repeat(64), expiry = nowMs + 2_000) => ({
    principal, identityRevision: revision, expiresAtMs: expiry,
  });
  const native = {
    readApplicationAuthority: async (selectedReq, selectedCtx) => {
      assert.equal(selectedReq, req);
      assert.equal(selectedCtx, ctx);
      events.push('initial-native');
      return options.initial ?? identity();
    },
    lockOriginalApplicationAuthorityInTransaction: async (selectedReq, selectedCtx, tx) => {
      assert.equal(selectedReq, req);
      assert.equal(selectedCtx, ctx);
      assert.equal(tx, transaction);
      events.push('lock-original-native');
      if (options.lockError) throw options.lockError;
    },
    readFreshApplicationAuthorityInTransaction: async (selectedReq, selectedCtx, tx) => {
      assert.equal(selectedReq, req);
      assert.equal(selectedCtx, ctx);
      assert.equal(tx, transaction);
      events.push('fresh-online-in-transaction');
      if (options.freshError) throw options.freshError;
      return options.fresh ?? identity();
    },
  };
  const transaction = {
    $queryRaw: async (strings, ...args) => {
      const sql = strings.join('?');
      if (sql.includes('FROM clio_conversations')) {
        assert.match(sql, /tenant_id = \?/);
        assert.match(sql, /user_id = \?/);
        assert.match(sql, /FOR SHARE/);
        events.push(`conversation-${args[2]}`);
        return [{ id: args[2], tenantId, userId: actorId, clientId,
          status: options.archived ? 'archived' : 'active', archivedAt: null, metadata: {} }];
      }
      if (sql.includes('FROM clients')) {
        assert.match(sql, /tenant_id = \?/);
        events.push('client');
        return [{ id: clientId, tenantId, status: 'active', memoryWall: false }];
      }
      throw Error('unexpected SQL');
    },
  };
  const prisma = {
    withTenant: async (selectedTenant, run, opts) => {
      assert.equal(selectedTenant, tenantId);
      assert.deepEqual(opts, { isolationLevel: 'RepeatableRead', timeoutMs: 4_000 });
      events.push('transaction-start');
      const result = await run(transaction);
      if (options.commitError) throw options.commitError;
      events.push('transaction-commit');
      return result;
    },
  };
  const port = createHistoryReleaseBatchPort({ req, ctx, native, prisma, now: () => nowMs });
  return { req, ctx, native, prisma, port, events };
}

test('one RR tenant transaction locks native facts, all selected subjects, then observes Clerk before commit', async () => {
  const h = harness();
  const receipt = await readHistoryReleaseSource(body([subject(5), subject(4)]), principal, h.port, () => nowMs)
    .catch(error => { throw Error(`events=${JSON.stringify(h.events)}; ${error.message}`); });
  assert.equal(receipt.responseSha256, 'a'.repeat(64));
  assert.deepEqual(h.events, ['initial-native', 'transaction-start', 'lock-original-native',
    `conversation-${id(4)}`, `conversation-${id(5)}`, 'client', 'fresh-online-in-transaction',
    'transaction-commit']);
});

test('empty list still locks original native facts and makes final online observation', async () => {
  const h = harness();
  const receipt = await readHistoryReleaseSource(body([]), principal, h.port, () => nowMs)
    .catch(error => { throw Error(`events=${JSON.stringify(h.events)}; ${error.message}`); });
  assert.equal(receipt.route, 'list');
  assert.deepEqual(h.events, ['initial-native', 'transaction-start', 'lock-original-native',
    'fresh-online-in-transaction', 'transaction-commit']);
});

test('native target, impersonation and absent exact-provenance method refuse before transaction', async () => {
  for (const change of [
    h => { h.req.path = '/api/clio/application-authority/context'; },
    h => { h.req.originalUrl = '/api/clio/application-authority/history-release/'; },
    h => { h.req.headers.authorization = 'CapiroMeriRead signed'; },
    h => { h.native.lockOriginalApplicationAuthorityInTransaction = undefined; },
  ]) {
    const h = harness(); change(h);
    await assert.rejects(readHistoryReleaseSource(body([]), principal, h.port, () => nowMs), denied);
    assert.deepEqual(h.events, []);
  }
  const h = harness({ impersonation: true });
  await assert.rejects(readHistoryReleaseSource(body([]), principal, h.port, () => nowMs), denied);
  assert.deepEqual(h.events, []);
});

test('identity drift, expiry, subject refusal and failed commit never return a receipt', async () => {
  for (const options of [
    { initial: { principal: { tenantId: id(90), actorId }, identityRevision: 'c'.repeat(64), expiresAtMs: nowMs + 2_000 } },
    { fresh: { principal, identityRevision: 'd'.repeat(64), expiresAtMs: nowMs + 2_000 } },
    { fresh: { principal, identityRevision: 'c'.repeat(64), expiresAtMs: nowMs } },
    { lockError: Error('missing member') },
    { freshError: Error('Clerk revoked') },
    { archived: true },
    { commitError: Error('40001 serialization conflict') },
  ]) {
    const h = harness(options);
    await assert.rejects(readHistoryReleaseSource(body([subject(4)]), principal, h.port, () => nowMs), denied);
    assert.equal(h.events.includes('transaction-commit'), false);
  }
});
