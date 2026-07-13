/**
 * GOLDEN FIXTURES — the three fact-checked hallucination incidents that opened
 * this whole effort, encoded as regression tests against the shipped auditor
 * (v3 plan Wave 5 "golden fixtures (3 incidents)" + Phase 4 success metric).
 *
 * Each fixture is (a) an output span close to what actually shipped to a client,
 * and (b) the same-turn ToolResultLedger reflecting the TRUE data. The assertion
 * is that the deterministic auditor CATCHES the incident-specific error class.
 *
 * COVERAGE BOUNDARY (updated 2026-07-13): the full deterministic taxonomy D1,
 * D3, D4 (text + evidence), D4b, D5, D6, D7, D8, D9, D10, D11, and now D12
 * (enactment-proof, safe status-contradiction form), D13 (legislative-stage
 * ordering), D14 (negative-assertion, narrow contradiction-of-present-rows
 * slice) is shipped, registered in `runAuditor`, and asserted here — the three
 * original client incidents (Samples 1-3), the cataloged classes D3/D5/D8
 * (Sample 4), and D12/D13/D14 (Sample 5). Two forms remain deliberately
 * skeptic-deferred: (a) the residual undecidable class (fabricated staffer/
 * section specifics over 0-result evidence, S3-3/4/5), and (b) D14's GENERAL
 * negative-assertion/coverage form ("is retrieval complete enough to assert a
 * negative?") — both unprovable deterministically and routed to the LLM skeptic.
 * D12's stricter "structured public-law id + date field must be present" form is
 * deferred pending a get_bill_status ledger-contract extension. Coverage is a
 * tracked metric, never implied.
 */
import { runAuditor, type ToolResultLedger } from './auditor';

const ledger = (entries: ToolResultLedger['entries']): ToolResultLedger => ({ entries });

describe('GOLDEN — Sample 1: Outreach H.R. 8800 memo (client Jaia Robotics)', () => {
  // The governing rule for H.R. 8800 FAILED on the floor; the memo nonetheless
  // framed the bill as advancing under the rule (S1-5/6).
  const failedRuleLedger = ledger([
    {
      tool: 'get_bill_status',
      serialized: '{"billId":"hr-8800-119","status":"rule_failed","statusAt":"2026-06-12"}',
      result: { billId: 'hr-8800-119', status: 'rule_failed', statusAt: '2026-06-12' },
    },
  ]);

  it('D6 catches the stale/failed-rule operative framing (critical)', () => {
    const shipped =
      'With the rule now in effect, H.R. 8800 hr-8800-119 is advancing to the floor and we expect passage this work period.';
    const v = runAuditor({
      output: shipped,
      ledger: failedRuleLedger,
      surface: 'outreach',
      mode: 'enforce',
    });
    expect(v.findings.some((f) => f.check === 'D6' && f.severity === 'critical')).toBe(true);
    // On the fully-blocking outreach surface, enforce holds the draft.
    expect(v.decision).toBe('hold');
  });

  it('D4b catches an NDAA (authorization) line described as appropriating money', () => {
    const shipped = 'The NDAA appropriates $112.9M for the program this cycle.';
    const v = runAuditor({
      output: shipped,
      ledger: ledger([]),
      surface: 'outreach',
      mode: 'shadow',
    });
    expect(v.findings.some((f) => f.check === 'D4b')).toBe(true);
  });

  it('D4 catches the reversed current-vs-request comparison (S1-3, the ICBM reversal)', () => {
    // The headline error that shipped to a client: a mark ABOVE the request
    // ($112.9M > $72.1M) narrated as a "cut". (Isolated to the reversal; a mixed
    // "cut … push to restore" sentence is ambiguous by design and abstains here —
    // the ledger-signed-delta D4 in the Wave-2 remainder resolves that case.)
    const shipped = 'The FY27 mark was cut to $112.9M, down from the $72.1M request.';
    const v = runAuditor({
      output: shipped,
      ledger: ledger([]),
      surface: 'outreach',
      mode: 'enforce',
    });
    expect(v.findings.some((f) => f.check === 'D4' && f.severity === 'critical')).toBe(true);
    expect(v.decision).toBe('hold');
  });
});

