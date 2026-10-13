import { NotFoundException } from '@nestjs/common';
import {
  clientId,
  clientRow,
  deferred,
  harness,
  inputOf,
  installHooks,
  tenantId,
} from '../../test/fixtures/intelligence-mapping.js';

installHooks();
const metadata = [
  {
    key: 'lda',
    label: 'LDA mapping confirmed',
    impact: 'Unlocks tracked bills, the office recommender, hearings, and regulations.',
    hint: 'Confirm it in Settings → Intelligence Mappings.',
  },
  {
    key: 'issue_codes',
    label: 'Issue codes set',
    impact: 'Drives bill & regulation matching — even with no LDA mapping.',
    hint: 'Set LDA issue codes on the client form (Sector & Tracks); they auto-fill from the LDA match.',
  },
  {
    key: 'capabilities',
    label: 'Capabilities added',
    impact: 'Capabilities feed bill & regulation matching.',
    hint: "Add the client's products/services as capabilities.",
  },
  {
    key: 'capability_tags',
    label: 'Specific capability tags',
    impact: 'Specific tags (e.g. "hypersonics") sharpen which bills surface; vague tags add noise.',
    hint: 'Add specific tags to each capability; acronyms like EW/C2/ISR auto-expand.',
  },
  {
    key: 'capability_descriptions',
    label: 'Capability descriptions',
    impact: 'Descriptions power the semantic bill matcher.',
    hint: 'Write a sentence or two describing each capability.',
  },
  {
    key: 'sector',
    label: 'Sector set',
    impact: 'Drives agency & regulation matching.',
    hint: 'Pick a sector on the client form.',
  },
  {
    key: 'contracting',
    label: 'Contracting mapping confirmed',
    impact: 'Federal obligations, return ratio, and real district-by-dollars nexus.',
    hint: 'Confirm in Settings → Intelligence Mappings (optional).',
  },
  {
    key: 'fec_employer',
    label: 'FEC employer mapping confirmed',
    impact: 'Employer-linked political-contribution panel.',
    hint: 'Confirm in Settings → Intelligence Mappings (optional).',
  },
];

describe('Mapping setup completeness public contract', () => {
  test('returns all original ordered check metadata, zero defaults and no internal weights', async () => {
    const h = harness();
    expect(await h.service.getSetupCompleteness(clientId, tenantId)).toEqual({
      clientId,
      score: 0,
      complete: false,
      checks: metadata.map((check) => ({ ...check, done: false })),
    });
  });
  test('returns 100 and complete only when every named check is done', async () => {
    const h = harness({
      rows: {
        client: clientRow({ sectorTag: 'DEFENSE' }),
        mappings: [{ source: 'lda' }, { source: 'contracting' }, { source: 'fec_employer' }],
        capabilities: [{ tags: ['hypersonics'], description: 'Research technology' }],
      },
    });
    expect(await h.service.getSetupCompleteness(clientId, tenantId)).toEqual({
      clientId,
      score: 100,
      complete: true,
      checks: metadata.map((check) => ({ ...check, done: true })),
    });
  });
});

const scoreCases = [
  {
    name: 'LDA also satisfies issue codes',
    client: {},
    mappings: [{ source: 'lda' }],
    caps: [],
    score: 42,
    done: ['lda', 'issue_codes'],
  },
  {
    name: 'duplicate LDA sources do not add weight',
    client: {},
    mappings: [{ source: 'lda' }, { source: 'lda' }],
    caps: [],
    score: 42,
    done: ['lda', 'issue_codes'],
  },
  {
    name: 'raw issue-code array entries count',
    client: { issueCodes: [null] },
    mappings: [],
    caps: [],
    score: 17,
    done: ['issue_codes'],
  },
  {
    name: 'non-array issue codes do not count',
    client: { issueCodes: 'DEF' },
    mappings: [],
    caps: [],
    score: 0,
    done: [],
  },
  {
    name: 'raw tag entries and added capability count',
    client: {},
    mappings: [],
    caps: [{ tags: [null], description: ' ' }],
    score: 25,
    done: ['capabilities', 'capability_tags'],
  },
  {
    name: 'non-array tags but trimmed description',
    client: {},
    mappings: [],
    caps: [{ tags: 'DEF', description: ' text ' }],
    score: 17,
    done: ['capabilities', 'capability_descriptions'],
  },
  {
    name: 'boxed description is not a primitive string',
    client: {},
    mappings: [],
    caps: [{ tags: [], description: new String('text') }],
    score: 8,
    done: ['capabilities'],
  },
  {
    name: 'whitespace sector remains truthy',
    client: { sectorTag: ' ' },
    mappings: [],
    caps: [],
    score: 8,
    done: ['sector'],
  },
  {
    name: 'contracting contributes one check',
    client: {},
    mappings: [{ source: 'contracting' }],
    caps: [],
    score: 8,
    done: ['contracting'],
  },
  {
    name: 'FEC employer contributes one check',
    client: {},
    mappings: [{ source: 'fec_employer' }],
    caps: [],
    score: 8,
    done: ['fec_employer'],
  },
  {
    name: 'assistance and PAC sources have no exposed setup weight',
    client: {},
    mappings: [{ source: 'assistance_recipient' }, { source: 'fec_committee' }],
    caps: [],
    score: 0,
    done: [],
  },
];

