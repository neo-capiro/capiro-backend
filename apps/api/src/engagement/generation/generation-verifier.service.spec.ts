/**
 * Deterministic government-affairs claim verification (Phase 1 §3.i1, §5.3).
 *
 * Each check is paired with a NEGATIVE case, because a verifier that fires on
 * everything is as useless as one that fires on nothing — a hold on every draft
 * trains reviewers to click through holds.
 */
import { describe, expect, test } from '@jest/globals';
import {
  GenerationVerifierService,
  parseAmounts,
  truthAmounts,
  type VerifyRequest,
} from './generation-verifier.service.js';
import { policyForAudience } from './government-affairs-policy.registry.js';
import type { EvidenceItem, EvidencePacketV2 } from './evidence-packet.types.js';

const NOW = new Date('2026-07-26T00:00:00.000Z');
const svc = new GenerationVerifierService();

type EvidenceOverride = Omit<Partial<EvidenceItem>, 'ref'> & {
  ref?: Partial<EvidenceItem['ref']>;
};

function evidence(over: EvidenceOverride = {}): EvidenceItem {
  const { ref, ...rest } = over;
  return {
    ref: {
      sourceType: 'bill',
      sourceId: 'hr1234-119',
      title: 'HR 1234',
      trust: 'authoritative_structured',
      retrievedAt: NOW.toISOString(),
      authoritativeAsOf: '2026-07-20T00:00:00.000Z',
      ...(ref ?? {}),
    },
    evidenceText: 'HR 1234 was referred to Armed Services on 2026-06-01.',
    scope: 'all',
    ...rest,
  };
}

function packet(over: Partial<EvidencePacketV2> = {}): EvidencePacketV2 {
  return {
    packetId: 'p1',
    packetVersion: 2,
    tenantId: 't',
    userId: 'u',
    clientId: 'c',
    surface: 'outreach_email',
    ref: {},
    directives: [],
    evidence: [evidence()],
    standingMemory: [],
    standingMemoryExclusions: [],
    failures: [],
    policy: {
      jurisdiction: 'federal',
      audienceType: 'congressional_office',
      policyId: 'federal.congressional_office',
      version: 'ga-policy-v1',
    },
    modelPolicy: { provider: 'anthropic', model: 'm', promptSpecVersion: 'v2.2-gateway' },
    criticalFailureCount: 0,
    freshestSourceAt: null,
    stalestSourceAt: null,
    compiledAt: NOW.toISOString(),
    packetHash: 'h',
    emailScope: 'mine',
    ...over,
  };
}

function verify(body: string, over: Partial<VerifyRequest> = {}) {
  return svc.verify({
    subject: 'Meeting request',
    body,
    packet: packet(),
    policy: policyForAudience('congressional_office'),
    plan: null,
    audienceKind: 'individual',
    now: NOW,
    ...over,
  });
}

function checks(body: string, over: Partial<VerifyRequest> = {}): string[] {
  return verify(body, over).findings.map((f) => f.check);
}

// ── 1. Unresolved placeholders ──────────────────────────────────────────────

describe('unresolved_placeholder', () => {
  test('catches {token}, [NAME] and <token>', () => {
    expect(checks('Hi from {district}.')).toContain('unresolved_placeholder');
    expect(checks('Hi [NAME], thanks.')).toContain('unresolved_placeholder');
    expect(checks('Serving <district> well.')).toContain('unresolved_placeholder');
  });

  test('is blocking', () => {
    const v = verify('Hi from {district}.');
    expect(v.held).toBe(true);
    expect(v.status).toBe('held');
  });

  test('does NOT fire on a normal markdown link', () => {
    expect(checks('See [the summary](https://example.com).')).not.toContain(
      'unresolved_placeholder',
    );
  });
});

// ── 2. Numeric grounding ────────────────────────────────────────────────────

