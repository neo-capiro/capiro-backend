import { describe, expect, it } from '@jest/globals';
import type { LedgerEntry } from '../grounding/auditor';
import {
  buildClaimLedgerFromToolResults,
  evidenceFromToolResults,
  type CitationLike,
} from './tool-ledger-adapter';

/** One resolvable citation for `tool`/`id`, plus the ledger entry it resolves against. */
function citationFixture(
  tool: string,
  id = 'rec-1',
): { citations: CitationLike[]; ledgerEntries: LedgerEntry[] } {
  return {
    citations: [{ n: 1, tool, id }],
    ledgerEntries: [{ tool, serialized: `{"id":"${id}","ok":true}` }],
  };
}

/** Asserts exactly one item and returns it, so callers get a real value instead of `T | undefined`. */
function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  return items[0] as T;
}

describe('evidenceClassForTool / primaryTool / authoritativeTool (via evidenceFromToolResults)', () => {
  describe('Capiro-computed/derived tools are never primary or authoritative', () => {
    const derivedTools = [
      // Funding Opportunities (P37) — the tools found feeding claim confidence
      // as if they were official government records.
      'explain_opportunity_match',
      'get_opportunity_client_context',
      'get_opportunity_government_landscape',
      'compare_funding_opportunities',
      'build_opportunity_action_plan',
      // Research & strategy synthesis.
      'research_federal_market_strategy',
      'run_analysis',
      'search_capiro_data',
      // meriv2-orchestrator retrieval recipes that self-report their own name
      // as the citation tool (confirmed to leak into this exact path).
      'query_relationship_brief',
      'query_client_changes',
      'query_portfolio_changes',
      'research_external_company',
      'query_portfolio_overlap',
      'query_funding_opportunity_match',
    ];

    it.each(derivedTools)('%s is capiro_system_of_record, non-primary, non-authoritative', (tool) => {
      const { citations, ledgerEntries } = citationFixture(tool);
      const evidence = only(evidenceFromToolResults(ledgerEntries, citations));
      expect(evidence.evidenceClass).toBe('capiro_system_of_record');
      expect(evidence.primary).toBe(false);
      expect(evidence.authoritative).toBe(false);
    });
  });

  describe('independently-sourced tools stay authoritative (regression guard)', () => {
    const officialTools: Array<[tool: string, evidenceClass: string]> = [
      ['get_bill_status', 'official_action_vote_status'],
      ['search_congress_bills', 'primary_legislative_legal_text'],
      ['get_pe_budget_timeline', 'official_budget_exhibit_mark_law'],
      ['get_committee_roster', 'committee_agency_guidance'],
      // Previously fell through to the (buggy) default and happened to land
      // on the right class by accident; now explicit.
      ['search_sam_opportunities', 'official_government_data'],
      ['search_funding_opportunities', 'official_government_data'],
      ['get_funding_opportunity', 'official_government_data'],
    ];

    it.each(officialTools)('%s is %s, primary and authoritative', (tool, evidenceClass) => {
      const { citations, ledgerEntries } = citationFixture(tool);
      const evidence = only(evidenceFromToolResults(ledgerEntries, citations));
      expect(evidence.evidenceClass).toBe(evidenceClass);
      expect(evidence.primary).toBe(true);
      expect(evidence.authoritative).toBe(true);
    });

    it('get_client_context (Capiro\'s own operational record) stays primary and authoritative', () => {
      const { citations, ledgerEntries } = citationFixture('get_client_context');
      const evidence = only(evidenceFromToolResults(ledgerEntries, citations));
      expect(evidence.evidenceClass).toBe('capiro_system_of_record');
      expect(evidence.primary).toBe(true);
      expect(evidence.authoritative).toBe(true);
    });
  });

  it('an unrecognized tool name defaults to non-primary, non-authoritative — not official_government_data', () => {
    const { citations, ledgerEntries } = citationFixture('some_future_unclassified_tool');
    const evidence = only(evidenceFromToolResults(ledgerEntries, citations));
    expect(evidence.evidenceClass).toBe('capiro_system_of_record');
    expect(evidence.evidenceClass).not.toBe('official_government_data');
    expect(evidence.primary).toBe(false);
    expect(evidence.authoritative).toBe(false);
  });
});

describe('claim confidence calibration for Capiro-derived evidence (end-to-end)', () => {
  it('a factual claim citing only a Capiro-derived tool is unsupported, not high-confidence', () => {
    const { citations, ledgerEntries } = citationFixture('explain_opportunity_match', 'opp-1');
    const ledger = buildClaimLedgerFromToolResults({
      output: 'This opportunity matches the client profile [1].',
      ledgerEntries,
      citations,
    });
    const claim = only(ledger.claims);
    expect(claim.type).toBe('fact');
    expect(claim.primarySourcePresent).toBe(false);
    expect(claim.unsupportedReason).toBe(
      'The cited material is not authoritative enough to support this factual claim.',
    );
    expect(claim.confidence).toBe('unknown');
    expect(ledger.unsupportedClaimIds).toContain(claim.id);
  });

  it('the same factual claim shape citing an official record IS treated as high-confidence', () => {
    const { citations, ledgerEntries } = citationFixture('get_bill_status', 'bill-1');
    const ledger = buildClaimLedgerFromToolResults({
      output: 'This opportunity matches the client profile [1].',
      ledgerEntries,
      citations,
    });
    const claim = only(ledger.claims);
    expect(claim.primarySourcePresent).toBe(true);
    expect(claim.unsupportedReason).toBeUndefined();
    expect(claim.confidence).toBe('high');
  });
});
