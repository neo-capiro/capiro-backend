import { createHash } from 'node:crypto';
import { classifyApiToolReadOutcome, MERI_CAPABILITY_REGISTRY } from '@capiro/shared';
import { MeriToolsService } from './meri-tools.service.js';
import {
  currentOwnerResultAuthorizesReplay,
  supportsDurableOwnerReauthorization,
} from './meri-research-replay-authorization.js';
import { publicResearchSourceTool } from './meri-report-provenance.js';

jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const REVISION = '44444444-4444-4444-8444-444444444444';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const CTX = {
  tenantId: TENANT,
  tenantSlug: 'tenant',
  userId: USER,
  clerkUserId: 'clerk-user',
  role: 'capiro_admin',
} as const;

function service(input: { prisma?: object; retrieval?: object } = {}) {
  const args: unknown[] = Array.from({ length: 36 }, () => undefined);
  args[0] = {
    withTenantUser: jest.fn(async (_tenant: string, _user: string, run: (tx: unknown) => unknown) =>
      run({ $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]) }),
    ),
    ...(input.prisma ?? {}),
  };
  args[1] = { get: jest.fn() };
  args[35] = input.retrieval;
  return Reflect.construct(MeriToolsService, args) as MeriToolsService;
}

function mondayResult(status: 'healthy' | 'unavailable' = 'healthy') {
  const healthy = status === 'healthy';
  return {
    records: healthy
      ? [{ domain: 'monday', recordId: 'item:42', payload: { itemId: '42', updates: [] } }]
      : [],
    coverage: {
      complete: healthy,
      returned: healthy ? 1 : 0,
      sources: [
        {
          domain: 'monday',
          sourceStatus: status,
          recordsEvaluated: healthy ? 1 : 0,
          returned: healthy ? 1 : 0,
          hasMore: false,
          truncated: !healthy,
          paginationComplete: healthy,
          coverageComplete: healthy,
          stopReason: healthy ? 'complete' : 'monday_managed_mcp_unavailable',
          nextCursor: null,
        },
      ],
    },
  };
}

function billText(text = 'Exact enrolled bill text.') {
  return {
    tool: 'read_bill_text',
    authoritativeOwner: 'federal_evidence_current',
    currentStatus: 'available',
    found: true,
    billId: '119-hr-42',
    versionCode: 'enr',
    revisionId: REVISION,
    packageId: 'BILLS-119hr42enr',
    provider: 'govinfo',
    lineageKey: 'bill:119-hr-42:enr',
    versionHash: HASH_A,
    textHash: HASH_B,
    sourceLocator: 'https://www.govinfo.gov/x',
    text,
    coverage: {
      locator: { offset: 0, endOffset: text.length },
      totalCharacters: text.length,
      pageComplete: true,
      contentComplete: true,
      paginationComplete: true,
      complete: true,
      truncated: false,
      nextCursor: null,
    },
  };
}

function billStatus(status = 'passed_house') {
  return {
    tool: 'get_bill_status',
    authoritativeOwner: 'congress_bill_status',
    currentStatus: 'available',
    found: true,
    billId: '119-hr-42',
    status,
    statusAt: '2026-01-03T00:00:00.000Z',
    latestAction: { text: 'Passed House', date: '2026-01-03T00:00:00.000Z' },
    recentActions: [{ text: 'Passed House' }],
    floorVotes: [{ rollNumber: 7, result: 'Passed' }],
    governingRules: [{ ruleBillId: '119-hres-1', ruleStatus: 'passed_house' }],
    title: ' bill',
    congress: 119,
    sponsor: 'Rep. Smith',
    cosponsorsCount: 3,
    note: 'Original note',
  };
}

function webPage(text = 'Consulted primary page') {
  return {
    tool: 'scrape_web_page',
    url: 'https://example.gov/a',
    finalUrl: 'https://example.gov/a',
    contentType: 'text/html',
    text,
    contentHash: HASH_A,
    authoritativeOwner: 'public_url',
    currentStatus: 'available',
    trust: 'external_untrusted',
    title: 'Primary Page Title',
    links: ['https://example.gov/link1'],
    coverage: {
      locator: { url: 'https://example.gov/a', characterStart: 0, characterEnd: text.length },
      complete: true,
      truncated: false,
    },
  };
}

