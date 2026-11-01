import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const data = (s) => `data:text/javascript;base64,${Buffer.from(s).toString('base64')}`;
const nest = data(
  `export class BadRequestException extends Error { constructor(body){ super(JSON.stringify(body));this.body=body;} } export class ConflictException extends BadRequestException{} export class NotFoundException extends BadRequestException{}`,
);
async function load(file, replacements) {
  let source = await readFile(
    new URL('../src/clients/objectives/questions/' + file, import.meta.url),
    'utf8',
  );
  for (const [from, to] of replacements) source = source.replaceAll(from, JSON.stringify(to));
  return data(stripTypeScriptTypes(source, { mode: 'transform' }));
}
const rulesUrl = await load('objective-question.rules.ts', [["'@nestjs/common'", nest]]);
const rules = await import(rulesUrl);
const store = await import(
  await load('objective-question.store.ts', [
    ["'@nestjs/common'", nest],
    ["'./objective-question.rules.js'", rulesUrl],
  ])
);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = { tenantId: id(1), userId: id(2), clerkUserId: 'synthetic-test-user' };
const scope = {
  clientId: id(3),
  objectiveId: id(4),
  objectiveVersion: 7,
  currentRevisionId: id(5),
};
const create = {
  requestId: id(6),
  questionId: id(7),
  expectedVersion: 0,
  expectedObjectiveVersion: 7,
  action: 'create',
  title: 'Which context matters?',
};
const open = rules.advanceQuestion(null, create, scope);
const answer = {
  ...create,
  requestId: id(8),
  expectedVersion: 1,
  action: 'answer',
  answer: 'The saved minimum win.',
  evidenceNote: 'Reviewed the Objective context.',
};
delete answer.title;
const answered = rules.advanceQuestion(open, answer, scope);
const close = { ...create, requestId: id(9), expectedVersion: 2, action: 'close' };
delete close.title;
test('exact context answer and closure retain source and identity', () => {
  const closed = rules.advanceQuestion(answered, close, scope);
  assert.equal(closed.id, open.id);
  assert.equal(closed.version, 3);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.sourceRevisionId, scope.currentRevisionId);
});
test('Objective edit marks historical answer stale and prevents closing it', () => {
  const changed = { ...scope, objectiveVersion: 8, currentRevisionId: id(10) };
  assert.equal(rules.presentQuestion(answered, 8).stale, true);
  assert.throws(
    () => rules.advanceQuestion(answered, { ...close, expectedObjectiveVersion: 8 }, changed),
    /SOURCE_STALE/,
  );
});
test('reopen preserves identity while new answer uses current context; prior object unchanged', () => {
  const changed = { ...scope, objectiveVersion: 8, currentRevisionId: id(10) };
  const reopened = rules.advanceQuestion(
    answered,
    { ...close, action: 'reopen', expectedObjectiveVersion: 8 },
    changed,
  );
  assert.equal(reopened.id, answered.id);
  assert.equal(reopened.answer, null);
  assert.equal(answered.answer, answer.answer);
  const updated = rules.advanceQuestion(
    reopened,
    { ...answer, expectedVersion: 3, expectedObjectiveVersion: 8 },
    changed,
  );
  assert.equal(updated.sourceObjectiveVersion, 8);
  assert.equal(updated.version, 4);
});
for (const [label, value] of [
  ['empty evidence', { ...answer, evidenceNote: ' ' }],
  ['injected actor', { ...answer, actorUserId: id(30) }],
  ['invalid version', { ...answer, expectedVersion: 0 }],
  ['oversized answer', { ...answer, answer: 'x'.repeat(8001) }],
  ['unsupported evidence', { ...answer, evidenceKind: 'document' }],
  ['unknown action', { ...close, action: 'approve' }],
])
  test(`closed command rejects ${label}`, () =>
    assert.throws(() => rules.parseQuestionCommand(value)));
