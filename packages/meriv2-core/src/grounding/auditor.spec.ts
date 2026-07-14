import {
  runAuditor,
  checkCitations,
  checkQuoteSpans,
  checkNumericDirection,
  checkFundingDirectionVsEvidence,
  checkVehicleConflation,
  checkFailedRuleFraming,
  checkIdentifierIdentity,
  checkMemberDistrict,
  checkPlusUpAttribution,
  checkUnitMagnitude,
  checkPrimaryVehicleOverclaim,
  checkSponsorExistence,
  checkAsOfFreshness,
  resolveAuditorMode,
  type ToolResultLedger,
} from './auditor';

const ledgerWith = (entries: ToolResultLedger['entries']): ToolResultLedger => ({ entries });

describe('resolveAuditorMode — per-tenant override (Phase 2 close-out)', () => {
  it('falls back to the env mode when no override is present', () => {
    expect(resolveAuditorMode('enforce', undefined)).toBe('enforce');
    expect(resolveAuditorMode('enforce', {})).toBe('enforce');
    expect(resolveAuditorMode('enforce', { clioFeatureFlags: {} })).toBe('enforce');
  });
  it('a valid per-tenant override WINS over the env (both directions)', () => {
    // hold a tenant on shadow while global is enforce
    expect(resolveAuditorMode('enforce', { clioFeatureFlags: { meriAuditorMode: 'shadow' } })).toBe(
      'shadow',
    );
    // canary a tenant to enforce while global is shadow
    expect(resolveAuditorMode('shadow', { clioFeatureFlags: { meriAuditorMode: 'enforce' } })).toBe(
      'enforce',
    );
  });
  it('ignores an invalid override value and keeps the env mode', () => {
    expect(resolveAuditorMode('shadow', { clioFeatureFlags: { meriAuditorMode: 'bogus' } })).toBe(
      'shadow',
    );
    expect(resolveAuditorMode('shadow', { clioFeatureFlags: { meriAuditorMode: 42 } })).toBe(
      'shadow',
    );
  });
});

describe('D3 — unit-magnitude mismatch', () => {
  const ledger = ledgerWith([
    {
      tool: 'get_pe_budget_timeline',
      serialized: '{"peCode":"0603851F"}',
      result: {
        peCode: '0603851F',
        generatedAt: '2026-07-12T00:00:00Z',
        currentCycleFy: 2027,
        years: [{ fy: 2027, request: 50, hacDMark: 72.1 }],
      },
    },
  ]);
  it('flags a figure off by ~1000x (thousands read as millions)', () => {
    const f = checkUnitMagnitude('PE 0603851F is funded at $72,100 this cycle.', ledger);
    expect(f).toHaveLength(1);
    expect(f[0]!.check).toBe('D3');
  });
  it('flags a figure off by ~1,000,000x (ones read as millions)', () => {
    const f = checkUnitMagnitude('PE 0603851F is funded at $72,100,000 this cycle.', ledger);
    expect(f).toHaveLength(1);
  });
  it('does NOT flag the correctly-scaled figure', () => {
    expect(checkUnitMagnitude('PE 0603851F is funded at $72.1M this cycle.', ledger)).toEqual([]);
  });
  it('does NOT flag a genuinely different (non-magnitude-related) figure', () => {
    expect(checkUnitMagnitude('PE 0603851F is funded at $50M this cycle.', ledger)).toEqual([]);
  });
});

