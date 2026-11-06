import { randomUUID } from 'node:crypto';
import { ClientProfileFillWorkflowService } from './client-profile-fill-workflow.service.js';
import { ClientProfileFillService } from './client-profile-fill.service.js';
import { readResearchInputs, researchTaskInput } from './client-profile-fill-research-inputs.js';

const ctx = { tenantId: randomUUID(), userId: randomUUID(), role: 'standard_user' } as any;
const clientId = randomUUID(), runId = randomUUID();
const selected = [{ id: 42, name: 'Existing identity', confidence: 1 }];
const suggested = { id: 73, name: 'Research candidate', confidence: 0.8 };

function workflow() {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const tx = {
    $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      writes.push({ sql, args });
      return [{ id: runId }];
    }),
    $executeRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      writes.push({ sql, args }); return 1;
    }),
  };
  const prisma = { withTenant: async (_tenant: string, run: any) => run(tx) };
  const engine = { maybeSeedWebsite: jest.fn(), gatherPublicWeb: jest.fn(), gatherLda: jest.fn() };
  const intelligence = { createManualMapping: jest.fn() };
  const prepopulation = { prepopulate: jest.fn() };
  const context = { resolve: jest.fn(async () => ({})), recordRunContext: jest.fn(), failRun: jest.fn() };
  const service = new ClientProfileFillWorkflowService(prisma as any, engine as any, context as any,
    {} as any, intelligence as any, prepopulation as any, {} as any) as any;
  service.latestActiveRun = jest.fn(async () => null);
  service.getSetup = jest.fn(async () => ({
    website: 'https://saved.example/', selectedIdentities: selected, suggestedIdentities: [suggested],
  }));
  service.validateAttachments = jest.fn(async () => []);
  service.getRun = jest.fn(async () => ({ id: runId }));
  service.requestSweep = jest.fn();
  return { service, writes, engine, intelligence, prepopulation, context };
}

test('starting research persists provisional selections only in the existing run/task rows', async () => {
  const h = workflow();
  await h.service.startRun(ctx, clientId, {
    sources: ['public_web', 'lda'], website: 'https://research.example/', ldaClientIds: [73],
  });
  expect(h.engine.maybeSeedWebsite).not.toHaveBeenCalled();
  expect(h.intelligence.createManualMapping).not.toHaveBeenCalled();
  expect(h.prepopulation.prepopulate).not.toHaveBeenCalled();
  const run = h.writes.find(row => row.sql.includes('INSERT INTO client_profile_fill_run'))!;
  expect(JSON.parse(run.args[5] as string)).toMatchObject({
    researchInputVersion: 1, website: 'https://research.example/', selectedLdaIds: [42, 73], appendedLdaIds: [73],
  });
  const tasks = h.writes.filter(row => row.sql.includes('INSERT INTO client_profile_fill_task'));
  expect(JSON.parse(tasks.find(row => row.args[4] === 'public_web')!.args[7] as string)).toEqual({
    researchInputVersion: 1, website: 'https://research.example/',
  });
  expect(JSON.parse(tasks.find(row => row.args[4] === 'lda')!.args[7] as string)).toEqual({
    researchInputVersion: 1, ldaIdentities: [...selected, suggested],
  });
  expect(h.writes.filter(row => !/^\s*SELECT/.test(row.sql)).every(row =>
    /(?:INSERT INTO|UPDATE) client_profile_fill_(?:run|task|extension_task)/.test(row.sql))).toBe(true);
});
test('an omitted website is fixed to the selected setup snapshot, not a later client edit', async () => {
  const h = workflow();
  await h.service.startRun(ctx, clientId, { sources: ['public_web'] });
  const task = h.writes.find(row => row.sql.includes('INSERT INTO client_profile_fill_task'))!;
  expect(JSON.parse(task.args[7] as string).website).toBe('https://saved.example/');
});
test('preparation failure does not save the website or identities to canonical data', async () => {
  const h = workflow();
  h.context.resolve.mockRejectedValueOnce(new Error('Current source refused'));
  await expect(h.service.startRun(ctx, clientId, {
    sources: ['public_web', 'lda'], website: 'https://research.example/', ldaClientIds: [73],
  })).rejects.toThrow('Current source refused');
  expect(h.writes).toEqual([]);
  expect(h.intelligence.createManualMapping).not.toHaveBeenCalled();
  expect(h.engine.maybeSeedWebsite).not.toHaveBeenCalled();
});
test('unoffered identities are still refused before any research persistence', async () => {
  const h = workflow();
  await expect(h.service.startRun(ctx, clientId, { sources: ['lda'], ldaClientIds: [99] })).rejects.toThrow('not offered');
  expect(h.writes).toEqual([]);
});
test('reloaded workers receive their recorded inputs; malformed new inputs cannot fall back', async () => {
  const h = workflow();
  const task = { clientId, runId, taskType: 'public_web', input: researchTaskInput('public_web', 'https://research.example/', []) };
  const signal = new AbortController().signal;
  await h.service.executeTask(ctx, structuredClone(task), {}, signal);
  expect(h.engine.gatherPublicWeb).toHaveBeenCalledWith(ctx, clientId, runId, 'https://research.example/', undefined, signal, undefined, undefined);
  const unit = {id: randomUUID(), name: 'Reviewed fixture segment', annualReportYear: 2026, sourceUrls: ['https://research.example/annual-report']};
  await h.service.executeTask(ctx, {...task, input: researchTaskInput('public_web', 'https://research.example/', [], unit)}, {}, signal);
  expect(h.engine.gatherPublicWeb).toHaveBeenLastCalledWith(ctx, clientId, runId, 'https://research.example/', undefined, signal, unit, undefined);
  await h.service.executeTask(ctx, { ...task, taskType: 'lda', input: researchTaskInput('lda', null, [suggested]) }, {});
  expect(h.engine.gatherLda).toHaveBeenCalledWith(ctx, clientId, runId, [suggested]);
  expect(() => readResearchInputs({ researchInputVersion: 1 }, 'public_web')).toThrow('does not match');
  expect(() => readResearchInputs({ researchInputVersion: 1, website: 1 }, 'public_web')).toThrow('Invalid');
  expect(() => readResearchInputs({ researchInputVersion: 1, ldaIdentities: [suggested, suggested] }, 'lda')).toThrow('Duplicate');
  expect(() => readResearchInputs({ researchInputVersion: 2 }, 'lda')).toThrow('Unsupported');
});

