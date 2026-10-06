const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const helperModule = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(
    fs.readFileSync(require.resolve('../../src/engagement/krisp/krisp.helpers.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText,
  { exports: helperModule.exports, Date, Set },
);
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(__dirname + '/krisp-backfill.cjs', 'utf8'), {
  module: mod,
  Date,
  Set,
  require: (name) =>
    name.includes('krisp.helpers')
      ? helperModule.exports
      : name.includes('engagement-access')
        ? { ownMeetingWhere: (userId) => ({ createdByUserId: userId }) }
        : require(name),
});
const { backfillKrisp } = mod.exports;

function fixture() {
  const id = 'a'.repeat(32);
  const state = { writes: 0, processed: 0, item: null, meetings: [] };
  const tx = {
    $queryRaw: async () => [],
    meeting: {
      findMany: async () => state.meetings,
      findFirst: async () => state.meetings[0],
      upsert: async ({ create, update }) => {
        assert.deepEqual(Object.keys(update), []);
        state.writes++;
        const meeting = { id: 'meeting', ...create };
        state.meetings.push(meeting);
        return meeting;
      },
    },
    krispMeetingImport: {
      findUnique: async () => state.item,
      upsert: async ({ create }) => {
        state.writes++;
        state.item = { id: 'import', ...create };
        return state.item;
      },
    },
    meetingNote: { findFirst: async () => ({ body: 'exact Krisp notes' }) },
    meetingDebrief: { findFirst: async () => ({ body: 'exact Krisp notes' }) },
  };
  const args = {
    prisma: {
      withTenantUser: async (tenantId, userId, fn) => {
        assert.equal(tenantId, 'tenant');
        assert.equal(userId, 'user');
        return fn(tx);
      },
    },
    ctx: { tenantId: 'tenant', userId: 'user' },
    preference: { id: 'pref', serverId: 'server', tenantId: 'tenant', userId: 'user' },
    since: new Date('2026-01-01T05:00:00Z'),
    until: new Date('2026-10-01T00:00:00Z'),
    createHistorical: true,
    crypto: { decrypt: (row) => row.body },
    service: {
      assertActive: async () => {},
      assertActiveTx: async () => {},
      read: async (_ctx, name) =>
        name === 'search_meetings'
          ? {
              meetings: [
                {
                  meeting_id: id,
                  name: 'Past meeting',
                  date: '2026-02-01T15:00:00Z',
                  end_time: '2026-02-01T16:00:00Z',
                },
              ],
              count: 1,
            }
          : { results: [{ id, document: { id, notes: 'exact Krisp notes' } }] },
      process: async () => {
        state.processed++;
        Object.assign(state.item, { status: 'done', noteId: 'note', debriefId: 'debrief' });
      },
    },
  };
  return { args, state };
}

test('dry-run inventories notes without creating meetings, imports, or artifacts', async () => {
  const { args, state } = fixture();
  const report = await backfillKrisp(args);
  assert.equal(report.ready, 1);
  assert.equal(report.historical, 1);
  assert.equal(state.writes, 0);
  assert.equal(state.processed, 0);
});
test('apply creates private unassigned history, invokes the direct importer, verifies both artifacts, and is restart-safe', async () => {
  const { args, state } = fixture();
  args.apply = true;
  const report = await backfillKrisp(args);
  assert.equal(report.completed, 1);
  assert.equal(state.meetings[0].visibility, 'private');
  assert.equal(state.meetings[0].clientId, null);
  assert.equal(state.meetings[0].createdByUserId, 'user');
  assert.equal((await backfillKrisp(args)).alreadyDone, 1);
  assert.equal(state.writes, 2);
  assert.equal(state.processed, 1);
});
test('skipped imports are preserved, and unmatched meetings require historical opt-in', async () => {
  const { args, state } = fixture();
  args.apply = true;
  args.createHistorical = false;
  assert.equal((await backfillKrisp(args)).needsMatch, 1);
  assert.equal(state.writes, 0);
  state.item = { status: 'skipped' };
  assert.equal((await backfillKrisp(args)).failed, 1);
  assert.equal(state.processed, 0);
});
test('wrong tenant and revoked consent fail before any write', async () => {
  const { args, state } = fixture();
  args.apply = true;
  args.preference.tenantId = 'other';
  await assert.rejects(backfillKrisp(args));
  args.preference.tenantId = 'tenant';
  args.service.assertActive = async () => {
    throw new Error('revoked');
  };
  await assert.rejects(backfillKrisp(args), /revoked/);
  assert.equal(state.writes, 0);
});