function attachment(text = 'Current attachment section') {
  const provenance = {
    originalAttachmentId: '66666666-6666-4666-8666-666666666666',
    sourceMessageId: '77777777-7777-4777-8777-777777777777',
    originalBytesHash: HASH_A,
    textHash: HASH_B,
    locator: { page: 1 },
  };
  return {
    tool: 'read_chat_attachments',
    authoritativeOwner: 'clio_chat_attachment',
    currentStatus: 'available',
    conversationId: '55555555-5555-4555-8555-555555555555',
    clientId: CLIENT,
    records: [{ recordId: 'attachment:1:page:1', payload: { text, provenance }, provenance }],
    coverage: {
      mode: 'section',
      extractionStatus: 'complete',
      sectionComplete: true,
      contentComplete: true,
      truncated: false,
      nextCursor: null,
    },
  };
}

function researchEvidence(text = 'Prior attachment evidence') {
  const provenance = {
    originalAttachmentId: '66666666-6666-4666-8666-666666666666',
    sessionId: '44444444-4444-4444-8444-444444444444',
  };
  return {
    tool: 'get_research_evidence',
    authoritativeOwner: 'clio_chat_attachment',
    currentStatus: 'available',
    conversationId: '55555555-5555-4555-8555-555555555555',
    clientId: CLIENT,
    records: [
      {
        recordId: 'prior-attachment',
        payload: {
          text: text,
          contentSha256: HASH_A,
        },
        provenance,
      },
    ],
    coverage: {
      status: 'complete',
      complete: true,
      paginationComplete: true,
      contentComplete: true,
      returned: 1,
      truncated: false,
      nextCursor: null,
    },
  };
}

