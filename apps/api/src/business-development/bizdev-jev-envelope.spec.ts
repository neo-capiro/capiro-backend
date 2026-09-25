import type { EvidenceItem } from './bizdev-evidence.types.js';
import {
  bdJevIdempotencyKey,
  bdSourceHashesForTask,
  buildBdEvidenceEnvelope,
  buildBdSignalQuestionFromCards,
  canonicalCandidateEvidenceItem,
  candidateInventoryHash,
  neutralCanonicalDescription,
  stagedSignals,
} from './bizdev-jev-envelope.js';
import { buildBdEntityProspectQuestion } from './bizdev-jev-envelope-entity.js';

/**
 * Strict BD-ENTITY / BD-SIGNAL envelope privacy, source binding, staged-source
 * semantics and version/source/candidate hash invalidation. Pure construction —
 * no provider, no database.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const PROSPECT = '22222222-2222-2222-2222-222222222222';

const signal = (over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  sourceFamily: 'usaspending_contract',
  recordId: 'AWARD_1',
  locator: 'https://usaspending.gov/award/1',
  originalSourceName: 'USAspending',
  originalSourceId: 'AWARD_1',
  claimType: 'government_exposure',
  relationshipStrength: 'direct',
  eventDate: '2026-06-15',
  effectiveDate: null,
  fiscalYear: 2026,
  stage: 'awarded',
  sourceUpdatedAt: '2026-06-20T00:00:00Z',
  fetchedAt: '2026-06-21T00:00:00Z',
  scopeChecked: 'award',
  status: 'available',
  title: 'Contract award to Acme',
  detail: {},
  ...over,
});

const candidate = {
  canonicalEntityId: '33333333-3333-3333-3333-333333333333',
  canonicalName: 'Acme Aerospace',
  identityScope: 'global_public',
  identifiers: [
    { type: 'uei', value: 'ABCDE123456F' },
    { type: 'cage', value: '1AB2C' },
    { type: 'duns', value: '999999999' },
  ],
};

// ── staged sources ──────────────────────────────────────────────────────────

describe('stagedSignals (no manufactured financial stage)', () => {
  test('keeps only explicitly allowed stages; never defaults a missing stage', () => {
    const items = [
      signal({ recordId: 'A', stage: 'awarded' }),
      signal({ recordId: 'B', stage: null }),
      signal({ recordId: 'C', stage: 'rumored' as EvidenceItem['stage'] }), // not an allowed stage
      signal({ recordId: 'D', stage: 'requested' }),
      signal({ recordId: 'E', stage: undefined as unknown as null }),
    ];
    expect(stagedSignals(items).map((i) => i.recordId)).toEqual(['A', 'D']);
  });
});

// ── envelope privacy + source binding ───────────────────────────────────────

describe('buildBdEvidenceEnvelope (privacy + source binding)', () => {
  test('bd_signal: only staged sources are bound; passage is the public title', () => {
    const envelope = buildBdEvidenceEnvelope({
      task: 'bd_signal',
      tenantId: TENANT,
      prospectId: PROSPECT,
      canonicalEntityId: null,
      evidence: [signal({ recordId: 'A' }), signal({ recordId: 'B', stage: null })],
    });
    expect(envelope).not.toBeNull();
    expect(envelope!.sources).toHaveLength(1);
    expect(envelope!.sources[0]!.sourceId).toBe('A');
    expect(envelope!.sources[0]!.passage).toBe('Contract award to Acme');
    expect(envelope!.sources[0]!.financialStage).toBe('awarded');
    expect(envelope!.sources[0]!.locator).toContain('usaspending.gov/award/1');
    expect(envelope!.tenantId).toBe(TENANT);
  });

  test('bd_signal with NO staged source → null (caller must record source_unavailable)', () => {
    const envelope = buildBdEvidenceEnvelope({
      task: 'bd_signal',
      tenantId: TENANT,
      prospectId: PROSPECT,
      canonicalEntityId: null,
      evidence: [signal({ stage: null })],
    });
    expect(envelope).toBeNull();
  });

  test('envelope text contains no private prospect content (privacy scan)', () => {
    const envelope = buildBdEvidenceEnvelope({
      task: 'bd_signal',
      tenantId: TENANT,
      prospectId: PROSPECT,
      canonicalEntityId: null,
      evidence: [signal()],
    });
    const json = JSON.stringify(envelope);
    for (const banned of [
      'serviceHypothesis', 'description', 'preferences', 'notes',
      'conflictReason', 'contact', 'people@', 'phone', 'email@',
    ]) {
      expect(json).not.toContain(banned);
    }
    expect(json).not.toContain(PROSPECT); // ids appear only via claimId? — no private ids in sources
    expect(json).toContain(TENANT); // tenant binding is explicit
  });

  test('duplicate evidence ids are collapsed (provider rejects repeats)', () => {
    const envelope = buildBdEvidenceEnvelope({
      task: 'bd_signal',
      tenantId: TENANT,
      prospectId: null,
      canonicalEntityId: null,
      evidence: [signal(), signal()],
    });
    expect(envelope!.sources).toHaveLength(1);
  });

  test('bd_entity accepts canonical identity evidence whose financialStage is null', () => {
    const identity = canonicalCandidateEvidenceItem(candidate);
    expect(identity.stage).toBeNull();
    expect(identity.sourceFamily).toBe('capiro_canonical_identity');
    expect(identity.locator).toBe(`canonical_entity_id=${candidate.canonicalEntityId}`);
    const envelope = buildBdEvidenceEnvelope({
      task: 'bd_entity',
      tenantId: TENANT,
      prospectId: PROSPECT,
      canonicalEntityId: candidate.canonicalEntityId,
      evidence: [identity],
    });
    expect(envelope).not.toBeNull();
    expect(envelope!.sources[0]!.financialStage).toBeNull();
    expect(envelope!.sources[0]!.relationScope).toBe('pe_specific');
  });

  test('neutralCanonicalDescription derives ONLY from the canonical name', () => {
    const d = neutralCanonicalDescription('Acme Aerospace');
    expect(d).toContain('Acme Aerospace');
    expect(d).toContain('canonical organization registry');
    // Contains no other tenant-supplied text by construction.
    expect(d.split('“').length - 1).toBe(1);
  });
});

// ── question pairs ──────────────────────────────────────────────────────────

describe('buildBdSignalQuestionFromCards', () => {
  test('company description is the neutral canonical one; record types map correctly', () => {
    const built = buildBdSignalQuestionFromCards({
      tenantId: TENANT,
      prospectId: null,
      canonicalEntityId: null,
      companyName: 'Acme Aerospace',
      signals: [
        signal({ recordId: 'A', stage: 'awarded' }),
        signal({ recordId: 'S', sourceFamily: 'sam_opportunity', stage: 'requested' }),
      ],
    });
    expect(built).not.toBeNull();
    const q = JSON.stringify(built!.question);
    expect(q).toContain('Acme Aerospace');
    expect(q).toContain('canonical organization registry');
  });

  test('no staged signals → null', () => {
    expect(
      buildBdSignalQuestionFromCards({
        tenantId: TENANT,
        prospectId: PROSPECT,
        canonicalEntityId: null,
        companyName: 'Acme',
        signals: [signal({ stage: 'unknown-stage' as unknown as EvidenceItem['stage'] })],
      }),
    ).toBeNull();
  });
});

describe('buildBdEntityProspectQuestion (prospect display name only)', () => {
  test('question carries the display name and bounded candidate, no private text', () => {
    const built = buildBdEntityProspectQuestion({
      tenantId: TENANT,
      prospectId: PROSPECT,
      prospectDisplayName: 'Acme Aero',
      candidate,
      evidence: [canonicalCandidateEvidenceItem(candidate)],
    });
    expect(built).not.toBeNull();
    const q = JSON.stringify(built!.question);
    expect(q).toContain('Acme Aero');
    expect(q).toContain('Acme Aerospace');
    // UEI/CAGE identifiers bounded to the allowed kinds only (no duns).
    expect(q).toContain('ABCDE123456F');
    expect(q).toContain('1AB2C');
    expect(q).not.toContain('999999999');
    for (const banned of ['serviceHypothesis', 'preferences', 'notes', 'conflictReason', 'contact']) {
      expect(q).not.toContain(banned);
    }
  });

  test('missing candidate evidence → null (source_unavailable)', () => {
    expect(
      buildBdEntityProspectQuestion({
        tenantId: TENANT,
        prospectId: PROSPECT,
        prospectDisplayName: 'Acme Aero',
        candidate,
        evidence: [],
      }),
    ).toBeNull();
  });
});

// ── hashes and idempotency keys ─────────────────────────────────────────────

describe('source/candidate/version hash invalidation', () => {
  const base = {
    tenantId: TENANT,
    task: 'bd_signal' as const,
    mode: 'shadow' as const,
    questionVersion: 'q1',
    modelVersion: 'm1',
    registryVersion: 'r1',
    envelopeHash: 'sha256:abc',
    sourceHashes: ['sha256:s1'],
    candidateInventoryHash: null,
  };

  test('idempotency key changes with question/model/registry version', () => {
    const k0 = bdJevIdempotencyKey(base);
    expect(bdJevIdempotencyKey({ ...base, questionVersion: 'q2' })).not.toBe(k0);
    expect(bdJevIdempotencyKey({ ...base, modelVersion: 'm2' })).not.toBe(k0);
    expect(bdJevIdempotencyKey({ ...base, registryVersion: 'r2' })).not.toBe(k0);
    expect(bdJevIdempotencyKey({ ...base, envelopeHash: 'sha256:zzz' })).not.toBe(k0);
    expect(bdJevIdempotencyKey({ ...base, candidateInventoryHash: 'sha256:c1' })).not.toBe(k0);
    expect(bdJevIdempotencyKey({ ...base, tenantId: '44444444-4444-4444-4444-444444444444' })).not.toBe(k0);
    // Stable for identical inputs.
    expect(bdJevIdempotencyKey(base)).toBe(k0);
  });

  test('idempotency key hashes are order-insensitive over sources', () => {
    expect(
      bdJevIdempotencyKey({ ...base, sourceHashes: ['sha256:a', 'sha256:b'] }),
    ).toBe(bdJevIdempotencyKey({ ...base, sourceHashes: ['sha256:b', 'sha256:a'] }));
  });

  test('bdSourceHashesForTask is source-REVISION-sensitive', () => {
    const h0 = bdSourceHashesForTask('bd_signal', [signal()]);
    expect(bdSourceHashesForTask('bd_signal', [signal({ sourceUpdatedAt: '2026-07-01T00:00:00Z' })])).not.toEqual(h0);
    expect(bdSourceHashesForTask('bd_signal', [signal({ fetchedAt: '2026-07-02T00:00:00Z' })])).not.toEqual(h0);
    expect(bdSourceHashesForTask('bd_signal', [signal({ eventDate: '2025-01-01' })])).not.toEqual(h0);
    expect(bdSourceHashesForTask('bd_signal', [signal({ stage: 'obligated' })])).not.toEqual(h0);
    expect(bdSourceHashesForTask('bd_signal', [signal({ locator: 'https://x/other' })])).not.toEqual(h0);
    expect(bdSourceHashesForTask('bd_signal', [signal({ title: 'Revised title' })])).not.toEqual(h0);
    expect(bdSourceHashesForTask('bd_signal', [signal()])).toEqual(h0);
    // Hashes stay redacted: hex digests only, never source text.
    for (const h of h0) expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('bdSourceHashesForTask filters unstaged signals for bd_signal but keeps entity evidence', () => {
    const unstaged = signal({ stage: null });
    expect(bdSourceHashesForTask('bd_signal', [unstaged])).toHaveLength(0);
    expect(bdSourceHashesForTask('bd_entity', [unstaged])).toHaveLength(1);
  });

  test('candidateInventoryHash changes when the candidate set changes (order-sensitive)', () => {
    const a = candidateInventoryHash([candidate]);
    const b = candidateInventoryHash([{ ...candidate, canonicalName: 'Renamed' }]);
    const c = candidateInventoryHash([{ ...candidate, canonicalEntityId: '55555555-5555-5555-5555-555555555555' }]);
    expect(a).not.toBe(b); // name is part of the candidate projection
    expect(a).not.toBe(c);
    expect(candidateInventoryHash([candidate])).toBe(a);
    // Redacted hash form.
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});