describe('D8 — primary-vehicle overclaim (auditor-level port)', () => {
  const ledger = ledgerWith([
    {
      tool: 'get_pe_budget_timeline',
      serialized: '{"peCode":"0603851F"}',
      result: {
        peCode: '0603851F',
        generatedAt: '2026-07-12T00:00:00Z',
        currentCycleFy: 2027,
        years: [{ fy: 2027, request: 50, hacDMark: 50 }],
      },
    },
    {
      tool: 'get_pe_budget_timeline',
      serialized: '{"peCode":"0604256AX"}',
      result: {
        peCode: '0604256AX',
        generatedAt: '2026-07-12T00:00:00Z',
        currentCycleFy: 2027,
        years: [{ fy: 2027, request: 500, hacDMark: 500 }],
      },
    },
  ]);
  it('flags "primary" framing when a same-FY sibling is materially larger', () => {
    const f = checkPrimaryVehicleOverclaim(
      'PE 0603851F is the primary funding vehicle for this mission.',
      ledger,
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.check).toBe('D8');
    expect(f[0]!.detail).toContain('0604256AX');
  });
  it('does NOT flag without a "primary" claim', () => {
    expect(checkPrimaryVehicleOverclaim('PE 0603851F funds prototyping.', ledger)).toEqual([]);
  });
  it('does NOT flag when no sibling clears the 3x factor', () => {
    const close = ledgerWith([
      {
        tool: 'get_pe_budget_timeline',
        serialized: '{}',
        result: {
          peCode: '0603851F',
          generatedAt: '2026-07-12T00:00:00Z',
          currentCycleFy: 2027,
          years: [{ fy: 2027, request: 50, hacDMark: 50 }],
        },
      },
      {
        tool: 'get_pe_budget_timeline',
        serialized: '{}',
        result: {
          peCode: '0604256AX',
          generatedAt: '2026-07-12T00:00:00Z',
          currentCycleFy: 2027,
          years: [{ fy: 2027, request: 80, hacDMark: 80 }],
        },
      },
    ]);
    expect(checkPrimaryVehicleOverclaim('PE 0603851F is the primary vehicle here.', close)).toEqual(
      [],
    );
  });
});

describe('D5 — sponsor entity existence', () => {
  const ledger = ledgerWith([
    {
      tool: 'get_bill_status',
      serialized: '{"billId":"hr-8800-119"}',
      result: { billId: 'hr-8800-119', sponsor: { name: 'Mike Rogers', bioguideId: 'R000575' } },
    },
  ]);
  it('flags a claimed sponsor that does not match the ledger', () => {
    const f = checkSponsorExistence('Sponsor: Rep. Jane Smith, hr-8800-119.', ledger);
    expect(f).toHaveLength(1);
    expect(f[0]!.check).toBe('D5');
  });
  it('does NOT flag the correct sponsor (with or without a title)', () => {
    expect(checkSponsorExistence('Sponsored by Rep. Mike Rogers, hr-8800-119.', ledger)).toEqual(
      [],
    );
    expect(checkSponsorExistence('The sponsor is Mike Rogers (hr-8800-119).', ledger)).toEqual([]);
  });
  it('does NOT flag a last-name-only claim that matches', () => {
    expect(checkSponsorExistence('Sponsor: Rogers, hr-8800-119.', ledger)).toEqual([]);
  });
  it('abstains without an explicit sponsor claim or without the billId present', () => {
    expect(checkSponsorExistence('hr-8800-119 was reported favorably.', ledger)).toEqual([]);
    expect(checkSponsorExistence('Sponsor: Rep. Jane Smith.', ledger)).toEqual([]); // no billId token
  });
});

describe('D10 — stale as-of date', () => {
  const ledger = ledgerWith([
    {
      tool: 'get_bill_status',
      serialized: '{"billId":"hr-8800-119"}',
      result: { billId: 'hr-8800-119', status: 'reported', statusAt: '2026-06-12' },
    },
  ]);
  it('flags an explicit as-of date staler than the ledger status date', () => {
    const f = checkAsOfFreshness(
      'H.R. 8800 (hr-8800-119) was reported out of committee (as of 2026-05-01).',
      ledger,
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.check).toBe('D10');
  });
  it('does NOT flag a current or newer as-of date', () => {
    expect(checkAsOfFreshness('hr-8800-119 was reported (as of 2026-06-12).', ledger)).toEqual([]);
    expect(checkAsOfFreshness('hr-8800-119 was reported (as of 2026-07-01).', ledger)).toEqual([]);
  });
  it('abstains on a sentence with no explicit as-of date', () => {
    expect(checkAsOfFreshness('hr-8800-119 was reported out of committee.', ledger)).toEqual([]);
  });
});