function engine() {
  const service = Object.create(ClientProfileFillService.prototype) as any;
  service.getClientSnapshot = jest.fn(async () => ({ name: 'Synthetic client', website: 'https://canonical.example/', description: '' }));
  service.addFinding = jest.fn(async () => true);
  service.addLdaHistory = jest.fn(async () => true);
  service.ldaCandidates = jest.fn();
  service.prisma = { withTenant: async (_tenant: string, run: any) => run({
    clientIntelMapping: { findMany: async () => [
      { externalId: '42', externalName: 'Existing identity', confidence: 1 },
      { externalId: '99', externalName: 'Later mapping', confidence: 1 },
    ] },
  }) };
  return service;
}
test('selected LDA inputs produce provisional findings and do not widen to later mappings', async () => {
  const service = engine();
  expect(await service.gatherLda(ctx, clientId, runId, [...selected, suggested])).toBe(3);
  expect(service.addFinding).toHaveBeenCalledTimes(1);
  expect(service.addFinding).toHaveBeenCalledWith(ctx.tenantId, clientId, runId, expect.objectContaining({
    kind: 'lda_identity', factKind: 'recommendation', currentValue: null,
    proposedValue: { externalId: '73', externalName: suggested.name, selectedForResearch: true },
  }), {kind: 'client', id: clientId});
  expect(service.addLdaHistory.mock.calls.map((args: unknown[]) => args[3])).toEqual(['42', '73']);
  expect(service.ldaCandidates).not.toHaveBeenCalled();
});
test('explicit empty LDA selections do not run name matching or newly confirmed mappings', async () => {
  const service = engine();
  expect(await service.gatherLda(ctx, clientId, runId, [])).toBe(0);
  expect(service.addLdaHistory).not.toHaveBeenCalled();
  expect(service.ldaCandidates).not.toHaveBeenCalled();
});
test('web research uses its seed while finding current values remain canonical', async () => {
  const service = engine();
  service.searchCompany = jest.fn(async () => []);
  service.fetchPublicPages = jest.fn(async () => [{ url: 'https://research.example/', html: '', text: 'Evidence', description: 'Proposed description' }]);
  service.extractPublicWeb = jest.fn(async () => null);
  const signal = new AbortController().signal;
  expect(await service.gatherPublicWeb(ctx, clientId, runId, 'https://research.example/', undefined, signal)).toBe(1);
  expect(service.extractPublicWeb).toHaveBeenCalledWith(ctx, expect.anything(), expect.anything(), [], expect.anything(), {kind:'client',id:clientId}, signal, undefined);
  expect(service.searchCompany).toHaveBeenCalledWith(expect.objectContaining({ website: 'https://research.example/' }));
  expect(service.fetchPublicPages).toHaveBeenCalledWith('https://research.example/', signal, false);
  expect(service.addFinding).toHaveBeenCalledWith(ctx.tenantId, clientId, runId, expect.objectContaining({
    targetKey: 'description', currentValue: '', proposedValue: 'Proposed description',
  }), {kind: 'client', id: clientId});
});
test('a recorded absent website does not silently adopt a later canonical website', async () => {
  const service = engine();
  service.searchCompany = jest.fn(async () => []);
  service.fetchPublicPages = jest.fn();
  service.extractPublicWeb = jest.fn(async () => null);
  expect(await service.gatherPublicWeb(ctx, clientId, runId, null)).toBe(0);
  expect(service.searchCompany).toHaveBeenCalledWith(expect.objectContaining({ website: null }));
  expect(service.fetchPublicPages).not.toHaveBeenCalled();
  expect(readResearchInputs({}, 'public_web')).toEqual({});
});

test('initial public-web extraction selects the bounded corpus protocol and preserves its task signal', async () => {
  const service = engine();
  const extract = jest.fn(async () => ({ data: { officialWebsite: { value: null, evidenceUrl: null },
    description: { value: null, evidenceUrl: null }, people: [], facilities: [], capabilities: [], news: [] } }));
  service.portfolioAgent = { extract };
  const signal = new AbortController().signal;
  await service.extractPublicWeb(ctx, { id: clientId, name: 'Synthetic client', website: 'https://evidence.example/' },
    { url: 'https://evidence.example/', text: 'Approved evidence', description: null }, [], [],
    { kind: 'client', id: clientId }, signal);
  expect(extract).toHaveBeenCalledWith(expect.objectContaining({
    task: 'public_web', sourceOverview: true, maxTurns: 8, timeoutMs: 180_000, signal,
    sources: [{ id: 'page-0', url: 'https://evidence.example/', text: 'Approved evidence' }],
  }));
});
