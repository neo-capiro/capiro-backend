import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  MERI_PROSPECT_SCOPE_METADATA_KEY,
  type MeriProspectScope,
} from '../business-development/bizdev-meri-scope.service.js';
import type { BizDevMeriScopeService } from '../business-development/bizdev-meri-scope.service.js';
import type { BriefSections } from '../business-development/bizdev-brief.types.js';
import type { EvidenceItem } from '../business-development/bizdev-evidence.types.js';
import type { BizDevDossier } from '../business-development/bizdev-dossier.service.js';
import { MeriBizDevToolsService } from './meri-bizdev-tools.service.js';
import { withMeriToolExecutionControl } from './meri-tool-request-control.js';

/**
 * Business Development Phase 4 — narrow mocked harness for the five
 * prospect-scoped Meri tools. Only the objects this service consumes are
 * faked: the tenant prisma facade, the scope service (assertCurrent), the
 * three BD services, and the dossier/brief contracts they return. No Prisma
 * graph, no providers. The fail-closed gate (authority keys → conversation
 * ownership → scope re-resolution) is exercised on every handler.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const PROSPECT_ID = '44444444-4444-4444-8444-444444444444';

const ctx = { tenantId: TENANT, userId: USER } as unknown as TenantContext;

const scope = (): MeriProspectScope => ({
  prospectId: PROSPECT_ID,
  prospectName: 'Acme Aerospace LLC',
  canonicalOrganizationId: '55555555-5555-4555-8555-555555555555',
  linkedClientId: null,
  scopeVersion: 'a'.repeat(64),
});

const validInput = () => ({ conversationId: CONVERSATION_ID });

type Handler = (
  service: MeriBizDevToolsService,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Build a service whose every dependency is a jest.fn we control. */
function harness(overrides: {
  metadata?: Record<string, unknown>;
  scopeResult?: MeriProspectScope | null;
  scopeThrow?: Error;
  bizdev?: Record<string, jest.Mock>;
  dossier?: Partial<BizDevDossier>;
  brief?: Record<string, jest.Mock>;
  watch?: Record<string, jest.Mock>;
  watchFlagGuard?: Record<string, jest.Mock>;
}) {
  const assertCurrent = jest.fn();
  if (overrides.scopeThrow) assertCurrent.mockRejectedValue(overrides.scopeThrow);
  else assertCurrent.mockResolvedValue(overrides.scopeResult === undefined ? scope() : overrides.scopeResult);
  const scopeService = { assertCurrent } as unknown as BizDevMeriScopeService;

  const conversationRow = {
    id: CONVERSATION_ID,
    metadata:
      overrides.metadata === undefined
        ? { [MERI_PROSPECT_SCOPE_METADATA_KEY]: scope() }
        : overrides.metadata,
  };
  const withTenant = jest.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      clioConversation: {
        findFirst: async () => conversationRow,
      },
    }),
  );
  const prisma = { withTenant } as never;

  const bizdev = {
    get: jest.fn(async () => ({
      id: PROSPECT_ID,
      displayName: 'Acme Aerospace LLC',
      ownerUserId: USER,
      stage: 'researching',
      serviceHypothesis: 'Federal prime contracting fit',
      geography: 'CO',
      nextAction: 'Draft outreach',
      canonicalEntityId: '55555555-5555-4555-8555-555555555555',
      linkedClientId: null,
    })),
    getPreferences: jest.fn(async () => ({
      practiceServiceAreas: ['gov-contracts'],
      agenciesIssues: ['DoD'],
      geographies: ['CO'],
    })),
    history: jest.fn(async () => []),
    ...overrides.bizdev,
  };

  const dossierService = {
    prospectDossier: jest.fn(async () => ({
      canonicalEntityId: '55555555-5555-4555-8555-555555555555',
      canonicalName: 'Acme Aerospace LLC',
      identityScope: 'global_public',
      identityBasis: 'exact_uei',
      generatedAt: '2026-09-25T00:00:00.000Z',
      sections: {},
      sectionStates: [],
      prospect: { id: PROSPECT_ID, displayName: 'Acme Aerospace LLC' },
      ...overrides.dossier,
    })),
  };

  const briefService = {
    getCurrentBrief: jest.fn(async () => ({ brief: null, currentVersion: null })),
    resolveCitation: jest.fn(async () => ({
      resolvable: false,
      limitation: 'brief_not_found',
      message: 'No saved brief exists for this prospect yet.',
      citation: null,
    })),
    saveEditedVersion: jest.fn(),
    ...overrides.brief,
  };

  const watchService = {
    listProspectAlerts: jest.fn(async () => ({
      items: [],
      nextCursor: null,
      unreadCount: 0,
    })),
    ...(overrides.watch ?? {}),
  };

  const watchFlagGuard = {
    assertEnabledForTenant: jest.fn(async () => true),
    ...(overrides.watchFlagGuard ?? {}),
  };

  const service = new MeriBizDevToolsService(
    prisma,
    scopeService,
    bizdev as never,
    dossierService as never,
    briefService as never,
    watchService as never,
    watchFlagGuard as never,
  );
  return {
    service,
    withTenant,
    assertCurrent,
    bizdev,
    dossierService,
    briefService,
    watchService,
    watchFlagGuard,
  };
}