test('same editor may close but stale question version cannot overwrite another answer', () => {
  assert.throws(
    () => rules.advanceQuestion(answered, { ...close, expectedVersion: 1 }, scope),
    /VERSION_CONFLICT/,
  );
  assert.throws(() => rules.advanceQuestion(answered, answer, scope), /VERSION_CONFLICT/);
});
test('parser normalizes text and IDs before digesting replay', () => {
  assert.deepEqual(
    rules.parseQuestionCommand({ ...create, title: ' ' + create.title + ' ' }),
    create,
  );
  assert.equal(
    rules.questionCommandDigest(rules.parseQuestionCommand(create)),
    rules.questionCommandDigest(create),
  );
});
function fixture({ current = null, prior = null } = {}) {
  const calls = [];
  const tx = {
    $queryRaw: async (parts, ...args) => {
      const sql = parts.join('?');
      calls.push({ sql, args });
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('FROM client_objective_question_revisions') && sql.includes('request_id='))
        return prior ? [prior] : [];
      if (sql.includes('FOR UPDATE')) return current ? [{ snapshot: current }] : [];
      if (
        sql.startsWith('INSERT INTO client_objective_questions') ||
        sql.startsWith('UPDATE client_objective_questions')
      )
        return [{ id: id(7) }];
      if (sql.startsWith('INSERT INTO client_objective_question_revisions'))
        return [
          {
            requestId: args[8],
            payloadDigest: args[9],
            actorUserId: args[7],
            action: args[10],
            snapshot: JSON.parse(args[11]),
            committedAt: new Date('2026-11-01T00:00:00Z'),
          },
        ];
      throw Error('Unexpected SQL ' + sql);
    },
  };
  return { tx, calls };
}
test('one command produces current state and immutable original-request revision', async () => {
  const f = fixture();
  const result = await store.commitQuestion(f.tx, actor, scope, create);
  assert.equal(result.question.id, create.questionId);
  assert.equal(result.requestId, create.requestId);
  assert.equal(f.calls.filter((x) => x.sql.startsWith('INSERT')).length, 2);
  assert.match(f.calls[0].sql, /pg_advisory_xact_lock[^]*::text/);
  for (const call of f.calls.filter((x) => !x.sql.includes('pg_advisory')))
    assert.ok(call.args.includes(actor.tenantId));
});
test('lost reply replay returns original revision before any mutation, even after Objective changes', async () => {
  const prior = {
    requestId: create.requestId,
    payloadDigest: rules.questionCommandDigest(create),
    actorUserId: actor.userId,
    action: 'create',
    snapshot: open,
    committedAt: new Date('2026-11-01T00:00:00Z'),
  };
  const f = fixture({ prior });
  const result = await store.commitQuestion(f.tx, actor, { ...scope, objectiveVersion: 8 }, create);
  assert.equal(result.question.version, 1);
  assert.equal(result.question.stale, true);
  assert.equal(f.calls.length, 2);
});
test('same request with changed payload conflicts without erasing original outcome', async () => {
  const f = fixture({ prior: { payloadDigest: 'foreign' } });
  await assert.rejects(store.commitQuestion(f.tx, actor, scope, create), /REQUEST_CONFLICT/);
  assert.equal(f.calls.length, 2);
});
test('terminal stale close refusal is emitted after original request check with no mutation', async () => {
  const f = fixture({ current: answered });
  await assert.rejects(
    store.commitQuestion(
      f.tx,
      actor,
      { ...scope, objectiveVersion: 8 },
      { ...close, expectedObjectiveVersion: 8 },
    ),
    (error) =>
      error.body.error.code === 'OBJECTIVE_QUESTION_REFUSED' &&
      error.body.outcome === 'not_committed',
  );
  assert.equal(f.calls.filter((x) => /^(INSERT|UPDATE)/.test(x.sql)).length, 0);
  assert.ok(f.calls[1].sql.includes('request_id='));
});
test('SQL/transport failure is not relabelled a no-write refusal', async () => {
  const f = fixture();
  f.tx.$queryRaw = async () => {
    throw Error('synthetic interrupted transaction');
  };
  await assert.rejects(store.commitQuestion(f.tx, actor, scope, create), /interrupted/);
});
test('tenant RLS, immutable revision and scoped source FKs exist in unapplied forward migration', async () => {
  const sql = await readFile(
    new URL(
      '../prisma/migrations/20281101040000_objective_questions/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.equal((sql.match(/FORCE ROW LEVEL SECURITY/g) || []).length, 2);
  assert.match(
    sql,
    /FOREIGN KEY \(tenant_id,client_id,objective_id,source_revision_id,source_objective_version\)/,
  );
  assert.match(sql, /BEFORE UPDATE/);
  assert.match(sql, /REVOKE UPDATE,DELETE ON client_objective_question_revisions/);
  assert.match(sql, /GRANT SELECT,INSERT,UPDATE ON client_objective_questions TO capiro_app/);
  assert.match(sql, /GRANT SELECT,INSERT ON client_objective_question_revisions TO capiro_app/);
});
