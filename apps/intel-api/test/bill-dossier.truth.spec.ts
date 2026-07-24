import { billStatusLabel } from '@capiro/shared';
import { BillDossierService } from '../src/bill-dossier/bill-dossier.service.js';
import {
  HR_8800_ID,
  HR_8800_RULE_TALLY,
  HR_8800_RULE_VOTE_ID,
  makeHr8800SourceData,
} from './fixtures/hr-8800-rule-failed.fixture.js';

/**
 * Bill 360 truth-layer regression (§0.4, §6.3 Milestone A). H.R. 8800: a rule was
 * reported, the governing-rule vote FAILED, and there is NO floor vote on the bill.
 * The dossier must surface the failed-rule outcome + exact tally, state the absence
 * of a target-bill vote explicitly, and NEVER imply a pending floor vote.
 */
function buildService() {
  // Global route touches only SourceDataRepository — prisma + state repo unused.
  return new BillDossierService(
    {} as never,
    makeHr8800SourceData() as never,
    {} as never,
  );
}

describe('Bill 360 truth layer — H.R. 8800 failed governing rule', () => {
  it('reports a canonical stalled / rule_failed status (never fabricated)', async () => {
    const d = await buildService().getGlobalDossier(HR_8800_ID);
    expect(d.bill.stage).toBe('rule_failed');
    // Label is derived from the canonical status, not invented.
    expect(d.bill.statusLabel).toBe(billStatusLabel('rule_failed'));
    expect(d.bill.statusSev).toBe('critical');
  });

  it('returns the governing-rule failure with the exact tally', async () => {
    const d = await buildService().getGlobalDossier(HR_8800_ID);
    expect(d.governingRules).toHaveLength(1);
    const rule = d.governingRules[0]!;
    expect(rule.result).toBe('Failed');
    expect(rule.resultSev).toBe('critical');
    expect(rule.tally).toBe(HR_8800_RULE_TALLY);
    expect(rule.controls).toBe(true);
  });

  it('states the absence of a target-bill vote explicitly and never infers one', async () => {
    const d = await buildService().getGlobalDossier(HR_8800_ID);
    // No passage vote exists on the bill → explicit noVote string.
    expect(d.noVote).toBe('No roll call vote has been recorded on this bill.');
    // No passage-target vote is present…
    expect(d.votes.some((v) => v.target === 'passage')).toBe(false);
    // …but the failed rule vote IS surfaced as a recorded vote (target='rule').
    const ruleVote = d.votes.find((v) => v.target === 'rule');
    expect(ruleVote?.id).toBe(HR_8800_RULE_VOTE_ID);
    expect(ruleVote?.tally).toBe(HR_8800_RULE_TALLY);
  });

  it('never says "pending floor vote" anywhere in the dossier', async () => {
    const d = await buildService().getGlobalDossier(HR_8800_ID);
    const blob = JSON.stringify(d).toLowerCase();
    expect(blob).not.toContain('pending floor vote');
    // The official next step reflects the stalled rule, not an imagined vote.
    expect(d.overview.officialNextStep?.text ?? '').toMatch(/rule failed/i);
  });

  it('computes the party breakdown for the rule vote from member tallies', async () => {
    const d = await buildService().getGlobalDossier(HR_8800_ID);
    const ruleVote = d.votes.find((v) => v.target === 'rule');
    expect(ruleVote?.party).toEqual({ gopYea: 210, gopNay: 3, demYea: 1, demNay: 211 });
  });

  it('surfaces the failed rule as a "failed" milestone on the legislative path', async () => {
    const d = await buildService().getGlobalDossier(HR_8800_ID);
    expect(d.milestones.some((m) => m.state === 'failed')).toBe(true);
  });

  it('shows a grounded funding empty state (no $0) before funding data ships', async () => {
    const d = await buildService().getGlobalDossier(HR_8800_ID);
    expect(d.funding.available).toBe(false);
    expect(d.funding.positions).toEqual([]);
    // The empty-state copy is grounded (it explains no $0 is shown), and no
    // position row is fabricated with a zero amount.
    expect(d.funding.status).toMatch(/not yet enabled/i);
    expect(d.funding.positions.some((p) => p.amountMillions === 0)).toBe(false);
  });

  it('reflects the rule outcome in the "Latest recorded vote" KPI', async () => {
    const d = await buildService().getGlobalDossier(HR_8800_ID);
    const kpi = d.kpis.find((k) => k.label === 'Latest recorded vote')!;
    expect(kpi.value).toBe(`Failed ${HR_8800_RULE_TALLY}`);
  });
});
