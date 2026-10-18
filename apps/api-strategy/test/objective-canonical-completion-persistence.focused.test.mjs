// Actual objectivePersistence hook source; synthetic SQL responses, transaction
// rollback model and authority/source/ledger ports. No real database, framework,
// lease concurrency, current authority or semantic compiler is qualified here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const copy = value => structuredClone(value);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const custody = [];
async function sourceModule(relative, replacements = []) {
  const path = new URL(relative, import.meta.url), raw = await readFile(path, 'utf8');
  let source = raw;
  for (const [from, to] of replacements) {
    assert.equal(source.split(from).length, 2, `one declared import rewrite: ${from}`);
    source = source.replace(from, JSON.stringify(to));
  }
  const transformed = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: path.href });
  custody.push({ path: relative, sha256: createHash('sha256').update(raw).digest('hex'),
    transformedSha256: createHash('sha256').update(transformed).digest('hex'),
    replacementSpecifiers: replacements.map(([from]) => from), mode: 'strip' });
  return data(transformed);
}
const nest = data('export class BadRequestException extends Error{};export class ConflictException extends Error{};');
const enums = data("export const STRATEGY_TYPES=['appropriations','authorization','regulatory','coalition','procurement','earmark','amendment'];");
const typesUrl = await sourceModule('../src/meri/objective-generation.types.ts', [
  ["'@nestjs/common'", nest], ["'../strategy/dto/create-strategy.dto.js'", enums],
]);
const { digest } = await import(typesUrl);
const ports = data(`
  import assert from 'node:assert/strict';
  import {digest} from ${JSON.stringify(typesUrl)};
  const clone=value=>structuredClone(value);
  export const generationMarker=a=>({schemaVersion:1,syntheticAdmissionHash:digest(a)});
  export async function lockObjectiveSources(tx){
    assert.equal(tx.fixture.depth,1);tx.fixture.calls.locks++;
  }
  export async function admitObjective(tx,actor,request){
    const s=tx.fixture;s.calls.admission++;
    assert.deepEqual(actor,{tenantId:s.claim.tenantId,clerkUserId:s.claim.ownerUserId});
    assert.deepEqual(request,s.claim.input.objectiveGeneration.request);
    return {source:clone(s.source),sourceDigest:s.admittedSourceDigest??s.compiled.context.sourceDigest};
  }
  export async function readObjectiveSources(tx,tenant,client,contacts,clerk){
    const s=tx.fixture;s.calls.sources++;
    assert.equal(tenant,s.claim.tenantId);assert.equal(client,s.source.clientId);
    assert.deepEqual(contacts,s.compiled.contactIds);assert.equal(clerk,s.claim.ownerUserId);
    return clone(s.sources);
  }
  export async function generationAssociation(tx,tenant,clerk,job){
    const s=tx.fixture;s.calls.association++;
    assert.equal(tenant,s.claim.tenantId);assert.equal(clerk,s.claim.ownerUserId);assert.equal(job,s.claim.id);
    return clone(s.association);
  }
  export async function requireCanonicalGenerationEffectWithinTx(tx,a,request,phase){
    const s=tx.fixture;s.calls.effect.push(phase??'before-write');
    assert.deepEqual(a,s.a);assert.deepEqual(request,{generationJobId:s.claim.id,generationRequestId:s.request.requestId});
    if(s.failEffectPhase===(phase??'before-write'))throw s.fenceError;
  }
  export async function recordCanonicalGenerationProducer(tx,tenant,clerk,job){
    const s=tx.fixture;s.calls.producer++;
    assert.equal(s.depth,1);assert.equal(tenant,s.claim.tenantId);assert.equal(clerk,s.claim.ownerUserId);
    assert.equal(job,s.claim.id);assert.equal(s.durable.job.status,'completed');
    assert.deepEqual(s.durable.job.input.canonicalCompletion,s.claim.completion);
    if(s.producerError)throw s.producerError;
    s.durable.producer={sourceAdmission:clone(s.a),acceptance:clone(s.association.acceptance),
      objectiveReceipt:clone(s.durable.job.input.objectiveGeneration.receipt)};
    return clone(s.durable.producer);
  }
`);
const completionUrl = await sourceModule('../src/meri/objective-generation-completion.ts', [
  ["'./objective-generation-admission.js'", ports],
  ["'./objective-generation-sources.js'", ports],
  ["'./objective-generation.types.js'", typesUrl],
  ["'./objective-canonical-producer-ledger.js'", ports],
  ["'./objective-canonical-generation-fence.js'", ports],
]);
const { objectivePersistence, ObjectiveLeaseLost } = await import(completionUrl);

