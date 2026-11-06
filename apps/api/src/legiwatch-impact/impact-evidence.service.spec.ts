import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { ProfileFact } from '../clients/profile-facts.js';
import { billStructureHash, structureText } from '../ingestion/bill-document-structure.js';
import {
  ImpactEvidenceService,
  IMPACT_CURRENT_FEDERAL_SQL,
  IMPACT_CURRENT_STATE_SQL,
} from './impact-evidence.service.js';
import { loadImpactProfileContext } from './impact-client-evidence.js';

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
} as TenantContext;
const clientId = '00000000-0000-4000-8000-000000000003';
const sourceId = '00000000-0000-4000-8000-000000000004';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const fact = (overrides: Partial<ProfileFact> = {}): ProfileFact => ({
  id: 'fact-one',
  fieldKey: 'description',
  value: 'Manufactures aircraft components in the United States.',
  origin: 'person',
  sourceType: null,
  sourceUrl: null,
  attachmentId: null,
  evidence: [],
  observedAt: null,
  confidence: null,
  status: 'approved',
  isCurrent: true,
  approvedBy: ctx.userId,
  approvedAt: null,
  version: 1,
  findingId: null,
  runId: null,
  originId: 'person',
  ...overrides,
});
function harness(sourceKind: 'federal' | 'state' = 'state') {
  const structure = structureText(
    'SECTION 1. Domestic suppliers.\nA covered supplier shall report domestic component sourcing.\nSECTION 2. Exception.\nThis requirement does not apply to purchases below $10,000.',
  );
  const version = {
    id: sourceId,
    label: 'Introduced',
    sourceUrl: 'https://legislature.example.gov/bill/text',
    publishedAt: '2026-02-01',
    contentHash: sha('original retained bytes'),
    revisionHash: sha('publisher revision'),
    completeness: 'complete',
    extractionId: 'extraction-one',
    text: structure.text,
    textHash: structure.textHash,
    structureHash: structure.structureHash,
    structure,
    retainedStructure: null as unknown,
    oversized: false,
  };
  const rows = {
    client: {
      id: clientId,
      name: 'Example Components',
      description: 'Manufactures aircraft components in the United States.',
      productDescription: null,
      sectorTag: null,
      naicsCodes: [],
      pscCodes: [],
      applicantTypes: [],
      setAsideCertifications: [],
    } as Record<string, unknown> | null,
    lifecycle: {
      title: 'Domestic sourcing',
      status: 'introduced',
      latestAction: 'Introduced',
      actionDate: '2026-02-01',
      sourceUrl: 'https://legislature.example.gov/bill',
      sourceKind,
    },
    facts: [] as ProfileFact[],
    facilities: [] as Record<string, unknown>[],
    capabilities: [] as Record<string, unknown>[],
    cases: [] as Record<string, unknown>[],
    terms: [] as Record<string, unknown>[],
    links: [] as Record<string, unknown>[],
    versions: [version],
    attachmentVisible: true,
    meetingVisible: true,
    missingBill: false,
  };
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('FROM congress_bill WHERE')) return rows.missingBill ? [] : [rows.lifecycle];
    if (sql.includes('FROM profile_fact')) return rows.facts;
    if (sql === IMPACT_CURRENT_STATE_SQL || sql === IMPACT_CURRENT_FEDERAL_SQL)
      return rows.versions;
    if (sql.includes('FROM engagement_attachments'))
      return rows.attachmentVisible ? [{ id: sourceId, prospectId: null }] : [];
    throw Error(`Unexpected query: ${sql}`);
  });
  const tx = {
    $queryRawUnsafe: query,
    client: { findFirst: jest.fn(async () => rows.client) },
    clientFacility: { findMany: jest.fn(async () => rows.facilities) },
    clientCapability: { findMany: jest.fn(async () => rows.capabilities) },
    clientPortfolioProposal: { findMany: jest.fn(async () => rows.cases) },
    clientCapabilityTerm: { findMany: jest.fn(async () => rows.terms) },
    clientFacilityCapability: { findMany: jest.fn(async () => rows.links) },
    meeting: { findFirst: jest.fn(async () => (rows.meetingVisible ? { id: 'meeting' } : null)) },
    mailThread: { findFirst: jest.fn(async () => null) },
  };
  const load = () =>
    new ImpactEvidenceService().load(
      tx as never,
      ctx,
      clientId,
      sourceKind === 'state' ? 'ca-2026-ab123' : '119-hr-123',
    );
  return { rows, tx, version, structure, load };
}