describe('remaining canonical source families', () => {
  afterEach(() => jest.restoreAllMocks());

  it('registers only finite current-owner reads and keeps public search discovery-only', () => {
    const names = new Set(MERI_CAPABILITY_REGISTRY.map((capability) => capability.name));
    expect(names.has('read_monday_client_boards')).toBe(true);
    expect(names.has('read_bill_text')).toBe(true);
    expect(publicResearchSourceTool('search_public_web')).toBeNull();
    expect(publicResearchSourceTool('scrape_web_page')).toBe('scrape_web_page');
    expect(
      classifyApiToolReadOutcome('search_public_web', {
        tool: 'search_public_web',
        contentStatus: 'discovered',
        results: [{ url: 'https://example.gov' }],
      }),
    ).toMatchObject({ kind: 'partial', reason: 'public_web_search_is_discovery_only' });
    for (const name of [
      'read_monday_client_boards',
      'get_bill_status',
      'read_bill_text',
      'scrape_web_page',
      'read_chat_attachments',
      'get_research_evidence',
    ]) {
      expect(supportsDurableOwnerReauthorization(name)).toBe(true);
    }
  });

  it('uses the governed Monday owner and reports a missing connection as unavailable, never empty', async () => {
    const retrieval = { retrieve: jest.fn().mockResolvedValue(mondayResult('unavailable')) };
    const result = (await service({ retrieval }).execute(CTX, 'read_monday_client_boards', {
      clientId: CLIENT,
    })) as Record<string, unknown>;
    expect(retrieval.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: expect.objectContaining({ tenantId: TENANT, userId: USER, clientIds: [CLIENT] }),
        requestedDomains: ['monday'],
        requireComplete: true,
      }),
    );
    expect(result).toMatchObject({
      authoritativeOwner: 'managed_monday_mcp',
      currentStatus: 'unavailable',
      records: [],
    });
    expect(classifyApiToolReadOutcome('read_monday_client_boards', result)).toMatchObject({
      kind: 'unavailable',
    });
  });

  it('reads exact current bill-version text with retained version and extraction hashes', async () => {
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        {
          revisionId: REVISION,
          sourceKey: 'govinfo:BILLS-119hr42enr',
          provider: 'govinfo',
          packageId: 'BILLS-119hr42enr',
          billId: '119-hr-42',
          versionCode: 'enr',
          lineageKey: 'bill:119-hr-42:enr',
          contentHash: HASH_A,
          extractionHash: HASH_B,
          sourceUrl: 'https://www.govinfo.gov/x',
          sourceModifiedAt: new Date('2026-01-01T00:00:00Z'),
          publishedAt: null,
          fetchedAt: new Date('2026-01-02T00:00:00Z'),
          extractedText: 'Exact enrolled bill text.',
        },
      ]),
    };
    const result = (await service({ prisma }).execute(CTX, 'read_bill_text', {
      billId: '119-hr-42',
      versionCode: 'enr',
    })) as Record<string, unknown>;
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('federal_evidence_current'),
      '119-hr-42',
      'enr',
    );
    expect(result).toMatchObject({
      billId: '119-hr-42',
      versionCode: 'enr',
      versionHash: HASH_A,
      textHash: HASH_B,
      text: 'Exact enrolled bill text.',
      trust: 'external_untrusted',
    });
    expect(classifyApiToolReadOutcome('read_bill_text', result)).toEqual({ kind: 'complete' });
  });

  it('marks actually fetched public content untrusted and binds proof to response bytes', async () => {
    const body = '<html><head><title>Primary</title></head><body>Consulted page text</body></html>';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(Buffer.byteLength(body)),
        },
      }),
    );
    const result = (await service().execute(CTX, 'scrape_web_page', {
      url: 'https://example.gov/a',
      maxChars: 5000,
    })) as Record<string, unknown>;
    expect(result).toMatchObject({
      trust: 'external_untrusted',
      authoritativeOwner: 'public_url',
      currentStatus: 'available',
      truncated: false,
    });
    expect(result.contentHash).toBe(createHash('sha256').update(Buffer.from(body)).digest('hex'));
    expect(classifyApiToolReadOutcome('scrape_web_page', result)).toEqual({ kind: 'complete' });
  });

  it('qualifies a full targeted attachment section but not its discovery manifest', () => {
    expect(classifyApiToolReadOutcome('read_chat_attachments', attachment())).toEqual({
      kind: 'complete',
    });
    expect(
      classifyApiToolReadOutcome('read_chat_attachments', {
        tool: 'read_chat_attachments',
        authoritativeOwner: 'clio_chat_attachment',
        currentStatus: 'available',
        records: [],
        coverage: { mode: 'manifest', complete: true },
      }),
    ).toMatchObject({ kind: 'partial', reason: 'attachment_manifest_is_discovery_only' });
  });

  it('binds bill timestamps sourceModifiedAt/publishedAt/fetchedAt to proof in replay binding', () => {
    const saved = billText('original');
    expect(
      currentOwnerResultAuthorizesReplay('read_bill_text', saved, structuredClone(saved)),
    ).toBe(true);
    const withTimestamps = {
      ...saved,
      sourceModifiedAt: '2026-01-01T00:00:00.000Z',
      publishedAt: '2026-01-02T00:00:00.000Z',
      fetchedAt: '2026-01-03T00:00:00.000Z',
    };
    expect(currentOwnerResultAuthorizesReplay('read_bill_text', saved, withTimestamps)).toBe(false);
  });

  it('binds web page contentType to proof in replay binding', () => {
    const saved = webPage('content');
    expect(
      currentOwnerResultAuthorizesReplay('scrape_web_page', saved, structuredClone(saved)),
    ).toBe(true);
    const withContentType = {
      ...saved,
      contentType: 'application/xhtml+xml',
    };
    expect(currentOwnerResultAuthorizesReplay('scrape_web_page', saved, withContentType)).toBe(
      false,
    );
  });

  it('binds attachment record provenance with snapshot text to proof', () => {
    const saved = attachment('original text');
    expect(
      currentOwnerResultAuthorizesReplay('read_chat_attachments', saved, structuredClone(saved)),
    ).toBe(true);
    const changed = attachment('changed text');
    expect(currentOwnerResultAuthorizesReplay('read_chat_attachments', saved, changed)).toBe(false);
  });

  it.each([
    [
      'read_monday_client_boards',
      {
        tool: 'read_monday_client_boards',
        authoritativeOwner: 'managed_monday_mcp',
        currentStatus: 'healthy',
        clientId: CLIENT,
        ...mondayResult(),
      },
      {
        tool: 'read_monday_client_boards',
        authoritativeOwner: 'managed_monday_mcp',
        currentStatus: 'healthy',
        clientId: CLIENT,
        ...mondayResult(),
        records: [{ recordId: 'changed' }],
      },
    ],
    ['read_bill_text', billText(), billText('Changed bill bytes')],
    ['get_bill_status', billStatus(), billStatus('introduced')],
    ['scrape_web_page', webPage(), { ...webPage(), contentHash: HASH_B }],
    ['read_chat_attachments', attachment(), attachment('Changed attachment bytes')],
    [
      'get_research_evidence',
      researchEvidence(),
      researchEvidence('Changed prior attachment bytes'),
    ],
  ])('rehydrates %s proof and rejects changed current-owner bytes', (tool, saved, changed) => {
    expect(currentOwnerResultAuthorizesReplay(tool, saved, structuredClone(saved))).toBe(true);
    expect(currentOwnerResultAuthorizesReplay(tool, saved, changed)).toBe(false);
  });

  it('normalizes exhausted Monday cursors without authorizing incomplete pagination', () => {
    const saved = {
      tool: 'read_monday_client_boards',
      authoritativeOwner: 'managed_monday_mcp',
      currentStatus: 'healthy',
      clientId: CLIENT,
      ...mondayResult(),
    };
    const current = structuredClone(saved);
    delete (current.coverage.sources[0] as { nextCursor?: string | null }).nextCursor;
    expect(currentOwnerResultAuthorizesReplay('read_monday_client_boards', saved, current)).toBe(
      true,
    );
    for (const pagination of [
      { nextCursor: 'another-page' },
      { hasMore: true },
      { paginationComplete: false },
      { coverageComplete: false },
      { truncated: true },
      { nextCursor: 7 },
    ]) {
      const incomplete = structuredClone(current);
      Object.assign(incomplete.coverage.sources[0]!, pagination);
      expect(
        currentOwnerResultAuthorizesReplay('read_monday_client_boards', saved, incomplete),
      ).toBe(false);
    }
  });

  it('binds bill status metadata fields to proof in replay binding', () => {
    const saved = billStatus('passed_house');
    expect(
      currentOwnerResultAuthorizesReplay('get_bill_status', saved, structuredClone(saved)),
    ).toBe(true);
    const withGeneratedAt = {
      ...saved,
      generatedAt: '2026-01-04T00:00:00.000Z',
    };
    expect(currentOwnerResultAuthorizesReplay('get_bill_status', saved, withGeneratedAt)).toBe(
      true,
    );
    const changedTitle = {
      ...saved,
      title: ' Changed Bill Title',
    };
    expect(currentOwnerResultAuthorizesReplay('get_bill_status', saved, changedTitle)).toBe(false);
    const changedCosponsors = {
      ...saved,
      cosponsorsCount: 5,
    };
    expect(currentOwnerResultAuthorizesReplay('get_bill_status', saved, changedCosponsors)).toBe(
      false,
    );
    const changedNote = {
      ...saved,
      note: 'New note',
    };
    expect(currentOwnerResultAuthorizesReplay('get_bill_status', saved, changedNote)).toBe(false);
  });

  it('binds web page title and links to proof in replay binding', () => {
    const saved = webPage('content');
    expect(
      currentOwnerResultAuthorizesReplay('scrape_web_page', saved, structuredClone(saved)),
    ).toBe(true);
    const changedTitle = {
      ...saved,
      title: 'Changed Title',
    };
    expect(currentOwnerResultAuthorizesReplay('scrape_web_page', saved, changedTitle)).toBe(false);
    const changedLinks = {
      ...saved,
      links: ['https://example.com/other'],
    };
    expect(currentOwnerResultAuthorizesReplay('scrape_web_page', saved, changedLinks)).toBe(false);
  });

  it('binds attachment provenance sourceMessageId and text to proof in replay binding', () => {
    const saved = attachment('text');
    expect(
      currentOwnerResultAuthorizesReplay('read_chat_attachments', saved, structuredClone(saved)),
    ).toBe(true);
    const changedText = attachment('different text');
    expect(currentOwnerResultAuthorizesReplay('read_chat_attachments', saved, changedText)).toBe(
      false,
    );
    const changedSourceMessageId = {
      ...saved,
      records: saved.records.map((r: any) => ({
        ...r,
        provenance: { ...r.provenance, sourceMessageId: '00000000-0000-0000-0000-000000000000' },
      })),
    };
    expect(
      currentOwnerResultAuthorizesReplay('read_chat_attachments', saved, changedSourceMessageId),
    ).toBe(false);
  });

  it('binds research evidence sessionId and provenance to proof in replay binding', () => {
    const saved = researchEvidence('evidence');
    expect(
      currentOwnerResultAuthorizesReplay('get_research_evidence', saved, structuredClone(saved)),
    ).toBe(true);
    const changedSessionId = {
      ...saved,
      records: saved.records.map((r: any) => ({
        ...r,
        provenance: { ...r.provenance, sessionId: '88888888-8888-4888-8888-888888888888' },
      })),
    };
    expect(
      currentOwnerResultAuthorizesReplay('get_research_evidence', saved, changedSessionId),
    ).toBe(false);
  });
});
