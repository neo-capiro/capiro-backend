const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(__dirname + '/krisp-debrief-regeneration.cjs', 'utf8'), {
  module: mod,
  require: (name) => name.includes('engagement-access')
    ? { ownMeetingWhere: (userId) => ({ createdByUserId: userId }) }
    : require(name),
});
const { regenerateC2KrispDebriefs } = mod.exports;

function fixture() {
  const note = { id: 'n', bodyCiphertext: 'Krisp notes', iv: 'original', authTag: 'tag' };
  const debrief = { id: 'd', ...note, id: 'd', sharedAt: null, updatedAt: new Date(0) };
  const item = { id: 'i', noteId: 'n', debriefId: 'd', meetingId: 'm' };
  const meeting = { id: 'm', clientId: 'c' };
  const tx = {
    $queryRaw: async () => [],
    krispMeetingImport: { findMany: async ({ cursor }) => cursor ? [] : [item] },
    meetingNote: { findFirst: async () => note },
    meetingDebrief: {
      findFirst: async () => debrief,
      updateMany: async ({ data }) => { Object.assign(debrief, data); return { count: 1 }; },
    },
    meeting: { findFirst: async () => meeting },
  };
  const calls = [];
  const args = {
    prisma: { withTenantUser: async (_tenant, _user, fn) => fn(tx) },
    service: { assertActive: async () => 'direct_notes', assertActiveTx: async () => 'direct_notes' },
    crypto: { decrypt: (row) => row.bodyCiphertext, encrypt: (body) => ({
      bodyCiphertext: body, iv: 'new', authTag: 'tag',
    }) },
    generate: async (_ctx, _meetingId, sourceText) => {
      calls.push(sourceText);
      return { recap: 'Generated debrief' };
    },
    format: (draft) => draft.recap,
    ctx: { tenantId: 't', userId: 'u', tenantSlug: 'c2-strategies' },
    preference: { id: 'p', serverId: 's', tenantId: 't', userId: 'u' },
  };
  return { args, note, debrief, calls };
}

test('dry run inventories eligible direct copies without generating or changing artifacts', async () => {
  const f = fixture();
  const result = await regenerateC2KrispDebriefs(f.args);
  assert.equal(result.eligible, 1);
  assert.equal(result.converted, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.note.bodyCiphertext, 'Krisp notes');
});

test('apply generates debrief from Krisp Meeting Notes and is restart safe', async () => {
  const f = fixture();
  f.args.apply = true;
  const result = await regenerateC2KrispDebriefs(f.args);
  assert.equal(result.converted, 1);
  assert.deepEqual(f.calls, ['Krisp notes']);
  assert.equal(f.note.bodyCiphertext, 'Krisp notes');
  assert.equal(f.debrief.bodyCiphertext, 'Generated debrief');
  assert.equal((await regenerateC2KrispDebriefs(f.args)).changed, 1);
  assert.equal(f.calls.length, 1);
});

test('shared or edited debriefs are never overwritten', async () => {
  const f = fixture();
  f.args.apply = true;
  f.debrief.sharedAt = new Date();
  assert.equal((await regenerateC2KrispDebriefs(f.args)).changed, 1);
  f.debrief.sharedAt = null;
  f.debrief.bodyCiphertext = 'Human edit';
  assert.equal((await regenerateC2KrispDebriefs(f.args)).changed, 1);
  assert.equal(f.calls.length, 0);
});

test('tenant scope is required before reading or generating', async () => {
  const f = fixture();
  f.args.ctx.tenantSlug = 'other-firm';
  await assert.rejects(regenerateC2KrispDebriefs(f.args), /C2 tenant/);
});
