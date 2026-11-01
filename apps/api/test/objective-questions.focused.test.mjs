import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const data = (s) => `data:text/javascript;base64,${Buffer.from(s).toString('base64')}`;
const nest = data(
  `export class BadRequestException extends Error { constructor(body){ super(JSON.stringify(body));this.body=body;} } export class ConflictException extends BadRequestException{} export class NotFoundException extends BadRequestException{} export const Injectable=()=>x=>x;`,
);
async function load(file, replacements) {
  let source = await readFile(
    new URL('../src/clients/objectives/questions/' + file, import.meta.url),
    'utf8',
  );
  source = source.replace('@Injectable()', '');
  for (const [from, to] of replacements) source = source.replaceAll(from, JSON.stringify(to));
  return data(stripTypeScriptTypes(source, { mode: 'transform' }));
}
const sourceRulesUrl = await load('../evidence/objective-evidence-source.rules.ts', [
  ["'@nestjs/common'", nest],
]);
const rulesUrl = await load('objective-question.rules.ts', [
  ["'@nestjs/common'", nest],
  ["'../evidence/objective-evidence-source.rules.js'", sourceRulesUrl],
]);
const rules = await import(rulesUrl);
const evidenceUrl = await load('objective-question.evidence.ts', [
  ["'@nestjs/common'", nest],
  ["'./objective-question.rules.js'", rulesUrl],
]);
const evidence = await import(evidenceUrl);
const store = await import(
  await load('objective-question.store.ts', [
    ["'@nestjs/common'", nest],
    ["'./objective-question.rules.js'", rulesUrl],
    ["'./objective-question.evidence.js'", evidenceUrl],
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

const hash = 'a'.repeat(64);
const citation = {
  selector: {
    kind: 'news',
    articleId: 'synthetic-article',
    observationId: hash,
    expectedDigest: hash,
  },
  version: hash,
  digest: hash,
  provenanceDigest: hash,
  title: 'Synthetic article',
  sourceSystem: 'retained_news',
  sourceUrl: 'https://example.test/source',
  summary: 'Synthetic excerpt',
  rights: 'excerpt',
  complete: false,
  observedAt: null,
};
const citedAnswer = { ...answer, evidenceRefs: [citation.selector] };
const citedState = { ...answered, evidenceRefs: [citation] };
const owner = (status = 'current') => ({
  resolve: async () => citation,
  inspect: async () => (status === 'unavailable' ? { status } : { status, snapshot: citation }),
});
test('old command shape and original digest are byte-identical when evidence is absent', () => {
  assert.equal(Object.hasOwn(rules.parseQuestionCommand(answer), 'evidenceRefs'), false);
  assert.equal(
    rules.questionCommandDigest(rules.parseQuestionCommand(answer)),
    rules.questionCommandDigest(answer),
  );
});
test('citations accept only bounded unique canonical selectors, no injected source content', () => {
  assert.deepEqual(rules.parseQuestionCommand(citedAnswer).evidenceRefs, [citation.selector]);
  for (const refs of [
    [...Array(9).fill(citation.selector)],
    [citation.selector, citation.selector],
    [{ ...citation.selector, title: 'injected' }],
    [{ ...citation.selector, expectedDigest: 'invalid' }],
  ])
    assert.throws(() => rules.parseQuestionCommand({ ...answer, evidenceRefs: refs }));
});
test('answer stores only owner-rehydrated reviewed source snapshot', async () => {
  const f = fixture({ current: open });
  const result = await store.commitQuestion(f.tx, actor, scope, citedAnswer, owner());
  assert.deepEqual(result.question.evidenceRefs, [citation]);
  assert.equal(result.payloadDigest, rules.questionCommandDigest(citedAnswer));
});
test('source change between preview and answer refuses before any write', async () => {
  const f = fixture({ current: open });
  await assert.rejects(
    store.commitQuestion(f.tx, actor, scope, citedAnswer, {
      ...owner(),
      resolve: async () => ({ ...citation, digest: 'b'.repeat(64) }),
    }),
    /REFUSED/,
  );
  assert.equal(f.calls.filter((x) => /^(INSERT|UPDATE)/.test(x.sql)).length, 0);
});
test('source changed after rehydration refuses answer and stale source refuses close', async () => {
  for (const [current, command] of [
    [open, citedAnswer],
    [citedState, close],
  ]) {
    const f = fixture({ current });
    await assert.rejects(
      store.commitQuestion(f.tx, actor, scope, command, owner('stale')),
      /REFUSED/,
    );
    assert.equal(f.calls.filter((x) => /^(INSERT|UPDATE)/.test(x.sql)).length, 0);
  }
});
test('denied evidence hides dependent answer/note and every source label, preserving lifecycle', async () => {
  const shown = await evidence.presentQuestionEvidence(citedState, 7, owner('unavailable'));
  assert.equal(shown.status, 'answered');
  assert.equal(shown.version, 2);
  assert.equal(shown.answer, null);
  assert.equal(shown.evidenceNote, null);
  assert.deepEqual(shown.evidenceRefs, []);
  assert.equal(shown.stale, true);
  assert.equal(JSON.stringify(shown).includes(citation.title), false);
});
test('original committed cited answer reconciles redacted before checking changed source/new command', async () => {
  const prior = {
    requestId: citedAnswer.requestId,
    payloadDigest: rules.questionCommandDigest(citedAnswer),
    actorUserId: actor.userId,
    action: 'answer',
    snapshot: citedState,
    committedAt: new Date('2026-11-01T00:00:00Z'),
  };
  const f = fixture({ prior });
  const result = await store.commitQuestion(
    f.tx,
    actor,
    { ...scope, objectiveVersion: 8 },
    citedAnswer,
    {
      ...owner('unavailable'),
      resolve: async () => {
        throw Error('must not reexecute');
      },
    },
  );
  assert.equal(result.question.evidenceState, 'unavailable');
  assert.equal(result.payloadDigest, prior.payloadDigest);
  assert.equal(f.calls.length, 2);
});
test('unavailable source projection is safe on owner outage, mutation outage remains unknown', async () => {
  const unavailable = {
    ...owner(),
    inspect: async () => {
      throw Error('source outage');
    },
  };
  assert.equal((await evidence.presentQuestionEvidence(citedState, 7, unavailable)).answer, null);
  const f = fixture({ current: citedState });
  await assert.rejects(
    store.commitQuestion(f.tx, actor, scope, close, unavailable),
    /source outage/,
  );
  assert.equal(f.calls.filter((x) => /^(INSERT|UPDATE)/.test(x.sql)).length, 0);
});
test('reopen clears current citation but leaves immutable historical witness intact', () => {
  const next = rules.advanceQuestion(citedState, { ...close, action: 'reopen' }, scope);
  assert.deepEqual(next.evidenceRefs, []);
  assert.equal(next.answer, null);
  assert.deepEqual(citedState.evidenceRefs, [citation]);
});
test('list and history use the same current source redaction as receipt', async () => {
  const tx = {
    $queryRaw: async (parts) => {
      const sql = parts.join('?');
      if (sql.includes('count(*)')) return [{ total: 1, openCount: 0 }];
      if (sql.includes('client_objective_question_revisions'))
        return [
          {
            snapshot: citedState,
            requestId: answer.requestId,
            payloadDigest: rules.questionCommandDigest(citedAnswer),
            actorUserId: actor.userId,
            action: 'answer',
            committedAt: new Date('2026-11-01T00:00:00Z'),
          },
        ];
      return [{ snapshot: citedState }];
    },
  };
  const list = await store.readQuestions(tx, actor, scope, null, null, owner('unavailable'));
  const history = await store.readQuestionHistory(
    tx,
    actor,
    scope,
    open.id,
    null,
    owner('unavailable'),
  );
  assert.equal(list.items[0].answer, null);
  assert.equal(history.items[0].question.answer, null);
});
test('saved document citation lookup binds exact immutable question revision and digest', async () => {
  const document = {
    ...citation,
    selector: { kind: 'document', attachmentId: id(50), expectedDigest: hash },
    sourceSystem: 'client_document',
    rights: 'private_document',
    summary: null,
    sourceUrl: null,
  };
  const calls = [];
  const tx = {
    $queryRaw: async (parts, ...args) => {
      calls.push(args);
      return [{ snapshot: { ...answered, evidenceRefs: [document] } }];
    },
  };
  assert.deepEqual(await store.readQuestionCitation(tx, actor, scope, open.id, 2, hash), document);
  assert.deepEqual(calls[0], [actor.tenantId, scope.clientId, scope.objectiveId, open.id, 2]);
  await assert.rejects(
    store.readQuestionCitation(tx, actor, scope, open.id, 2, 'b'.repeat(64)),
    /unavailable/,
  );
});
test('command digest matches browser canonical evidence witness order', () => {
  const command = {
    requestId: id(70),
    questionId: id(5),
    expectedVersion: 1,
    expectedObjectiveVersion: 7,
    action: 'answer',
    answer: 'Synthetic answer',
    evidenceNote: 'Synthetic evidence note',
    evidenceRefs: [citation.selector],
  };
  assert.equal(
    rules.questionCommandDigest(rules.parseQuestionCommand(command)),
    '0e9dfd1768bcf1df554acc71ca13a3a80ee15c73bb00da517ac46818a9772a29',
  );
});

const { ObjectiveQuestionsService } = await import(
  await load('objective-questions.service.ts', [
    ["'@nestjs/common'", nest],
    ["'../../../prisma/prisma.service.js'", data('export class PrismaService{}')],
    [
      "'../evidence/objective-evidence-source.service.js'",
      data('export class ObjectiveEvidenceSourceService{}'),
    ],
    [
      "'../operational/objective-operational.store.js'",
      data('export const loadCurrentOperationalScopeWithinTx=(tx,...args)=>tx.scope(...args);'),
    ],
    [
      "'../operational/objective-operational.rules.js'",
      data('export const operationalFailure=code=>{throw Error(code)};'),
    ],
    ["'./objective-question.rules.js'", rulesUrl],
    [
      "'./objective-question.store.js'",
      await load('objective-question.store.ts', [
        ["'@nestjs/common'", nest],
        ["'./objective-question.rules.js'", rulesUrl],
        ["'./objective-question.evidence.js'", evidenceUrl],
      ]),
    ],
  ])
);
test('history endpoint loads stored original witness and never trusts a caller snapshot', async () => {
  const document = {
    ...citation,
    selector: { kind: 'document', attachmentId: id(50), expectedDigest: hash },
    sourceSystem: 'client_document',
    rights: 'private_document',
  };
  const tx = {
    scope: async () => scope,
    $queryRaw: async () => [{ snapshot: { ...answered, evidenceRefs: [document] } }],
  };
  const seen = [];
  const service = new ObjectiveQuestionsService(
    { withTenant: async (_tenant, work) => work(tx) },
    {
      historyAnchorWithinTx: async (_tx, _ctx, _scope, snapshot) => {
        seen.push(snapshot);
        return {
          attachmentId: id(50),
          contentHash: hash,
          headId: id(51),
          originalId: id(50),
          versionCount: 2,
        };
      },
    },
  );
  const ctx = { ...actor, role: 'standard_user' };
  const result = await service.evidenceHistory(ctx, scope.clientId, scope.objectiveId, {
    from: 'question',
    questionId: open.id,
    questionVersion: 2,
    digest: hash,
  });
  assert.deepEqual(seen, [document]);
  assert.equal(result.anchor.attachmentId, id(50));
  assert.equal(result.anchor.headId, id(51));
  assert.throws(() =>
    service.evidenceHistory(ctx, scope.clientId, scope.objectiveId, {
      from: 'question',
      questionId: open.id,
      questionVersion: 2,
      digest: hash,
      snapshot: document,
    }),
  );
  assert.throws(
    () =>
      service.evidenceHistory({ ...ctx, role: 'reader' }, scope.clientId, scope.objectiveId, {
        from: 'question',
        questionId: open.id,
        questionVersion: 2,
        digest: hash,
      }),
    /FORBIDDEN/,
  );
});
