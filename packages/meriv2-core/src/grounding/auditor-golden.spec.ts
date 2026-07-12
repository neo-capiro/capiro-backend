/**
 * GOLDEN FIXTURES — the three fact-checked hallucination incidents that opened
 * this whole effort, encoded as regression tests against the shipped auditor
 * (v3 plan Wave 5 "golden fixtures (3 incidents)" + Phase 4 success metric).
 *
 * Each fixture is (a) an output span close to what actually shipped to a client,
 * and (b) the same-turn ToolResultLedger reflecting the TRUE data. The assertion
 * is that the deterministic auditor CATCHES the incident-specific error class.
 *
 * HONEST COVERAGE BOUNDARY: the Wave-2-Phase-A kernel ships D1/D4b/D6/D7. The
 * incident errors those cover are asserted below. The remaining incident errors
 * (reversed comparison → D4, wrong-PE plus-up → D9, member↔district → D11,
 * 0-result fabrication → skeptic) are marked `it.todo` — they are covered by the
 * shadow-gated / later-wave checks, and this file is where they get switched from
 * todo to assertion as those land. Coverage is a tracked metric, never implied.
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

  // The headline S1-3 error: "$112.9M current vs $72.1M request" narrated as a
  // REDUCTION (a raise called a cut). Needs D4 (direction re-derived from the
  // ledger's signed delta) — shadow-gated Wave-2 remainder.
  it.todo('D4 catches the reversed current-vs-request comparison (S1-3)');
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

  // S2-11 wrong-PE plus-up attribution needs D9 (|stage−request|≈X on the claimed
  // PE then siblings) — a later-wave check.
  it.todo('D9 catches the plus-up attributed to the wrong PE (S2-11)');
});

describe('GOLDEN — Sample 3: Deep-research memo (self-audited against nothing)', () => {
  // The critical S3-1 error: a member↔district mapping (Rogers / AL-05) inferred,
  // not retrieved. Needs D11 (get_representation/resolve_entity) — later wave.
  it.todo('D11 catches the fabricated member↔district mapping (S3-1)');
  // S3-3/4/5/12: specific claims asserted over 0-result / unretrieved evidence
  // (fabricated staffer contact, invented section numbers) — needs the LLM
  // skeptic + 0-result telemetry, shadow-gated.
  it.todo('Skeptic + 0-result telemetry catch the fabricated staffer/section specifics (S3-3/4/5)');
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