/** Run a handler inside the cooperative tool-execution control (required gate). */
async function run(handler: Handler, service: MeriBizDevToolsService, input: Record<string, unknown>) {
  return withMeriToolExecutionControl(
    { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 },
    () => handler(service, input),
  );
}

// ── authority-like keys & conversation denial (shared fail-closed gate) ────

describe('MeriBizDevToolsService fail-closed gate', () => {
  const handlers: [string, Handler][] = [
    ['getContext', (s, i) => s.getContext(ctx, i)],
    ['getEvidence', (s, i) => s.getEvidence(ctx, i)],
    ['getBrief', (s, i) => s.getBrief(ctx, i)],
    ['resolveSource', (s, i) => s.resolveSource(ctx, i)],
    ['saveBrief', (s, i) => s.saveBrief(ctx, i)],
    ['getRecentChanges', (s, i) => s.getRecentChanges(ctx, i)],
  ];

  it.each(handlers)('%s rejects every authority-like key before any read or write', async (_name, handler) => {
    for (const key of [
      'tenantId',
      'userId',
      'prospectId',
      'canonicalOrganizationId',
      'linkedClientId',
      'scopeVersion',
      'alertId',
      'watchId',
    ]) {
      const { service, withTenant, assertCurrent, briefService } = harness({});
      await expect(run(handler, service, { ...validInput(), [key]: 'spoofed' })).rejects.toThrow(
        BadRequestException,
      );
      expect(withTenant).not.toHaveBeenCalled();
      expect(assertCurrent).not.toHaveBeenCalled();
      expect(briefService.saveEditedVersion).not.toHaveBeenCalled();
    }
  });

  it.each(handlers)('%s denies a missing conversationId with no BD service call', async (_name, handler) => {
    const { service, withTenant, briefService } = harness({});
    await expect(run(handler, service, {})).rejects.toThrow(BadRequestException);
    expect(withTenant).not.toHaveBeenCalled();
    expect(briefService.saveEditedVersion).not.toHaveBeenCalled();
  });

  it.each(handlers)('%s denies a malformed conversationId with no BD service call', async (_name, handler) => {
    const { service, briefService } = harness({});
    await expect(run(handler, service, { conversationId: 'not-a-uuid' })).rejects.toThrow(
      BadRequestException,
    );
    expect(briefService.saveEditedVersion).not.toHaveBeenCalled();
  });

  it.each(handlers)('%s denies a conversation that does not exist (wrong user/tenant/stale)', async (_name, handler) => {
    const assertCurrent = jest.fn();
    const scopeService = { assertCurrent } as unknown as BizDevMeriScopeService;
    const withTenant = jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ clioConversation: { findFirst: async () => null } }),
    );
    const service = new MeriBizDevToolsService(
      { withTenant } as never,
      scopeService,
      {} as never,
      {} as never,
      { saveEditedVersion: jest.fn() } as never,
    );
    await expect(run(handler, service, validInput())).rejects.toThrow(NotFoundException);
    expect(assertCurrent).not.toHaveBeenCalled();
  });

  it.each(handlers)('%s denies an unscoped conversation before any BD service call', async (_name, handler) => {
    // Conversation exists but metadata carries NO prospect scope.
    const { service, assertCurrent, bizdev, dossierService, briefService } = harness({ metadata: {} });
    await expect(run(handler, service, validInput())).rejects.toThrow(
      'This conversation is not scoped to a business-development prospect.',
    );
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(bizdev.get).not.toHaveBeenCalled();
    expect(dossierService.prospectDossier).not.toHaveBeenCalled();
    expect(briefService.getCurrentBrief).not.toHaveBeenCalled();
    expect(briefService.saveEditedVersion).not.toHaveBeenCalled();
  });

  it.each(handlers)('%s denies a stale/changed prospect scope and never reaches BD services', async (_name, handler) => {
    const { service, bizdev, dossierService, briefService } = harness({
      metadata: { [MERI_PROSPECT_SCOPE_METADATA_KEY]: 'stale-scope' },
      scopeThrow: new ConflictException('The prospect this chat was created for has changed.'),
    });
    await expect(run(handler, service, validInput())).rejects.toThrow(ConflictException);
    expect(bizdev.get).not.toHaveBeenCalled();
    expect(dossierService.prospectDossier).not.toHaveBeenCalled();
    expect(briefService.saveEditedVersion).not.toHaveBeenCalled();
  });

  it('uses ONLY the server-resolved scope.prospectId, never a model-supplied one', async () => {
    const { service, briefService } = harness({});
    const result = await run((s, i) => s.getBrief(ctx, i), service, validInput());
    expect(briefService.getCurrentBrief).toHaveBeenCalledWith(ctx, PROSPECT_ID);
    expect(result).toMatchObject({ tool: 'get_business_development_brief' });
  });
});