describe('D9 — plus-up attributed to the wrong PE', () => {
  // Two PEs: 0603851F delta = +12.9 (72.1→85), 0604256AX delta = +40.8 (72.1→112.9).
  const ledger = ledgerWith([
    {
      tool: 'get_pe_budget_timeline',
      serialized: '{"peCode":"0603851F"}',
      result: {
        peCode: '0603851F',
        generatedAt: '2026-07-12T00:00:00Z',
        currentCycleFy: 2027,
        years: [{ fy: 2027, request: 72.1, hacDMark: 85 }],
      },
    },
    {
      tool: 'get_pe_budget_timeline',
      serialized: '{"peCode":"0604256AX"}',
      result: {
        peCode: '0604256AX',
        generatedAt: '2026-07-12T00:00:00Z',
        currentCycleFy: 2027,
        years: [{ fy: 2027, request: 72.1, hacDMark: 112.9 }],
      },
    },
  ]);
  it('flags a plus-up whose amount does not match the claimed PE, naming the sibling it fits', () => {
    const f = checkPlusUpAttribution(
      'The committee added a $40.8M plus-up to PE 0603851F.',
      ledger,
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.check).toBe('D9');
    expect(f[0]!.detail).toContain('0604256AX'); // the sibling the amount actually matches
  });
  it('does NOT flag a plus-up that matches the claimed PE delta', () => {
    expect(checkPlusUpAttribution('A $12.9M plus-up was added to PE 0603851F.', ledger)).toEqual(
      [],
    );
  });
  it('abstains without a plus-up word, or with != one PE / != one figure', () => {
    expect(checkPlusUpAttribution('PE 0603851F got $40.8M.', ledger)).toEqual([]); // no plus-up word
    expect(
      checkPlusUpAttribution('A $40.8M plus-up spanned 0603851F and 0604256AX.', ledger),
    ).toEqual([]); // two PEs
  });
});

describe('D4 (evidence-backed) — direction vs compiled EvidencePackets', () => {
  // A get_pe_budget_timeline-shaped ledger entry: FY27 request 72.1, HAC-D 112.9
  // (a RAISE). The current authoritative figure is therefore an increase.
  const timelineLedger = ledgerWith([
    {
      tool: 'get_pe_budget_timeline',
      serialized: '{"peCode":"0603851F"}',
      result: {
        peCode: '0603851F',
        identifierKind: 'pe',
        generatedAt: '2026-07-12T00:00:00Z',
        currentCycleFy: 2027,
        years: [{ fy: 2027, request: 72.1, hacDMark: 112.9 }],
      },
    },
  ]);

  it('flags the IMPLICIT reversal ("PE X funding was cut") with no explicit numbers', () => {
    const out = 'Unfortunately PE 0603851F saw its funding cut this cycle.';
    const f = checkFundingDirectionVsEvidence(out, timelineLedger);
    expect(f).toHaveLength(1);
    expect(f[0]!.check).toBe('D4');
    expect(f[0]!.severity).toBe('critical');
  });
  it('does NOT flag the correct direction ("PE X funding rose")', () => {
    const out = 'PE 0603851F funding rose this cycle.';
    expect(checkFundingDirectionVsEvidence(out, timelineLedger)).toEqual([]);
  });
  it('abstains without a funding cue, with mixed polarity, or with no PE in the ledger', () => {
    expect(checkFundingDirectionVsEvidence('PE 0603851F was cut.', timelineLedger)).toEqual([]); // no funding cue word ("cut" alone, no fund/mark/$)...
    expect(checkFundingDirectionVsEvidence('PE 9999999Z funding was cut.', timelineLedger)).toEqual(
      [],
    ); // PE not in ledger
    expect(checkFundingDirectionVsEvidence('funding was cut', ledgerWith([]))).toEqual([]); // empty ledger
  });
});

