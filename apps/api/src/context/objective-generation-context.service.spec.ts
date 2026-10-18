import {
  ObjectiveGenerationContextService,
  OBJECTIVE_FIELD_INVENTORY,
  objectiveDigest,
} from './objective-generation-context.service.js';
import { objectiveFixture } from '../../../api-strategy/src/meri/objective-generation.fixture.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

jest.mock('../directory/directory.service.js', () => ({ DirectoryService: class {} }));
jest.mock('../clients/representation-resolver.service.js', () => ({
  RepresentationResolverService: class {},
}));

function fill(group: string, value: Record<string, any>) {
  return {
    ...Object.fromEntries(OBJECTIVE_FIELD_INVENTORY[group]!.map((key) => [key, null])),
    ...value,
  };
}
function fixture() {
  const f = objectiveFixture();
  const originalQuery = f.tx.$queryRaw;
  f.tx.$queryRaw = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join('').includes('objective_background_evidence'))
      return [{ background: { runs: [], tasks: [], findings: [] } }];
    return originalQuery(strings, ...values);
  }) as typeof f.tx.$queryRaw;
  for (const [group, rows] of Object.entries(f.state.sources)) {
    if (group in OBJECTIVE_FIELD_INVENTORY)
      (f.state.sources as any)[group] = rows.map((row) => fill(group, row));
  }
  const directory = {
    getMemberDetail: jest.fn(async () => ({
      id: 'member-1',
      source: { snapshotId: 'dir-v1', lastUpdatedAt: '2026-10-15' },
      identity: { name: 'MEMBER' },
      offices: [{ officeTypeId: 'HOUSE_OFFICE' }],
      officeAddresses: [{ phone: 'CONTACT_PHONE' }],
      committees: ['CURRENT_COMMITTEE'],
      leaderships: [],
      socialContacts: [],
      staffRoles: ['ROLE'],
      staffIssues: [],
    })),
    getStaffDetail: jest.fn(async () => ({
      id: 'staff-2',
      source: { snapshotId: 'dir-v1', lastUpdatedAt: '2026-10-15' },
      identity: { name: 'STAFF' },
      positions: [{ isCurrent: true, officeName: 'CURRENT_OFFICE', member: { id: 'member-1' } }],
      roles: ['CURRENT_ROLE'],
      issues: [],
      committeeAssociations: [],
      memberAssociations: [],
      emails: [{ value: 'CURRENT_EMAIL' }],
      socialContacts: [],
      officeAddresses: [],
    })),
    getAllContacts: jest.fn(async () => [
      { id: 'member-1', state: 'CA', chamber: 'House', district: '40' },
    ]),
  };
  const representation = {
    facilitiesForMember: jest.fn(async () => [{ id: 'facility-1', name: 'FACILITY' }]),
  };
  const service = new ObjectiveGenerationContextService(
    { withTenant: async (_: any, fn: any) => fn(f.tx) } as any,
    directory as any,
    representation as any,
  );
  const input: any = {
    tenantId: f.actor.tenantId,
    clerkUserId: f.actor.clerkUserId,
    clientId: f.request.clientId,
    mode: 'draft',
    objective: f.request.objective,
    generationRequestId: f.request.requestId,
    generationType: f.request.type,
  };
  const bundle: any = {
    kind: 'governed_packet',
    records: [],
    coverage: { complete: true, paginationComplete: true, truncated: false },
    governedContext: {
      prompt:
        'GOVERNED STEERING:\nSTEERING\nAUTHORIZED RETRIEVAL:\nHISTORY\n</capiro_strategy_context_plane>',
      contextPacket: {
        packetId: 'packet-1',
        compiledAt: '2026-10-15T00:00:00Z',
        persisted: true,
        degraded: false,
      },
      retrieval: { coverage: { complete: true, paginationComplete: true, truncated: false } },
    },
  };
  const prompt = { steering: 'STEERING', retrieval: 'HISTORY',
    compose: (intent: string, records: string) =>
      `GOVERNED STEERING:\n${intent}\nSTEERING\nAUTHORIZED RETRIEVAL:\n${records}\nHISTORY\n</capiro_strategy_context_plane>` };
  return { ...f, directory, representation, service, input, bundle, prompt };
}
describe('Objective required context observation and budget coverage', () => {
  test('saved source keys, current staff classification and all five intent fields survive governed binding', async () => {
    const f = fixture();
    const observed = await f.service.observe(f.input);
    const admission = f.service.bind(f.input, observed, f.bundle, 'a'.repeat(64), [], f.prompt);
    const prompt = f.bundle.governedContext.prompt;
    for (const sentinel of [
      'OUTCOME',
      'PROBLEM',
      'MINIMUM',
      'LIMITS',
      'funding',
      'PROFILE',
      'COMMITTEE',
      'FACILITY',
      'TENANT_NOTE',
      'CURRENT_OFFICE',
      'CURRENT_EMAIL',
      'CONTACT_PHONE',
      'CURRENT_COMMITTEE',
      'personal_office',
    ])
      expect(prompt).toContain(sentinel);
    expect(observed.contacts[1]!.detail.staffKind).toBe('personal_office');
    expect(admission.coverage.every((g) => g.enumerationComplete)).toBe(true);
    expect(admission.context.state).toBe('complete');
    expect(f.state.events.some((e) => e.includes('LOCK TABLE'))).toBe(false);
    expect(JSON.stringify(admission)).not.toContain('TENANT_NOTE');
  });
  test.each(['missing-page', 'record-budget', 'total-budget', 'missing-key', 'directory-error'])(
    'refuses %s without dispatch',
    async (which) => {
      const f = fixture();
      const observed = await f.service.observe(f.input);
      if (which === 'missing-page') f.bundle.coverage.paginationComplete = false;
      if (which === 'record-budget') observed.sources.member_notes[0]!.body = 'x'.repeat(1601);
      if (which === 'total-budget')
        observed.sources.member_notes = Array.from({ length: 25 }, (_, i) => ({
          ...observed.sources.member_notes[0],
          id: `note-${i}`,
          body: 'x'.repeat(1100),
        }));
      if (which === 'missing-key')
        delete observed.sources.represented_facilities[0]!.employee_count;
      if (which === 'directory-error')
        observed.issues.push({
          group: 'government_targets',
          code: 'REQUIRED_CONTEXT_UNAVAILABLE',
          message: 'Required relationship context could not be completely observed.',
        });
      expect(() => f.service.bind(f.input, observed, f.bundle, 'a'.repeat(64), [], f.prompt)).toThrow();
    },
  );
  test('Directory failure is distinct from legitimate absent field and refuses complete context', async () => {
    const f = fixture();
    f.directory.getStaffDetail.mockRejectedValueOnce(new Error('private upstream'));
    const observed = await f.service.observe(f.input);
    expect(observed.issues).toHaveLength(1);
    expect(JSON.stringify(observed.issues)).not.toContain('private upstream');
    expect(() => f.service.bind(f.input, observed, f.bundle, 'a'.repeat(64), [], f.prompt)).toThrow();
  });
  test('source reader copies and field inventory remain aligned, including intake JSON and actual table mappings', () => {
    const root = resolve(__dirname, '../../../..');
    const core = readFileSync(
      resolve(root, 'apps/api/src/context/objective-generation-sources.ts'),
      'utf8',
    );
    const strategy = readFileSync(
      resolve(root, 'apps/api-strategy/src/meri/objective-generation-sources.ts'),
      'utf8',
    );
    expect(core).toBe(strategy);
    expect(core).toContain('c.intake_data_jsonb->CASE k');
    expect(core).toContain("THEN 'fundingPriorities'");
    expect(core).toContain("THEN 'sbClassification'");
    expect(core).toContain('engagement_connections');
    expect(core).toContain('state_legislator');
    expect(objectiveDigest({ b: 2, a: 1 })).toBe(objectiveDigest({ a: 1, b: 2 }));
  });
});