// ── get_business_development_context ────────────────────────────────────────

describe('get_business_development_context', () => {
  const history = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `activity-${i}`,
      kind: 'note',
      body: `entry ${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
      actorUserId: USER,
      // Fields that must NEVER be projected to the model:
      before: { sensitive: 'before-payload' },
      after: { sensitive: 'after-payload', contact: { email: 'x@y.z' }, provider: { raw: true } },
      conflictOfInterestCheck: { status: 'internal' },
    }));

  it('projects safe prospect/preference fields and the newest 20 history entries only', async () => {
    const { service, bizdev } = harness({ bizdev: { history: jest.fn(async () => history(35)) } });
    const result = await run((s, i) => s.getContext(ctx, i), service, validInput());
    expect(bizdev.get).toHaveBeenCalledWith(ctx, PROSPECT_ID);
    expect(result).toMatchObject({
      tool: 'get_business_development_context',
      prospect: {
        id: PROSPECT_ID,
        displayName: 'Acme Aerospace LLC',
        stage: 'researching',
        serviceHypothesis: 'Federal prime contracting fit',
        geography: 'CO',
        nextAction: 'Draft outreach',
        canonicalEntityId: '55555555-5555-4555-8555-555555555555',
        linkedClientId: null,
        ownerUserId: USER,
      },
      firmPreferences: {
        practiceServiceAreas: ['gov-contracts'],
        agenciesIssues: ['DoD'],
        geographies: ['CO'],
      },
      history: { returned: 20, total: 35, truncated: true },
    });
    const entries = (result.history as { entries: Array<{ id: string }> }).entries;
    // Newest-first: the 20 most recent of 35 are activity-34 … activity-15.
    expect(entries.map((e) => e.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `activity-${34 - i}`),
    );
    // Only the five safe fields per entry — no before/after/conflict payloads.
    for (const entry of entries as Record<string, unknown>[]) {
      expect(Object.keys(entry).sort()).toEqual(['actorUserId', 'at', 'body', 'id', 'kind']);
    }
  });

  it('excludes conflict/contact/provider payloads from the whole result', async () => {
    const { service } = harness({ bizdev: { history: jest.fn(async () => history(3)) } });
    const result = await run((s, i) => s.getContext(ctx, i), service, validInput());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('before-payload');
    expect(serialized).not.toContain('after-payload');
    expect(serialized).not.toContain('conflictOfInterestCheck');
    expect(serialized).not.toContain('contact');
    expect(serialized).not.toContain('provider');
  });

  it('defaults preferences when the firm has none saved', async () => {
    const { service } = harness({ bizdev: { getPreferences: jest.fn(async () => null) } });
    const result = await run((s, i) => s.getContext(ctx, i), service, validInput());
    expect(result.firmPreferences).toEqual({
      practiceServiceAreas: [],
      agenciesIssues: [],
      geographies: [],
    });
  });
});

// ── get_business_development_evidence ───────────────────────────────────────

describe('get_business_development_evidence', () => {
  const evidenceItem = (i: number): EvidenceItem => ({
    sourceFamily: 'usaspending_contract',
    recordId: `award-${i}`,
    locator: `https://example.gov/award/${i}`,
    originalSourceName: 'USAspending',
    originalSourceId: `PIID-${i}`,
    claimType: 'government_exposure',
    relationshipStrength: 'direct',
    eventDate: '2026-01-15',
    effectiveDate: null,
    fiscalYear: 2026,
    stage: 'awarded',
    sourceUpdatedAt: '2026-02-01',
    fetchedAt: '2026-03-01',
    scopeChecked: 'recipient_uei=UEI1',
    status: 'available',
    title: `Acme received a $${i}M DoD contract, FY2026`,
    detail: {
      agency: 'Department of Defense',
      amount: i * 1_000_000,
      amountType: 'obligated',
      stage: 'awarded',
      // Arbitrary provider detail must be dropped:
      providerPayload: { contactEmail: 'buyer@navy.mil', internalNotes: 'unreviewed' },
      contact: { email: 'buyer@navy.mil' },
    },
  });

  const dossier = (count: number, sectionStatus: 'available' | 'stale' = 'available'): Partial<BizDevDossier> => ({
    sections: {
      government_exposure: {
        section: 'government_exposure',
        status: 'available',
        statusText: 'ok',
        detail: {},
        evidence: Array.from({ length: count }, (_, i) => evidenceItem(i)),
      },
    },
    sectionStates: [
      { section: 'identity', status: 'available', statusText: 'ok' },
      { section: 'government_exposure', status: sectionStatus, statusText: 'ok' },
    ],
  });

  it('caps flattened evidence at 24 and reports partial/truncated honestly', async () => {
    const { service, dossierService } = harness({ dossier: dossier(30) });
    const result = await run((s, i) => s.getEvidence(ctx, i), service, validInput());
    expect(dossierService.prospectDossier).toHaveBeenCalledWith(ctx, PROSPECT_ID, undefined, true);
    expect(result).toMatchObject({
      tool: 'get_business_development_evidence',
      evidence: { total: 30, returned: 24, truncated: true },
      coverage: {
        complete: false,
        partial: true,
        note: 'Only the first 24 of 30 evidence records are included; this is a partial view.',
      },
    });
  });

  it('includes safe factual amount/agency/stage/date/source fields and omits arbitrary provider detail', async () => {
    const { service } = harness({ dossier: dossier(2) });
    const result = await run((s, i) => s.getEvidence(ctx, i), service, validInput());
    const records = (
      result.evidence as { records: Array<{ facts: Record<string, unknown> }> }
    ).records;
    expect(records).toHaveLength(2);
    const facts = records[0]!.facts;
    expect(facts).toMatchObject({
      agency: 'Department of Defense',
      amount: 0,
      amountType: 'obligated',
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('providerPayload');
    expect(serialized).not.toContain('internalNotes');
    expect(serialized).not.toContain('contactEmail');
    // Envelope fields survive: identity, locator, strength, separated dates.
    expect(records[0]).toMatchObject({
      sourceFamily: 'usaspending_contract',
      recordId: 'award-0',
      locator: 'https://example.gov/award/0',
      originalSourceName: 'USAspending',
      originalSourceId: 'PIID-0',
      relationshipStrength: 'direct',
      eventDate: '2026-01-15',
      sourceUpdatedAt: '2026-02-01',
      retrievedAt: '2026-03-01',
      status: 'available',
      title: 'Acme received a $0M DoD contract, FY2026',
    });
  });

  it('reports complete coverage honestly when every record fits and sections are clean', async () => {
    const { service } = harness({ dossier: dossier(3) });
    const result = await run((s, i) => s.getEvidence(ctx, i), service, validInput());
    expect(result).toMatchObject({
      evidence: { total: 3, returned: 3, truncated: false },
      coverage: {
        complete: true,
        partial: false,
        note: 'All available evidence records are included.',
      },
    });
  });

  it('a section that is not available/partial marks coverage partial even under the cap', async () => {
    const { service } = harness({ dossier: dossier(2, 'stale') });
    const result = await run((s, i) => s.getEvidence(ctx, i), service, validInput());
    expect(result.coverage).toMatchObject({ complete: true, partial: true });
  });
});