describe('D4 — numeric direction self-consistency', () => {
  it('flags a raise narrated as a cut (S1-3 reversal) as CRITICAL', () => {
    const f = checkNumericDirection('The line was cut to $112.9M from the $72.1M request.');
    expect(f).toHaveLength(1);
    expect(f[0]!.check).toBe('D4');
    expect(f[0]!.severity).toBe('critical');
  });
  it('flags a cut narrated as an increase', () => {
    expect(
      checkNumericDirection('The mark increased to $60M from the $100M request.'),
    ).toHaveLength(1);
  });
  it('does NOT flag a correctly-described raise', () => {
    expect(checkNumericDirection('The mark rose to $112.9M from the $72.1M request.')).toEqual([]);
  });
  it('does NOT flag a correctly-described cut', () => {
    expect(checkNumericDirection('The line was cut to $60M from the $100M request.')).toEqual([]);
  });
  it('stays silent when the sentence is ambiguous (both/no direction or ≠2 figures)', () => {
    expect(checkNumericDirection('The request is $72.1M.')).toEqual([]); // one figure
    expect(checkNumericDirection('$112.9M vs $72.1M vs $50M across the cycle.')).toEqual([]); // 3 figures, no dir
    expect(
      checkNumericDirection('It went up from $50M then down from $80M in a later year.'),
    ).toEqual([]); // both polarities
  });
  it('normalizes units before comparing ($B vs $M)', () => {
    // $1.2B (=1200M) described as "below" the $900M request is a contradiction.
    expect(checkNumericDirection('Funding fell to $1.2B, below the $900M request.')).toHaveLength(
      1,
    );
  });
});

describe('D1 — FORM-B citation existence', () => {
  const ledger = ledgerWith([
    { tool: 'get_pe_budget_timeline', serialized: '{"peCode":"0603851F","request":72.1}' },
  ]);
  it('passes a token whose tool + record_id resolve', () => {
    const out = 'FY27 request is $72.1M [S:get_pe_budget_timeline:0603851F].';
    expect(checkCitations(out, ledger)).toEqual([]);
  });
  it('flags a token whose tool was not called this turn', () => {
    const out = 'Rep. Strong represents AL-05 [S:get_representation:AL-05].';
    const f = checkCitations(out, ledger);
    expect(f).toHaveLength(1);
    expect(f[0]!.check).toBe('D1');
  });
  it('flags a token whose record_id is not verbatim in the result', () => {
    const out = 'The request is $99M [S:get_pe_budget_timeline:9999999Z].';
    expect(checkCitations(out, ledger)).toHaveLength(1);
  });
});

describe('D2 — quote/source-span gate', () => {
  const REAL_SPAN =
    'The Committee directs the Secretary of the Air Force to submit a report on hypersonics';
  const ledger = ledgerWith([
    { tool: 'get_committee_report', serialized: `{"provision":"${REAL_SPAN} within 90 days."}` },
  ]);

  it('passes an attributed quote that appears verbatim in a tool result', () => {
    const out = `The report states "${REAL_SPAN}" in the classified annex.`;
    expect(checkQuoteSpans(out, ledger)).toEqual([]);
  });
  it('passes despite whitespace/smart-quote/case differences (normalized match)', () => {
    const out = `The report states “the committee DIRECTS the  Secretary of the Air Force to submit a report on hypersonics” today.`;
    expect(checkQuoteSpans(out, ledger)).toEqual([]);
  });
  it('flags a long attributed quote that appears in NO tool result (fabricated span)', () => {
    const out = `The committee report states "the Secretary shall terminate the program no later than fiscal year 2027 absent certification".`;
    const f = checkQuoteSpans(out, ledger);
    expect(f).toHaveLength(1);
    expect(f[0]!.check).toBe('D2');
    expect(f[0]!.severity).toBe('high');
  });
  it('does NOT flag short scare quotes or coined terms (precision guard)', () => {
    expect(checkQuoteSpans('The bill text calls this a "skinny budget" approach.', ledger)).toEqual(
      [],
    );
  });
  it('does NOT flag a long quote on a line with no attribution cue', () => {
    const out = `Some call it "a generational shift in how the department buys software and fields it".`;
    expect(checkQuoteSpans(out, ledger)).toEqual([]);
  });
  it('stays silent when the ledger is empty (fabrication unprovable)', () => {
    const out = `The report states "the Secretary shall terminate the program no later than fiscal year 2027".`;
    expect(checkQuoteSpans(out, ledgerWith([]))).toEqual([]);
  });
  it('is wired into runAuditor (fires end-to-end under shadow)', () => {
    const out = `The committee report states "the Secretary shall terminate the program no later than fiscal year 2027 absent certification".`;
    const verdict = runAuditor({ output: out, ledger, surface: 'alert', mode: 'shadow' });
    expect(verdict.findings.some((f) => f.check === 'D2')).toBe(true);
    expect(verdict.decision).toBe('deliver'); // shadow never blocks
  });
});