describe('GOLDEN — Sample 2: Meri chat PE matching (Boresight)', () => {
  it('D7 catches a procurement line item cited as "PE 1507N2280" (S2-1)', () => {
    // The ledger returns the code as a procurement line item; the reply calls it a PE.
    const l = ledger([
      {
        tool: 'search_program_elements',
        serialized:
          '{"tool":"search","data":[{"peCode":"1507N2280","identifierKind":"procurement_line_item","budgetExhibitType":"P-1 procurement line item (NOT a Program Element)"}]}',
        result: {
          tool: 'search',
          data: [{ peCode: '1507N2280', identifierKind: 'procurement_line_item' }],
        },
      },
    ]);
    const shipped =
      'The strongest match is PE 1507N2280, a Weapons Procurement Navy program element aligned to the mission.';
    const v = runAuditor({ output: shipped, ledger: l, surface: 'chat', mode: 'enforce' });
    expect(v.findings.some((f) => f.check === 'D7')).toBe(true);
    // High-severity on chat → repair (not silent delivery).
    expect(v.decision).toBe('repair');
  });

  it('D7 fires on the BLIN shape even without a ledger record for the code', () => {
    const v = runAuditor({
      output: 'Anchor the ask to PE 1507N2280.',
      ledger: ledger([]),
      surface: 'chat',
      mode: 'shadow',
    });
    expect(v.findings.some((f) => f.check === 'D7')).toBe(true);
  });

  it('D9 catches the plus-up attributed to the wrong PE (S2-11)', () => {
    // The $40.8M plus-up belongs to 0604256AX (delta +40.8), not the cited PE
    // 0603851F (delta +12.9) — the misattribution that named the wrong line.
    const l = ledger([
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
    const shipped = 'Committee report language directs a $40.8M plus-up to PE 0603851F.';
    const v = runAuditor({ output: shipped, ledger: l, surface: 'chat', mode: 'enforce' });
    expect(v.findings.some((f) => f.check === 'D9')).toBe(true);
  });
});

describe('GOLDEN — Sample 3: Deep-research memo (self-audited against nothing)', () => {
  it('D11 catches the fabricated member↔district mapping (S3-1)', () => {
    // The critical S3-1 error: a member↔district mapping asserted with no
    // get_representation/resolve_entity lookup this turn (inferred from a roster,
    // which carries no district). Research is fully-blocking → hold.
    const shipped =
      "Rep. Mike Rogers represents AL-05, the district home to the client's facility.";
    const v = runAuditor({
      output: shipped,
      ledger: ledger([]),
      surface: 'research',
      mode: 'enforce',
    });
    expect(v.findings.some((f) => f.check === 'D11' && f.severity === 'critical')).toBe(true);
    expect(v.decision).toBe('hold');
  });
  // S3-3/4/5/12: specific claims asserted over 0-result / unretrieved evidence
  // (fabricated staffer contact, invented section numbers) — needs the LLM
  // skeptic + 0-result telemetry, shadow-gated.
  it.todo('Skeptic + 0-result telemetry catch the fabricated staffer/section specifics (S3-3/4/5)');
});

describe('GOLDEN — Sample 4: cataloged classes D3/D5/D8 (registered checks, now regression-covered)', () => {
  it('D3 catches a thousands/millions unit swap on a ledger-known PE amount', () => {
    // The PE's authoritative current-cycle mark is $112.9M (HAC-D). Prose that
    // states "$112.9 billion" is off by a factor of 1000 — the classic unit swap.
    const l = ledger([
      {
        tool: 'get_pe_budget_timeline',
        serialized: '{"peCode":"0603851F"}',
        result: {
          peCode: '0603851F',
          generatedAt: '2026-07-12T00:00:00Z',
          currentCycleFy: 2027,
          years: [{ fy: 2027, request: 72.1, hacDMark: 112.9 }],
        },
      },
    ]);
    const shipped = 'PE 0603851F is funded at $112.9 billion in FY2027.';
    const v = runAuditor({ output: shipped, ledger: l, surface: 'chat', mode: 'enforce' });
    expect(v.findings.some((f) => f.check === 'D3')).toBe(true);
  });

  it('D5 catches a claimed bill sponsor that contradicts get_bill_status', () => {
    const l = ledger([
      {
        tool: 'get_bill_status',
        serialized: '{"billId":"hr-8800-119","sponsorName":"Rob Wittman"}',
        result: { billId: 'hr-8800-119', sponsorName: 'Rob Wittman' },
      },
    ]);
    const shipped = 'H.R. 8800 (hr-8800-119) is sponsored by Rep. Adam Smith.';
    const v = runAuditor({ output: shipped, ledger: l, surface: 'chat', mode: 'enforce' });
    expect(v.findings.some((f) => f.check === 'D5')).toBe(true);
  });

  it('D8 catches a "primary vehicle" overclaim when a same-FY sibling PE is materially larger', () => {
    // 0603851F is $30M; its same-FY sibling 0604256AX is $120M (4x) — calling the
    // smaller line the "primary" funding vehicle is the overclaim D8 flags.
    const l = ledger([
      {
        tool: 'get_pe_budget_timeline',
        serialized: '{"peCode":"0603851F"}',
        result: {
          peCode: '0603851F',
          generatedAt: '2026-07-12T00:00:00Z',
          currentCycleFy: 2027,
          years: [{ fy: 2027, request: 30, hacDMark: 30 }],
        },
      },
      {
        tool: 'get_pe_budget_timeline',
        serialized: '{"peCode":"0604256AX"}',
        result: {
          peCode: '0604256AX',
          generatedAt: '2026-07-12T00:00:00Z',
          currentCycleFy: 2027,
          years: [{ fy: 2027, request: 120, hacDMark: 120 }],
        },
      },
    ]);
    const shipped = 'PE 0603851F is the primary funding vehicle for this capability.';
    const v = runAuditor({ output: shipped, ledger: l, surface: 'chat', mode: 'enforce' });
    expect(v.findings.some((f) => f.check === 'D8')).toBe(true);
  });

  it('no false positive: a correctly-scaled amount, correct sponsor, and non-primary framing are clean', () => {
    const peL = ledger([
      {
        tool: 'get_pe_budget_timeline',
        serialized: '{"peCode":"0603851F"}',
        result: {
          peCode: '0603851F',
          generatedAt: '2026-07-12T00:00:00Z',
          currentCycleFy: 2027,
          years: [{ fy: 2027, request: 72.1, hacDMark: 112.9 }],
        },
      },
    ]);
    // Correctly-scaled figure ($112.9M matches the mark) — D3 must NOT fire.
    const okAmount = runAuditor({
      output: 'PE 0603851F is funded at $112.9M in FY2027.',
      ledger: peL,
      surface: 'chat',
      mode: 'enforce',
    });
    expect(okAmount.findings.some((f) => f.check === 'D3')).toBe(false);

    // Matching sponsor — D5 must NOT fire.
    const sponsorL = ledger([
      {
        tool: 'get_bill_status',
        serialized: '{"billId":"hr-8800-119","sponsorName":"Rob Wittman"}',
        result: { billId: 'hr-8800-119', sponsorName: 'Rob Wittman' },
      },
    ]);
    const okSponsor = runAuditor({
      output: 'H.R. 8800 (hr-8800-119) is sponsored by Rep. Rob Wittman.',
      ledger: sponsorL,
      surface: 'chat',
      mode: 'enforce',
    });
    expect(okSponsor.findings.some((f) => f.check === 'D5')).toBe(false);
  });
});

describe('GOLDEN — Sample 5: enactment-proof + stage-ordering + negative-assertion (D12/D13/D14)', () => {
  const statusL = (billId: string, status: string, extra: Record<string, unknown> = {}) =>
    ledger([
      {
        tool: 'get_bill_status',
        serialized: JSON.stringify({ billId, status, ...extra }),
        result: { billId, status, ...extra },
      },
    ]);

  it('D12 catches an enactment claim over a non-enacted status (critical → hold on a blocking surface)', () => {
    const v = runAuditor({
      output: 'Good news — H.R. 8800 (hr-8800-119) was signed into law this week.',
      ledger: statusL('hr-8800-119', 'rule_failed'),
      surface: 'outreach',
      mode: 'enforce',
    });
    expect(v.findings.some((f) => f.check === 'D12' && f.severity === 'critical')).toBe(true);
    expect(v.decision).toBe('hold');
  });

  it('D12 does NOT fire when the bill really is enacted, nor on hedged enactment talk', () => {
    const enacted = runAuditor({
      output: 'H.R. 8800 (hr-8800-119) was enacted and is now Public Law 119-75.',
      ledger: statusL('hr-8800-119', 'enacted'),
      surface: 'outreach',
      mode: 'enforce',
    });
    expect(enacted.findings.some((f) => f.check === 'D12')).toBe(false);

    const hedged = runAuditor({
      output: 'H.R. 8800 (hr-8800-119) has not yet been enacted; it awaits floor action.',
      ledger: statusL('hr-8800-119', 'reported'),
      surface: 'outreach',
      mode: 'enforce',
    });
    expect(hedged.findings.some((f) => f.check === 'D12')).toBe(false);
  });

  it('D13 catches a bill described as further along than its retrieved status (high)', () => {
    const v = runAuditor({
      output: 'H.R. 8800 (hr-8800-119) passed the House and is headed to the President.',
      ledger: statusL('hr-8800-119', 'reported'), // rank 2, far below to_president (7)
      surface: 'memo',
      mode: 'enforce',
    });
    expect(v.findings.some((f) => f.check === 'D13' && f.severity === 'high')).toBe(true);
  });

  it('D13 does NOT fire when the claimed stage matches the status, nor on hypotheticals', () => {
    const exact = runAuditor({
      output: 'H.R. 8800 (hr-8800-119) was sent to the President this week.',
      ledger: statusL('hr-8800-119', 'to_president'), // rank 7 == claimed
      surface: 'memo',
      mode: 'enforce',
    });
    expect(exact.findings.some((f) => f.check === 'D13')).toBe(false);

    const hypothetical = runAuditor({
      output: 'If H.R. 8800 (hr-8800-119) passes the House, it would move to the Senate.',
      ledger: statusL('hr-8800-119', 'reported'),
      surface: 'memo',
      mode: 'enforce',
    });
    expect(hypothetical.findings.some((f) => f.check === 'D13')).toBe(false);
  });

  it('D14 catches a "no sponsor" claim contradicted by a sponsor in the tool data (high)', () => {
    const v = runAuditor({
      output: 'Note: hr-8800-119 currently has no sponsor.',
      ledger: statusL('hr-8800-119', 'reported', { sponsorName: 'Rep. Rob Wittman' }),
      surface: 'chat',
      mode: 'enforce',
    });
    expect(v.findings.some((f) => f.check === 'D14' && f.severity === 'high')).toBe(true);
  });

  // D14's GENERAL form (coverage-completeness / prove-a-negative over partial
  // retrieval, S3-3/4/5) is deliberately NOT deterministic — it routes to the
  // LLM skeptic. Only the narrow contradiction-of-present-rows slice ships here.
  it.todo('D14 general negative-assertion/coverage — routes to the LLM skeptic (deferred)');
});

describe('GOLDEN — no false positives on the CORRECT versions of each incident', () => {
  it('an honest H.R. 8800 stalled-rule sentence is clean', () => {
    const l = ledger([
      {
        tool: 'get_bill_status',
        serialized: '{"billId":"hr-8800-119","status":"rule_failed"}',
        result: { billId: 'hr-8800-119', status: 'rule_failed' },
      },
    ]);
    const honest =
      'The rule governing H.R. 8800 (hr-8800-119) failed on the floor, so the bill is stalled and its debate-limit provisions are not in effect (as of 2026-06-12).';
    const v = runAuditor({ output: honest, ledger: l, surface: 'outreach', mode: 'enforce' });
    expect(v.findings).toEqual([]);
    expect(v.decision).toBe('deliver');
  });

  it('a correctly-labeled procurement line item is clean', () => {
    const honest =
      'Procurement line item 1507N2280 (Weapons Procurement, Navy) is the fielding vehicle; the RDT&E work sits under PE 0603851F.';
    const v = runAuditor({ output: honest, ledger: ledger([]), surface: 'chat', mode: 'enforce' });
    expect(v.findings).toEqual([]);
  });

  it('a correct authorization-vs-appropriations contrast is clean', () => {
    const honest =
      'The NDAA authorizes the ceiling; the defense appropriations bill provides the money.';
    const v = runAuditor({ output: honest, ledger: ledger([]), surface: 'memo', mode: 'enforce' });
    expect(v.findings).toEqual([]);
  });
});