describe('Mapping setup completeness scoring quirks', () => {
  test.each(scoreCases)('preserves $name', async ({ client, mappings, caps, score, done }) => {
    const h = harness({ rows: { client: clientRow(client), mappings, capabilities: caps } });
    const value = await h.service.getSetupCompleteness(clientId, tenantId);
    expect(value.score).toBe(score);
    expect(value.complete).toBe(false);
    expect(value.checks.filter((check) => check.done).map((check) => check.key)).toEqual(done);
    expect(value.checks.every((check) => !Object.hasOwn(check, 'weight'))).toBe(true);
  });
});

describe('Mapping setup completeness tenant read sequencing', () => {
  test('guards the client then starts mapping and capability reads in separate concurrent tenant transactions', async () => {
    const client = deferred<unknown>();
    const mappings = deferred<unknown[]>();
    const caps = deferred<unknown[]>();
    const h = harness({
      rows: { client: client.promise, mappings: mappings.promise, capabilities: caps.promise },
    });
    const pending = h.service.getSetupCompleteness(clientId, tenantId);
    await h.started('client');
    expect(h.callsOf('mappings')).toEqual([]);
    expect(h.callsOf('capabilities')).toEqual([]);
    client.resolve(clientRow());
    await h.started('capabilities');
    expect(inputOf(h, 'client')).toEqual({
      where: { id: clientId },
      select: { id: true, sectorTag: true, issueCodes: true },
    });
    expect(inputOf(h, 'mappings')).toEqual({
      where: {
        clientId,
        confirmed: true,
        OR: [
          { source: { notIn: ['contracting', 'assistance_recipient'] } },
          { reviewStatus: 'confirmed', rollUpAwards: true },
        ],
      },
      select: { source: true },
    });
    expect(inputOf(h, 'capabilities')).toEqual({
      where: { clientId },
      select: { tags: true, description: true },
    });
    expect(h.callsOf('mappings')[0]).toMatchObject({ tenantId, transaction: 2 });
    expect(h.callsOf('capabilities')[0]).toMatchObject({ tenantId, transaction: 3 });
    expect(h.transactions[0]!.outcome).toBe('commit');
    mappings.resolve([]);
    caps.resolve([]);
    expect((await pending).score).toBe(0);
    expect(h.transactions.map((tx) => tx.outcome)).toEqual(['commit', 'commit', 'commit']);
  });
});

describe('Mapping setup completeness read failures', () => {
  test('refuses an absent client before starting either signal read', async () => {
    const h = harness({ rows: { client: null } });
    await expect(h.service.getSetupCompleteness(clientId, tenantId)).rejects.toThrow(
      new NotFoundException('Client not found'),
    );
    expect(h.callsOf('mappings')).toEqual([]);
    expect(h.callsOf('capabilities')).toEqual([]);
  });
  test.each(['client', 'mappings', 'capabilities'])('propagates %s failure', async (operation) => {
    const error = new Error(`${operation} failed`);
    const h = harness({ errors: { [operation]: error } });
    await expect(h.service.getSetupCompleteness(clientId, tenantId)).rejects.toBe(error);
    expect(h.transactions.find((tx) => tx.outcome === 'rollback')).toBeDefined();
  });
});
