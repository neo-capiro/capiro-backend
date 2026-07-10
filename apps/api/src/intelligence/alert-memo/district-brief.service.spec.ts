import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DistrictBriefService } from './district-brief.service.js';
import type { AlertMemoAlertInput } from './alert-memo.types.js';
import type { RepresentationResult } from '../../clients/representation-resolver.service.js';

const FACILITY_ROW = {
  id: 'fac-1',
  name: 'Acme Plant 3',
  city: 'Orlando',
  state: 'FL',
  employeeCount: 240,
  congressionalDistrict: '02',
  stateHouseDistrict: '9',
  stateSenateDistrict: '3',
  geocodeStatus: 'matched',
  client: { id: 'client-1', name: 'Acme Corp' },
};

const RESOLVED_REP: RepresentationResult = {
  unresolved: false,
  federal: {
    house: {
      bioguideId: 'D000001',
      fullName: 'Jane Doe',
      party: 'Democratic',
      state: 'FL',
      district: 2,
      chamber: 'house',
    },
    senate: [
      {
        bioguideId: 'S000001',
        fullName: 'Sen A',
        party: 'D',
        state: 'FL',
        district: null,
        chamber: 'senate',
      },
      {
        bioguideId: 'S000002',
        fullName: 'Sen B',
        party: 'R',
        state: 'FL',
        district: null,
        chamber: 'senate',
      },
    ],
  },
  state: {
    lower: {
      id: 'ocd-1',
      name: 'State Rep X',
      state: 'FL',
      chamber: 'lower',
      district: '9',
      party: 'D',
      url: null,
    },
    upper: {
      id: 'ocd-2',
      name: 'State Sen Y',
      state: 'FL',
      chamber: 'upper',
      district: '3',
      party: 'R',
      url: null,
    },
  },
};

const FEDERAL_ALERT: AlertMemoAlertInput = {
  alertId: 'alert-1',
  sourceType: 'bill',
  title: 'H.R. 8800: Rule granted (floor scheduled)',
  whyItMatters: 'Directly affects defense manufacturing incentives the client relies on.',
  billDisplayNum: 'H.R. 8800',
  billTitle: 'National Defense Manufacturing Act',
  actionText: 'Rules Committee granted a closed rule for floor consideration.',
  actionDate: '2026-07-01',
  committee: 'House Armed Services Committee',
  url: 'https://congress.gov/bill/hr8800',
};

const STATE_ALERT: AlertMemoAlertInput = {
  alertId: 'alert-2',
  sourceType: 'bill',
  title: 'FL HB 123: Passed House floor vote',
  whyItMatters: 'Sets a new state manufacturing tax credit the client would qualify for.',
  billDisplayNum: 'FL HB 123',
  billTitle: 'Manufacturing Jobs Tax Credit Act',
  actionText: 'Passed the Florida House 82-34.',
  actionDate: '2026-07-05',
  url: 'https://flsenate.gov/hb123',
};

function makeDeps(opts: {
  facility?: typeof FACILITY_ROW | null;
  representation?: RepresentationResult;
  committees?: Array<{ systemCode: string; name: string }>;
  memberships?: Array<{ bioguideId: string; title: string | null }>;
  cred?: { apiKey: string; model: string; usedTenantKey: boolean } | null;
  fetchImpl?: typeof fetch;
  memoryItem?: unknown;
}) {
  const created: unknown[] = [];
  const aiUsageEvents: unknown[] = [];
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({
        clientFacility: {
          findFirst: jest.fn(async () => opts.facility ?? null),
        },
        aiUsageEvent: {
          create: jest.fn(async (args: unknown) => {
            aiUsageEvents.push(args);
            return args;
          }),
        },
      }),
    ),
    congressCommittee: {
      findMany: jest.fn(async () => opts.committees ?? []),
    },
    congressCommitteeMembership: {
      findMany: jest.fn(async () => opts.memberships ?? []),
    },
  };
  const representation = {
    representativesForFacility: jest.fn(
      async () => opts.representation ?? { unresolved: true, reason: 'no_state' },
    ),
  };
  const credentials = {
    resolveProvider: jest.fn(async () =>
      'cred' in opts
        ? opts.cred
        : { apiKey: 'key', model: 'claude-sonnet-5', usedTenantKey: false },
    ),
  };
  const memory = {
    getByTypeSlug: jest.fn(async () => opts.memoryItem ?? null),
  };
  const engagement = {
    createAttachmentFromBuffer: jest.fn(async () => {
      const doc = { id: 'att-1', fileName: 'brief.docx' };
      created.push(doc);
      return doc;
    }),
    deleteAttachment: jest.fn(async () => undefined),
  };
  const service = new DistrictBriefService(
    prisma as never,
    representation as never,
    credentials as never,
    memory as never,
    engagement as never,
  );
  return {
    service,
    prisma,
    representation,
    credentials,
    memory,
    engagement,
    created,
    aiUsageEvents,
  };
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

function anthropicTextResponse(sections: unknown) {
  return jsonResponse({
    content: [{ type: 'text', text: JSON.stringify({ sections }) }],
    usage: { input_tokens: 500, output_tokens: 120 },
  });
}