// ── get_business_development_brief ─────────────────────────────────────────

describe('get_business_development_brief', () => {
  const version = () => ({
    id: randomUUID(),
    versionNumber: 4,
    createdAt: '2026-09-01T00:00:00.000Z',
    createdByUserId: USER,
    sectionsHash: 'hash',
    citationCount: 2,
    sections: {
      companyAndFirmImplication: { text: 'a', provenance: 'generated', citationIndexes: [0] },
      verifiedEvidence: { text: 'b', provenance: 'generated', citationIndexes: [0, 1] },
      judgment: { text: 'c', provenance: 'edited', citationIndexes: [] },
      practicalAction: { text: 'd', provenance: 'generated', citationIndexes: [1] },
      missingInformation: { text: 'e', provenance: 'generated', citationIndexes: [] },
    } as BriefSections,
    citations: [
      {
        sourceFamily: 'usaspending_contract',
        recordId: 'award-1',
        locator: 'https://example.gov/award/1',
        originalSourceName: 'USAspending',
        originalSourceId: 'PIID-1',
        eventDate: '2026-01-15',
        sourceUpdatedAt: null,
        retrievedAt: null,
        title: 'award',
        relationshipStrength: 'direct',
        stage: 'awarded',
      },
    ],
    sourceSnapshot: null,
    snapshotHash: 'snap',
  });

  it('returns the current versioned brief verbatim', async () => {
    const brief = {
      id: randomUUID(),
      title: 'Acme brief',
      status: 'draft',
      currentVersionNumber: 4,
      updatedAt: '2026-09-20T00:00:00.000Z',
    };
    const { service, briefService } = harness({
      brief: { getCurrentBrief: jest.fn(async () => ({ brief, currentVersion: version() })) },
    });
    const result = await run((s, i) => s.getBrief(ctx, i), service, validInput());
    expect(briefService.getCurrentBrief).toHaveBeenCalledWith(ctx, PROSPECT_ID);
    expect(result).toMatchObject({
      tool: 'get_business_development_brief',
      brief: { title: 'Acme brief', status: 'draft', currentVersionNumber: 4 },
    });
  });

  it('reports a missing brief honestly and never fabricates one', async () => {
    const { service } = harness({});
    const result = await run((s, i) => s.getBrief(ctx, i), service, validInput());
    expect(result).toMatchObject({
      tool: 'get_business_development_brief',
      brief: null,
      message: expect.stringContaining('No saved brief exists'),
    });
  });
});

