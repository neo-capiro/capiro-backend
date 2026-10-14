import test from 'node:test';
import assert from 'node:assert/strict';
import harness from './canonical-harness.cjs';
import { openSavedRevision, openPlannerOccurrence } from './receiver.mjs';
const { fixture, ids, binding, hashSnapshot, nest, sourceReceipt } = harness;
const fileSelection = { draftId: ids.draft, versionId: ids.version };
const calendarSelection = { taskId: ids.task, occurrence: 'due', destinationVersion: 5 };
function receiving(h, change = (value) => value) {
  const requests = [];
  return { requests, isCurrent: () => true, hashSnapshot,
    async request(request) {
      requests.push(request);
      const url = new URL(request.path, 'https://synthetic.invalid/');
      assert.deepEqual([...url.searchParams.keys()], ['clientId', 'objectiveId', 'objectiveVersion']);
      const input = { clientId: url.searchParams.get('clientId'), objectiveId: url.searchParams.get('objectiveId'),
        objectiveVersion: Number(url.searchParams.get('objectiveVersion')) };
      if (request.owner === 'workspace') {
        assert.equal(url.pathname, `/drafts/${ids.draft}/versions/${ids.version}/objective-destination`);
        return change(await h.file(input));
      }
      assert.equal(request.owner, 'strategy');
      assert.equal(url.pathname, `/planner/tasks/${ids.task}/objective-destination`);
      return change(await h.calendar(input));
    } };
}
const code = (expected) => (error) => error.code === expected;
test('exact canonical source receipts and bounded qualification scope', (t) => {
  t.diagnostic(JSON.stringify(sourceReceipt()));
});
test('Files returns the exact owner saved snapshot/hash and immutable revision UUID', async () => {
  const h = fixture(), options = receiving(h);
  const result = await openSavedRevision(fileSelection, binding, options);
  assert.equal(result.destination.resourceId, ids.version);
  assert.equal(result.destination.draftId, ids.draft);
  assert.equal(result.destination.objectiveRevisionId, ids.revision);
  assert.equal(result.snapshotHash, hashSnapshot(h.state.snapshot));
  assert.equal(result.snapshot, h.state.snapshot);
  assert.equal(options.requests.length, 1);
  assert.equal(h.transactions, 1);
  assert(!Object.hasOwn(result.destination, 'destinationVersion'));
});
test('Calendar due and start selectors reuse the same current task and version', async () => {
  const h = fixture(), options = receiving(h);
  for (const occurrence of ['start', 'due']) {
    const result = await openPlannerOccurrence({ ...calendarSelection, occurrence }, binding, options);
    assert.equal(result.destination.resourceId, ids.task);
    assert.equal(result.destination.destinationVersion, 5);
    assert.equal(result.occurrence.id, `planner:${ids.task}:${occurrence}`);
    assert.equal(result.occurrence.civilDate, occurrence === 'start' ? '2026-10-14' : '2026-10-15');
    assert.equal(result.occurrence.time, null);
    assert.equal(result.occurrence.timeZone, null);
  }
  assert.equal(h.transactions, 2);
});
test('coincident civil start/due dates collapse to due; missing dates do not invent events', async () => {
  const h = fixture(), options = receiving(h);
  h.task.data.startOn = h.task.data.dueOn;
  await assert.rejects(openPlannerOccurrence({ ...calendarSelection, occurrence: 'start' }, binding, options), code('OCCURRENCE_UNAVAILABLE'));
  assert.equal((await openPlannerOccurrence(calendarSelection, binding, options)).occurrence.dateKind, 'planner_due');
  h.task.data.dueOn = null;
  await assert.rejects(openPlannerOccurrence(calendarSelection, binding, options), code('OCCURRENCE_UNAVAILABLE'));
});
test('civil dates retain their day in a distant zone and a DST fold retains the source HH:mm/zone', async () => {
  const h = fixture(), options = receiving(h);
  h.task.data.dueOn = '2026-11-01'; h.task.data.timeZone = 'America/New_York'; h.task.data.dueTime = '01:30';
  const timed = (await openPlannerOccurrence(calendarSelection, binding, options)).occurrence;
  assert.deepEqual([timed.civilDate, timed.time, timed.timeZone], ['2026-11-01', '01:30', 'America/New_York']);
  assert(!Object.hasOwn(timed, 'instant'));
  h.task.data.dueTime = null; h.task.data.timeZone = 'Pacific/Kiritimati';
  assert.equal((await openPlannerOccurrence(calendarSelection, binding, options)).occurrence.civilDate, '2026-11-01');
});
for (const field of ['tenant', 'member', 'client', 'grant', 'objective', 'revision']) {
  test(`both owners recheck current ${field} on replay`, async () => {
    for (const open of ['file', 'calendar']) {
      const h = fixture(), options = receiving(h);
      const run = () => open === 'file' ? openSavedRevision(fileSelection, binding, options) :
        openPlannerOccurrence(calendarSelection, binding, options);
      await run(); h.state[field] = false;
      await assert.rejects(run(), nest.NotFoundException);
      assert.equal(options.requests.length, 2);
    }
  });
}
test('Workspace collaborator revocation and changed current client defeat replay before stale Objective probing', async () => {
  const h = fixture(), options = receiving(h);
  h.state.draftOwner = 'user_other';
  await openSavedRevision(fileSelection, binding, options);
  h.state.collaborator = null;
  await assert.rejects(openSavedRevision(fileSelection, binding, options), nest.NotFoundException);
  h.state.collaborator = 'viewer'; h.state.currentClient = ids.other; h.state.objectiveVersion = 4;
  h.sql.length = 0;
  await assert.rejects(openSavedRevision(fileSelection, binding, options), nest.NotFoundException);
  assert(!h.sql.some((q) => q.text.includes('FROM client_objectives')));
});
for (const source of ['prospect', 'research', 'editorial', 'preparation', 'future']) {
  test(`saved revision remains unavailable for excluded ${source} origin`, async () => {
    const h = fixture();
    if (source === 'prospect') h.state.prospect = ids.other;
    else h.state.source = source;
    await assert.rejects(openSavedRevision(fileSelection, binding, receiving(h)), nest.NotFoundException);
  });
}
test('Planner archive, ACL revocation and client reassignment hide stale Objective conflicts', async () => {
  for (const mutate of [(h) => { h.task.archived = true; }, (h) => { h.task.ownerId = 'other'; },
    (h) => { h.task.data.clientId = ids.other; }]) {
    const h = fixture(), options = receiving(h);
    await openPlannerOccurrence(calendarSelection, binding, options);
    mutate(h); h.state.objectiveVersion = 4; h.sql.length = 0;
    await assert.rejects(openPlannerOccurrence(calendarSelection, binding, options), nest.NotFoundException);
    assert(!h.sql.some((q) => q.text.includes('FROM client_objectives')));
  }
});
test('same-client authorized stale Objective remains a typed conflict in each owner', async () => {
  const h = fixture(); h.state.objectiveVersion = 4;
  for (const run of [() => h.file(), () => h.calendar()])
    await assert.rejects(run(), (e) => e instanceof nest.ConflictException && e.getResponse().code === 'OBJECTIVE_VERSION_CONFLICT');
});
test('Planner corrections require a refreshed selected version, not silent old-date opening', async () => {
  const h = fixture(), options = receiving(h);
  await openPlannerOccurrence(calendarSelection, binding, options);
  h.task.version = 6; h.task.data.dueOn = '2026-10-16';
  await assert.rejects(openPlannerOccurrence(calendarSelection, binding, options), code('DESTINATION_CHANGED'));
  const refreshed = await openPlannerOccurrence({ ...calendarSelection, destinationVersion: 6 }, binding, options);
  assert.equal(refreshed.occurrence.civilDate, '2026-10-16');
});
test('source and Objective failures propagate once without unbound fallback or retry', async () => {
  for (const [kind, failOn] of [['file', 'FROM ws_draft'], ['file', 'FROM client_objectives'], ['calendar', 'FROM client_objectives']]) {
    const h = fixture(), options = receiving(h); h.state.fail = failOn;
    const run = kind === 'file' ? openSavedRevision(fileSelection, binding, options) : openPlannerOccurrence(calendarSelection, binding, options);
    await assert.rejects(run, (e) => e === h.state.error);
    assert.equal(options.requests.length, 1);
  }
});
test('actual SQL keeps immutable revision SELECT and Planner lock ordering without business writes', async () => {
  const h = fixture(); await h.file(); await h.calendar();
  assert(h.sql.every((q) => !/\b(INSERT|UPDATE|DELETE)\b/.test(q.text)));
  const revision = h.sql.filter((q) => q.text.includes('FROM client_objective_revisions'));
  assert(revision.length === 2 && revision.every((q) => !q.text.includes('FOR SHARE')));
  assert(h.sql.find((q) => q.text.includes('FROM ws_doc_version')).text.includes('FOR SHARE'));
  assert(h.sql.some((q) => q.text.includes('pg_advisory_xact_lock') && q.values[0] === `planner:${ids.tenant}`));
});
for (const [kind, mutate] of [
  ['file', (r) => { r.destination.resourceId = ids.other; }],
  ['file', (r) => { r.destination.draftId = ids.other; }],
  ['file', (r) => { r.destination.objectiveVersion++; }],
  ['file', (r) => { r.hashFormat = 'other'; }],
  ['calendar', (r) => { r.destination.resourceId = ids.other; }],
  ['calendar', (r) => { r.task.version++; }],
  ['calendar', (r) => { r.task.clientId = ids.other; }],
  ['calendar', (r) => { r.task.dueOn = '2026-02-30'; }],
  ['calendar', (r) => { r.task.dueTime = '09:00'; r.task.timeZone = null; }],
]) {
  test(`${kind} receiver refuses mismatched or malformed wire projection ${String(mutate)}`, async () => {
    const h = fixture(), options = receiving(h, (value) => { mutate(value); return value; });
    await assert.rejects(kind === 'file' ? openSavedRevision(fileSelection, binding, options) :
      openPlannerOccurrence(calendarSelection, binding, options), code('INVALID_RECEIPT'));
  });
}
test('saved bytes and a previously selected hash cannot be substituted', async () => {
  const h = fixture(), options = receiving(h, (r) => { r.snapshot = { ...r.snapshot, ask: 'Changed' }; return r; });
  await assert.rejects(openSavedRevision(fileSelection, binding, options), code('SAVED_REVISION_CHANGED'));
  await assert.rejects(openSavedRevision({ ...fileSelection, snapshotHash: '0'.repeat(64) }, binding, receiving(fixture())), code('SAVED_REVISION_CHANGED'));
});
test('a late response after session/client/Objective admission changes cannot reopen either destination', async () => {
  for (const kind of ['file', 'calendar']) {
    let current = true;
    const options = receiving(fixture(), () => { current = false; return null; });
    options.isCurrent = () => current;
    assert.equal(await (kind === 'file' ? openSavedRevision(fileSelection, binding, options) :
      openPlannerOccurrence(calendarSelection, binding, options)), null);
  }
});
test('asynchronous snapshot verification also checks current admission before returning', async () => {
  let current = true;
  const options = receiving(fixture()); options.isCurrent = () => current;
  options.hashSnapshot = async (snapshot) => { current = false; return hashSnapshot(snapshot); };
  assert.equal(await openSavedRevision(fileSelection, binding, options), null);
});
test('aborted or already superseded selections never issue a request', async () => {
  for (const change of [(o) => { o.signal = AbortSignal.abort(); }, (o) => { o.isCurrent = () => false; }]) {
    const options = receiving(fixture()); change(options);
    assert.equal(await openSavedRevision(fileSelection, binding, options), null);
    assert.equal(await openPlannerOccurrence(calendarSelection, binding, options), null);
    assert.equal(options.requests.length, 0);
  }
});
test('invalid bounded selectors fail before any request; arbitrary claims never enter the query', async () => {
  const options = receiving(fixture());
  for (const invalid of [0, -1, 1.5, 2147483648])
    await assert.rejects(openSavedRevision(fileSelection, { ...binding, objectiveVersion: invalid }, options), code('INVALID_SELECTION'));
  await assert.rejects(openPlannerOccurrence({ ...calendarSelection, occurrence: 'effective' }, binding, options), code('INVALID_SELECTION'));
  assert.equal(options.requests.length, 0);
  await openSavedRevision({ ...fileSelection, tenantId: ids.other }, { ...binding, actor: 'other' }, options);
  assert.equal(options.requests.length, 1);
});