describe('D4b — authorization vs appropriation conflation', () => {
  it('flags an appropriations mark described as authorization', () => {
    const f = checkVehicleConflation(
      'The HAC-D mark authorizes $112.9M for the program this year.',
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.check).toBe('D4b');
    expect(f[0]!.severity).toBe('high');
  });
  it('flags an NDAA figure described as providing appropriations money', () => {
    const f = checkVehicleConflation('The NDAA funds $150M in new appropriations for the line.');
    expect(f).toHaveLength(1);
  });
  it('does NOT flag a correctly-separated sentence', () => {
    expect(
      checkVehicleConflation(
        'The NDAA authorizes the ceiling; the defense appropriations bill provides the money.',
      ),
    ).toEqual([]);
  });
  it('does NOT flag the legitimate NDAA conference report phrasing', () => {
    expect(
      checkVehicleConflation('The NDAA conference report set the authorization at $150M.'),
    ).toEqual([]);
  });
});

describe('D6 — failed / stale rule framing', () => {
  const ledger = ledgerWith([
    {
      tool: 'get_bill_status',
      serialized: '{"billId":"hr-8800-119","status":"rule_failed"}',
      result: { billId: 'hr-8800-119', status: 'rule_failed' },
    },
  ]);
  it('flags operative framing about a bill the ledger reports rule_failed as CRITICAL', () => {
    const out =
      'H.R. 8800 is advancing and will be considered under the rule hr-8800-119 next week.';
    const f = checkFailedRuleFraming(out, ledger);
    expect(f).toHaveLength(1);
    expect(f[0]!.check).toBe('D6');
    expect(f[0]!.severity).toBe('critical');
  });
  it('does NOT flag an honest stalled description', () => {
    const out = 'The rule for hr-8800-119 failed on the floor, so the bill is stalled.';
    expect(checkFailedRuleFraming(out, ledger)).toEqual([]);
  });
  it('does nothing when no ledger bill is failed', () => {
    const clean = ledgerWith([
      {
        tool: 'get_bill_status',
        serialized: '{"billId":"hr-1-119","status":"passed_chamber"}',
        result: { billId: 'hr-1-119', status: 'passed_chamber' },
      },
    ]);
    expect(checkFailedRuleFraming('hr-1-119 is advancing on the floor.', clean)).toEqual([]);
  });
});

describe('D7 — procurement line item called a Program Element', () => {
  it('flags "PE <BLIN>" by code shape', () => {
    const f = checkIdentifierIdentity('We should target PE 1507N2280 for the ask.', ledgerWith([]));
    expect(f).toHaveLength(1);
    expect(f[0]!.check).toBe('D7');
  });
  it('does NOT flag a real 7-digit PE code', () => {
    expect(
      checkIdentifierIdentity('PE 0603851F funds the prototype effort.', ledgerWith([])),
    ).toEqual([]);
  });
  it('flags "PE <code>" when the ledger classifies the code as a procurement line item', () => {
    const ledger = ledgerWith([
      {
        tool: 'search_program_elements',
        serialized: '[]',
        result: {
          data: [{ peCode: '3010F10TRGT', identifierKind: 'procurement_line_item' }],
        },
      },
    ]);
    const f = checkIdentifierIdentity('Anchor the memo to PE 3010F10TRGT.', ledger);
    expect(f).toHaveLength(1);
  });
});

