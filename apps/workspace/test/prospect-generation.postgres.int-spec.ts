import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ProspectGenerationService } from '../src/document-agent/prospect-generation/prospect-generation.service.js';
import { NativeGenerationOwnerError } from '../src/document-agent/native-generation-conversation.client.js';
import type { ProspectGenerationInput } from '../src/document-agent/prospect-generation/contract.js';
import type { DraftsService } from '../src/drafts/drafts.service.js';

const repoRoot = resolve(__dirname, '../../..');
const helper = require(join(repoRoot, 'scripts/testing/a1-disposable-postgres.cjs'));
const readiness = helper.nativePostgresReadiness({ repoRoot });
const native = readiness.available ? describe : describe.skip;
type Runtime = typeof import('./support/ws03-postgres-harness.js');
type Harness = Awaited<ReturnType<Runtime['createNativeWorkspaceHarness']>>;
const prospectId = '00000000-0000-4000-8000-000000000080';
const actor = 'user_owner';
const runId = '00000000-0000-4000-8000-000000000099';
const output = {
  status: 'complete',
  runId,
  result: {
    document: {
      sections: [
        { id: 'section-1', text: 'Generated scope' },
        { id: 'section-2', text: 'Generated next steps' },
      ],
    },
  },
};

native(`prospect generation lifecycle PostgreSQL [${readiness.reason}]`, () => {
  let database: { url: string; cleanup(): Promise<void> }, h: Harness, runtime: Runtime;
  let generation: ProspectGenerationService, drafts: DraftsService, input: ProspectGenerationInput;
  let tenantId: string, draftId: string;
  const turn = jest.fn(),
    readTurn = jest.fn(),
    register = jest.fn();
  beforeAll(async () => {
    database = await helper.createDisposableSchema({
      repoRoot,
      coreSchemaPath: join(__dirname, 'support/workspace-identity.fixture.prisma'),
      workspaceSchemaPath: join(repoRoot, 'apps/workspace/prisma/schema.prisma'),
      extraModels: await readFile(
        join(__dirname, 'support/ws-source-action.fixture.prisma'),
        'utf8',
      ),
    });
    runtime = require('./support/ws03-postgres-harness.js');
    h = await runtime.createNativeWorkspaceHarness(database.url, {
      generation: {
        bootstrap: { configured: () => true, register },
        native: { turn, readTurn, cancel: jest.fn() },
      },
    });
    ({ tenantId, draftId } = runtime.WS03_IDS);
    generation = h.app.get(ProspectGenerationService);
    drafts = h.app.get(require('../src/drafts/drafts.service.js').DraftsService);
    await h.db.$executeRawUnsafe(
      'INSERT INTO business_development_prospects (id,tenant_id,display_name,updated_at) VALUES ($1::uuid,$2::uuid,$3,now())',
      prospectId,
      tenantId,
      'Synthetic prospect',
    );
  }, 240000);
  afterAll(async () => {
    try {
      await h?.close();
    } finally {
      await database?.cleanup();
    }
  }, 60000);
  beforeEach(async () => {
    turn.mockReset().mockResolvedValue(output);
    readTurn.mockReset().mockResolvedValue(output);
    register.mockReset().mockResolvedValue('registered');
    await h.reset();
    await h.db.wsDraft.update({ where: { id: draftId }, data: { prospectId } });
    await h.db.$executeRawUnsafe(
      "UPDATE business_development_prospects SET status='active',dismissed_at=NULL,linked_client_id=NULL WHERE id=$1::uuid",
      prospectId,
    );
    await h.db.$executeRawUnsafe(
      "UPDATE tenant_memberships SET status='active' WHERE tenant_id=$1::uuid",
      tenantId,
    );
    await h.db.$executeRawUnsafe(
      'UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid',
      JSON.stringify({ clioFeatureFlags: { 'businessDevelopment.enabled': true } }),
      tenantId,
    );
    const state = await drafts.prospectState(tenantId, draftId, actor, prospectId);
    const saved = await drafts.saveProspect(tenantId, draftId, actor, {
      requestId: randomUUID(),
      expectedProspectId: prospectId,
      expectedStateHash: state.stateHash,
      title: 'Saved proposal',
      names: ['Scope', 'Next steps'],
      sections: { Scope: 'Selected evidence', 'Next steps': 'UNSELECTED EVIDENCE' },
    });
    input = {
      requestId: randomUUID(),
      expectedProspectId: prospectId,
      expectedStateHash: saved.receipt.stateHash,
      sourceVersionId: saved.receipt.versionId,
      sourceSnapshotHash: saved.receipt.snapshotHash,
      selectedSections: ['Scope'],
      writingBrief: 'Write a concise proposal',
      paidGeneration: true,
    };
  });
  const generate = () => generation.generate(tenantId, draftId, actor, input, 'current-session');
  const read = () => generation.read(tenantId, draftId, prospectId, actor, input.requestId);
  const advance = (action: 'retry' | 'reconcile') =>
    generation.advance(
      tenantId,
      draftId,
      prospectId,
      actor,
      input.requestId,
      'current-session',
      action,
    );
  const decision = (
    proposal: Awaited<ReturnType<typeof read>>,
    choice: 'accept' | 'reject' = 'accept',
  ) => ({
    requestId: randomUUID(),
    decision: choice,
    expectedStateHash: proposal.baseStateHash,
    outputHash: proposal.outputHash!,
  });
  const decide = (body: ReturnType<typeof decision>) =>
    generation.decide(tenantId, draftId, prospectId, actor, input.requestId, body);
  async function laterSave() {
    const state = await drafts.prospectState(tenantId, draftId, actor, prospectId);
    return drafts.saveProspect(tenantId, draftId, actor, {
      requestId: randomUUID(),
      expectedProspectId: prospectId,
      expectedStateHash: state.stateHash,
      title: 'Later work',
      names: ['Scope'],
      sections: { Scope: 'Later edited content' },
    });
  }

  it('retains before dispatch, selects only saved evidence, creates a proposal without saving or publishing', async () => {
    const before = await h.snapshot();
    turn.mockImplementationOnce(async (request) => {
      expect(await h.db.wsAgentProposal.count({ where: { id: input.requestId } })).toBe(1);
      expect(request.actorId).toBe('00000000-0000-4000-8000-000000000020');
      expect(request.writingBrief).toBe(input.writingBrief);
      expect(JSON.stringify(request.sources)).toContain('Selected evidence');
      expect(JSON.stringify(request.sources)).not.toContain('UNSELECTED EVIDENCE');
      return output;
    });
    const proposal = await generate(),
      after = await h.snapshot();
    expect(proposal.phase).toBe('ready');
    expect(proposal.output?.sections.Scope).toBe('Generated scope');
    expect(after.drafts).toEqual(before.drafts);
    expect(after.versions).toEqual(before.versions);
    expect(register.mock.calls[0][1]).toBe('00000000-0000-4000-8000-000000000020');
    expect(
      (await generation.list(tenantId, draftId, prospectId, actor)).proposals[0]?.output,
    ).toBeNull();
    expect(await generate()).toEqual(proposal);
    expect(turn).toHaveBeenCalledTimes(1);
    await expect(
      generation.generate(
        tenantId,
        draftId,
        actor,
        { ...input, writingBrief: 'Different intent' },
        'session',
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('recovers lost acknowledgement by readback and explicit same-request retry without a new identity', async () => {
    turn.mockRejectedValueOnce(new Error('Connection lost'));
    expect((await generate()).phase).toBe('unknown');
    expect((await generate()).phase).toBe('unknown');
    expect(turn).toHaveBeenCalledTimes(1);
    readTurn.mockResolvedValueOnce(null);
    expect((await advance('reconcile')).phase).toBe('unknown');
    expect(turn).toHaveBeenCalledTimes(1);
    expect((await advance('retry')).phase).toBe('ready');
    expect(turn.mock.calls[1][0]).toEqual(turn.mock.calls[0][0]);
    expect((await advance('retry')).phase).toBe('ready');
    expect(turn).toHaveBeenCalledTimes(2);
  });
  it('accepts atomically once and replays the original saved version after later edits', async () => {
    const proposal = await generate(),
      body = decision(proposal);
    const [first, second] = await Promise.all([decide(body), decide(body)]);
    expect(first.save?.receipt.versionId).toBe(body.requestId);
    expect(second.save?.receipt).toEqual(first.save?.receipt);
    expect(first.proposal.status).toBe('accepted');
    const version = await h.db.wsDocVersion.findUniqueOrThrow({ where: { id: body.requestId } });
    expect((version.snapshot as any).config.prospectGeneration.sourceVersionId).toBe(
      input.sourceVersionId,
    );
    expect((version.snapshot as any).prospectPublication).toBeUndefined();
    await laterSave();
    expect((await decide(body)).save?.receipt).toEqual(first.save?.receipt);
    expect((await h.db.wsDraft.findUniqueOrThrow({ where: { id: draftId } })).docTitle).toBe(
      'Later work',
    );
    await expect(decide({ ...body, requestId: randomUUID() })).rejects.toMatchObject({
      status: 409,
    });
  });
  it('rejects stale acceptance and allows an explicit rejection without modifying newer work', async () => {
    const proposal = await generate();
    await laterSave();
    await expect(decide(decision(proposal))).rejects.toMatchObject({ status: 409 });
    expect((await read()).stale).toBe(true);
    const body = decision(proposal, 'reject'),
      rejected = await decide(body);
    expect(rejected.save).toBeNull();
    expect(rejected.proposal.status).toBe('rejected');
    expect(await decide(body)).toEqual(rejected);
    expect((await h.db.wsDraft.findUniqueOrThrow({ where: { id: draftId } })).docTitle).toBe(
      'Later work',
    );
  });
  it('serializes competing acceptance and rejection so exactly one decision wins', async () => {
    const proposal = await generate();
    const results = await Promise.allSettled([
      decide(decision(proposal)),
      decide(decision(proposal, 'reject')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
  it('blocks revoked membership before read, retry, decision or another native call', async () => {
    const proposal = await generate();
    await h.db.$executeRawUnsafe(
      "UPDATE tenant_memberships SET status='inactive' WHERE tenant_id=$1::uuid",
      tenantId,
    );
    await expect(read()).rejects.toMatchObject({ status: 404 });
    await expect(advance('retry')).rejects.toMatchObject({ status: 404 });
    await expect(decide(decision(proposal))).rejects.toMatchObject({ status: 404 });
    expect(turn).toHaveBeenCalledTimes(1);
  });
  it('rechecks current source authority after the external run before retaining output', async () => {
    turn.mockImplementationOnce(async () => {
      await h.db.$executeRawUnsafe("UPDATE business_development_prospects SET status='archived' WHERE id=$1::uuid", prospectId);
      return output;
    });
    await expect(generate()).rejects.toMatchObject({ status: 404 });
    const row = await h.db.wsAgentProposal.findUniqueOrThrow({ where: { id: input.requestId } });
    expect((row.payload as any).output).toBeUndefined();
    expect((row.payload as any).phase).toBe('unknown');
  });
  it('does not let a late unknown read overwrite a completed proposal', async () => {
    turn.mockRejectedValueOnce(new Error('Lost acknowledgement'));
    await generate();
    let release!: (value: null) => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    readTurn.mockImplementationOnce(() => { started(); return new Promise(resolve => { release = resolve; }); });
    const late = advance('reconcile');
    await entered;
    expect((await advance('reconcile')).phase).toBe('ready');
    release(null);
    expect((await late).phase).toBe('ready');
  });
  it('records invalid output as failure and surfaces current native authority refusal', async () => {
    turn.mockResolvedValueOnce({
      ...output,
      result: { document: { sections: [{ id: 'wrong', text: 'Wrong shape' }] } },
    });
    const failed = await generate();
    expect(failed.phase).toBe('failed');
    expect(failed.failureReason).toBe('output-invalid');
    expect(failed.output).toBeNull();
    expect((await advance('retry')).phase).toBe('failed');
    expect(turn).toHaveBeenCalledTimes(1);
    input = { ...input, requestId: randomUUID() };
    turn.mockRejectedValueOnce(new NativeGenerationOwnerError('authority', 403, 'Revoked'));
    await expect(generate()).rejects.toMatchObject({ status: 403 });
  });
  it('can reconcile an approval wait without bypassing approval by redispatching', async () => {
    turn.mockResolvedValueOnce({ status: 'approval_required', runId, proposalId: randomUUID() });
    expect((await generate()).phase).toBe('approval-required');
    expect((await advance('retry')).phase).toBe('approval-required');
    expect(turn).toHaveBeenCalledTimes(1);
    expect((await advance('reconcile')).phase).toBe('ready');
    expect(readTurn).toHaveBeenCalledTimes(1);
  });
  it('mounts the guarded HTTP route with closed inputs and server-owned identity', async () => {
    const url = await h.app.getUrl(),
      path = `${url}/workspace-api/drafts/${draftId}/prospect-generation`;
    const post = (body: unknown, auth = true) =>
      fetch(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(auth ? { authorization: `Bearer ${runtime.NATIVE_TOKEN}` } : {}),
        },
        body: JSON.stringify(body),
      });
    expect((await post(input, false)).status).toBe(401);
    expect((await post({ ...input, actorId: 'spoofed' })).status).toBe(400);
    const response = await post(input);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ phase: 'ready' });
  });
});