describe('numeric_grounding', () => {
  const peEvidence = evidence({
    ref: { sourceType: 'programElement', sourceId: '0603285F', title: 'PE' },
    evidenceText: 'FY27 request 72.1',
    structuredTruth: { years: [{ fy: 2027, request: 72.1, enacted: null }] },
  });

  test('a figure absent from the structured truth is held', () => {
    const v = verify('The program is funded at $4.2 billion.', {
      packet: packet({ evidence: [peEvidence] }),
    });
    expect(v.findings.map((f) => f.check)).toContain('numeric_grounding');
    expect(v.held).toBe(true);
  });

  test('a figure PRESENT in the truth series passes, in either notation (§4.33)', () => {
    // The series stores $ millions; both spellings normalize to 72,100,000.
    expect(
      checks('The FY27 request is $72.1 million.', { packet: packet({ evidence: [peEvidence] }) }),
    ).not.toContain('numeric_grounding');
    expect(
      checks('The FY27 request is $72,100,000.', { packet: packet({ evidence: [peEvidence] }) }),
    ).not.toContain('numeric_grounding');
  });

  test('a figure quoted verbatim from evidence PROSE is allowed', () => {
    const doc = evidence({
      ref: { sourceType: 'document', sourceId: 'd1', trust: 'external_untrusted' },
      evidenceText: 'The contract is valued at $18.5 million over five years.',
    });
    expect(
      checks('The contract is worth $18.5 million.', { packet: packet({ evidence: [doc] }) }),
    ).not.toContain('numeric_grounding');
  });

  test('parseAmounts normalizes units to whole dollars', () => {
    expect(parseAmounts('$10M')[0]?.dollars).toBe(10_000_000);
    expect(parseAmounts('$10,000,000')[0]?.dollars).toBe(10_000_000);
    expect(parseAmounts('$1.5 billion')[0]?.dollars).toBe(1_500_000_000);
  });

  test('truthAmounts scales the PE series from millions', () => {
    expect(truthAmounts(packet({ evidence: [peEvidence] }))).toContain(72_100_000);
  });
});

// ── 3. Bill identifier grounding ────────────────────────────────────────────

describe('bill_identifier_grounding', () => {
  test('a bill nobody selected is held', () => {
    expect(checks('Please support S. 4567.')).toContain('bill_identifier_grounding');
  });

  test('the selected bill passes, ignoring punctuation differences', () => {
    expect(checks('Please support H.R. 1234.')).not.toContain('bill_identifier_grounding');
    expect(checks('Please support HR 1234.')).not.toContain('bill_identifier_grounding');
  });
});

// ── 4. Enactment claims ─────────────────────────────────────────────────────

describe('enactment_claim', () => {
  test('"signed into law" with no enactment record is held', () => {
    expect(checks('Now that HR 1234 was signed into law, …')).toContain('enactment_claim');
  });

  test('an enacted status in the structured truth clears it', () => {
    const enacted = evidence({ structuredTruth: { status: 'enacted' } });
    expect(
      checks('Now that HR 1234 was signed into law, …', { packet: packet({ evidence: [enacted] }) }),
    ).not.toContain('enactment_claim');
  });
});

// ── 5. Authorization vs appropriation ───────────────────────────────────────

describe('authorization_vs_appropriation', () => {
  const authOnly = evidence({
    ref: { sourceType: 'programElement', sourceId: 'pe1' },
    structuredTruth: { years: [{ fy: 2027, ndaaConference: 100, enacted: null }] },
  });
  const enacted = evidence({
    ref: { sourceType: 'programElement', sourceId: 'pe1' },
    structuredTruth: { years: [{ fy: 2027, enacted: 100 }] },
  });

  test('calling an authorization mark "appropriated" is held', () => {
    const v = verify('The appropriated amount supports the program.', {
      packet: packet({ evidence: [authOnly] }),
    });
    expect(v.findings.map((f) => f.check)).toContain('authorization_vs_appropriation');
    expect(v.held).toBe(true);
  });

  test('the reverse — calling enacted money "only authorized" — is also held', () => {
    expect(
      checks('The program is only authorized and not yet funded.', {
        packet: packet({ evidence: [enacted] }),
      }),
    ).toContain('authorization_vs_appropriation');
  });

  test('describing an appropriation when one IS enacted passes', () => {
    expect(
      checks('The appropriated amount supports the program.', {
        packet: packet({ evidence: [enacted] }),
      }),
    ).not.toContain('authorization_vs_appropriation');
  });
});