describe('D11 — member↔district mapping', () => {
  const repLedger = ledgerWith([
    {
      tool: 'get_representation',
      serialized: '{"facilities":[{"district":"AL-05","member":"Dale Strong"}]}',
      result: { facilities: [{ district: 'AL-05' }] },
    },
  ]);
  it('flags a district asserted WITHOUT any representation lookup (the S3-1 class)', () => {
    const f = checkMemberDistrict(
      'Rep. Rogers represents AL-03, the district containing the plant.',
      ledgerWith([]),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.check).toBe('D11');
    expect(f[0]!.severity).toBe('critical');
  });
  it('flags a district the representation lookup did NOT return', () => {
    const f = checkMemberDistrict('The client is represented by the member for TX-23.', repLedger);
    expect(f).toHaveLength(1);
  });
  it('does NOT flag a district that get_representation returned', () => {
    expect(
      checkMemberDistrict(
        'Rep. Dale Strong represents AL-05 [S:get_representation:AL-05].',
        repLedger,
      ),
    ).toEqual([]);
  });
  it('grounds correctly against the REAL RepresentationResult shape (state/district as separate JSON fields, no dash) — regression for the district-brief wiring', () => {
    // RepresentationResult stores {state:"AL", district:5} — never a joined
    // "AL-05" string. district-brief.service.ts appends the SAME "STATE-NN"
    // token it already renders (via formatFederalDistrict) to the ledger
    // entry's serialized text so this grounds; without that append, the raw
    // JSON.stringify alone would false-flag every correct district claim.
    const realShapeLedger = ledgerWith([
      {
        tool: 'get_representation',
        serialized:
          '{"unresolved":false,"federal":{"house":{"bioguideId":"S001208","fullName":"Dale Strong","party":"R","state":"AL","district":5,"chamber":"house"},"senate":[]},"state":{"lower":null,"upper":null}} AL-05',
        result: {
          unresolved: false,
          federal: { house: { state: 'AL', district: 5 }, senate: [] },
        },
      },
    ]);
    expect(checkMemberDistrict('Rep. Dale Strong represents AL-05.', realShapeLedger)).toEqual([]);
    // A DIFFERENT district on the same turn is still correctly flagged.
    expect(checkMemberDistrict('Rep. X represents TX-23.', realShapeLedger)).toHaveLength(1);
  });
  it('abstains when there is no representation claim in the sentence', () => {
    expect(checkMemberDistrict('The AL-05 figure is $50M.', ledgerWith([]))).toEqual([]);
  });
});

describe('runAuditor — verdict gate + mode/surface fail policy', () => {
  const failed = ledgerWith([
    {
      tool: 'get_bill_status',
      serialized: '{"billId":"hr-8800-119","status":"rule_failed"}',
      result: { billId: 'hr-8800-119', status: 'rule_failed' },
    },
  ]);
  const badOutput = 'H.R. 8800 is advancing under the rule hr-8800-119.';

  it('off mode short-circuits: no findings, deliver', () => {
    const v = runAuditor({ output: badOutput, ledger: failed, surface: 'chat', mode: 'off' });
    expect(v.findings).toEqual([]);
    expect(v.decision).toBe('deliver');
  });
  it('shadow mode observes findings but still delivers (never alters output)', () => {
    const v = runAuditor({
      output: badOutput,
      ledger: failed,
      surface: 'outreach',
      mode: 'shadow',
    });
    expect(v.findings.length).toBeGreaterThan(0);
    expect(v.topSeverity).toBe('critical');
    expect(v.decision).toBe('deliver');
  });
  it('enforce + outreach (fully-blocking) holds on any finding', () => {
    const v = runAuditor({
      output: badOutput,
      ledger: failed,
      surface: 'outreach',
      mode: 'enforce',
    });
    expect(v.decision).toBe('hold');
  });
  it('enforce + chat repairs on a high/critical finding', () => {
    const v = runAuditor({ output: badOutput, ledger: failed, surface: 'chat', mode: 'enforce' });
    expect(v.decision).toBe('repair');
  });
  it('clean output delivers under every mode', () => {
    const clean = 'The rule for hr-8800-119 failed on the floor; the bill is stalled.';
    for (const mode of ['shadow', 'annotate', 'enforce'] as const) {
      const v = runAuditor({ output: clean, ledger: failed, surface: 'outreach', mode });
      expect(v.findings).toEqual([]);
      expect(v.decision).toBe('deliver');
    }
  });
});
