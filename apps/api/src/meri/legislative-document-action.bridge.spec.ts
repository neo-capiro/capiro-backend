/** Core-side classification and boundary cases for the two governed legislative-document effects.
 * These drive the REAL shared write boundary and the REAL bridge classification; the mounted route +
 * authority behaviour is covered in legislative-document-action.http.spec.ts. No network is used. */
import { MeriToolsService } from './meri-tools.service.js';

const revision = '1'.repeat(64);
const briefingRequest = {
  clientId: null as string | null,
  folderId: '20000000-0000-4000-8000-000000000011',
  template: 'research_update',
  title: 'Session briefing',
  analysis: 'Cited original analysis.',
  cutoff: '2026-10-26T00:00:00.000Z',
  timezone: 'America/New_York',
  requestKey: 'synthetic-legislative-document',
  sources: [{ kind: 'news', id: 'n1', revision }],
  citations: [{ kind: 'news', id: 'n1', revision, locator: 'body', start: 0, end: 4, quote: 'text' }],
};
const researchRequest = {
  clientId: null as string | null,
  jurisdiction: 'FL',
  sessionKey: '2026-regular',
  title: 'Research draft',
  analysis: 'Cited original analysis.',
  requestKey: 'synthetic-legislative-document',
  documents: [{ id: 'd1', revision }],
  citations: [{ documentId: 'd1', revision, locator: 'sec-1', start: 0, end: 4, quote: 'text' }],
};

describe('save_legislative_research durable receipt classification', () => {
  const beforeFetch = global.fetch,
    beforeSecret = process.env.INTERNAL_SERVICE_SECRET;
  afterEach(() => {
    global.fetch = beforeFetch;
    if (beforeSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = beforeSecret;
  });
  const call = async (tool: string, json: unknown) => {
    process.env.INTERNAL_SERVICE_SECRET = 'synthetic-internal';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => json });
    return (MeriToolsService.prototype as any).legiwatchTool.call(
      Object.assign(Object.create(MeriToolsService.prototype), { isSideEffecting: () => true }),
      { tenantId: 'tenant-1', clerkUserId: 'owner-1' },
      tool,
      { requestKey: 'same-key' },
    );
  };
  test('an exported draft is reported complete with its canonical workspace location', async () => {
    expect(
      await call('save_legislative_research', {
        selectionId: 'selection-1',
        draft: { draftId: 'draft-1', state: 'complete', replayed: true },
      }),
    ).toMatchObject({
      documentId: 'draft-1',
      location: '/workspace/draft/draft-1',
      status: 'saved',
      reused: true,
    });
  });
  test('a selection-only save is never relabelled as a completed document', async () => {
    expect(
      await call('save_legislative_research', { selectionId: 'selection-2', state: 'saved' }),
    ).toMatchObject({
      status: 'selection_saved',
      documentId: null,
      location: null,
      reused: false,
    });
  });
  test('an unconfirmed outcome stays unknown and is never reported as saved', async () => {
    await expect(call('save_legislative_research', { selectionId: 'selection-3' })).rejects.toThrow(
      'Research draft receipt unavailable',
    );
  });
});

describe('canonical legislative-document write boundary', () => {
  const validate = (tool: string, input: unknown) =>
    (MeriToolsService.prototype as any).validateSideEffectingInput.call(
      { isSideEffecting: () => true, requireResearchPortfolioTools: () => {} },
      tool,
      input,
    );
  const citation = (index: number) => ({
    kind: 'news',
    id: `n${index}`,
    revision,
    locator: 'body',
    start: 0,
    end: 4,
    quote: 'text',
  });
  test('the advertised 150-citation briefing bound is accepted, and 151 is refused', () => {
    expect(
      validate('prepare_legiwatch_briefing', {
        ...briefingRequest,
        citations: Array.from({ length: 150 }, (_, index) => citation(index)),
      }).citations,
    ).toHaveLength(150);
    expect(() =>
      validate('prepare_legiwatch_briefing', {
        ...briefingRequest,
        citations: Array.from({ length: 151 }, (_, index) => citation(index)),
      }),
    ).toThrow();
  });
  test("the research owner's cross-session fields survive the boundary unchanged", () => {
    expect(
      validate('save_legislative_research', {
        ...researchRequest,
        allowCrossBill: true,
        rightSessionKey: '2026-special',
        documents: [{ id: 'd1', revision, sessionKey: '2026-special' }],
      }),
    ).toMatchObject({
      allowCrossBill: true,
      rightSessionKey: '2026-special',
      documents: [{ id: 'd1', revision, sessionKey: '2026-special' }],
    });
  });
  test('a client-omitted briefing (the declared client-less folder form) is accepted', () => {
    const input = validate('prepare_legiwatch_briefing', briefingRequest);
    expect('clientId' in input).toBe(false);
  });
  test('an undeclared property is still refused at the boundary', () => {
    expect(() =>
      validate('save_legislative_research', { ...researchRequest, unexpected: true }),
    ).toThrow(/Invalid legislative document selection/u);
  });
});