// ── resolve_business_development_source ─────────────────────────────────────

describe('resolve_business_development_source', () => {
  it('passes the bounded citationIndex through to the brief service', async () => {
    const { service, briefService } = harness({
      brief: {
        resolveCitation: jest.fn(async () => ({
          resolvable: true,
          citation: { title: 'award', relationshipStrength: 'direct' },
          sourceSnapshotEvidence: null,
          currentDossierEvidence: null,
        })),
      },
    });
    const result = await run((s, i) => s.resolveSource(ctx, i), service, { ...validInput(), citationIndex: 1 });
    expect(briefService.resolveCitation).toHaveBeenCalledWith(ctx, PROSPECT_ID, 1);
    expect(result).toMatchObject({
      tool: 'resolve_business_development_source',
      resolvable: true,
    });
  });

  it('passes source limitations through truthfully', async () => {
    const { service } = harness({});
    const result = await run((s, i) => s.resolveSource(ctx, i), service, { ...validInput(), citationIndex: 9 });
    expect(result).toMatchObject({
      tool: 'resolve_business_development_source',
      resolvable: false,
      limitation: 'brief_not_found',
    });
  });

  it('rejects a missing/negative/non-integer citationIndex before the brief service call', async () => {
    const { service, briefService } = harness({});
    for (const citationIndex of [undefined, -1, 1.5, '0']) {
      await expect(
        run((s, i) => s.resolveSource(ctx, i), service, { ...validInput(), citationIndex }),
      ).rejects.toThrow('citationIndex must be a non-negative integer');
    }
    expect(briefService.resolveCitation).not.toHaveBeenCalled();
  });
});

// ── save_business_development_brief ─────────────────────────────────────────