describe('DistrictBriefService.generate', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('generates a grounded brief for a FEDERAL bill alert, files a district_brief Attachment, and meters usage (M1-F)', async () => {
    const { service, engagement, aiUsageEvents } = makeDeps({
      facility: FACILITY_ROW,
      representation: RESOLVED_REP,
    });
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        {
          heading: 'Facility & footprint',
          paragraphs: [{ text: 'Acme Plant 3 employs ~240 people.', claimIds: ['c1', 'c2'] }],
        },
        {
          heading: 'Who represents it',
          paragraphs: [{ text: 'Rep. Jane Doe represents this district.', claimIds: ['c3'] }],
        },
      ]),
    ) as never;

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      'fac-1',
      FEDERAL_ALERT,
    );

    expect(result.lowConfidence).toBe(false);
    expect(result.sections.length).toBeGreaterThan(0);
    expect(result.document).toEqual({
      attachmentId: 'att-1',
      fileName: expect.stringContaining('.docx'),
    });
    expect(engagement.createAttachmentFromBuffer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clientId: 'client-1', source: 'district_brief' }),
    );
    expect(aiUsageEvents).toHaveLength(1);
    expect(aiUsageEvents[0]).toMatchObject({
      data: expect.objectContaining({
        tenantId: 't1',
        workflow: 'district_brief',
        inputTokens: 500,
        outputTokens: 120,
      }),
    });
  });

  it('generates identically for a STATE bill alert — same code path, state legislators in the fact sheet (M1-F)', async () => {
    const { service } = makeDeps({ facility: FACILITY_ROW, representation: RESOLVED_REP });
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        {
          heading: 'Who represents it',
          paragraphs: [{ text: 'State Rep X represents this district.', claimIds: ['c5'] }],
        },
        {
          heading: 'The bill/rule at stake',
          paragraphs: [{ text: 'FL HB 123 passed the House.', claimIds: ['c7'] }],
        },
      ]),
    ) as never;

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      'fac-1',
      STATE_ALERT,
    );

    expect(result.lowConfidence).toBe(false);
    expect(result.title).toContain('FL HB 123');
    const allText = result.sections.flatMap((s) => s.paragraphs.map((p) => p.text)).join(' ');
    expect(allText).toContain('State Rep X');
  });

  it('drops a paragraph citing an unknown claim id (grounding gate)', async () => {
    const { service } = makeDeps({ facility: FACILITY_ROW, representation: RESOLVED_REP });
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        {
          heading: 'Facility & footprint',
          paragraphs: [{ text: 'Real claim.', claimIds: ['c1'] }],
        },
        { heading: 'The ask', paragraphs: [{ text: 'Fabricated fact.', claimIds: ['c999'] }] },
      ]),
    ) as never;

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      'fac-1',
      FEDERAL_ALERT,
    );

    const headings = result.sections.map((s) => s.heading);
    expect(headings).toContain('Facility & footprint');
    expect(headings).not.toContain('The ask');
  });

  it('falls back to a deterministic scaffold + lowConfidence when the model call fails', async () => {
    const { service } = makeDeps({ facility: FACILITY_ROW, representation: RESOLVED_REP });
    global.fetch = jest.fn(async () => {
      throw new Error('network down');
    }) as never;

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      'fac-1',
      FEDERAL_ALERT,
    );

    expect(result.lowConfidence).toBe(true);
    expect(result.sections.length).toBeGreaterThan(0);
  });

  it('degrades gracefully when the facility has no resolved representation (never guesses)', async () => {
    const { service } = makeDeps({
      facility: FACILITY_ROW,
      representation: { unresolved: true, reason: 'no_geocode' },
    });
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        {
          heading: 'Facility & footprint',
          paragraphs: [{ text: 'Acme Plant 3.', claimIds: ['c1'] }],
        },
      ]),
    ) as never;

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      'fac-1',
      FEDERAL_ALERT,
    );
    expect(result.lowConfidence).toBe(false);
  });

  it('throws NotFoundException when the facility does not belong to the client/tenant', async () => {
    const { service } = makeDeps({ facility: null });
    await expect(
      service.generate(
        { tenantId: 't1', userId: 'u1' } as never,
        'client-1',
        'missing',
        FEDERAL_ALERT,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws ServiceUnavailableException when no AI credential is available', async () => {
    const { service } = makeDeps({
      facility: FACILITY_ROW,
      representation: RESOLVED_REP,
      cred: null,
    });
    await expect(
      service.generate(
        { tenantId: 't1', userId: 'u1' } as never,
        'client-1',
        'fac-1',
        FEDERAL_ALERT,
      ),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});

describe('DistrictBriefService.resolveCommitteeRoles (private, best-effort, never guesses)', () => {
  it('asserts a role when the committee name matches exactly one current committee', async () => {
    const { service } = makeDeps({
      committees: [{ systemCode: 'hsas00', name: 'House Armed Services Committee' }],
      memberships: [{ bioguideId: 'D000001', title: 'Chair' }],
    });
    const roles = await (
      service as never as {
        resolveCommitteeRoles: (n: string, ids: string[]) => Promise<Map<string, string>>;
      }
    ).resolveCommitteeRoles('House Armed Services Committee', ['D000001']);
    expect(roles.get('D000001')).toBe('Chair');
  });

  it('asserts nothing when the committee name matches zero or multiple committees', async () => {
    const { service } = makeDeps({
      committees: [
        { systemCode: 'hsas00', name: 'House Armed Services Committee' },
        { systemCode: 'ssas00', name: 'Senate Armed Services Committee' },
      ],
      memberships: [{ bioguideId: 'D000001', title: 'Chair' }],
    });
    const roles = await (
      service as never as {
        resolveCommitteeRoles: (n: string, ids: string[]) => Promise<Map<string, string>>;
      }
    ).resolveCommitteeRoles('Armed Services Committee', ['D000001']);
    expect(roles.size).toBe(0);
  });

  it('asserts nothing when no committee name is on the alert', async () => {
    const { service } = makeDeps({});
    const roles = await (
      service as never as {
        resolveCommitteeRoles: (n: string | null, ids: string[]) => Promise<Map<string, string>>;
      }
    ).resolveCommitteeRoles(null, ['D000001']);
    expect(roles.size).toBe(0);
  });
});
