import {
  runAuditor,
  checkCitations,
  checkNumericDirection,
  checkVehicleConflation,
  checkFailedRuleFraming,
  checkIdentifierIdentity,
  type ToolResultLedger,
} from './auditor';

const ledgerWith = (entries: ToolResultLedger['entries']): ToolResultLedger => ({ entries });

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
