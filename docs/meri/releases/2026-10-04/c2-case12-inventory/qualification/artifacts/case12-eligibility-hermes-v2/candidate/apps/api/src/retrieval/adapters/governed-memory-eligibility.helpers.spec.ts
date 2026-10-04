import { includeCanonicalGovernedMemoryRow, canonicalMemoryEligibilitySql, type CanonicalGovernedMemoryRow } from './governed-memory-eligibility.helpers.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-10-04T12:00:00.000Z');

function validRow(overrides: Partial<CanonicalGovernedMemoryRow> = {}): CanonicalGovernedMemoryRow {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    tenantId,
    ownerUserId: userId,
    clientId,
    memoryClass: 'client_steering',
    authority: 'client_approved',
    scope: 'client',
    status: 'active',
    legacyStatus: 'active',
    visibility: 'tenant',
    conflictStatus: 'none',
    sensitivity: 'normal',
    sourceType: 'client_record',
    sourceId: 'source-1',
    approvedByUserId: userId,
    approvedAt: now,
    ...overrides,
  };
}

const access = { tenantId, userId, allowedClientIds: [clientId] };

describe('canonical governed-memory eligibility SQL', () => {
  it('contains the source tenant, visibility, status, class, scope, governance, provenance, sensitivity, temporal, client, and lifecycle clauses', () => {
    const sql = canonicalMemoryEligibilitySql({ tenantId, userId, allowedClientIds: [] });
    expect(sql.text).toContain('mi.tenant_id = $1::uuid');
    for (const clause of [
      "(mi.visibility = 'tenant' OR mi.owner_user_id = $2::uuid)",
      "mi.status = 'active'",
      "mi.memory_class IN ('institutional_authoritative', 'client_steering', 'user_preference', 'episodic_working')",
      "mi.memory_scope <> 'user_private' OR mi.owner_user_id = $2::uuid",
      "mi.memory_scope <> 'client' OR mi.client_id = ANY(",
      "mi.memory_class NOT IN ('institutional_authoritative', 'client_steering')",
      'mi.approved_by_user_id IS NOT NULL',
      "mi.source_type <> 'unknown'",
      "mi.memory_class <> 'episodic_working'",
      "COALESCE(mi.sensitivity, 'normal') = 'normal'",
      'mi.expires_at > now()',
      'mi.valid_until > now()',
      'mi.effective_from <= now()',
      'mi.client_id IS NULL OR mi.client_id = ANY(',
      "mi.governed_status IN ('active', 'stale')",
      "mi.governed_status = 'conflicted'",
    ]) expect(sql.text).toContain(clause);
    expect(sql.text).not.toContain('WHERE');
    expect(sql.values).toEqual([tenantId, userId, [], []]);
  });

  it('adds an exact item selector only when present and parameterizes its value', () => {
    const absent = canonicalMemoryEligibilitySql({ tenantId, userId, allowedClientIds: [] });
    const selected = canonicalMemoryEligibilitySql({ tenantId, userId, allowedClientIds: [], memoryItemId: "x' OR TRUE --" });
    expect(absent.text).not.toContain('mi.id =');
    expect(selected.text).toContain('mi.id = $3::uuid');
    expect(selected.values).toEqual([tenantId, userId, "x' OR TRUE --", [], []]);
    expect(selected.text).not.toContain("x' OR TRUE --");
  });

  it('keeps empty allowed-client arrays as bound parameters', () => {
    const sql = canonicalMemoryEligibilitySql({ tenantId, userId, allowedClientIds: [] });
    expect(sql.values.filter((value) => Array.isArray(value))).toEqual([[], []]);
    expect(sql.text).toContain('ANY($3::uuid[])');
  });
});

describe('includeCanonicalGovernedMemoryRow', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts an approved, current client-steering record through the real governance filter', () => {
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    expect(includeCanonicalGovernedMemoryRow(validRow(), access)).toBe(true);
  });

  it.each([
    ['foreign tenant', { tenantId: '99999999-9999-4999-8999-999999999999' }],
    ['foreign user-private owner', { memoryClass: 'user_preference' as const, authority: 'user_asserted' as const, scope: 'user_private' as const, ownerUserId: '99999999-9999-4999-8999-999999999999' }],
    ['wrong client', { clientId: '99999999-9999-4999-8999-999999999999' }],
    ['expired', { expiresAt: new Date('2026-10-04T11:59:59.000Z') }],
    ['future effective time', { effectiveFrom: new Date('2026-10-04T12:00:01.000Z') }],
    ['revoked', { status: 'revoked' as const }],
    ['stale legacy status', { legacyStatus: 'stale' }],
    ['unknown class', { memoryClass: 'legacy_unclassified' as const }],
    ['visibility denied', { visibility: 'private', ownerUserId: '99999999-9999-4999-8999-999999999999' }],
    ['missing approval', { approvedByUserId: null, approvedAt: null }],
    ['denied sensitivity', { sensitivity: 'restricted' as const }],
    ['missing unknown provenance', { sourceType: 'unknown' as const, sourceId: null, sourceRef: null }],
  ])('rejects %s using existing filter contracts', (_label, overrides) => {
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    expect(includeCanonicalGovernedMemoryRow(validRow(overrides), access)).toBe(false);
  });

  it('rejects client steering when its source client is outside the allowed set', () => {
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    expect(includeCanonicalGovernedMemoryRow(validRow(), { ...access, allowedClientIds: [] })).toBe(false);
  });
});

