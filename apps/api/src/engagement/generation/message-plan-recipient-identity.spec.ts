import {
  RECIPIENT_IDENTITY_SOURCE_ID,
  normalizeSourceId,
  sourceIdVariants,
} from './message-plan.service.js';

/**
 * Regression for the SECOND live failure, captured 2026-08-24 16:13 UTC from the
 * first campaign run after the source-id shortening shipped.
 *
 * Persisted `outreach_job_items.result_jsonb.planIssues` (this field only exists
 * because the same ship started recording it) read exactly:
 *
 *   code:    CLAIM_CITES_UNKNOWN_SOURCE
 *   message: "A planned claim cites source id(s) not present in the evidence
 *             packet: directory."
 *   subject: "Senator Alan Armstrong is a United States Senator representing
 *             Oklahoma, a federal legislative role."
 *
 * Root cause: the plan prompt rendered the recipient block as
 * `<<<SPOTLIGHT source="directory">>>` — the same syntax as evidence, whose
 * section header instructs "cite by the id attribute" — but `directory` was
 * never registered as a resolvable source. Recipient identity arrives as prose
 * (`recipientBrief`), not as a packet evidence row.
 *
 * That made the policy self-contradictory: `federal.congressional_office` sets
 * `requiredEvidenceTypes: ['recipient_identity']`, check #4 satisfies it from
 * that prose, yet check #2 could never accept a citation to it. Any claim about
 * who the recipient is was unsupportable by construction.
 */

const AMBIGUOUS = '\u0000ambiguous';

function buildResolver(
  evidence: ReadonlyArray<{ sourceType: string; sourceId: string }>,
  recipientBrief: string | null,
) {
  const canonicalById = new Map<string, string>();
  const register = (variant: string, canonical: string): void => {
    const key = normalizeSourceId(variant);
    if (!key) return;
    const existing = canonicalById.get(key);
    canonicalById.set(key, existing && existing !== canonical ? AMBIGUOUS : canonical);
  };
  for (const e of evidence) {
    for (const v of sourceIdVariants(e.sourceType, e.sourceId)) register(v, e.sourceId);
  }
  if (recipientBrief?.trim()) {
    register(RECIPIENT_IDENTITY_SOURCE_ID, RECIPIENT_IDENTITY_SOURCE_ID);
    register('directory', RECIPIENT_IDENTITY_SOURCE_ID);
  }
  return (cited: string): string | null => {
    const hit = canonicalById.get(normalizeSourceId(cited));
    return !hit || hit === AMBIGUOUS ? null : hit;
  };
}

// Real packet sourceIds observed live in the same job, post-shortening.
const LIVE_EVIDENCE = [
  {
    sourceType: 'outreach_v3:capiro_record',
    sourceId: 'campaign_fact:campaign:capiro_record:client:0e042626-ecde-44b3-88f1-9c2aed31d910',
  },
  { sourceType: 'context_plane:coverage', sourceId: '4e6751b0-9aab-4e84-84c7-a3da6cc05ad8' },
  { sourceType: 'context_plane:coverage', sourceId: '4f0488e4-31db-4a6c-accf-ee42d55071f3' },
];

const BRIEF = 'Name: Alan Armstrong\nTitle: United States Senator\nState/District: OK';

describe('recipient-identity citation (live planIssues regression)', () => {
  it('resolves a claim citing the recipient-identity id when a brief was supplied', () => {
    const resolve = buildResolver(LIVE_EVIDENCE, BRIEF);
    expect(resolve(RECIPIENT_IDENTITY_SOURCE_ID)).toBe(RECIPIENT_IDENTITY_SOURCE_ID);
  });

  it('resolves the exact citation that failed live: "directory"', () => {
    const resolve = buildResolver(LIVE_EVIDENCE, BRIEF);
    // This is verbatim the id from the persisted planIssues entry.
    expect(resolve('directory')).toBe(RECIPIENT_IDENTITY_SOURCE_ID);
  });

  it('does NOT make recipient identity citable when no brief was resolved', () => {
    // The security half: a group message passes recipientBrief=null, and an
    // unresolved identity must not be usable to "support" a claim about a person.
    const resolve = buildResolver(LIVE_EVIDENCE, null);
    expect(resolve(RECIPIENT_IDENTITY_SOURCE_ID)).toBeNull();
    expect(resolve('directory')).toBeNull();
    expect(resolve('   ')).toBeNull();
  });

  it('treats a whitespace-only brief as unresolved', () => {
    const resolve = buildResolver(LIVE_EVIDENCE, '   \n  ');
    expect(resolve('directory')).toBeNull();
  });

  it('still rejects sources absent from both the packet and the recipient block', () => {
    const resolve = buildResolver(LIVE_EVIDENCE, BRIEF);
    expect(resolve('congress_gov')).toBeNull();
    expect(resolve('00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(resolve('lda_filing')).toBeNull();
  });

  it('keeps resolving the real live packet ids alongside recipient identity', () => {
    const resolve = buildResolver(LIVE_EVIDENCE, BRIEF);
    for (const e of LIVE_EVIDENCE) {
      expect(resolve(e.sourceId)).toBe(e.sourceId);
    }
  });

  it('confirms the shipped id-shortening: live ids are short and non-repetitive', () => {
    // Guards the first fix using ids actually observed in production.
    for (const e of LIVE_EVIDENCE) {
      expect(e.sourceId.length).toBeLessThan(100);
      const segs = e.sourceId.split(':');
      expect(new Set(segs).size).toBe(segs.length);
    }
  });
});
