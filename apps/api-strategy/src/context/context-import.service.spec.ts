import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { ContextImportService, splitContextSections, validateImportAnalysis, validateImportComparison } from './context-import.service.js';
import { locate } from './markdown-locate.js';
import { parseFrontmatter, validateFrontmatter } from './frontmatter.js';

const CLIENT = '11111111-1111-4111-a111-111111111111';
const STRATEGY = '22222222-2222-4222-a222-222222222222';
const ATTACHMENT = '33333333-3333-4333-a333-333333333333';
const TENANT = '44444444-4444-4444-a444-444444444444';
const tc = { tenantId: TENANT, clerkUserId: 'user_actual', role: 'org:admin' } as AuthTenantContext;
const sourceText = 'Client goal: secure grant funding.\nBudget cannot exceed $100,000.';
const file = { attachmentId: ATTACHMENT, clientId: CLIENT, fileName: 'Firm blueprint.pptx', contentHash: 'a'.repeat(64),
  sections: [{ ref: 'slide:1', label: 'Slide 1', text: sourceText }], warnings: [] };

function setup() {
  const stored = { documents: [] as any[], facts: [] as any[], conflicts: [] as any[] };
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    spStrategy: { findFirst: jest.fn(async ({ where }: any) => where.id === STRATEGY && where.clientId === CLIENT ? { id: STRATEGY } : null) },
    spContextDocument: {
      findFirst: jest.fn(async ({ where }: any) => stored.documents.find((d) => d.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: any) => stored.documents.filter((d) => !where?.id?.in || where.id.in.includes(d.id))),
      create: jest.fn(async ({ data }: any) => { const row = { ...data, createdAt: new Date(), updatedAt: new Date() }; stored.documents.push(row); return row; }),
    },
    spContextFact: {
      findMany: jest.fn(async ({ where }: any) => stored.facts.filter((f) => {
        const doc = stored.documents.find((entry) => entry.id === f.documentId) ?? { scope: 'client', clientId: CLIENT };
        const scopes = where?.document?.is?.AND?.[1]?.OR;
        return f.state === 'active' && (!scopes || scopes.some((scope: any) => Object.entries(scope).every(([key, value]) => doc[key] === value)));
      }).map((f) => ({ ...f,
        document: { title: stored.documents.find((doc) => doc.id === f.documentId)?.title ?? 'Prior brief' },
      })).slice(0, 101)),
      create: jest.fn(async ({ data }: any) => { const row = { ...data, id: `55555555-5555-4555-a555-${String(stored.facts.length + 1).padStart(12, '0')}`, createdAt: new Date(), updatedAt: new Date() }; stored.facts.push(row); return row; }),
    },
    spContextConflict: { create: jest.fn(async ({ data }: any) => { stored.conflicts.push(data); return data; }) },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, run: any) => run(tx)),
    withTenantUser: jest.fn(async (_tenant: string, _user: string, run: any) => {
      const before = { documents: [...stored.documents], facts: [...stored.facts], conflicts: [...stored.conflicts] };
      try { return await run(tx); } catch (error) { Object.assign(stored, before); throw error; }
    }),
  };
  const documents = { assertImportScopeAllowed: jest.fn(async () => undefined) };
  const versioning = { logActivity: jest.fn(async () => undefined) };
  const resolver = { resolve: jest.fn(async () => undefined) };
  const orchestrator = {
    contextImport: jest.fn(async (input: any) => ({ documents: [
      { documentType: 'strategy_brief', title: 'Strategy brief', sections: [{ heading: 'Source details', content: 'Client goal: secure grant funding.', evidence: [{ sourceRef: input.sections[0].ref, quote: 'Client goal: secure grant funding.' }] }] },
      { documentType: 'client_constraints', title: 'Client constraints', sections: [{ heading: 'Source details', content: 'Budget cannot exceed $100,000.', evidence: [{ sourceRef: input.sections[0].ref, quote: 'Budget cannot exceed $100,000.' }] }] },
    ], conflicts: [], warnings: [] })),
    contextCompare: jest.fn(async (_input: any) => ({ conflicts: [] as any[], warnings: [] })),
  };
  const config = new ConfigService({ INTERNAL_SERVICE_SECRET: 'test-only-context-import-signing-secret', API_INTERNAL_URL: 'https://api.test' });
  const service = new ContextImportService(config, prisma as any, documents as any, versioning as any, resolver as any, orchestrator as any);
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(file), { status: 200, headers: { 'content-type': 'application/json' } }));
  const resolve = () => service.resolve(tc, 'caller-session-token', { clientId: CLIENT, strategyId: STRATEGY, attachmentId: ATTACHMENT });
  const analyze = async () => {
    const resolved = await resolve();
    return service.analyze(tc, 'caller-session-token', resolved.chunks[0]!.token);
  };
  return { service, tx, stored, prisma, documents, versioning, orchestrator, fetchMock, resolve, analyze };
}