function fixture({ canonical = true, completion = true } = {}) {
  const s = { depth: 0, trace: [], cas: [], rollbacks: 0, transactions: 0,
    casCount: 1, deadlineValid: true, issuanceValid: true,
    savedAt: '2026-10-16T01:02:03.004Z', historyAt: '2026-10-16T01:02:02.000Z',
    calls: { context: 0, locks: 0, admission: 0, sources: 0, association: 0, effect: [], producer: 0 },
    fenceError: new Error('Synthetic effect authority refused') };
  s.source = { clientId: id(1), objectiveId: id(2), objectiveVersion: 3, objectiveRevisionId: id(3) };
  s.request = { requestId: id(4), clientId: id(1), objective: { objectiveId: id(2), objectiveVersion: 3 }, type: 'authorization' };
  s.sources = { government_profile_support: [{ id: id(1) }], government_targets: [], represented_facilities: [],
    target_recommendations: [], member_notes: [], state_directory: [], mailbox_authority: [] };
  s.compiled = { tenantId: id(5), clerkUserId: 'user_original', requestId: id(4), type: 'authorization',
    source: copy(s.source), contactIds: [], localDigest: digest(s.sources),
    context: { state: 'complete', packetId: id(6), compiledAt: '2026-10-16T01:02:01.000Z',
      sourceDigest: 'a'.repeat(64), coverageDigest: 'b'.repeat(64), inputDigest: 'c'.repeat(64),
      reobservedAt: null, issues: [] } };
  s.a = { schemaVersion: 1, canonical: { tenantId: id(5), clientId: id(1), objectiveId: id(2) },
    generationJobId: id(7), generationRequestId: id(4), clerkUserId: 'user_original' };
  s.association = { admission: s.a, acceptance: { issuance: { issuanceKey: 'original-issuance', expiresAtMs: 99_000 } } };
  s.witness = { schemaVersion: 1, namespace: 'capiro.objective-strategy.completion:v1',
    generationJobId: id(7), generationRequestId: id(4), sourceAdmissionSha256: 'd'.repeat(64),
    sourceRequestSha256: 'e'.repeat(64), sourceBindingSha256: 'f'.repeat(64), typedRequestSha256: '1'.repeat(64),
    executionContextSha256: '2'.repeat(64), completionId: id(8), checkpointId: id(9), checkpointSha256: '3'.repeat(64),
    resultRef: 'retained-original-result', resultSha256: '4'.repeat(64), rawFileSha256: '5'.repeat(64),
    executionSha256: '6'.repeat(64), completedAtMs: 90_000, payloadSha256: '7'.repeat(64), corePayloadSha256: '8'.repeat(64) };
  const input = { dto: { clientId: id(1), type: 'authorization', goal: 'Original raw goal' }, bearer: null,
    objectiveGeneration: { request: copy(s.request), fingerprint: digest(s.request),
      receipt: { schemaVersion: 1, requestId: id(4), source: copy(s.source), context: copy(s.compiled.context), result: null, failure: null } } };
  if (canonical) input.canonicalGeneration = { schemaVersion: 1, syntheticAdmissionHash: digest(s.a) };
  s.claim = { id: id(7), tenantId: id(5), ownerUserId: 'user_original',
    claimToken: canonical ? 'canonical:original-issuance' : 'legacy-worker', attempt: canonical ? 2 : 1, input: copy(input) };
  if (completion) s.claim.completion = copy(s.witness);
  s.durable = { job: { status: 'running', claimedBy: s.claim.claimToken, attempt: s.claim.attempt,
    input: copy(input), strategyId: null }, strategies: [], nodes: [], versions: [], producer: null };
  s.saved = { strategyId: id(10), strategyVersionId: id(11) };
  s.context = { recheckObjective: async (scope, compiled) => {
    s.calls.context++;s.trace.push('context-outside-transaction');assert.equal(s.depth, 0);
    assert.deepEqual(compiled, s.compiled);
    assert.deepEqual(scope, { tenantId: id(5), clerkUserId: 'user_original', clientId: id(1), mode: 'draft',
      objective: s.request.objective, generationRequestId: id(4), generationType: 'authorization' });
    if (s.contextError) throw s.contextError;
    return s.historyAt;
  } };
  s.tx = { fixture: s,
    $queryRaw: async (strings, ...values) => {
      assert.equal(s.depth, 1);
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      if (sql.startsWith('SELECT input,')) {
        assert.deepEqual(values, [s.claim.claimToken, s.claim.attempt, s.claim.tenantId, s.claim.id]);
        return [{ input: copy(s.durable.job.input), ownerUserId: s.claim.ownerUserId, clientId: s.source.clientId,
          valid: s.durable.job.status === 'running' && s.durable.job.claimedBy === s.claim.claimToken && s.durable.job.attempt === s.claim.attempt }];
      }
      if (sql.startsWith('SELECT deadline_at')) return [{ valid: s.deadlineValid }];
      if (sql.startsWith('SELECT clock_timestamp()')) return [{ savedAt: new Date(s.savedAt) }];
      if (sql.startsWith('SELECT ceil(')) return [{ valid: s.issuanceValid }];
      throw Error(`Unexpected synthetic SQL: ${sql}`);
    },
    $executeRaw: async (strings, ...values) => {
      assert.equal(s.depth, 1);
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      assert.ok(sql.startsWith("UPDATE sp_draft_job SET status='completed'"));
      assert.ok(sql.includes('deadline_at > clock_timestamp()'));
      assert.ok(sql.includes("(input #> '{objectiveGeneration,receipt,result}')='null'::jsonb"));
      assert.ok(sql.includes('claimed_by=? AND attempt=? AND strategy_id IS NULL'));
      assert.equal(values.length, 6);
      assert.deepEqual([values[0], ...values.slice(2)], [s.saved.strategyId, s.claim.id, s.claim.tenantId, s.claim.claimToken, s.claim.attempt]);
      const nextInput = JSON.parse(values[1]);
      s.cas.push({ sql, values: copy(values), input: nextInput });
      s.trace.push('original-completion-cas');
      if (s.casError) throw s.casError;
      if (s.casCount === 1) {
        s.durable.job.input = copy(nextInput);s.durable.job.status = 'completed';
        s.durable.job.strategyId = s.saved.strategyId;
      }
      return s.casCount;
    },
  };
  s.hooks = objectivePersistence(s.claim, s.context, () => s.compiledAvailable === false ? undefined : s.compiled);
  return s;
}

