import { randomUUID } from 'node:crypto';
import { ClientProfileFillWorkflowService } from './client-profile-fill-workflow.service.js';
import { ClientProfileFillService } from './client-profile-fill.service.js';
import { readResearchInputs, researchTaskInput } from './client-profile-fill-research-inputs.js';
import { createPortfolioSourceReader } from './portfolio-source-reader.js';
import { governedRun } from './profile-extraction-context.js';
import type { ClientProfileFillGovernedContext } from './client-profile-fill-context-plane.service.js';

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
  service.logger = { warn: jest.fn() };
  service.getClientSnapshot = jest.fn(async () => ({ name: 'Synthetic client', website: 'https://canonical.example/', description: '' }));
  service.addFinding = jest.fn(async () => true);
  service.addLdaHistory = jest.fn(async () => true);
  service.ldaCandidates = jest.fn();
  service.searchPublicWeb = jest.fn(async () => []);
  service.prisma = { withTenant: async (_tenant: string, run: any) => run({
    clientIntelMapping: { findMany: async () => [
      { externalId: '42', externalName: 'Existing identity', confidence: 1 },
      { externalId: '99', externalName: 'Later mapping', confidence: 1 },
    ] },
  }) };
  return service;
}

function withGovernedContext<T>(action: () => T): T {
  const bundle: ClientProfileFillGovernedContext = {
    kind: 'governed_packet', packet: { version: 2 } as never, packetId: 'synthetic-packet', traceHash: 'synthetic-trace',
    canonicalClient: { id: clientId, name: 'Synthetic client', website: 'https://canonical.example/', description: null,
      productDescription: null, primaryContactName: null, primaryContactEmail: null, primaryContactPhone: null,
      uei: null, cageCode: null, naicsCodes: [], pscCodes: [], updatedAt: new Date('2026-01-01T00:00:00Z') },
    coverage: { complete: true, requestedDomains: ['clients'], searchedDomains: ['clients'], missingDomains: [],
      partialDomains: [], recordsReturned: 1, paginationComplete: true, truncated: false, stopReason: 'complete' },
    records: [], modelContextBlock: '<capiro_crm_context_plane>PRIVATE SYNTHETIC CONTEXT</capiro_crm_context_plane>',
  };
  return governedRun.run(bundle, action);
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
  await withGovernedContext(() => service.extractPublicWeb(ctx, { id: clientId, name: 'Synthetic client', website: 'https://evidence.example/' },
    { url: 'https://evidence.example/', text: 'Approved evidence', description: null }, [], [],
    { kind: 'client', id: clientId }, signal));
  expect(extract).toHaveBeenCalledWith(expect.objectContaining({
    task: 'public_web', sourceOverview: true, maxTurns: 8, timeoutMs: 180_000, signal,
    sources: [{ id: 'page-0', url: 'https://evidence.example/', text: 'Approved evidence' }],
  }));
});

test.each([false, true])('the real collector bounds 40 pages plus 24 search hits before extraction (duplicate=%s)', async duplicate => {
  const service = engine();
  const pages = Array.from({ length: 40 }, (_, index) => ({
    url: `https://research.example/page-${index}`, text: `Approved page ${index}`, html: '', description: null,
  }));
  const companies = Array.from({ length: 16 }, (_, index) => ({
    url: `https://company-evidence.example/result-${index}`, title: `Company ${index}`, snippet: `Company evidence ${index}`,
  }));
  const news = Array.from({ length: 8 }, (_, index) => ({
    url: duplicate && index === 0 ? companies[0]!.url + '#same-source' : `https://news-evidence.example/result-${index}`,
    title: `News ${index}`, snippet: `News evidence ${index}`,
  }));
  service.searchCompany = jest.fn(async () => [...companies]);
  service.searchPublicWeb = jest.fn(async () => news);
  service.fetchPublicPages = jest.fn(async () => pages);
  service.people = { listPeople: jest.fn(async () => []) };
  service.facilities = { listFacilities: jest.fn(async () => []) };
  service.capabilities = { listCapabilities: jest.fn(async () => []) };
  const extract = jest.fn(async (request: any) => {
    // Use the production corpus validator, not a permissive adapter mock.
    expect(() => createPortfolioSourceReader(request.sources)).not.toThrow();
    return { data: { officialWebsite: { value: null, evidenceUrl: null },
      description: { value: null, evidenceUrl: null }, people: [], facilities: [], capabilities: [], news: [] } };
  });
  service.portfolioAgent = { extract };
  const signal = new AbortController().signal;
  expect(await withGovernedContext(() => service.gatherPublicWeb(ctx, clientId, runId, 'https://research.example/', undefined, signal))).toBe(0);
  expect(extract).toHaveBeenCalledTimes(1);
  const request = extract.mock.calls[0]![0];
  expect(request).toMatchObject({ task: 'public_web', sourceOverview: true, maxTurns: 8, signal });
  expect(request.prompt).toContain('PRIVATE SYNTHETIC CONTEXT');
  expect(request.instructions).toContain('It is not evidence');
  expect(JSON.stringify(request.sources)).not.toContain('PRIVATE SYNTHETIC CONTEXT');
  expect(request.sources).toHaveLength(56);
  expect(request.sources.slice(0, 40).map((source: any) => source.url)).toEqual(pages.map(page => page.url));
  // Existing news-first priority is stable; canonical duplicates consume no
  // extra slot, and remaining company results fill the sixteen-result budget.
  const retainedCompanies = companies.slice(duplicate ? 1 : 0, duplicate ? 9 : 8);
  expect(request.sources.slice(40).map((source: any) => source.url)).toEqual([...news, ...retainedCompanies].map(result => result.url));
  expect(request.sources.slice(40).map((source: any) => source.id)).toEqual(Array.from({ length: 16 }, (_, index) => `result-${index}`));
  expect(service.addFinding).not.toHaveBeenCalled();
});

test('real client extraction still refuses missing governed context before invoking the agent', async () => {
  const service = engine();
  service.portfolioAgent = { extract: jest.fn() };
  await expect(service.extractPublicWeb(ctx, { id: clientId, name: 'Synthetic client' },
    { url: 'https://evidence.example/', text: 'Approved evidence', description: null }, [], [],
    { kind: 'client', id: clientId })).rejects.toThrow('phase23_crm_context_plane_bundle_required');
  expect(service.portfolioAgent.extract).not.toHaveBeenCalled();
});
