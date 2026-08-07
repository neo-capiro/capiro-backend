import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CROSSWALK_STATES,
  PARITY_AGREEMENTS,
  PARITY_FIELDS,
  compareParity,
  normalizeSolicitationNumber,
  resolveCrosswalk,
  toOpportunitySnapshot,
  type SamCandidate,
  type SamParitySource,
} from './tango-opportunity.mapper.js';
import type { TangoOpportunity } from './tango.types.js';

/**
 * The crosswalk and the parity ledger (P27).
 *
 * Two questions kept apart on purpose: IDENTITY (is this the same record) and
 * CONTENT (do the two catalogs agree about it). Every test below belongs to
 * exactly one of them, and the identity tests come first because comparing
 * fields across two records that might not be the same record produces
 * confident-looking nonsense.
 */

function opportunity(over: Partial<TangoOpportunity> = {}): TangoOpportunity {
  return {
    provenance: {
      provider: 'tango',
      resourceType: 'opportunity',
      externalId: 'TO-1',
      fetchedAt: '2026-08-07T00:00:00.000Z',
      providerUpdatedAt: '2026-08-06T00:00:00.000Z',
    },
    opportunityId: 'TO-1',
    solicitationNumber: 'W911QY-26-R-0012',
    title: 'Turbofan Engine Sustainment',
    firstNoticeDate: '2026-06-01',
    lastNoticeDate: '2026-07-15',
    responseDeadline: '2026-09-01T17:00:00.000Z',
    active: true,
    setAside: 'Total Small Business Set-Aside (FAR 19.5)',
    naicsCode: '336412',
    pscCode: '2840',
    sourceUrl: 'https://sam.gov/opp/abc/view',
    agency: 'DEPT OF THE ARMY',
    officeCode: 'W911QY',
    officeName: 'ACC-APG Natick',
    ...over,
  };
}

function samSource(over: Partial<SamParitySource> = {}): SamParitySource {
  return {
    title: 'Turbofan Engine Sustainment',
    solicitationNumber: 'W911QY-26-R-0012',
    responseDeadline: new Date('2026-09-01T17:00:00.000Z'),
    active: true,
    setAside: 'Total Small Business Set-Aside (FAR 19.5)',
    naicsCode: '336412',
    pscCode: '2840',
    agency: 'DEPT OF THE ARMY',
    ...over,
  };
}

function candidate(over: Partial<SamCandidate> = {}): SamCandidate {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    noticeId: 'NOTICE-1',
    solicitationNumber: 'W911QY-26-R-0012',
    ...over,
  };
}

// ── Solicitation-number normalization ────────────────────────────────────────

describe('a solicitation number is normalized, never fuzzy-matched', () => {
  test('punctuation and case are stripped, because agencies punctuate their own numbers inconsistently', () => {
    expect(normalizeSolicitationNumber('W911QY-26-R-0012')).toBe('W911QY26R0012');
    expect(normalizeSolicitationNumber('w911qy 26 r 0012')).toBe('W911QY26R0012');
    expect(normalizeSolicitationNumber(' W911QY26R0012 ')).toBe('W911QY26R0012');
  });

  test('no character is ADDED, REMOVED or TRANSPOSED — two different numbers cannot collide', () => {
    // The distinction from fuzzy matching: normalization is idempotent and
    // injective over the alphanumerics. A digit that differs still differs.
    expect(normalizeSolicitationNumber('W911QY-26-R-0012')).not.toBe(
      normalizeSolicitationNumber('W911QY-26-R-0013'),
    );
    expect(normalizeSolicitationNumber('SPE7M1-26-R-0001')).not.toBe(
      normalizeSolicitationNumber('SPE7MI-26-R-0001'),
    );
  });

  test('null and empty normalize to the empty string, which never matches', () => {
    expect(normalizeSolicitationNumber(null)).toBe('');
    expect(normalizeSolicitationNumber('')).toBe('');
    expect(normalizeSolicitationNumber('---')).toBe('');
  });
});

// ── Identity ─────────────────────────────────────────────────────────────────