// The rollback model only observes whether actual hooks throw to their caller.
// Native owner transactions, row-count behavior and rollback require real PG.
async function apply(s) {
  await s.hooks.beforeTransaction();
  const before = copy(s.durable);s.transactions++;s.depth++;
  try {
    await s.hooks.beforeWrite(s.tx);
    s.trace.push('synthetic-strategy-nodes-version-write');
    s.durable.strategies.push(s.saved.strategyId);s.durable.nodes.push(id(12));s.durable.versions.push(s.saved.strategyVersionId);
    await s.hooks.afterWrite(s.tx, s.saved);
  } catch (error) {
    s.durable = before;s.rollbacks++;throw error;
  } finally { s.depth--; }
}
function noDurableEffects(s) {
  assert.equal(s.durable.job.status, 'running');assert.equal(s.durable.job.strategyId, null);
  assert.equal(s.durable.job.input.objectiveGeneration.receipt.result, null);
  assert.equal(s.durable.producer, null);assert.deepEqual(s.durable.strategies, []);
  assert.deepEqual(s.durable.nodes, []);assert.deepEqual(s.durable.versions, []);assert.equal(s.depth, 0);
}

test('exact private witness and saved version share the original completion CAS after outside-transaction context read', async () => {
  const s = fixture();await apply(s);
  assert.equal(s.cas.length, 1);assert.equal(s.calls.context, 1);
  assert.equal(s.trace[0], 'context-outside-transaction');
  assert.deepEqual(s.cas[0].input.canonicalCompletion, s.witness);
  assert.deepEqual(s.durable.job.input.canonicalCompletion, s.witness);
  assert.notEqual(s.durable.job.input.canonicalCompletion, s.claim.completion);
  const receipt = s.cas[0].input.objectiveGeneration.receipt;
  assert.deepEqual(receipt.result, { ...s.saved, sourceDigest: s.compiled.context.sourceDigest,
    contextPacketId: s.compiled.context.packetId, coverageDigest: s.compiled.context.coverageDigest,
    inputDigest: s.compiled.context.inputDigest, savedAt: s.savedAt });
  assert.equal(receipt.context.reobservedAt, s.historyAt);
  assert.equal(s.cas[0].input.objectiveGeneration.historyCheckedAt, s.historyAt);
  assert.equal(receipt.failure, null);
  assert.equal(s.calls.producer, 1);assert.deepEqual(s.calls.effect, ['before-write', 'after-write']);
  assert.equal(s.durable.job.status, 'completed');assert.equal(s.depth, 0);
  s.claim.completion.resultRef = 'later-caller-mutation';
  assert.equal(s.durable.job.input.canonicalCompletion.resultRef, 'retained-original-result');
});