// ── 6. Recipient commitment ─────────────────────────────────────────────────

describe('recipient_commitment_claim', () => {
  test('"your support for" with no evidence is held', () => {
    expect(checks('Thank you for your support for this program.')).toContain(
      'recipient_commitment_claim',
    );
  });

  test('a recorded cosponsorship in evidence clears it', () => {
    const votes = evidence({
      ref: { sourceType: 'relevantVotes', sourceId: 'v1', trust: 'server_record' },
      evidenceText: 'The member is a cosponsor of HR 1234.',
    });
    expect(
      checks('Thank you for your support for this program.', {
        packet: packet({ evidence: [votes] }),
      }),
    ).not.toContain('recipient_commitment_claim');
  });

  test('STANDING MEMORY cannot establish a position (§4.6)', () => {
    const memory = evidence({
      ref: { sourceType: 'clientSteering', sourceId: 's1', trust: 'standing_memory' },
      evidenceText: 'This office has been supportive and committed to our priorities.',
    });
    expect(
      checks('Thank you for your support for this program.', {
        packet: packet({ evidence: [memory] }),
      }),
    ).toContain('recipient_commitment_claim');
  });
});

// ── 7. Attendance claims ────────────────────────────────────────────────────

describe('attendance_claim', () => {
  test('"when we met" with no meeting evidence is held', () => {
    expect(checks('When we met last month you raised the timeline.')).toContain('attendance_claim');
  });

  test('a debrief clears it', () => {
    const debrief = evidence({
      ref: { sourceType: 'debrief', sourceId: 'd1', trust: 'server_record' },
      evidenceText: 'Met with the office; they raised the timeline.',
    });
    expect(
      checks('When we met last month you raised the timeline.', {
        packet: packet({ evidence: [debrief] }),
      }),
    ).not.toContain('attendance_claim');
  });

  test('a PREP does NOT clear it — a plan is not an outcome (§4.34)', () => {
    const prep = evidence({
      ref: {
        sourceType: 'prep',
        sourceId: 'p1',
        trust: 'server_record',
        provenance: { isPlanNotOutcome: true },
      },
      evidenceText: 'Agenda: raise the timeline.',
    });
    const v = verify('When we met last month you raised the timeline.', {
      packet: packet({ evidence: [prep] }),
    });
    expect(v.findings.map((f) => f.check)).toContain('attendance_claim');
    expect(v.findings.find((f) => f.check === 'attendance_claim')?.message).toMatch(/PREP/);
  });
});

// ── 8. Date grounding ───────────────────────────────────────────────────────

describe('date_grounding', () => {
  test('an invented date is held', () => {
    expect(checks('The markup is scheduled for September 14, 2026.')).toContain('date_grounding');
  });

  test('a date present in evidence passes, across formats', () => {
    const withDate = evidence({ evidenceText: 'Referred to Armed Services on 2026-06-01.' });
    expect(
      checks('Referred on June 1, 2026.', { packet: packet({ evidence: [withDate] }) }),
    ).not.toContain('date_grounding');
  });
});

// ── 9. Stale-source caveat ──────────────────────────────────────────────────

describe('stale_source_caveat', () => {
  const stale = evidence({
    ref: { authoritativeAsOf: '2026-01-01T00:00:00.000Z' }, // ~200 days old vs a 14-day bill limit
  });

  test('a stale authoritative source with no caveat is held', () => {
    const v = verify('HR 1234 is in committee.', { packet: packet({ evidence: [stale] }) });
    expect(v.findings.map((f) => f.check)).toContain('stale_source_caveat');
    expect(v.held).toBe(true);
  });

  test('an explicit as-of caveat clears it', () => {
    expect(
      checks('As of our latest check, HR 1234 is in committee.', {
        packet: packet({ evidence: [stale] }),
      }),
    ).not.toContain('stale_source_caveat');
  });

  test('a FRESH source needs no caveat', () => {
    expect(checks('HR 1234 is in committee.')).not.toContain('stale_source_caveat');
  });
});

