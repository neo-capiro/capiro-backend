import { AlertMemoService } from '../../alert-memo.service.js';
import { DistrictBriefService } from '../../district-brief.service.js';
import type { AlertMemoAlertInput } from '../../alert-memo.types.js';
import type { ExpectedSection, ProviderCase } from './cases.js';

export type Producer = 'alert memo' | 'district brief';
export const PRODUCERS: Producer[] = ['alert memo', 'district brief'];
const CTX = { tenantId: 'tenant-parser', userId: 'user-parser' } as never;
const ALERT: AlertMemoAlertInput = {
  alertId: 'alert-parser',
  sourceType: 'bill',
  title: 'Alert title',
  actionText: 'Official action',
  billDisplayNum: 'H.R. 1',
  url: 'https://congress.gov/bill/hr1',
};
const FACILITY = {
  id: 'facility-parser',
  name: 'Fixture plant',
  city: null,
  state: null,
  employeeCount: null,
  client: { id: 'client-parser', name: 'Fixture client' },
};

export const FALLBACK: Record<Producer, ExpectedSection[]> = {
  'alert memo': [
    { heading: 'Bottom line', paragraphs: [{ text: 'Alert title', claimIds: ['c1'] }] },
    {
      heading: 'What happened',
      paragraphs: [{ text: 'Official action', claimIds: ['c1', 'c2', 'c3'] }],
    },
  ],
  'district brief': [
    { heading: 'Facility & footprint', paragraphs: [{ text: 'Fixture plant', claimIds: ['c1'] }] },
    {
      heading: 'The bill/rule at stake',
      paragraphs: [{ text: 'Official action', claimIds: ['c1', 'c2', 'c3'] }],
    },
  ],
};
export const FALLBACK_DELIVERED: Record<
  Producer,
  Array<{ heading: string; paragraphs: string[] }>
> = {
  'alert memo': [
    { heading: 'Bottom line', paragraphs: ['Alert title [c1]'] },
    { heading: 'What happened', paragraphs: ['Official action [c1][c2][c3]'] },
  ],
  'district brief': [
    { heading: 'Facility & footprint', paragraphs: ['Fixture plant [c1]'] },
    { heading: 'The bill/rule at stake', paragraphs: ['Official action [c1][c2][c3]'] },
  ],
};

function makePrisma() {
  const usageRows: Array<{ data: Record<string, unknown> }> = [];
  const tx = {
    clientFacility: { findFirst: jest.fn(async () => FACILITY) },
    tenant: { findFirst: jest.fn(async () => ({ settings: {} })) },
    aiUsageEvent: {
      create: jest.fn(async (row: { data: Record<string, unknown> }) => {
        usageRows.push(row);
        return { id: 'usage-parser', ...row.data };
      }),
    },
    alertGenerationRecord: {
      create: jest.fn(async () => ({ id: 'generation-parser' })),
      update: jest.fn(async () => ({ id: 'generation-parser' })),
    },
  };
  return {
    prisma: {
      withTenant: jest.fn(async (_tenant: string, work: (db: typeof tx) => unknown) => work(tx)),
    },
    tx,
    usageRows,
  };
}

export function makeProducer(producer: Producer) {
  const db = makePrisma();
  const credentials = {
    resolveProvider: jest.fn(async () => ({
      apiKey: 'fixture-only',
      model: 'claude-sonnet-5',
      usedTenantKey: false,
    })),
  };
  const context = {
    compile: jest.fn(async () => ({
      rendered: [],
      items: [],
      exclusions: [],
      packetId: 'packet-parser',
    })),
  };
  const engagement = {
    billTruthBlock: jest.fn(async () => null),
    createAttachmentFromBuffer: jest.fn(async () => ({
      id: 'attachment-parser',
      fileName: 'fixture.docx',
    })),
  };
  const reviews = { createSystem: jest.fn(async () => 'review-parser') };
  const representation = {
    representativesForFacility: jest.fn(async () => ({ unresolved: true, reason: 'no_state' })),
  };
  const memo = new AlertMemoService(
    credentials as never,
    context as never,
    engagement as never,
    db.prisma as never,
    reviews as never,
  );
  const brief = new DistrictBriefService(
    db.prisma as never,
    representation as never,
    credentials as never,
    context as never,
    engagement as never,
    reviews as never,
  );
  return {
    ...db,
    credentials,
    context,
    engagement,
    reviews,
    representation,
    generate: () =>
      producer === 'alert memo'
        ? memo.generate(CTX, 'client-parser', ALERT, 'Fixture client')
        : brief.generate(CTX, 'client-parser', FACILITY.id, ALERT),
  };
}

export function providerReply(text: string) {
  return {
    ok: true,
    json: async () => ({
      content: [
        null,
        { type: 'tool_use', text: 'ignored' },
        { type: 'text', text },
        { type: 'text', text: 4 },
      ],
      usage: { input_tokens: 17, output_tokens: 9 },
    }),
  } as Response;
}

export function providerFailure(kind: ProviderCase) {
  if (kind === 'fetch rejection')
    return jest.fn(async () => {
      throw new Error('fixture rejection');
    });
  return jest.fn(
    async () =>
      ({
        ok: kind !== 'HTTP failure',
        json: async () => ({
          content: [{ type: 'tool_use', text: 'ignored' }],
          usage: { input_tokens: 17, output_tokens: 9 },
        }),
      }) as Response,
  );
}