test('CAS zero propagates lease loss to transaction caller instead of keeping Strategy/nodes/version or witness', async () => {
  const s = fixture();s.casCount = 0;
  await assert.rejects(() => apply(s), error => error instanceof ObjectiveLeaseLost);
  assert.equal(s.cas.length, 1);assert.deepEqual(s.cas[0].input.canonicalCompletion, s.witness);
  assert.equal(s.calls.producer, 0);assert.equal(s.rollbacks, 1);
  assert.equal(s.durable.job.input.canonicalCompletion, undefined);noDurableEffects(s);
});

test('actual CAS exception propagates unchanged to rollback caller with no receipt or Strategy output retained', async () => {
  const s = fixture();s.casError = new Error('Synthetic database commit write refused');
  await assert.rejects(() => apply(s), error => error === s.casError);
  assert.equal(s.cas.length, 1);assert.equal(s.calls.producer, 0);assert.equal(s.rollbacks, 1);noDurableEffects(s);
});

test('duplicate private witness is refused before CAS even if the job remains running', async () => {
  const s = fixture();s.durable.job.input.canonicalCompletion = copy(s.witness);
  await assert.rejects(() => apply(s), error => error instanceof ObjectiveLeaseLost);
  assert.equal(s.cas.length, 0);assert.equal(s.rollbacks, 1);
  assert.deepEqual(s.durable.job.input.canonicalCompletion, s.witness);noDurableEffects(s);
});

test('terminal accounting cannot coexist with successful completion before or after the original job lock', async () => {
  for (const phase of ['before-lock', 'after-lock']) {
    const s = fixture();let locked;
    if (phase === 'before-lock') s.durable.job.input.canonicalTerminal = { syntheticTerminal: true };
    else {
      const query = s.tx.$queryRaw;
      s.tx.$queryRaw = async (strings, ...values) => {
        const rows = await query(strings, ...values), sql = strings.join('?');
        if (sql.includes('SELECT input,')) locked = rows[0].input;
        // Controlled in-transaction fault, not a claim that another SQL writer
        // can mutate the already locked row. The afterWrite guard must refuse.
        if (sql.includes('SELECT clock_timestamp() AS')) locked.canonicalTerminal = { syntheticTerminal: true };
        return rows;
      };
    }
    await assert.rejects(() => apply(s), error => error instanceof ObjectiveLeaseLost);
    assert.equal(s.cas.length, 0);assert.equal(s.calls.producer, 0);
    assert.equal(s.durable.job.input.canonicalCompletion, undefined);noDurableEffects(s);
  }
});

test('witness cannot be attached to a different original job or request', async () => {
  for (const field of ['generationJobId', 'generationRequestId']) {
    const s = fixture();s.claim.completion[field] = id(90);
    await assert.rejects(() => apply(s), error => error instanceof ObjectiveLeaseLost);
    assert.equal(s.cas.length, 0);assert.equal(s.calls.producer, 0);
    assert.equal(s.durable.job.input.canonicalCompletion, undefined);noDurableEffects(s);
  }
});

test('legacy noncanonical Objective job cannot acquire a posted canonical completion witness', async () => {
  const s = fixture({ canonical: false });
  await assert.rejects(() => apply(s), error => error instanceof ObjectiveLeaseLost);
  assert.equal(s.cas.length, 0);assert.equal(s.calls.association, 0);
  assert.equal(s.durable.job.input.canonicalCompletion, undefined);noDurableEffects(s);
});