// ── 10. Group common facts ──────────────────────────────────────────────────

describe('group_common_facts', () => {
  const perMember = packet({ evidence: [evidence({ scope: 'rep-dana' })] });

  test('a single-member attribute in a GROUP draft is held', () => {
    const v = verify('Given your committee assignment, please consider this.', {
      packet: perMember,
      audienceKind: 'group',
    });
    expect(v.findings.map((f) => f.check)).toContain('group_common_facts');
  });

  test('the same sentence to an INDIVIDUAL is fine', () => {
    expect(
      checks('Given your committee assignment, please consider this.', {
        packet: perMember,
        audienceKind: 'individual',
      }),
    ).not.toContain('group_common_facts');
  });

  test('a group draft with only shared evidence passes', () => {
    expect(
      checks('Given your committee assignment, please consider this.', {
        packet: packet(),
        audienceKind: 'group',
      }),
    ).not.toContain('group_common_facts');
  });
});

// ── 11. Jurisdiction / etiquette scope ──────────────────────────────────────

describe('federal_etiquette_scope and jurisdiction_vocabulary', () => {
  const statePolicy = policyForAudience('state_legislator');
  const stateBill = evidence({
    ref: {
      sourceType: 'stateBill',
      sourceId: 'CA-2026-AB100',
      title: 'CA AB 100',
      provenance: { jurisdiction: 'state' },
    },
    evidenceText: 'CA AB 100 passed the Assembly.',
  });

  test('federal framing to a STATE legislator is held (§4.20)', () => {
    const v = verify('I know Capitol Hill is busy — thank you, Congressman.', {
      policy: statePolicy,
      packet: packet({ evidence: [stateBill] }),
    });
    expect(v.findings.map((f) => f.check)).toContain('federal_etiquette_scope');
    expect(v.held).toBe(true);
  });

  test('federal PROCESS vocabulary applied to a state bill is held', () => {
    expect(
      checks('Once signed by the President, AB 100 takes effect.', {
        policy: statePolicy,
        packet: packet({ evidence: [stateBill] }),
      }),
    ).toContain('jurisdiction_vocabulary');
  });

  test('the same federal framing to a CONGRESSIONAL office is fine', () => {
    expect(checks('I know Capitol Hill is busy — thank you, Congressman.')).not.toContain(
      'federal_etiquette_scope',
    );
  });

  test('a clean state message passes both checks', () => {
    const v = verify('AB 100 passed the Assembly; the Governor has not yet acted.', {
      policy: statePolicy,
      packet: packet({ evidence: [stateBill] }),
    });
    expect(v.findings.map((f) => f.check)).not.toContain('federal_etiquette_scope');
    expect(v.findings.map((f) => f.check)).not.toContain('jurisdiction_vocabulary');
  });
});

// ── Overall verdict ─────────────────────────────────────────────────────────

describe('verdict', () => {
  test('a clean draft passes with no findings', () => {
    const v = verify('Thanks for your time — could we find 20 minutes before the markup?');
    expect(v.findings).toEqual([]);
    expect(v.status).toBe('passed');
    expect(v.held).toBe(false);
  });

  test('only the validators the POLICY enables are run', () => {
    // internal_colleague omits jurisdiction_vocabulary from its validator list.
    const internal = policyForAudience('internal_colleague');
    expect(internal.validators).not.toContain('jurisdiction_vocabulary');
    const v = verify('Once signed by the President, AB 100 takes effect.', {
      policy: internal,
      packet: packet({
        evidence: [evidence({ ref: { sourceType: 'stateBill', sourceId: 's1' } })],
      }),
    });
    expect(v.findings.map((f) => f.check)).not.toContain('jurisdiction_vocabulary');
  });

  test('every finding is tagged with the deterministic verifier as its source', () => {
    const v = verify('Hi from {district}.');
    expect(v.findings.every((f) => f.source === 'deterministic_verifier')).toBe(true);
  });
});