describe('ImpactEvidenceService current evidence', () => {
  it.each(['federal', 'state'] as const)(
    'uses immutable current %s sections including closing exceptions',
    async (sourceKind) => {
      const h = harness(sourceKind),
        result = await h.load();
      expect(result.provisions.map((p) => p.text).join('\n')).toBe(
        h.structure.sections.map((s) => s.text).join('\n'),
      );
      expect(result.provisions.some((p) => p.quote.includes('does not apply'))).toBe(true);
      expect(
        result.provisions.every(
          (p) => p.sourceId === h.version.id && p.locator && p.revision.length === 64,
        ),
      ).toBe(true);
      expect(result.versions[0]).toMatchObject({
        current: true,
        completeness: 'complete',
        contentHash: h.version.contentHash,
      });
      const sql = sourceKind === 'state' ? IMPACT_CURRENT_STATE_SQL : IMPACT_CURRENT_FEDERAL_SQL;
      expect(h.tx.$queryRawUnsafe).toHaveBeenCalledWith(
        sql,
        sourceKind === 'state' ? 'ca-2026-ab123' : '119-hr-123',
        h.structure.parserVersion,
      );
      expect(IMPACT_CURRENT_STATE_SQL).toContain('JOIN published_record_source_current');
      expect(IMPACT_CURRENT_STATE_SQL).not.toContain("state='FL'");
      expect(IMPACT_CURRENT_FEDERAL_SQL).toContain("c.state='present'");
    },
  );

  it('reuses the verified retained structure before passage indexing, without extraction or provider calls', async () => {
    const h = harness();
    Object.assign(h.version, {
      extractionId: null,
      structure: null,
      text: null,
      textHash: null,
      structureHash: null,
      retainedStructure: h.structure,
    });
    const result = await h.load();
    expect(result.provisions.length).toBe(h.structure.sections.length);
    expect(result.versions[0]?.completeness).toBe('complete');
  });

  it.each(['text', 'offset', 'hash', 'url', 'oversize'])(
    'fails closed for %s-invalid retained source',
    async (invalid) => {
      const h = harness();
      if (invalid === 'text') h.version.text = 'different text';
      if (invalid === 'offset') h.structure.sections[0]!.endOffset++;
      if (invalid === 'hash') h.structure.structureHash = sha('forged structure');
      if (invalid === 'url') h.version.sourceUrl = 'javascript:alert(1)';
      if (invalid === 'oversize') h.version.oversized = true;
      const result = await h.load();
      expect(result.provisions).toEqual([]);
      expect(result.versions[0]?.completeness).toBe('unavailable');
      expect(result.coverageNotes).toEqual(
        expect.arrayContaining([expect.stringContaining('incomplete')]),
      );
    },
  );

  it('distinguishes partial text, unindexed text, and no current publication', async () => {
    const h = harness();
    h.structure.completeness = 'partial';
    h.structure.structureHash = billStructureHash(h.structure);
    h.version.structureHash = h.structure.structureHash;
    expect((await h.load()).versions[0]?.completeness).toBe('partial');
    Object.assign(h.version, { structure: null, retainedStructure: null, extractionId: null });
    const unindexed = await h.load();
    expect(unindexed.provisions).toEqual([]);
    expect(unindexed.versions[0]?.completeness).toBe('needs_extraction');
    h.rows.versions = [];
    expect((await h.load()).coverageNotes).toContain('No current retained bill text is available.');
  });

  it('never silently selects a subset when the current version inventory exceeds its bound', async () => {
    const h = harness();
    h.rows.versions = Array.from({ length: 65 }, (_, i) => ({ ...h.version, id: `version-${i}` }));
    const result = await h.load();
    expect(result.provisions).toEqual([]);
    expect(result.coverageNotes).toEqual(
      expect.arrayContaining([expect.stringContaining('incomplete list')]),
    );
  });

  it('scopes accepted facts and related records to the selected tenant/client', async () => {
    const h = harness();
    h.rows.facts = [
      fact(),
      fact({ id: 'product', fieldKey: 'productDescription', value: 'Composite rotor components' }),
      fact({
        id: 'pending',
        fieldKey: 'description',
        value: 'Unapproved claim',
        status: 'pending',
      }),
    ];
    const result = await h.load();
    expect(result.clientFacts.some((f) => f.value.includes('Unapproved'))).toBe(false);
    expect(result.clientFacts.some((f) => f.id === 'profile:fact-one')).toBe(true);
    expect(
      result.clientFacts.some(
        (f) => f.id.startsWith('client:') && f.label.startsWith('description'),
      ),
    ).toBe(false);
    expect(h.tx.clientFacility.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: ctx.tenantId, clientId } }),
    );
    expect(h.tx.clientCapability.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: ctx.tenantId, clientId },
        include: {
          documents: {
            where: { tenantId: ctx.tenantId, clientId },
            select: { attachmentId: true },
          },
        },
      }),
    );
    expect(h.tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("AND is_current AND status='approved'"),
      ctx.tenantId,
      clientId,
    );
  });

  it('withdraws restricted fact excerpts and blocks a description projection from restoring them', async () => {
    const h = harness();
    h.rows.facts = [
      fact({ evidence: [{ attachmentId: sourceId, excerpt: 'Restricted source excerpt' }] }),
    ];
    const before = await h.load();
    expect(JSON.stringify(before)).toContain('Restricted source excerpt');
    h.rows.attachmentVisible = false;
    const after = await h.load();
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.clientFacts).toEqual([]);
    expect(JSON.stringify(after)).not.toContain('Restricted source excerpt');
    expect(h.tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("a.viewer_mode='all'"),
      sourceId,
      ctx.tenantId,
      clientId,
    );
  });

  it('gives retained Bill360 exact authorized profile fields without parsing display labels', async () => {
    const h = harness();
    h.rows.facts = [
      fact({ evidence: [{ attachmentId: sourceId, excerpt: 'Source description' }] }),
    ];
    const before = await loadImpactProfileContext(h.tx as never, ctx, clientId);
    expect(before.description).toBe(h.rows.facts[0]!.value);
    expect(before.productDescription).toBeNull();
    h.rows.attachmentVisible = false;
    const after = await loadImpactProfileContext(h.tx as never, ctx, clientId);
    expect(after.description).toBeNull();
    expect(after.evidenceRevision).not.toBe(before.evidenceRevision);
  });

  it('rechecks meeting ownership and current capability attachment relations', async () => {
    const h = harness();
    h.rows.facts = [
      fact({
        evidence: [
          {
            metadata: { entityType: 'meeting', entityId: 'meeting' },
            excerpt: 'Private meeting context',
          },
        ],
      }),
    ];
    h.rows.capabilities = [
      {
        id: 'capability',
        name: 'Rotor component',
        type: 'product',
        reviewStatus: 'approved',
        version: 1,
        provenance: [],
        documents: [{ attachmentId: sourceId }],
      },
    ];
    expect((await h.load()).clientFacts.some((f) => f.id === 'capability:capability')).toBe(true);
    h.rows.meetingVisible = false;
    h.rows.attachmentVisible = false;
    const result = await h.load();
    expect(result.clientFacts).toEqual([]);
    expect(h.tx.meeting.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: ctx.tenantId, id: 'meeting' }),
      }),
    );
  });

  it('uses approved supplier/threshold facts only when their client capability and facility still exist', async () => {
    const h = harness();
    h.rows.facilities = [
      {
        id: 'facility',
        name: 'Factory',
        city: 'Sacramento',
        state: 'CA',
        siteVerificationStatus: 'verified',
        sourceEvidence: [
          { sourceUrl: 'https://example.com/factory', evidence: 'Factory in Sacramento' },
        ],
      },
    ];
    h.rows.capabilities = [
      {
        id: 'capability',
        name: 'Composite rotor',
        type: 'product',
        reviewStatus: 'approved',
        version: 1,
        provenance: [{ origin: 'person' }],
        documents: [],
      },
    ];
    h.rows.cases = [
      {
        id: 'supplier',
        capabilityId: 'capability',
        payload: {
          field: 'suppliers',
          facilityId: 'facility',
          text: 'Supplier Alpha provides resin.',
        },
        evidence: [
          { url: 'https://example.com/report', excerpt: 'Supplier Alpha provides resin.' },
        ],
        version: 1,
      },
      {
        id: 'employment',
        capabilityId: null,
        payload: {
          field: 'jobs',
          facilityId: 'facility',
          text: 'Facility employment',
          value: 35,
          unit: 'employees',
        },
        evidence: [
          { url: 'https://example.com/report', excerpt: 'This facility has 35 employees.' },
        ],
        version: 1,
      },
    ];
    const before = await h.load();
    expect(
      before.clientFacts.filter((f) => ['supplier', 'threshold'].includes(f.kind)),
    ).toHaveLength(2);
    h.rows.facilities = [];
    const after = await h.load();
    expect(after.clientFacts.some((f) => ['supplier', 'threshold'].includes(f.kind))).toBe(false);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('has a stable input fingerprint and invalidates it for profile, source, structure, and lifecycle changes', async () => {
    const h = harness();
    h.rows.facts = [
      fact({ id: 'one', fieldKey: 'description' }),
      fact({ id: 'two', fieldKey: 'productDescription', value: 'Composite rotor' }),
    ];
    const initial = await h.load();
    h.rows.facts.reverse();
    expect((await h.load()).fingerprint).toBe(initial.fingerprint);
    h.rows.facts[0]!.value = 'Composite wing';
    const profile = await h.load();
    expect(profile.fingerprint).not.toBe(initial.fingerprint);
    h.version.revisionHash = sha('new version');
    const source = await h.load();
    expect(source.fingerprint).not.toBe(profile.fingerprint);
    h.rows.lifecycle.status = 'passed';
    expect((await h.load()).fingerprint).not.toBe(source.fingerprint);
  });

  it('invalidates program and facility relationships without implying a contract award', async () => {
    const h = harness();
    h.rows.facilities = [{ id: 'factory', name: 'Factory', state: 'CA', sourceEvidence: [] }];
    h.rows.capabilities = [
      {
        id: 'rotor',
        name: 'Rotor',
        type: 'product',
        reviewStatus: 'approved',
        provenance: [],
        documents: [],
      },
    ];
    h.rows.terms = [
      {
        id: 'alignment',
        capabilityId: 'rotor',
        kind: 'program',
        value: 'Example rotor research',
        evidence: [{ sourceType: 'person', excerpt: 'Client approved program alignment.' }],
      },
    ];
    h.rows.links = [{ id: 'link', capabilityId: 'rotor', facilityId: 'factory' }];
    const before = await h.load();
    expect(before.clientFacts.find((f) => f.id === 'alignment:alignment')?.label).toContain(
      'not proof of a contract',
    );
    expect(before.clientFacts.some((f) => f.id === 'facility-capability:link')).toBe(true);
    h.rows.terms[0]!.value = 'Different approved alignment';
    const afterAlignment = await h.load();
    expect(afterAlignment.fingerprint).not.toBe(before.fingerprint);
    h.rows.links = [];
    expect((await h.load()).fingerprint).not.toBe(afterAlignment.fingerprint);
    h.rows.capabilities = [];
    expect((await h.load()).clientFacts.some((f) => f.id === 'alignment:alignment')).toBe(false);
  });

  it('keeps missing supplier and threshold context explicit rather than inferring it from the client name', async () => {
    const result = await harness().load();
    expect(result.clientFacts.every((f) => f.kind === 'profile')).toBe(true);
    expect(result.coverageNotes).toContain(
      'No current authorized client evidence establishes supplier relationships.',
    );
    expect(result.coverageNotes).toContain(
      'No current authorized client evidence establishes eligibility thresholds.',
    );
    expect(result.clientFacts[0]?.label).toContain('client-reported; no retained source evidence');
  });

  it('reuses client and bill reads only within one authorized page transaction', async () => {
    const h = harness(),
      service = new ImpactEvidenceService();
    const pairs = Array.from({ length: 5 }, () => ({ clientId, billId: 'ca-2026-ab123' }));
    const snapshots = await service.loadMany(h.tx as never, ctx, pairs);
    expect(snapshots).toHaveLength(5);
    expect(new Set(snapshots.map((s) => s.fingerprint)).size).toBe(1);
    expect(h.tx.client.findFirst).toHaveBeenCalledTimes(1);
    expect(
      h.tx.$queryRawUnsafe.mock.calls.filter(([sql]) => sql === IMPACT_CURRENT_STATE_SQL),
    ).toHaveLength(1);
    await service.loadMany(h.tx as never, ctx, pairs);
    expect(h.tx.client.findFirst).toHaveBeenCalledTimes(2);
  });

  it('keeps an unavailable tracked bill visible without failing the whole page', async () => {
    const h = harness();
    h.rows.missingBill = true;
    const result = await h.load();
    expect(result.billStatus).toBeNull();
    expect(result.versions).toEqual([]);
    expect(result.provisions).toEqual([]);
    expect(result.coverageNotes).toContain('Bill metadata is no longer available.');
  });
});