test('optional completion absent preserves legacy Objective completion without private witness or canonical ledger', async () => {
  const s = fixture({ canonical: false, completion: false });await apply(s);
  assert.equal(s.cas.length, 1);assert.equal(s.durable.job.status, 'completed');
  assert.equal(s.cas[0].input.canonicalCompletion, undefined);
  assert.equal(s.durable.job.input.canonicalCompletion, undefined);
  assert.equal(s.calls.association, 0);assert.deepEqual(s.calls.effect, []);assert.equal(s.calls.producer, 0);
  assert.deepEqual(s.durable.job.input.objectiveGeneration.receipt.result, { ...s.saved,
    sourceDigest: s.compiled.context.sourceDigest, contextPacketId: s.compiled.context.packetId,
    coverageDigest: s.compiled.context.coverageDigest, inputDigest: s.compiled.context.inputDigest, savedAt: s.savedAt });
});

test('missing or invalid history re-observation refuses witness and completion before CAS', async () => {
  for (const value of [null, 'invalid timestamp']) {
    const s = fixture();s.historyAt = value;
    await assert.rejects(() => apply(s), error => error instanceof ObjectiveLeaseLost);
    assert.equal(s.cas.length, 0);assert.equal(s.calls.producer, 0);noDurableEffects(s);
  }
});

test('canonical lease attempt or original claim replacement refuses before Strategy writes', async () => {
  for (const mutate of [s => { s.durable.job.attempt = 3; }, s => { s.durable.job.claimedBy = 'reclaimed-worker'; }]) {
    const s = fixture();mutate(s);
    await assert.rejects(() => apply(s), error => error instanceof ObjectiveLeaseLost);
    assert.equal(s.cas.length, 0);noDurableEffects(s);
  }
});

test('source or collection drift refuses original hook before Strategy writes', async () => {
  for (const mutate of [s => { s.admittedSourceDigest = '9'.repeat(64); },
    s => { s.sources.government_targets.push({ id: id(90) }); }]) {
    const s = fixture();mutate(s);
    await assert.rejects(() => apply(s), error => error.message === 'OBJECTIVE_CONTEXT_INCOMPLETE');
    assert.equal(s.cas.length, 0);noDurableEffects(s);
  }
});

test('after-CAS producer or authority failure escapes hook and rolls back every synthetic output together', async () => {
  for (const phase of ['producer', 'after-write']) {
    const s = fixture();
    const error = new Error('Synthetic final owner fence failed');
    if (phase === 'producer') s.producerError = error;
    else { s.failEffectPhase = 'after-write';s.fenceError = error; }
    await assert.rejects(() => apply(s), value => value === error);
    assert.equal(s.cas.length, 1);assert.equal(s.calls.producer, 1);assert.equal(s.rollbacks, 1);
    assert.equal(s.durable.job.input.canonicalCompletion, undefined);noDurableEffects(s);
  }
});

test('actual final database-clock issuance expiry check rolls back the already issued CAS', async () => {
  const s = fixture();s.issuanceValid = false;
  await assert.rejects(() => apply(s), error => error instanceof ObjectiveLeaseLost);
  assert.equal(s.cas.length, 1);assert.equal(s.calls.producer, 1);assert.equal(s.rollbacks, 1);noDurableEffects(s);
});

test('unavailable compiled context or failed context owner never opens a transaction', async () => {
  for (const phase of ['compiled', 'context']) {
    const s = fixture();
    if (phase === 'compiled') s.compiledAvailable = false;
    else s.contextError = new Error('Synthetic context owner unavailable');
    await assert.rejects(() => apply(s));
    assert.equal(s.transactions, 0);assert.equal(s.cas.length, 0);noDurableEffects(s);
  }
});

test('prints source custody and the synthetic SQL/rollback limitation', () => {
  assert.equal(custody.length, 2);
  console.log(JSON.stringify({ qualification: 'actual-objectivePersistence-source-only', sourceCustody: custody,
    syntheticPorts: ['SQL responses and transaction rollback model', 'current Objective admission',
      'local source reader/locks', 'generation association/effect authority', 'producer ledger'],
    actualHookAndDigest: true, nativeConcurrencyRlsGrantsAndDatabaseAtomicity: 'UNQUALIFIED',
    subprocesses: 0, network: false, fileWrites: false }));
});
