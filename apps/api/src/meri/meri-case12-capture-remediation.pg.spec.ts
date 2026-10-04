jest.mock('./meri-case12-capture-authority.js', () => ({readMeriCase12CompletedCorpusInTx: jest.fn()}));
import { PGlite } from '@electric-sql/pglite';
import type { TenantContext } from '@capiro/shared';
import { readMeriCase12CompletedCorpusInTx } from './meri-case12-capture-authority.js';
import { captureBudgetHash } from './meri-capture-provider-budget.js';
import { inspectCase12CaptureBindingInTx } from './meri-case12-capture-install.js';
import { inspectCase12FailedCaptureRemediationInTx as inspect,
  installCase12FailedCaptureRemediationInTx as install } from './meri-case12-capture-remediation.js';

const ctx: TenantContext = {tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
  tenantSlug: 'meri-foundation-20260928-t1', userId: 'b1f758fc-17bd-40f8-bef2-fa2d2380300f',
  clerkUserId: 'user_3Jw2FvWZkYGKmxWGx13tNJxFD2A', role: 'standard_user'};
const CLIENT = '41f9ec63-3963-479f-b747-59a3767ef44b';
const OLD = '40dd8401-dcfe-46bd-b010-c30e7098297c';
const NEW = '22222222-2222-4222-8222-222222222222';
const OLD_RUN = '4a32f9ce-3caa-49f2-95ef-2a512c854468';
const NEW_RUN = '33333333-3333-4333-8333-333333333333';
const VERIFY = '5ff329511d93d308aac9fc4ff335788040db8740994906c34a9cb76c15042e3d';
const SOURCE = '4'.repeat(40);
const input = {ctx, clientId: CLIENT, oldConversationId: OLD, newConversationId: NEW,
  newCaptureRunId: NEW_RUN, expectedCurrentVerifySha256: VERIFY, expectedApiSourceSha: SOURCE};
const qualification = {version: 1, caseId: '12', captureRunId: OLD_RUN,
  currentVerifySha256: VERIFY, priceKind: 'qualified_text_token_upper_bound',
  rateEvidenceSha256: '166362a8fa51e19255a054babccbe73ab17d76aede9c15f6503e4f20c565a59a',
  rateEvidenceExpiresAt: '2026-10-05T01:09:27.995Z', maxTokens: 500000, maxAttempts: 16,
  maxCostMicros: 13797053, rates: [
    {kind: 'openai_responses', model: 'gpt-6-astra', provider: 'openai',
      inputMicrosPerMillion: 25000000, outputMicrosPerMillion: 75000000},
    {kind: 'bedrock_embeddings', model: 'amazon.titan-embed-text-v2:0', provider: 'aws-bedrock',
      inputMicrosPerMillion: 20000, outputMicrosPerMillion: 0}]};
const oldBudget = {version: 1, turnId: null, admissionId: '52907cb0-88c7-401a-a15d-fff3bf068b05',
  policySha256: '43cb66d1b41c094caa5377f0da5f600efd3e94c1e61d7f10be85542f9800a083',
  qualificationSha256: captureBudgetHash(qualification), qualification,
  ledger: {version: 1, activation: 'enforced', attempts: [], chargedAttempts: 0, chargedTokens: 0,
    chargedCostMicros: 0, limits: {maxTokens: 500000, maxAttempts: 16, maxCostMicros: 13797053,
      deadlineAt: '2026-10-04T20:46:05.417Z'}}};
const setup = {setupRunId: '4aa30f1a-c852-43db-840e-62538d475373',
  fixtureInstanceId: '11111111-1111-4111-8111-111111111111', setupPlanSha256: 'a'.repeat(64),
  setupClaimSha256: 'b'.repeat(64), setupLedgerSha256: 'c'.repeat(64)};
const binding = {caseId: '12', captureRunId: OLD_RUN, fixtureNamespace: 'meri-foundation-20260928',
  fixtureVersion: 'fixture-v1', physicalMapSha256: 'd'.repeat(64), resetReceiptId: null,
  seedReceiptId: null, actorUserId: ctx.userId, clientId: CLIENT, currentVerifySha256: VERIFY, case12Setup: setup};
const initialSettings = {unrelated: 'keep', meriFoundationFixture: {fixtureNamespace: binding.fixtureNamespace,
  otherFixtureField: 'keep', captureEvidence: binding, captureProviderBudget: qualification}};
const oldMetadata = {unrelated: 'keep', serverCaptureProviderBudget: oldBudget};