describe('identity is an exact identifier or nothing', () => {
  test('exactly one candidate links, with the local id', () => {
    const result = resolveCrosswalk(opportunity(), [candidate()]);
    expect(result.state).toBe('linked');
    expect(result.samOpportunityId).toBe('11111111-1111-1111-1111-111111111111');
    expect(result.candidateCount).toBe(1);
  });

  test('a differently-punctuated local number still links — same identifier', () => {
    const result = resolveCrosswalk(opportunity({ solicitationNumber: 'W911QY26R0012' }), [
      candidate({ solicitationNumber: 'W911QY-26-R-0012' }),
    ]);
    expect(result.state).toBe('linked');
  });

  test('MORE THAN ONE candidate is ambiguous, and links NOTHING', () => {
    // A presolicitation, a solicitation and its amendments are separate
    // sam_opportunity rows under one solicitation number. Picking whichever
    // sorted first is how a closed presolicitation acquires a live deadline.
    const result = resolveCrosswalk(opportunity(), [
      candidate({ id: 'a', noticeId: 'NOTICE-PRESOL' }),
      candidate({ id: 'b', noticeId: 'NOTICE-SOL' }),
    ]);
    expect(result.state).toBe('ambiguous');
    expect(result.samOpportunityId).toBeNull();
    expect(result.candidateCount).toBe(2);
  });

  test('the ambiguous reason explains WHY nothing was picked, and suggests no pick', () => {
    const result = resolveCrosswalk(opportunity(), [
      candidate({ id: 'a' }),
      candidate({ id: 'b' }),
    ]);
    expect(result.reason).toMatch(/2 SAM\.gov notices share solicitation number/);
    expect(result.reason).toMatch(/No link is recorded/);
    expect(result.reason).not.toMatch(/most recent|latest|newest|pick/i);
  });

  test('no candidate is unlinked, with a reason naming the number', () => {
    const result = resolveCrosswalk(opportunity(), []);
    expect(result.state).toBe('unlinked');
    expect(result.reason).toContain('W911QY-26-R-0012');
  });

  test('a provider record with no solicitation number is unlinked, and no query is implied', () => {
    const result = resolveCrosswalk(opportunity({ solicitationNumber: null }), [candidate()]);
    expect(result.state).toBe('unlinked');
    expect(result.candidateCount).toBe(0);
    expect(result.reason).toMatch(/states no solicitation number/);
  });

  test('a candidate whose number does NOT normalize to the provider’s is filtered out', () => {
    // Defensive: the caller queries by the normalized number, but a caller that
    // passed a wider set must not have it silently accepted.
    const result = resolveCrosswalk(opportunity(), [
      candidate({ id: 'wrong', solicitationNumber: 'W911QY-26-R-9999' }),
    ]);
    expect(result.state).toBe('unlinked');
  });

  test('a title match is NOT an identity match — there is no such fallback', () => {
    // The same rule P02 settled for award history: an identifier or nothing.
    const result = resolveCrosswalk(opportunity({ solicitationNumber: null }), [
      candidate({ solicitationNumber: null }),
    ]);
    expect(result.state).toBe('unlinked');
  });

  test('the three states are exactly the vocabulary the ledger and the diagnostic share', () => {
    expect([...CROSSWALK_STATES]).toEqual(['linked', 'ambiguous', 'unlinked']);
  });
});

// ── Parity ───────────────────────────────────────────────────────────────────

