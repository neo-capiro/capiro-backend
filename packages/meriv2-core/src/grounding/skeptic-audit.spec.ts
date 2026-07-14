import {
  extractResidualClaims,
  buildResidualClaimPlan,
  runSkepticAudit,
  mergeSkepticFindings,
  resolveSkepticMode,
} from './skeptic-audit';
import { runClaimPlanGate } from './claim-gate';
import type { SkepticJudge } from './skeptic';
import type { AuditVerdict, ToolResultLedger } from './auditor';

const ledger: ToolResultLedger = {
  entries: [
    {
      tool: 'get_bill_status',
      serialized: '{"billId":"hr-8800-119","status":"rule_failed","title":"..."}',
    },
    { tool: 'get_pe_budget_timeline', serialized: '{"peCode":"0603851F","request":72.1}' },
  ],
};

const refuteAll: SkepticJudge = async () => ({
  refuted: true,
  confidence: 'high',
  reason: 'Evidence does not state this.',
});
const approveAll: SkepticJudge = async () => ({
  refuted: false,
  confidence: 'high',
  reason: 'Evidence literally states this.',
});

describe('extractResidualClaims — precision-first residual extraction', () => {
  it('escalates an assertive sentence anchored to a ledger-known entity', () => {
    const out = 'H.R. 8800 passed the House and now funds the program at $50 million annually.';
    expect(extractResidualClaims(out, ledger, [])).toHaveLength(1);
  });
  it('skips sentences about entities NOT in the ledger (D1/D14 territory, not skeptic)', () => {
    const out = 'H.R. 9999 passed the House and funds the program at $50 million annually.';
    expect(extractResidualClaims(out, ledger, [])).toEqual([]);
  });
  it('skips sentences a deterministic check already flagged', () => {
    const out = 'H.R. 8800 passed the House and now funds the program at $50 million annually.';
    const findings = [{ check: 'D6', severity: 'high' as const, span: out, detail: 'x' }];
    expect(extractResidualClaims(out, ledger, findings)).toEqual([]);
  });
  it('skips non-assertive / short sentences and respects the cap (money first)', () => {
    const out = [
      'H.R. 8800 is a bill.', // short, no assertion
      'PE 0603851F was zeroed in the HAC-D mark according to the committee.',
      'H.R. 8800 passed the House and now funds the effort at $50 million.',
    ].join('\n');
    const picked = extractResidualClaims(out, ledger, [], 1);
    expect(picked).toHaveLength(1);
    expect(picked[0]).toContain('$50 million'); // money-bearing preferred
  });
  it('returns nothing when the ledger is empty', () => {
    expect(
      extractResidualClaims('H.R. 8800 passed and funds $50 million.', { entries: [] }, []),
    ).toEqual([]);
  });
});

describe('claim-gate routing (the designed needs_skeptic channel, live)', () => {
  it('routes every residual to needs_skeptic — unregistered predicate', () => {
    const plan = buildResidualClaimPlan(['sentence one', 'sentence two'], 'alert');
    const gate = runClaimPlanGate(plan, []);
    expect(gate.needsSkeptic).toHaveLength(2);
    expect(gate.decision).toBe('approve_all'); // residuals never block deterministically
  });
});

describe('runSkepticAudit', () => {
  const out = 'H.R. 8800 passed the House and now funds the program at $50 million annually.';

  it('confident refutation → SK1 high finding', async () => {
    const res = await runSkepticAudit(
      { output: out, ledger, surface: 'alert', deterministicFindings: [] },
      refuteAll,
    );
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]!.check).toBe('SK1');
    expect(res.findings[0]!.severity).toBe('high');
  });
  it('supported claims produce no findings', async () => {
    const res = await runSkepticAudit(
      { output: out, ledger, surface: 'alert', deterministicFindings: [] },
      approveAll,
    );
    expect(res.findings).toEqual([]);
    expect(res.residuals).toHaveLength(1);
  });
  it('low-confidence refutations (incl. judge failures) are demoted, not findings', async () => {
    const failingJudge: SkepticJudge = async () => {
      throw new Error('LLM outage');
    };
    const res = await runSkepticAudit(
      { output: out, ledger, surface: 'alert', deterministicFindings: [] },
      failingJudge,
    );
    expect(res.findings).toEqual([]); // availability: an outage never holds a memo
    expect(res.lowConfidenceRefutations).toBe(1);
  });
});

describe('mergeSkepticFindings — one decision policy, never two', () => {
  const base: AuditVerdict = {
    mode: 'enforce',
    surface: 'alert',
    findings: [],
    topSeverity: null,
    decision: 'deliver',
  };
  it('re-derives hold on a blocking surface under enforce', () => {
    const merged = mergeSkepticFindings(base, [
      { check: 'SK1', severity: 'high', span: 's', detail: 'd' },
    ]);
    expect(merged.decision).toBe('hold');
    expect(merged.topSeverity).toBe('high');
  });
  it('stays deliver under shadow (skeptic findings observed, never acted on)', () => {
    const merged = mergeSkepticFindings({ ...base, mode: 'shadow' }, [
      { check: 'SK1', severity: 'high', span: 's', detail: 'd' },
    ]);
    expect(merged.decision).toBe('deliver');
  });
  it('no-op when there is nothing to merge', () => {
    expect(mergeSkepticFindings(base, [])).toBe(base);
  });
});

describe('resolveSkepticMode', () => {
  it('defaults to off; only shadow/enforce are accepted', () => {
    expect(resolveSkepticMode(undefined)).toBe('off');
    expect(resolveSkepticMode('')).toBe('off');
    expect(resolveSkepticMode('bogus')).toBe('off');
    expect(resolveSkepticMode('shadow')).toBe('shadow');
    expect(resolveSkepticMode('enforce')).toBe('enforce');
  });
});