afterEach(() => jest.restoreAllMocks());

describe('context import workflow', () => {
  it('reviews mixed content without writing and sends the exact orchestrator request shape', async () => {
    const f = setup();
    const review = await f.analyze();
    expect(review.documents.map((d) => d.documentType)).toEqual(['strategy_brief', 'client_constraints']);
    expect(f.stored.documents).toHaveLength(0);
    expect(f.stored.facts).toHaveLength(0);
    expect(f.orchestrator.contextImport.mock.calls[0]![0].sections).toEqual([{ ref: 'slide:1#part1', text: sourceText }]);
    expect(f.fetchMock.mock.calls[0]![1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer caller-session-token' }) }));
  });

  it('saves selected categories with ready-to-use grounded facts and preserves earlier authoritative sources', async () => {
    const f = setup();
    f.stored.documents.push({ id: 'existing', title: 'Approved client instructions', authority: 'client_approved', state: 'active' });
    const review = await f.analyze();
    await f.service.save(tc, 'bearer', { token: review.token!, selectedDocumentIds: review.documents.map((d) => d.id) });
    expect(f.stored.documents).toHaveLength(3);
    expect(f.stored.documents[0]).toEqual({ id: 'existing', title: 'Approved client instructions', authority: 'client_approved', state: 'active' });
    expect(f.stored.facts).toHaveLength(2);
    for (const doc of f.stored.documents.slice(1)) {
      const parsed = parseFrontmatter(doc.content);
      expect(validateFrontmatter(parsed.frontmatter!)).toEqual([]);
      expect(parsed.frontmatter).toMatchObject({ authority: 'working_draft', source_of_truth: false, source_as_of_unknown: true, scope: 'strategy', strategy_id: STRATEGY });
      expect(doc.supersedesId).toBeNull();
    }
    for (const fact of f.stored.facts) {
      const doc = f.stored.documents.find((d) => d.id === fact.documentId);
      expect(locate(doc.content, fact.sourceRef)?.content).toContain(fact.fact);
      expect(JSON.parse(fact.citation)).toMatchObject({ attachmentId: ATTACHMENT, contentHash: file.contentHash });
      expect(fact).toMatchObject({ asOf: null, authority: 'working_draft', state: 'active' });
    }
  });

  it('supports incremental selections and idempotent replay without reviving rejected facts or archived files', async () => {
    const f = setup();
    const review = await f.analyze();
    const first = review.documents[0]!.id;
    await f.service.save(tc, 'bearer', { token: review.token!, selectedDocumentIds: [first] });
    f.stored.facts[0].state = 'rejected';
    f.stored.documents[0].state = 'archived';
    await f.service.save(tc, 'bearer', { token: review.token!, selectedDocumentIds: [first] });
    await f.service.save(tc, 'bearer', { token: review.token!, selectedDocumentIds: [review.documents[1]!.id] });
    expect(f.stored.documents).toHaveLength(2);
    expect(f.stored.documents[0].state).toBe('archived');
    expect(f.stored.facts[0].state).toBe('rejected');
    expect(f.stored.facts).toHaveLength(2);
    expect(f.orchestrator.contextCompare).toHaveBeenCalledTimes(2);
  });

  it('rejects forged tokens, cross-tenant/user tokens and using a chunk as an approved review', async () => {
    const f = setup();
    const resolved = await f.resolve();
    const token = resolved.chunks[0]!.token;
    const [payload, sig] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), clientId: STRATEGY })).toString('base64url')}.${sig}`;
    await expect(f.service.analyze(tc, 'bearer', forged)).rejects.toThrow('could not be verified');
    await expect(f.service.analyze({ ...tc, tenantId: CLIENT }, 'bearer', token)).rejects.toThrow('different session');
    await expect(f.service.analyze({ ...tc, clerkUserId: 'user_other' }, 'bearer', token)).rejects.toThrow('different session');
    await expect(f.service.save(tc, 'bearer', { token, selectedDocumentIds: ['invented'] })).rejects.toThrow('different session');
    expect(f.stored.documents).toHaveLength(0);
  });

  it('rejects expired previews and selections not in the signed review', async () => {
    const f = setup();
    const review = await f.analyze();
    await expect(f.service.save(tc, 'bearer', { token: review.token!, selectedDocumentIds: ['not-reviewed'] })).rejects.toThrow('only documents');
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 3_600_001);
    await expect(f.service.save(tc, 'bearer', { token: review.token!, selectedDocumentIds: [review.documents[0]!.id] })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONTEXT_IMPORT_EXPIRED' }) });
  });

  it('rechecks canonical source access and rejects a changed digest before analysis or saving', async () => {
    const f = setup();
    const review = await f.analyze();
    f.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...file, contentHash: 'b'.repeat(64) }), { status: 200 }));
    await expect(f.service.save(tc, 'bearer', { token: review.token!, selectedDocumentIds: [review.documents[0]!.id] })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONTEXT_IMPORT_SOURCE_CHANGED' }) });
    f.fetchMock.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    await expect(f.service.save(tc, 'bearer', { token: review.token!, selectedDocumentIds: [review.documents[0]!.id] })).rejects.toThrow('do not have access');
    expect(f.stored.documents).toHaveLength(0);
  });

  it('enforces client/strategy binding and the existing client-wide admin gate', async () => {
    const f = setup();
    await expect(f.service.resolve(tc, 'bearer', { clientId: STRATEGY, strategyId: STRATEGY, attachmentId: ATTACHMENT })).rejects.toThrow('not available for this client');
    f.documents.assertImportScopeAllowed.mockRejectedValueOnce(new ForbiddenException('admin required'));
    await expect(f.service.resolve({ ...tc, role: 'org:member' }, 'bearer', { clientId: CLIENT, attachmentId: ATTACHMENT })).rejects.toThrow('admin required');
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a source response bound to a different client and missing bearer', async () => {
    const f = setup();
    f.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...file, clientId: STRATEGY }), { status: 200 }));
    await expect(f.resolve()).rejects.toThrow('selected client');
    await expect(f.service.resolve(tc, undefined, { clientId: CLIENT, strategyId: STRATEGY, attachmentId: ATTACHMENT })).rejects.toThrow('Sign in again');
  });

  it('checks contradictions against prior batch imports and between selected categories', async () => {
    const f = setup();
    const review = await f.analyze();
    f.orchestrator.contextCompare.mockImplementationOnce(async (input) => ({ conflicts: [{ incomingFactId: input.incomingFacts[0].id, otherFactId: input.incomingFacts[1].id, material: true }], warnings: [] }));
    await f.service.save(tc, 'bearer', { token: review.token!, selectedDocumentIds: review.documents.map((d) => d.id) });
    expect(f.stored.conflicts).toEqual([{ tenantId: TENANT, factAId: f.stored.facts[0].id, factBId: f.stored.facts[1].id, material: true, state: 'open' }]);
  });

  it('compares with information saved after the preview and links that conflict to its prior fact', async () => {
    const f = setup();
    const review = await f.analyze();
    const priorId = '77777777-7777-4777-a777-777777777777';
    f.stored.facts.push({ id: priorId, fact: 'Budget cannot exceed $50,000.', state: 'active', updatedAt: new Date(), asOf: null });
    f.orchestrator.contextCompare.mockImplementationOnce(async (input) => {
      expect(input.existingFacts).toEqual([expect.objectContaining({ id: priorId, fact: 'Budget cannot exceed $50,000.' })]);
      return { conflicts: [{ incomingFactId: input.incomingFacts[0].id, otherFactId: priorId, material: true }], warnings: [] };
    });
    await f.service.save(tc, 'bearer', { token: review.token!, selectedDocumentIds: [review.documents[1]!.id] });
    expect(f.stored.conflicts[0]).toMatchObject({ factBId: priorId, material: true, state: 'open' });
  });

  it('excludes another strategy from comparisons while including client-wide information', async () => {
    const f = setup();
    f.stored.documents.push(
      { id: 'other-strategy', title: 'Different objective', scope: 'strategy', scopeRef: CLIENT, clientId: CLIENT },
      { id: 'this-strategy', title: 'Current objective', scope: 'strategy', scopeRef: STRATEGY, clientId: CLIENT },
      { id: 'client-doc', title: 'Client instructions', scope: 'client', clientId: CLIENT },
    );
    for (const documentId of ['other-strategy', 'this-strategy', 'client-doc']) f.stored.facts.push({ id: documentId, documentId, fact: documentId, state: 'active', updatedAt: new Date(), asOf: null });
    const review = await f.analyze();
    expect(f.orchestrator.contextImport.mock.calls[0]![0].existingFacts.map((fact: any) => fact.id)).toEqual(['this-strategy', 'client-doc']);
    await f.service.save(tc, 'bearer', { token: review.token!, selectedDocumentIds: [review.documents[0]!.id] });
    expect(f.orchestrator.contextCompare.mock.calls[0]![0].existingFacts.map((fact: any) => fact.id)).toEqual(['this-strategy', 'client-doc']);
  });

  it('preserves source disclosures throughout review and save', async () => {
    const f = setup();
    f.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...file, disclosure: 'This file was not scanned.' }), { status: 200 }));
    const review = await f.analyze();
    expect(review.warnings).toContain('This file was not scanned.');
    const saved = await f.service.save(tc, 'bearer', { token: review.token!, selectedDocumentIds: [review.documents[0]!.id] });
    expect(saved.warnings).toContain('This file was not scanned.');
  });

  it('saves nothing when conflict checking fails or the active corpus changes during checking', async () => {
    const f = setup();
    const review = await f.analyze();
    f.orchestrator.contextCompare.mockRejectedValueOnce(new Error('temporarily unavailable'));
    await expect(f.service.save(tc, 'bearer', { token: review.token!, selectedDocumentIds: [review.documents[0]!.id] })).rejects.toThrow('temporarily unavailable');
    expect(f.stored.documents).toHaveLength(0);
    f.orchestrator.contextCompare.mockImplementationOnce(async () => {
      f.stored.facts.push({ id: 'new-active', fact: 'A newer client decision.', state: 'active', updatedAt: new Date(), asOf: null });
      return { conflicts: [], warnings: [] };
    });
    await expect(f.service.save(tc, 'bearer', { token: review.token!, selectedDocumentIds: [review.documents[0]!.id] })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONTEXT_IMPORT_CORPUS_CHANGED' }) });
    expect(f.stored.documents).toHaveLength(0);
  });

  it('rolls back document creation when fact persistence fails', async () => {
    const f = setup();
    const review = await f.analyze();
    f.tx.spContextFact.create.mockRejectedValueOnce(new Error('database failure'));
    await expect(f.service.save(tc, 'bearer', { token: review.token!, selectedDocumentIds: [review.documents[0]!.id] })).rejects.toThrow('database failure');
    expect(f.stored.documents).toHaveLength(0);
    expect(f.stored.facts).toHaveLength(0);
  });
});

describe('source-grounding boundaries', () => {
  it('preserves every source character across long sections and bounds section count', () => {
    const original = `${'a'.repeat(22_000)}\n\n${'b'.repeat(26_000)}\n# Heading\nWith a qualifier.`;
    const chunks = splitContextSections([{ ref: 'page:1', label: 'Page 1', text: original }]);
    expect(chunks.flat().map((s) => s.text).join('')).toBe(original);
    expect(chunks[0]![0]!.text.endsWith('\n\n')).toBe(true);
    for (const chunk of chunks) expect(chunk.reduce((sum, s) => sum + s.text.length, 0)).toBeLessThanOrEqual(24_000);
    const short = splitContextSections(Array.from({ length: 500 }, (_, i) => ({ ref: `page:${i}`, label: '', text: `short text ${i}` })));
    expect(short.flat()).toHaveLength(500);
    expect(short.every((chunk) => chunk.length <= 160)).toBe(true);
  });

  it('rejects invented, mismatched, or paraphrased evidence and unsupported categories', () => {
    const sections = [{ ref: 'page:1', label: '', text: 'The request is conditional.' }];
    const valid = { documents: [{ documentType: 'strategy_brief' as const, title: 'Strategy brief', sections: [{ heading: 'Source details', content: sections[0]!.text, evidence: [{ sourceRef: 'page:1', quote: sections[0]!.text }] }] }], conflicts: [] };
    expect(validateImportAnalysis(valid, sections, new Set()).documents).toHaveLength(1);
    const changed = structuredClone(valid);
    changed.documents[0]!.sections[0]!.content = 'The request is approved.';
    expect(() => validateImportAnalysis(changed, sections, new Set())).toThrow('reliably match');
    changed.documents[0]!.sections[0]!.evidence[0]!.quote = 'The request is approved.';
    expect(() => validateImportAnalysis(changed, sections, new Set())).toThrow('reliably match');
    expect(() => validateImportAnalysis({ ...valid, documents: [{ ...valid.documents[0]!, documentType: 'new_permission' as any }] }, sections, new Set())).toThrow('reliably match');
  });

  // F01 regression: live CloudWatch evidence showed the primary import path
  // hard-failing on a plain synthetic .txt file with "Meri could not finish
  // reading this file" — root cause was this second, independent grounding
  // check rejecting a quote that differed from the source only by lossless
  // typographic normalization the model applies (curly quotes, NBSP, joined
  // line breaks), not fabrication.
  it('accepts a quote that differs from the source only by typographic normalization (F01)', () => {
    const sourceText = 'Goal: Increase visibility.\nOwner: Program Director.';
    const sections = [{ ref: 'text:1', label: '', text: sourceText }];
    const modelQuote = 'Goal: Increase visibility. Owner: Program Director.';
    const valid = {
      documents: [{
        documentType: 'strategy_brief' as const,
        title: 'Strategy brief',
        sections: [{ heading: 'Source details', content: modelQuote, evidence: [{ sourceRef: 'text:1', quote: modelQuote }] }],
      }],
      conflicts: [],
    };
    expect(validateImportAnalysis(valid, sections, new Set()).documents).toHaveLength(1);
  });

  it('still rejects a fabricated quote under the typography-tolerant check (F01)', () => {
    const sourceText = 'Owner: Program Director. Dates: Effective 2026-09-01.';
    const sections = [{ ref: 'text:1', label: '', text: sourceText }];
    const fabricated = 'Owner: Program Director. Dates: Effective 2099-01-01.';
    const invalid = {
      documents: [{
        documentType: 'strategy_brief' as const,
        title: 'Strategy brief',
        sections: [{ heading: 'Source details', content: fabricated, evidence: [{ sourceRef: 'text:1', quote: fabricated }] }],
      }],
      conflicts: [],
    };
    expect(() => validateImportAnalysis(invalid, sections, new Set())).toThrow('reliably match');
  });

  it('accepts only comparison pairs drawn from the exact incoming and existing sets', () => {
    expect(() => validateImportComparison({ conflicts: [{ incomingFactId: 'one', otherFactId: 'other-tenant', material: true }] }, new Set(['one']), new Set(['prior']))).toThrow('Nothing was saved');
    expect(() => validateImportComparison({ conflicts: [{ incomingFactId: 'one', otherFactId: 'one', material: false }] }, new Set(['one']), new Set())).toThrow('Nothing was saved');
  });
});