describe('parity compares only what both catalogs carry, and reports five outcomes', () => {
  test('two identical records agree on every field', () => {
    const rows = compareParity(samSource(), opportunity());
    expect(rows).toHaveLength(PARITY_FIELDS.length);
    expect(rows.every((r) => r.agreement === 'agree')).toBe(true);
  });

  test('a genuine deadline disagreement is a CONFLICT, with both values kept', () => {
    const rows = compareParity(
      samSource({ responseDeadline: new Date('2026-09-01T17:00:00.000Z') }),
      opportunity({ responseDeadline: '2026-09-15T17:00:00.000Z' }),
    );
    const deadline = rows.find((r) => r.field === 'response_deadline')!;
    expect(deadline.agreement).toBe('conflict');
    expect(deadline.localValue).toBe('2026-09-01T17:00:00.000Z');
    expect(deadline.providerValue).toBe('2026-09-15T17:00:00.000Z');
  });

  test('a SECONDS-level deadline difference is NOT a conflict', () => {
    // The two catalogs round the same SAM.gov value differently at the seconds
    // place. A seconds-level disagreement about a deadline weeks away is a
    // rounding artefact, and treating it as a finding would fill the ledger
    // with false conflicts that bury the real ones.
    const rows = compareParity(
      samSource({ responseDeadline: new Date('2026-09-01T17:00:59.000Z') }),
      opportunity({ responseDeadline: '2026-09-01T17:00:00.000Z' }),
    );
    expect(rows.find((r) => r.field === 'response_deadline')!.agreement).toBe('agree');
  });

  test('a MINUTE-level deadline difference IS still a conflict', () => {
    const rows = compareParity(
      samSource({ responseDeadline: new Date('2026-09-01T17:01:00.000Z') }),
      opportunity({ responseDeadline: '2026-09-01T17:00:00.000Z' }),
    );
    expect(rows.find((r) => r.field === 'response_deadline')!.agreement).toBe('conflict');
  });

  test('re-cased or re-spaced text is not a conflict', () => {
    const rows = compareParity(
      samSource({ title: 'Turbofan  Engine   Sustainment' }),
      opportunity({ title: 'TURBOFAN ENGINE SUSTAINMENT' }),
    );
    expect(rows.find((r) => r.field === 'title')!.agreement).toBe('agree');
  });

  test('a differently-punctuated NAICS or PSC is not a conflict', () => {
    const rows = compareParity(
      samSource({ naicsCode: '336412', pscCode: '2840' }),
      opportunity({ naicsCode: ' 336-412 ', pscCode: '28 40' }),
    );
    expect(rows.find((r) => r.field === 'naics_code')!.agreement).toBe('agree');
    expect(rows.find((r) => r.field === 'psc_code')!.agreement).toBe('agree');
  });

  test('a genuinely different NAICS IS a conflict', () => {
    const rows = compareParity(samSource({ naicsCode: '336412' }), opportunity({ naicsCode: '336413' }));
    expect(rows.find((r) => r.field === 'naics_code')!.agreement).toBe('conflict');
  });

  test('one side silent is local_only or provider_only, NOT a conflict', () => {
    // "SAM states a deadline and Tango does not" is a coverage fact about the
    // provider. "They state DIFFERENT deadlines" is a data-quality finding.
    // Only the second is worth somebody's attention.
    const localOnly = compareParity(samSource({ setAside: 'SBA' }), opportunity({ setAside: null }));
    expect(localOnly.find((r) => r.field === 'set_aside')!.agreement).toBe('local_only');

    const providerOnly = compareParity(
      samSource({ setAside: null }),
      opportunity({ setAside: 'SBA' }),
    );
    expect(providerOnly.find((r) => r.field === 'set_aside')!.agreement).toBe('provider_only');
  });

  test('both silent is both_absent, and it is still RECORDED', () => {
    // A ledger that only stored disagreements could not answer "has this been
    // checked", and "checked, both silent" is exactly the coverage fact the
    // parity diagnostic reports on.
    const rows = compareParity(samSource({ pscCode: null }), opportunity({ pscCode: null }));
    const psc = rows.find((r) => r.field === 'psc_code')!;
    expect(psc.agreement).toBe('both_absent');
    expect(psc.localValue).toBeNull();
    expect(psc.providerValue).toBeNull();
  });

  test('a whitespace-only value is treated as absent, not as a value that disagrees', () => {
    const rows = compareParity(samSource({ agency: '   ' }), opportunity({ agency: null }));
    expect(rows.find((r) => r.field === 'agency')!.agreement).toBe('both_absent');
  });

  test('an active/inactive disagreement is a conflict, and false is never read as absent', () => {
    const rows = compareParity(samSource({ active: true }), opportunity({ active: false }));
    const active = rows.find((r) => r.field === 'active')!;
    expect(active.agreement).toBe('conflict');
    expect(active.localValue).toBe('true');
    expect(active.providerValue).toBe('false');
  });

  test('an unparseable provider deadline is absent, not an epoch date', () => {
    const rows = compareParity(samSource(), opportunity({ responseDeadline: 'not-a-date' }));
    const deadline = rows.find((r) => r.field === 'response_deadline')!;
    expect(deadline.providerValue).toBeNull();
    expect(deadline.agreement).toBe('local_only');
  });

  test('every field in the vocabulary produces exactly one row, in the declared order', () => {
    const rows = compareParity(samSource(), opportunity());
    expect(rows.map((r) => r.field)).toEqual([...PARITY_FIELDS]);
  });

  test('every agreement value produced is in the declared vocabulary', () => {
    const rows = compareParity(
      samSource({ title: null, setAside: 'A', naicsCode: '1' }),
      opportunity({ title: 'x', setAside: null, naicsCode: '2' }),
    );
    for (const row of rows) {
      expect(PARITY_AGREEMENTS as readonly string[]).toContain(row.agreement);
    }
  });
});