describe('one-time Case12 remediation — native PostgreSQL reads and CAS', () => {
  jest.setTimeout(30000);
  const db = new PGlite();
  const savedSha = process.env.GIT_SHA;
  let queries: string[];
  let nativeClock: number | undefined;
  let failCas: boolean;
  const prisma = {} as never;

  // Real PostgreSQL row versions, JSONB and transactions. PGlite has one backend;
  // concurrent-session locking is outside this test's scope.
  async function run<T>(action: (tx: any) => Promise<T>): Promise<T> {
    return db.transaction(async client => action({$queryRaw: async (parts: TemplateStringsArray, ...values: any[]) => {
      const sql = parts.reduce((s, p, i) => s + (i ? `$${i}` : '') + p, '');
      queries.push(sql);
      if (failCas && /UPDATE tenants/.test(sql)) return [];
      const {rows} = await client.query<any>(sql, values);
      if (nativeClock !== undefined && /clock_timestamp/.test(sql)) rows[0].nowMs = BigInt(nativeClock);
      return rows;
    }}));
  }
  async function snapshot() {
    return {settings: (await db.query<any>('SELECT settings_jsonb FROM tenants')).rows[0].settings_jsonb,
      conversations: (await db.query('SELECT * FROM clio_conversations ORDER BY id')).rows};
  }
  async function setMetadata(id: string, value: unknown) {
    await db.query('UPDATE clio_conversations SET metadata_jsonb=$2::jsonb WHERE id=$1::uuid', [id, JSON.stringify(value)]);
  }
  async function setFixture(value: unknown) {
    await db.query('UPDATE tenants SET settings_jsonb=$1::jsonb', [JSON.stringify(value)]);
  }
  const plan = () => run(tx => inspect(prisma, tx, input));
  const apply = (hash: string) => run(tx => install(prisma, tx,
    {...input, expectedPlanSha256: hash, confirmation: 'REMEDIATE_CASE12_FAILED_CAPTURE_ONCE'}));

  beforeAll(async () => {
    await db.exec(`CREATE TABLE tenants (id uuid PRIMARY KEY, settings_jsonb jsonb NOT NULL);
      CREATE TABLE clio_conversations (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL,
        client_id uuid, metadata_jsonb jsonb NOT NULL, status text DEFAULT 'active', archived_at timestamptz,
        summary text, summary_up_to_message_id uuid);
      CREATE TABLE clio_messages (conversation_id uuid REFERENCES clio_conversations(id), tenant_id uuid);
      CREATE TABLE clio_artifacts (conversation_id uuid REFERENCES clio_conversations(id));`);
  });
  afterAll(async () => {await db.close(); if (savedSha === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = savedSha;});
  beforeEach(async () => {
    process.env.GIT_SHA = SOURCE;
    queries = []; nativeClock = undefined; failCas = false;
    jest.mocked(readMeriCase12CompletedCorpusInTx).mockReset().mockResolvedValue({proof: {
      corpusQualified: true, caseId: '12', tenantId: ctx.tenantId, actorUserId: ctx.userId, clientId: CLIENT,
      currentVerifySha256: VERIFY, setupClaimSha256: setup.setupClaimSha256,
      fixtureNamespace: binding.fixtureNamespace, fixtureVersion: binding.fixtureVersion,
      physicalMapSha256: binding.physicalMapSha256}, completion: {binding: setup}} as never);
    await db.exec('TRUNCATE clio_messages, clio_artifacts, clio_conversations, tenants');
    await db.query('INSERT INTO tenants VALUES ($1::uuid,$2::jsonb)', [ctx.tenantId, JSON.stringify(initialSettings)]);
    for (const id of [OLD, NEW]) await db.query(`INSERT INTO clio_conversations
      (id, tenant_id, user_id, client_id, metadata_jsonb) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb)`,
      [id, ctx.tenantId, ctx.userId, CLIENT, JSON.stringify(id === OLD ? oldMetadata : {})]);
  });

  test('reads plan, preserves old ledger/history, removes old qualification, installs once', async () => {
    expect(oldBudget.qualificationSha256).toBe('d267a5985fc3caeb94416393a684877bfa81a33b3db27d99a48d76afa6ece905');
    const before = await snapshot();
    const p = await plan();
    expect(await snapshot()).toEqual(before);
    expect(queries.some(q => /FOR UPDATE/.test(q) && /clio_conversations/.test(q))).toBe(true);
    await expect(apply(p.planSha256)).resolves.toMatchObject({status: 'NEW_BINDING_INSTALLED_REQUIRES_NEW_PROVIDER_QUALIFICATION'});
    const after = await snapshot(), f = after.settings.meriFoundationFixture;
    expect(after.conversations).toEqual(before.conversations);
    expect(after.settings.unrelated).toBe('keep');
    expect(f.otherFixtureField).toBe('keep');
    expect(f.captureEvidence).toEqual({...binding, captureRunId: NEW_RUN, remediationConversationId: NEW});
    expect(f.captureProviderBudget).toBeUndefined();
    expect(f.case12CaptureRemediation).toMatchObject({priorCaptureBinding: binding,
      priorProviderQualification: qualification, oldConversationMetadata: oldMetadata,
      apiSourceSha: SOURCE, newConversationId: NEW, newCaptureRunId: NEW_RUN, liveAcceptance: 'NOT_RUN'});
    await expect(plan()).rejects.toThrow('already_remediated');
    expect(await snapshot()).toEqual(after);
  });
  test('ordinary installer still refuses a second Case12 binding', async () => {
    await expect(run(tx => inspectCase12CaptureBindingInTx(prisma, tx,
      {ctx, clientId: CLIENT, captureRunId: NEW_RUN}))).rejects.toThrow('existing_case12_binding');
  });
  test.each(['tenant', 'old', 'new'] as const)('rejects a stale %s row version without mutation', async target => {
    const p = await plan();
    if (target === 'tenant') await setFixture({...initialSettings, changed: true});
    else await setMetadata(target === 'old' ? OLD : NEW, {...(target === 'old' ? oldMetadata : {}), changed: true});
    const before = await snapshot();
    await expect(apply(p.planSha256)).rejects.toThrow('stale_plan');
    expect(await snapshot()).toEqual(before);
  });
  test('failed CAS rolls back without replacing history', async () => {
    const p = await plan(), before = await snapshot(); failCas = true;
    await expect(apply(p.planSha256)).rejects.toThrow('cas_readback');
    expect(await snapshot()).toEqual(before);
  });
  test.each(['attempt', 'unknown', 'tokens', 'cost', 'turn', 'qualification', 'deadline'])(
    'rejects changed or nonzero prior budget: %s', async change => {
      const m: any = structuredClone(oldMetadata), b = m.serverCaptureProviderBudget;
      if (change === 'attempt') b.ledger.attempts.push({state: 'reserved'});
      if (change === 'unknown') b.ledger.chargedCostMicros = null;
      if (change === 'tokens') b.ledger.chargedTokens = 1;
      if (change === 'cost') b.ledger.chargedCostMicros = 1;
      if (change === 'turn') b.turnId = NEW_RUN;
      if (change === 'qualification') b.qualification.maxAttempts = 17;
      if (change === 'deadline') b.ledger.limits.deadlineAt = '2999-01-01T00:00:00Z';
      await setMetadata(OLD, m); const before = await snapshot();
      await expect(plan()).rejects.toThrow('old_budget_not_expired_zero_cost');
      expect(await snapshot()).toEqual(before);
    });
  test('uses the native clock and ignores a caller-supplied later time', async () => {
    nativeClock = Date.parse('2026-10-04T20:45:00Z');
    await expect(run(tx => inspect(prisma, tx, {...input, nowMs: Date.parse('2999-01-01')} as any)))
      .rejects.toThrow('old_budget_not_expired_zero_cost');
  });
  test.each([OLD, NEW])('rejects persisted messages in %s regardless of message tenant', async id => {
    await db.query('INSERT INTO clio_messages VALUES ($1::uuid,$2::uuid)', [id, NEW_RUN]);
    await expect(plan()).rejects.toThrow(/conversation_(has_messages|not_empty)/);
  });
  test.each([OLD, NEW])('rejects artifacts in %s', async id => {
    await db.query('INSERT INTO clio_artifacts VALUES ($1::uuid)', [id]);
    await expect(plan()).rejects.toThrow('conversation_has_artifacts');
  });
  test.each(['serverCaptureProviderBudget', 'serverCaptureEvidenceReceipt', 'case12CaptureAuthority'])(
    'rejects prior capture state in new conversation: %s', async field => {
      await setMetadata(NEW, {[field]: {}});
      await expect(plan()).rejects.toThrow('new_conversation_has_capture_state');
    });
  test.each(['user_id', 'tenant_id', 'client_id'] as const)('rejects a new conversation with wrong %s', async field => {
    await db.query(`UPDATE clio_conversations SET ${field}=$2::uuid WHERE id=$1::uuid`, [NEW, NEW_RUN]);
    await expect(plan()).rejects.toThrow('new_conversation_owner_mismatch');
  });
  test('rejects a corpus that no longer qualifies', async () => {
    jest.mocked(readMeriCase12CompletedCorpusInTx).mockRejectedValue(new Error('current_corpus_denied'));
    await expect(plan()).rejects.toThrow('current_corpus_denied');
    expect(queries.some(q => /UPDATE tenants/.test(q))).toBe(false);
  });
  test.each([{newConversationId: OLD}, {newCaptureRunId: OLD_RUN}, {expectedApiSourceSha: 'e'.repeat(40)},
    {expectedCurrentVerifySha256: 'e'.repeat(64)}, {clientId: NEW}])('rejects changed input %j', async change => {
      await expect(run(tx => inspect(prisma, tx, {...input, ...change}))).rejects.toThrow('meri_case12_capture_remediation_');
      expect(queries).toEqual([]);
    });
});
