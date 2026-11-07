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
    if (strings.join('').includes('FROM sp_reference_entry')) return [];
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
  test('complete shared answers reach the lossless bound prompt with existing authorized relationships', async () => {
    const f = fixture();
    const intake = { schemaVersion: 1, type: f.request.type, goal: 'G'.repeat(4000),
      ownerUserId: 'user_selected', targetDate: '2027-11-01', meriContext: 'C'.repeat(8000) };
    Object.assign(f.state.snapshot, { strategyIntake: intake, ownerUserId: 'native-selected',
      outcome: '', governmentProblem: '', minimumWin: '', askType: null });
    const original = f.tx.$queryRaw;
    f.tx.$queryRaw = (async (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.join('').includes('SELECT u.id::text AS') ? [{ userId: 'native-selected' }] : original(parts, ...values)) as any;
    const observed = await f.service.observe(f.input);
    expect(observed.intent).toEqual({ kind: 'strategy-intake', strategyIntake: intake });
    const admission = f.service.bind(f.input, observed, f.bundle, 'a'.repeat(64), [], f.prompt);
    expect(f.bundle.governedContext.prompt).toContain(JSON.stringify(observed.intent));
    for (const context of ['PROFILE', 'TENANT_NOTE', 'CURRENT_OFFICE', 'CURRENT_EMAIL', 'CONTACT_PHONE'])
      expect(f.bundle.governedContext.prompt).toContain(context);
    expect(admission.context.state).toBe('complete');
  });
  test('shared intake refuses changed type and revoked selected owner before external directory work', async () => {
    for (const defect of ['type', 'owner']) {
      const f = fixture();
      Object.assign(f.state.snapshot, { ownerUserId: 'native-selected', strategyIntake: { schemaVersion: 1,
        type: defect === 'type' ? 'coalition' : f.request.type, goal: 'Goal', ownerUserId: 'user_selected',
        targetDate: null, meriContext: '' } });
      const original = f.tx.$queryRaw;
      f.tx.$queryRaw = (async (parts: TemplateStringsArray, ...values: unknown[]) =>
        parts.join('').includes('SELECT u.id::text AS') ? [] : original(parts, ...values)) as any;
      await expect(f.service.observe(f.input)).rejects.toThrow();
      expect(f.directory.getMemberDetail).not.toHaveBeenCalled();
    }
  });
  test('regeneration preserves the current Strategy type while retaining the original intake type as source context', async () => {
    const f = fixture();
    const intake = { schemaVersion: 1, type: 'appropriations', goal: 'Updated goal',
      ownerUserId: 'user_selected', targetDate: null, meriContext: 'Updated context' };
    Object.assign(f.state.snapshot, { strategyIntake: intake, ownerUserId: 'native-selected' });
    f.state.canonicalStrategyType = 'authorization'; f.input.generationType = 'authorization';
    const original = f.tx.$queryRaw;
    f.tx.$queryRaw = (async (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.join('').includes('SELECT u.id::text AS') ? [{ userId: 'native-selected' }] : original(parts, ...values)) as any;
    const observed = await f.service.observe(f.input);
    expect(observed.intent).toEqual({ kind: 'strategy-intake', strategyIntake: intake });
    const admission = f.service.bind(f.input, observed, f.bundle, 'a'.repeat(64), [], f.prompt);
    expect(admission.type).toBe('authorization');
    expect(f.bundle.governedContext.prompt).toContain('GENERATION STRATEGY TYPE (data):\n\"authorization\"');
    expect(f.bundle.governedContext.prompt).toContain(JSON.stringify(observed.intent));
    f.state.canonicalStrategyType = 'coalition';
    await expect(f.service.observe(f.input)).rejects.toThrow('Saved generation type changed');
  });
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
  test.each(['PRIVATE_EIN_SENTINEL', null, undefined])(
    'omits EIN from the model prompt and reports policy omission for saved value %p',
    async (ein) => {
      const f = fixture();
      const profile = f.state.sources.government_profile_support[0]! as Record<string, any>;
      const sentinels = OBJECTIVE_FIELD_INVENTORY.government_profile_support!
        .filter((field) => field !== 'id')
        .map((field) => [field, `KEEP_${field}`] as const);
      Object.assign(profile, Object.fromEntries(sentinels));
      // A mixed-version reader must not bypass the model-boundary omission.
      profile.ein = ein;
      const observed = await f.service.observe(f.input);
      const readOmittedValue = jest.fn(() => { throw new Error('EIN must not be read at the model boundary'); });
      Object.defineProperty(observed.sources.government_profile_support[0]!, 'ein', {
        enumerable: true, configurable: true, get: readOmittedValue,
      });
      const admission = f.service.bind(f.input, observed, f.bundle, 'a'.repeat(64), [], f.prompt);
      const prompt = f.bundle.governedContext.prompt;
      expect(prompt).not.toContain('PRIVATE_EIN_SENTINEL');
      expect(prompt).not.toContain('"ein"');
      for (const [, sentinel] of sentinels) expect(prompt).toContain(sentinel);
      for (const sentinel of ['COMMITTEE', 'FACILITY', 'TENANT_NOTE', 'CURRENT_OFFICE'])
        expect(prompt).toContain(sentinel);
      const coverage = admission.coverage.find((group) => group.group === 'government_profile_support')!;
      expect(coverage.fieldInventory).not.toContain('ein');
      expect(coverage.fields.filter((field) => field.field === 'ein')).toEqual([{
        field: 'ein', sourceReference: profile.id, sourceVersionOrAsOf: observed.observedAt,
        disposition: 'policy_omitted',
      }]);
      expect(JSON.stringify(admission)).not.toContain('PRIVATE_EIN_SENTINEL');
      expect(readOmittedValue).not.toHaveBeenCalled();
      expect(admission.context.state).toBe('complete');
      const legacyCoverage = structuredClone(admission.coverage);
      const legacyProfile = legacyCoverage.find((group) => group.group === 'government_profile_support')!;
      legacyProfile.fieldInventory = [...legacyProfile.fieldInventory!, 'ein'];
      legacyProfile.fields.find((field) => field.field === 'ein')!.disposition =
        ein == null ? 'absent' : 'included';
      expect(admission.context.coverageDigest).not.toBe(objectiveDigest({
        manifest: legacyCoverage, history: f.bundle.governedContext.retrieval.coverage,
        policy: 'objective-v1-required-lossless',
      }));
      delete observed.sources.government_profile_support[0]!.ein;
      const withoutSavedEin = f.service.bind(f.input, observed, f.bundle, 'a'.repeat(64), [], f.prompt);
      expect(withoutSavedEin.context.coverageDigest).toBe(admission.context.coverageDigest);
    },
  );
  // Supplementary retrieval pagination is no longer a refusal (see the partial
  // coverage test below); required groups and observation issues still refuse.
  test('a normal recommendation cache exceeding one record budget binds every recommendation losslessly', async () => {
    const f = fixture();
    const cache = f.state.sources.target_recommendations[0]!;
    cache.recommendations_jsonb = Array.from({ length: 12 }, (_, i) => ({
      memberId: `recommended-member-${i}`, office: `Recommended office ${i}`, party: 'I', state: 'CA',
      chamber: 'House', committee: `RECOMMENDED_COMMITTEE_${i}`, score: 0.9 - i / 100,
      tags: ['committee', 'district'], billCount: i + 1,
      evidence: { ref: `SYNTHETIC_REFERENCE_${i}`, text: `Recommendation support ${i}` },
    }));
    Object.assign(cache, { cache_annotation: 'KEEP_UNKNOWN_METADATA' });
    expect(JSON.stringify(cache).length).toBeGreaterThan(1600);
    const observed = await f.service.observe(f.input);
    const admission = f.service.bind(f.input, observed, f.bundle, 'a'.repeat(64), [], f.prompt);
    expect(f.bundle.governedContext.prompt).toContain(`[target_recommendations]\n${JSON.stringify(cache)}`);
    for (const sentinel of ['COMMITTEE', 'FACILITY', 'TENANT_NOTE', 'CURRENT_OFFICE', 'CURRENT_EMAIL'])
      expect(f.bundle.governedContext.prompt).toContain(sentinel);
    const coverage = admission.coverage.find(group => group.group === 'target_recommendations')!;
    expect(coverage).toMatchObject({ expectedRecords: 1, readRecords: 1, enumerationComplete: true });
    for (let i = 0; i < 12; i++)
      expect(coverage.fields).toContainEqual(expect.objectContaining({
        field: `recommendations_jsonb.${i}.memberId`, sourceReference: cache.id, disposition: 'included',
      }));
    expect(admission.localDigest).toBe(objectiveDigest(observed.sources));
    expect(admission.context.coverageDigest).toBe(objectiveDigest({
      manifest: admission.coverage, history: f.bundle.governedContext.retrieval.coverage,
      policy: 'objective-v1-required-lossless',
    }));
    expect(admission.context.state).toBe('complete');

    cache.recommendations_jsonb[11]!.tags.push('CHANGED_LAST_RECOMMENDATION');
    const changed = await f.service.observe(f.input);
    const rebound = f.service.bind(f.input, changed, f.bundle, 'a'.repeat(64), [], f.prompt);
    expect(rebound.localDigest).not.toBe(admission.localDigest);
    expect(rebound.context.inputDigest).not.toBe(admission.context.inputDigest);
  });
  test.each([[], null, { legacy: 'KEEP_LEGACY_SHAPE' }])(
    'empty or non-array recommendation caches preserve their complete original JSON: %p', async value => {
      const f = fixture();
      const cache = f.state.sources.target_recommendations[0]!;
      Object.assign(cache, { recommendations_jsonb: value });
      const observed = await f.service.observe(f.input);
      f.service.bind(f.input, observed, f.bundle, 'a'.repeat(64), [], f.prompt);
      expect(f.bundle.governedContext.prompt).toContain(`[target_recommendations]\n${JSON.stringify(cache)}`);
    },
  );
  test.each(['recommendation', 'metadata', 'aggregate'])(
    'recommendation cache still refuses an oversized %s without truncating required context', async which => {
      const f = fixture();
      const cache = f.state.sources.target_recommendations[0]!;
      if (which === 'recommendation') cache.recommendations_jsonb[0]!.tags = ['x'.repeat(1601)];
      if (which === 'metadata') cache.computed_at = 'x'.repeat(1601);
      if (which === 'aggregate') cache.recommendations_jsonb = Array.from({ length: 200 }, (_, i) => ({
        memberId: `member-${i}`, score: 1, tags: ['committee', 'district', 'x'.repeat(100)], billCount: 1,
      }));
      const observed = await f.service.observe(f.input);
      const originalPrompt = f.bundle.governedContext.prompt;
      expect(() => f.service.bind(f.input, observed, f.bundle, 'a'.repeat(64), [], f.prompt))
        .toThrow(expect.objectContaining({ response: expect.objectContaining({
          code: 'OBJECTIVE_CONTEXT_INCOMPLETE', issues: [expect.objectContaining({
            group: which === 'aggregate' ? 'government_targets' : 'target_recommendations',
            code: 'REQUIRED_FIELDS_EXCEED_PACKET_BUDGET',
          })],
        }) }));
      expect(f.bundle.governedContext.prompt).toBe(originalPrompt);
    },
  );
  test.each(['record-budget', 'total-budget', 'missing-key', 'directory-error'])(
    'refuses %s without dispatch',
    async (which) => {
      const f = fixture();
      const observed = await f.service.observe(f.input);
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
  test('partial, degraded or rollback supplementary retrieval is disclosed and bound, not refused', async () => {
    const f = fixture();
    const observed = await f.service.observe(f.input);
    f.bundle.kind = 'release_switch_rollback';
    f.bundle.coverage = { complete: false, paginationComplete: false, truncated: true };
    f.bundle.governedContext.contextPacket.degraded = true;
    f.bundle.governedContext.retrieval.coverage = { complete: false, paginationComplete: false, truncated: true,
      partialDomains: ['meetings', 'mail'] };
    const admission = f.service.bind(f.input, observed, f.bundle, 'a'.repeat(64), [], f.prompt);
    expect(admission.context.state).toBe('complete');
    const complete = fixture(), again = await complete.service.observe(complete.input);
    const full = complete.service.bind(complete.input, again, complete.bundle, 'a'.repeat(64), [], complete.prompt);
    // The actual partial coverage changes the bound coverage digest.
    expect(admission.context.coverageDigest).not.toBe(full.context.coverageDigest);
  });
  test('an unpersisted packet or unknown bundle kind still refuses', async () => {
    for (const mutate of [(b: any) => { b.governedContext.contextPacket.persisted = false; },
      (b: any) => { b.kind = 'something_else'; }]) {
      const f = fixture(), observed = await f.service.observe(f.input);
      mutate(f.bundle);
      expect(() => f.service.bind(f.input, observed, f.bundle, 'a'.repeat(64), [], f.prompt)).toThrow();
    }
  });
  test('House representation uses the directory display district, not NaN', async () => {
    const f = fixture();
    f.directory.getAllContacts.mockResolvedValue([{ id: 'member-1', state: 'CA', chamber: 'House', district: 'CA-40' }]);
    await f.service.observe(f.input);
    const calls = f.representation.facilitiesForMember.mock.calls as any[];
    expect(calls.some(c => c[2]?.type === 'federal' && c[2]?.district === 40)).toBe(true);
  });
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
    expect(core).not.toContain("'ein'");
    expect(OBJECTIVE_FIELD_INVENTORY.government_profile_support).not.toContain('ein');
    expect(objectiveDigest({ b: 2, a: 1 })).toBe(objectiveDigest({ a: 1, b: 2 }));
  });
});