// ── The snapshot ─────────────────────────────────────────────────────────────

describe('the snapshot stores the normalized domain object, not the wire payload', () => {
  test('every domain field survives', () => {
    const snapshot = toOpportunitySnapshot(opportunity());
    expect(snapshot).toMatchObject({
      opportunityId: 'TO-1',
      solicitationNumber: 'W911QY-26-R-0012',
      responseDeadline: '2026-09-01T17:00:00.000Z',
      agency: 'DEPT OF THE ARMY',
    });
  });

  test('provenance is DROPPED — the snapshot table stores it as columns', () => {
    // Duplicating fetched-at/provider-updated-at inside the JSON is how the
    // column and the payload come to disagree.
    expect(toOpportunitySnapshot(opportunity())).not.toHaveProperty('provenance');
  });
});

// ── The migration and the code agree ─────────────────────────────────────────

describe('the field vocabulary is the same in TypeScript and in SQL', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      'prisma',
      'migrations',
      '20260826010000_tango_opportunity_crosswalk',
      'migration.sql',
    ),
    'utf8',
  );

  test('every PARITY_FIELDS entry is admitted by the CHECK constraint', () => {
    const chk = sql.match(/tango_opportunity_parity_field_chk[\s\S]*?\);/)?.[0] ?? '';
    expect(chk).not.toBe('');
    for (const field of PARITY_FIELDS) {
      expect(chk).toContain(`'${field}'`);
    }
  });

  test('every PARITY_AGREEMENTS entry is admitted by the CHECK constraint', () => {
    const chk = sql.match(/tango_opportunity_parity_agreement_chk[\s\S]*?\);/)?.[0] ?? '';
    expect(chk).not.toBe('');
    for (const agreement of PARITY_AGREEMENTS) {
      expect(chk).toContain(`'${agreement}'`);
    }
  });

  test('the table carries NO tenant_id and claims no RLS', () => {
    // Same category as tango_resource_snapshot and sam_opportunity: a fact
    // about the federal marketplace, not about any one tenant. A false RLS
    // claim would be as wrong here as a missing one is on a tenant table.
    const create = sql.match(/CREATE TABLE IF NOT EXISTS "tango_opportunity_parity"[\s\S]*?\);/)?.[0] ?? '';
    expect(create).not.toBe('');
    expect(create).not.toMatch(/tenant_id/);
    expect(sql).not.toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/CREATE POLICY/);
  });

  test('there is no foreign key to sam_opportunity — the ledger must outlive either catalog', () => {
    expect(sql).not.toMatch(/REFERENCES\s+"?sam_opportunity"?/i);
  });

  test('the reviewed-resolution CHECK is a three-way all-or-nothing', () => {
    const chk = sql.match(/tango_opportunity_parity_review_actor_chk[\s\S]*?END \$\$;/)?.[0] ?? '';
    expect(chk).toMatch(/'unreviewed' AND "reviewed_by" IS NULL AND "reviewed_at" IS NULL/);
    expect(chk).toMatch(/<> 'unreviewed' AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL/);
  });

  test('the record/field uniqueness that makes a re-run an update, not a second opinion', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "tango_opportunity_parity_record_field_uniq"/);
  });

  test('every statement is retry-safe', () => {
    // A failed migration blocks every later one, so a half-applied run has to
    // be re-appliable. Same discipline as every other migration in this program.
    const creates = sql.match(/CREATE (TABLE|UNIQUE INDEX|INDEX)(?! IF NOT EXISTS)/g) ?? [];
    expect(creates).toEqual([]);
    for (const guard of ['field_chk', 'agreement_chk', 'resolution_chk', 'review_actor_chk']) {
      expect(sql).toContain(`WHERE conname = 'tango_opportunity_parity_${guard}'`);
    }
  });
});