describe('save_business_development_brief', () => {
  const sections = (text = '  Updated section text.  ') =>
    Object.fromEntries(
      [
        'companyAndFirmImplication',
        'verifiedEvidence',
        'judgment',
        'practicalAction',
        'missingInformation',
      ].map((key) => [key, { text, citationIndexes: [0] }]),
    );

  const save = () => jest.fn(async () => ({
    brief: {
      id: 'brief-1',
      title: 'Acme brief',
      status: 'draft',
      updatedAt: '2026-09-25T00:00:00.000Z',
    },
    version: {
      id: 'version-5',
      versionNumber: 5,
      createdAt: '2026-09-25T00:00:00.000Z',
      sections: sections('saved'),
      citations: [{}, {}],
    },
    created: true,
  }));

  const input = (extra: Record<string, unknown> = {}) => ({
    conversationId: CONVERSATION_ID,
    expectedVersionNumber: 4,
    sections: sections(),
    ...extra,
  });

  it('accepts exactly five text+citationIndexes sections, trims text, and forces generated provenance', async () => {
    const { service, briefService } = harness({ brief: { saveEditedVersion: save() } });
    const result = await run((s, i) => s.saveBrief(ctx, i), service, input());
    expect(result).toMatchObject({
      tool: 'save_business_development_brief',
      status: 'saved',
      brief: { currentVersionNumber: 5 },
      version: { versionNumber: 5, citationCount: 2 },
      reused: false,
      prospectName: 'Acme Aerospace LLC',
    });
    const call = (briefService.saveEditedVersion as jest.Mock).mock.calls[0]!;
    expect(call[1]).toBe(PROSPECT_ID);
    const payload = call[2] as { title?: string; sections: BriefSections };
    expect(payload.title).toBeUndefined();
    for (const key of [
      'companyAndFirmImplication',
      'verifiedEvidence',
      'judgment',
      'practicalAction',
      'missingInformation',
    ] as const) {
      expect(payload.sections[key]).toEqual({
        text: 'Updated section text.',
        provenance: 'generated',
        citationIndexes: [0],
      });
    }
    expect(typeof (payload as { idempotencyKey?: string }).idempotencyKey).toBe('string');
  });

  it('never accepts citation objects, citation ids or dates in a section', async () => {
    const { service, briefService } = harness({ brief: { saveEditedVersion: save() } });
    const bad = input({
      sections: {
        ...sections('Updated section text.'),
        verifiedEvidence: {
          text: 'x',
          citationIndexes: [0],
          citations: [{ recordId: 'award-1' }],
        },
      },
    });
    await expect(run((s, i) => s.saveBrief(ctx, i), service, bad)).rejects.toThrow(
      'sections.verifiedEvidence may only contain text and citationIndexes',
    );
    const badDates = input({
      sections: {
        ...sections('Updated section text.'),
        judgment: { text: 'x', citationIndexes: [0], eventDate: '2026-01-01' },
      },
    });
    await expect(run((s, i) => s.saveBrief(ctx, i), service, badDates)).rejects.toThrow(
      'sections.judgment may only contain text and citationIndexes',
    );
    expect(briefService.saveEditedVersion).not.toHaveBeenCalled();
  });

  it('rejects missing/extra section keys and bad section payloads', async () => {
    const { service, briefService } = harness({ brief: { saveEditedVersion: save() } });
    const badKey = input({ sections: { ...sections('x'), extraSection: { text: 'y', citationIndexes: [] } } });
    await expect(run((s, i) => s.saveBrief(ctx, i), service, badKey)).rejects.toThrow(
      'sections must contain exactly the five brief sections',
    );
    const missingKey = input({ sections: sections('x') });
    delete (missingKey.sections as Record<string, unknown>).judgment;
    await expect(run((s, i) => s.saveBrief(ctx, i), service, missingKey)).rejects.toThrow(
      'sections must contain exactly the five brief sections',
    );
    const notObject = input({ sections: 'nope' });
    await expect(run((s, i) => s.saveBrief(ctx, i), service, notObject)).rejects.toThrow(
      'sections must be an object',
    );
    expect(briefService.saveEditedVersion).not.toHaveBeenCalled();
  });

  it('rejects an invalid expectedVersionNumber before the save call', async () => {
    const { service, briefService } = harness({ brief: { saveEditedVersion: save() } });
    for (const expectedVersionNumber of [undefined, 0, -1, 1.5, '4']) {
      await expect(
        run((s, i) => s.saveBrief(ctx, i), service, input({ expectedVersionNumber })),
      ).rejects.toThrow('expectedVersionNumber must be a positive integer');
    }
    expect(briefService.saveEditedVersion).not.toHaveBeenCalled();
  });

  it('is deterministically idempotent for the same content (same idempotency key, reused)', async () => {
    const savedVersion = {
      brief: { id: 'brief-1', title: 'Acme brief', status: 'draft', updatedAt: '2026-09-25T00:00:00.000Z' },
      version: { versionNumber: 5, citations: [] },
    };
    const reuse = jest
      .fn()
      .mockResolvedValueOnce({ ...savedVersion, created: true })
      .mockResolvedValue({ ...savedVersion, created: false });
    const { service, briefService } = harness({ brief: { saveEditedVersion: reuse } });
    const first = await run((s, i) => s.saveBrief(ctx, i), service, input());
    const second = await run((s, i) => s.saveBrief(ctx, i), service, input());
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    const keys = (briefService.saveEditedVersion as jest.Mock).mock.calls.map(
      (c) => (c[2] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[0]).toBe(keys[1]);
    // Same content with different citation-index order dedupes to the same key.
    const reordered = input({
      sections: Object.fromEntries(
        Object.entries(sections('Updated section text.')).map(([key, value]) => [
          key,
          { text: value.text, citationIndexes: [0, 0] },
        ]),
      ),
    });
    await run((s, i) => s.saveBrief(ctx, i), service, reordered);
    const third = (briefService.saveEditedVersion as jest.Mock).mock.calls[2]!;
    expect((third[2] as { idempotencyKey: string }).idempotencyKey).toBe(keys[0]);
  });

  it('derives a different idempotency key for different content', async () => {
    const { service, briefService } = harness({ brief: { saveEditedVersion: save() } });
    await run((s, i) => s.saveBrief(ctx, i), service, input());
    await run((s, i) => s.saveBrief(ctx, i), service, input({
      sections: sections('Genuinely different content.'),
    }));
    const keys = (briefService.saveEditedVersion as jest.Mock).mock.calls.map(
      (c) => (c[2] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('propagates an optimistic version conflict unchanged', async () => {
    const conflict = new ConflictException({ code: 'BIZDEV_BRIEF_VERSION_CONFLICT' });
    const { service } = harness({
      brief: { saveEditedVersion: jest.fn(async () => { throw conflict; }) },
    });
    await expect(run((s, i) => s.saveBrief(ctx, i), service, input())).rejects.toBe(conflict);
  });

  it('converts a no-brief save into a bounded instruction, not a raw 404', async () => {
    const { service, briefService } = harness({
      brief: { saveEditedVersion: jest.fn(async () => { throw new NotFoundException('Brief not found'); }) },
    });
    await expect(run((s, i) => s.saveBrief(ctx, i), service, input())).rejects.toThrow(
      'This prospect has no brief yet. Ask the user to create the initial brief from the Brief tab first.',
    );
    expect(briefService.saveEditedVersion).toHaveBeenCalledTimes(1);
  });

  it('accepts and trims an optional bounded title', async () => {
    const { service, briefService } = harness({ brief: { saveEditedVersion: save() } });
    await run((s, i) => s.saveBrief(ctx, i), service, input({ title: '  Acme brief v5  ' }));
    const call = (briefService.saveEditedVersion as jest.Mock).mock.calls[0]!;
    expect((call[2] as { title: string }).title).toBe('Acme brief v5');
  });
});

// ── get_business_development_recent_changes ─────────────────────────────────

describe('get_business_development_recent_changes', () => {
  const ALERT_ID = '66666666-6666-4666-8666-666666666666';

  /** One BizDevAlertRow as listProspectAlerts returns it. */
  const alertRow = () => ({
    id: ALERT_ID,
    title: 'SAM opportunity updated',
    summary: 'Record opp-1 from sam_gov changed (material_update).',
    materiality: 'high',
    materialityLevel: 'high',
    company: 'Acme Aerospace LLC',
    sourceFamily: 'sam_gov',
    category: 'funding',
    eventAt: '2026-09-20T00:00:00.000Z',
    effectiveAt: '2026-10-01T00:00:00.000Z',
    publishedAt: '2026-09-19T00:00:00.000Z',
    firstObservedAt: '2026-09-21T00:00:00.000Z',
    sourceLocator: 'https://sam.gov/opp-1',
    implication: 'May signal a nearing solicitation window; worth tracking.',
    readAt: null,
    dismissedAt: null,
    prospectId: PROSPECT_ID,
  });

  /** Harness whose prisma also serves the changed-fields read. */
  function alertsHarness(
    page: { items: unknown[]; nextCursor: string | null; unreadCount: number },
    changesJsonb: unknown = [
      { field: 'amount', before: 1_000_000, after: 2_000_000 },
    ],
  ) {
    const base = harness({
      watch: {
        listProspectAlerts: jest.fn(async () => page),
      },
    });
    // Extend the existing withTenant stub: keep conversation lookup, add
    // the businessDevelopmentAlert read for the changed fields.
    const withTenant = jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        clioConversation: {
          findFirst: async () => ({
            id: CONVERSATION_ID,
            metadata: { [MERI_PROSPECT_SCOPE_METADATA_KEY]: scope() },
          }),
        },
        businessDevelopmentAlert: {
          findMany: async () =>
            page.items.map((item) => ({ id: (item as { id: string }).id, changesJsonb })),
        },
      }),
    );
    const service = new MeriBizDevToolsService(
      { withTenant } as never,
      { assertCurrent: base.assertCurrent } as never,
      {} as never,
      {} as never,
      { saveEditedVersion: jest.fn() } as never,
      base.watchService as never,
      base.watchFlagGuard as never,
    );
    return { ...base, service, withTenant };
  }

  it('returns a bounded, correctly-shaped page for the authorized prospect', async () => {
    const { service, watchService } = alertsHarness({ items: [alertRow()], nextCursor: null, unreadCount: 2 });
    const result = await run((s, i) => s.getRecentChanges(ctx, i), service, validInput());
    expect(watchService.listProspectAlerts).toHaveBeenCalledWith(ctx, PROSPECT_ID, { limit: 10 });
    expect(result).toMatchObject({
      tool: 'get_business_development_recent_changes',
      prospect: { id: PROSPECT_ID, name: 'Acme Aerospace LLC' },
      alerts: { returned: 1, unreadCount: 2, truncated: false, limit: 10 },
    });
    const item = (result.alerts as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(item).toMatchObject({
      id: ALERT_ID,
      sourceFamily: 'sam_gov',
      category: 'funding',
      title: 'SAM opportunity updated',
      sourceLocator: 'https://sam.gov/opp-1',
      dates: {
        eventAt: '2026-09-20T00:00:00.000Z',
        effectiveAt: '2026-10-01T00:00:00.000Z',
        publishedAt: '2026-09-19T00:00:00.000Z',
        firstObservedAt: '2026-09-21T00:00:00.000Z',
      },
      changedFields: [{ field: 'amount', before: 1_000_000, after: 2_000_000 }],
    });
    // Inference label is explicit and the conditional language is verbatim.
    expect(item.implication).toEqual({
      text: 'May signal a nearing solicitation window; worth tracking.',
      inference: true,
      note: expect.any(String),
    });
    // Raw baseline/payload fields are never exposed.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('beforeState');
    expect(serialized).not.toContain('afterState');
    expect(serialized).not.toContain('changesJsonb');
  });

  it('reports truncated truthfully when a next cursor exists', async () => {
    const { service } = alertsHarness({ items: [alertRow()], nextCursor: 'cursor-1', unreadCount: 5 });
    const result = await run((s, i) => s.getRecentChanges(ctx, i), service, validInput());
    expect((result.alerts as Record<string, unknown>).truncated).toBe(true);
  });

  it('defaults to limit 10 and accepts the bounded max 25', async () => {
    const { service, watchService } = alertsHarness({ items: [], nextCursor: null, unreadCount: 0 });
    await run((s, i) => s.getRecentChanges(ctx, i), service, validInput());
    expect(watchService.listProspectAlerts).toHaveBeenLastCalledWith(ctx, PROSPECT_ID, { limit: 10 });
    await run((s, i) => s.getRecentChanges(ctx, i), service, { ...validInput(), limit: 25 });
    expect(watchService.listProspectAlerts).toHaveBeenLastCalledWith(ctx, PROSPECT_ID, { limit: 25 });
  });

  it('rejects out-of-bound and non-integer limits before any alert read', async () => {
    const { service, watchService } = alertsHarness({ items: [], nextCursor: null, unreadCount: 0 });
    for (const limit of [0, -1, 26, 1.5, '10', null]) {
      await expect(
        run((s, i) => s.getRecentChanges(ctx, i), service, { ...validInput(), limit }),
      ).rejects.toThrow('limit must be an integer between 1 and 25');
    }
    expect(watchService.listProspectAlerts).not.toHaveBeenCalled();
  });

  it('rejects any unknown extra input key before any read', async () => {
    const { service, withTenant, watchService } = alertsHarness({ items: [], nextCursor: null, unreadCount: 0 });
    await expect(
      run((s, i) => s.getRecentChanges(ctx, i), service, {
        ...validInput(),
        prospectId: PROSPECT_ID,
      }),
    ).rejects.toThrow('Unknown input key');
    // Even a benign unknown key fails closed.
    await expect(
      run((s, i) => s.getRecentChanges(ctx, i), service, { ...validInput(), foo: 'bar' }),
    ).rejects.toThrow('Unknown input key');
    expect(watchService.listProspectAlerts).not.toHaveBeenCalled();
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('fails closed when the per-tenant watch flag is disabled', async () => {
    const { NotFoundException: NotFound } = await import('@nestjs/common');
    const notFound = new NotFound();
    const guard = { assertEnabledForTenant: jest.fn(async () => { throw notFound; }) };
    const watchService = { listProspectAlerts: jest.fn(async () => ({ items: [], nextCursor: null, unreadCount: 0 })) };
    const withTenant = jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        clioConversation: {
          findFirst: async () => ({
            id: CONVERSATION_ID,
            metadata: { [MERI_PROSPECT_SCOPE_METADATA_KEY]: scope() },
          }),
        },
      }),
    );
    const service = new MeriBizDevToolsService(
      { withTenant } as never,
      { assertCurrent: jest.fn(async () => scope()) } as never,
      {} as never,
      {} as never,
      { saveEditedVersion: jest.fn() } as never,
      watchService as never,
      guard as never,
    );
    await expect(run((s, i) => s.getRecentChanges(ctx, i), service, validInput())).rejects.toThrow(notFound);
    expect(watchService.listProspectAlerts).not.toHaveBeenCalled();
  });

  it('is read-only: never calls markAlertRead/dismissAlert or any provider', async () => {
    const { service, watchService } = alertsHarness({ items: [alertRow()], nextCursor: null, unreadCount: 1 });
    await run((s, i) => s.getRecentChanges(ctx, i), service, validInput());
    const calls = Object.keys(watchService);
    expect(calls).toEqual(['listProspectAlerts']);
    expect((watchService as Record<string, jest.Mock>).markAlertRead).toBeUndefined();
    expect((watchService as Record<string, jest.Mock>).dismissAlert).toBeUndefined();
  });

  it('fails closed when watchService or watchFlagGuard is not wired', async () => {
    const prisma = { withTenant: jest.fn() };
    const scopeSvc = { assertCurrent: jest.fn(async () => scope()) };
    const bare = new MeriBizDevToolsService(
      prisma as never,
      scopeSvc as never,
      {} as never,
      {} as never,
      { saveEditedVersion: jest.fn() } as never,
      undefined,
      undefined,
    );
    await expect(run((s, i) => s.getRecentChanges(ctx, i), bare, validInput())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('omits changedFields cleanly when the alert carries none', async () => {
    const { service } = alertsHarness({ items: [alertRow()], nextCursor: null, unreadCount: 0 }, []);
    const result = await run((s, i) => s.getRecentChanges(ctx, i), service, validInput());
    const item = (result.alerts as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(item.changedFields).toEqual([]);
  });
});
