import { describe, expect, it } from '@jest/globals';
import type { LedgerEntry } from '../grounding/auditor';
import {
  buildClaimLedgerFromToolResults,
  bindCitationToLedgerEntries,
  compareEvidenceClassification,
  evidenceFromToolResults,
  legacyAuthoritativeTool,
  legacyEvidenceClassForTool,
  legacyPrimaryTool,
  TOOL_EVIDENCE_PROFILES,
  type CitationLike,
} from './tool-ledger-adapter';

function citationFixture(
  tool: string,
  id = 'rec-1',
): { citations: CitationLike[]; ledgerEntries: LedgerEntry[] } {
  return {
    citations: [{ n: 1, tool, id }],
    ledgerEntries: [{ tool, serialized: `{"id":"${id}","ok":true}` }],
  };
}

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  return items[0] as T;
}

function profileEvidence(tool: string) {
  const { citations, ledgerEntries } = citationFixture(tool);
  return only(
    evidenceFromToolResults(ledgerEntries, citations, undefined, { classification: 'profiles' }),
  );
}

describe('profile evidence classification', () => {
  it('never promotes pending proposal text to primary or authoritative memory facts in either classification', () => {
    expect(profileEvidence('list_memory_proposals')).toMatchObject({ evidenceClass: 'capiro_system_of_record', primary: false, authoritative: false });
    expect(legacyEvidenceClassForTool('list_memory_proposals')).toBe('capiro_system_of_record');
    expect(legacyPrimaryTool('list_memory_proposals')).toBe(false);
    expect(legacyAuthoritativeTool('list_memory_proposals')).toBe(false);
  });
  const derivedTools = [
    'explain_opportunity_match',
    'get_opportunity_client_context',
    'get_opportunity_government_landscape',
    'compare_funding_opportunities',
    'build_opportunity_action_plan',
    'research_federal_market_strategy',
    'run_analysis',
    'search_capiro_data',
    'query_relationship_brief',
    'query_client_changes',
    'query_portfolio_changes',
    'research_external_company',
    'query_portfolio_overlap',
    'query_funding_opportunity_match',
    'get_district_nexus_context',
    'get_district_nexus_changes',
  ];

  it.each(derivedTools)('%s is Capiro-derived, non-primary, and non-authoritative', (tool) => {
    expect(profileEvidence(tool)).toMatchObject({
      evidenceClass: 'capiro_system_of_record',
      primary: false,
      authoritative: false,
    });
  });

  const officialTools: Array<[string, string]> = [
    ['get_bill_status', 'official_action_vote_status'],
    ['search_congress_bills', 'primary_legislative_legal_text'],
    ['get_pe_budget_timeline', 'official_budget_exhibit_mark_law'],
    ['get_committee_roster', 'committee_agency_guidance'],
    ['search_sam_opportunities', 'official_government_data'],
    ['search_funding_opportunities', 'official_government_data'],
    ['get_funding_opportunity', 'official_government_data'],
  ];

  it.each(officialTools)('%s is %s, primary, and authoritative', (tool, evidenceClass) => {
    expect(profileEvidence(tool)).toMatchObject({
      evidenceClass,
      primary: true,
      authoritative: true,
    });
  });

  it('keeps Capiro operational records self-authoritative', () => {
    expect(profileEvidence('get_client_context')).toMatchObject({
      evidenceClass: 'capiro_system_of_record',
      primary: true,
      authoritative: true,
    });
  });

  it('fails unknown tools closed', () => {
    expect(profileEvidence('some_future_unclassified_tool')).toMatchObject({
      evidenceClass: 'capiro_system_of_record',
      primary: false,
      authoritative: false,
    });
  });

  it('changes derived claim support while official support remains high-confidence', () => {
    const derived = citationFixture('explain_opportunity_match', 'opp-1');
    const derivedLedger = buildClaimLedgerFromToolResults({
      output: 'This opportunity matches the client profile [1].',
      ...derived,
      classification: 'profiles',
    });
    expect(only(derivedLedger.claims)).toMatchObject({
      primarySourcePresent: false,
      unsupportedReason:
        'The cited material is not authoritative enough to support this factual claim.',
      confidence: 'unknown',
    });

    const official = citationFixture('get_bill_status', 'bill-1');
    const officialLedger = buildClaimLedgerFromToolResults({
      output: 'The bill advanced [1].',
      ...official,
      classification: 'profiles',
    });
    expect(only(officialLedger.claims)).toMatchObject({
      primarySourcePresent: true,
      confidence: 'high',
    });
  });
});

describe('legacy evidence classification compatibility', () => {
  function oldEvidenceClass(tool: string) {
    if (
      /^(?:get_bill_status|get_state_bill_status|search_floor_votes|search_state_floor_votes|get_state_rule_status)$/.test(
        tool,
      )
    )
      return 'official_action_vote_status';
    if (/^(?:search_congress_bills|search_state_bills)$/.test(tool))
      return 'primary_legislative_legal_text';
    if (
      /^(?:get_pe_budget_timeline|get_program_element|get_pe_report_language|get_pe_bills|get_funding_positions)$/.test(
        tool,
      )
    )
      return 'official_budget_exhibit_mark_law';
    if (/^(?:query_regulatory_dockets|get_committee_roster)$/.test(tool))
      return 'committee_agency_guidance';
    if (
      /^(?:get_client_context|query_tasks|query_debriefs|query_outreach|list_emails|search_emails)$/.test(
        tool,
      )
    )
      return 'capiro_system_of_record';
    if (/^(?:search_memory|search_client_knowledge|read_client_documents)$/.test(tool))
      return 'institutional_memory';
    if (/^(?:search_public_web|scrape_web_page|search_intel_articles)$/.test(tool))
      return 'secondary_reporting';
    return 'official_government_data';
  }

  // The new proposal-state reader has no legacy fact-classification contract.
  const tools = [...Object.keys(TOOL_EVIDENCE_PROFILES).filter((name) => name !== 'list_memory_proposals'), 'unknown_tool', 'future_search', ''];
  it.each(tools)('%s exactly retains the pre-profile regex behavior', (tool) => {
    expect(legacyEvidenceClassForTool(tool)).toBe(oldEvidenceClass(tool));
    expect(legacyPrimaryTool(tool)).toBe(
      !/^(?:search_public_web|scrape_web_page|search_intel_articles|search_memory)$/.test(tool),
    );
    expect(legacyAuthoritativeTool(tool)).toBe(
      !/^(?:search_public_web|scrape_web_page|search_intel_articles|search_memory|query_knowledge_graph)$/.test(
        tool,
      ),
    );
  });

  it('default and explicit legacy ledgers are deeply identical on realistic tools', () => {
    const citations = [
      'search_capiro_data',
      'run_analysis',
      'get_bill_status',
      'search_public_web',
    ].map((tool, index) => ({ n: index + 1, tool, id: `id-${index + 1}` }));
    const ledgerEntries = citations.map(({ tool, id }) => ({
      tool,
      serialized: JSON.stringify({ id }),
    }));
    const input = {
      output:
        'Capiro found a match [1]. Analysis confirms it [2]. The bill advanced [3]. Reporting agrees [4].',
      ledgerEntries,
      citations,
    };
    expect(buildClaimLedgerFromToolResults(input)).toEqual(
      buildClaimLedgerFromToolResults({ ...input, classification: 'legacy' }),
    );
  });

  it('returns count-only comparison data when a derived source loses support', () => {
    const fixture = citationFixture('search_capiro_data', 'match-1');
    expect(
      compareEvidenceClassification({
        output: 'The client is a strong match [1].',
        ...fixture,
      }),
    ).toEqual({
      evidenceItems: 1,
      evidenceChanged: 1,
      toolsChanged: ['search_capiro_data'],
      claims: 1,
      claimSupportChanged: 1,
      claimConfidenceChanged: 1,
      primarySourcePresentChanged: 1,
    });
  });
});

describe('exact source-integrity binding', () => {
  it.each(['search_public_web', 'search_intel_articles'])(
    'keeps a discovered %s summary ineligible despite an authoritative-looking marker',
    (tool) => {
      const result = {
        data: [{ id: 'web-1', title: 'Official result', snippet: 'H.R. 1 passed.' }],
      };
      const ledger = buildClaimLedgerFromToolResults({
        output: 'H.R. 1 passed [1].',
        citations: [{ n: 1, tool, id: 'web-1' }],
        ledgerEntries: [{ tool, result, serialized: JSON.stringify(result) }],
      });
      expect(ledger.evidence[0]).toMatchObject({
        acquisitionState: 'discovered',
        primary: false,
        authoritative: false,
        ownerVerified: true,
      });
      expect(ledger.unsupportedClaimIds).toContain('sentence-1');
    },
  );

  it('does not reinterpret a document row without its owner envelope as a structured record', () => {
    const result = {
      clientId: 'client-1',
      records: [{ recordId: 'row-1', payload: { text: 'Orphaned document text.' } }],
    };
    expect(
      bindCitationToLedgerEntries(
        { n: 1, tool: 'read_client_documents', id: 'row-1' },
        [{ tool: 'read_client_documents', result, serialized: JSON.stringify(result) }],
        { expectedClientId: 'client-1' },
      ),
    ).toBeNull();
  });

  it.each([
    [
      'get_bill_status',
      { billId: '119-hr-1', found: true, title: 'H.R. 1', status: 'enacted' },
      '119-hr-1',
    ],
    [
      'query_tasks',
      {
        tool: 'query_tasks',
        total: 1,
        tasks: [{ id: 'task-1', title: 'Follow up', status: 'todo', clientId: 'client-1' }],
      },
      'task-1',
    ],
  ])('binds the actual %s owner shape as a consulted structured record', (tool, result, id) => {
    expect(
      bindCitationToLedgerEntries(
        { n: 1, tool, id },
        [{ tool, result, serialized: JSON.stringify(result) }],
        { expectedClientId: 'client-1' },
      ),
    ).toMatchObject({
      recordId: id,
      evidenceKind: 'structured_record',
      acquisitionState: 'consulted',
    });
  });

  it('does not bind an id found only inside another row or metadata blob', () => {
    const entry = {
      tool: 'get_bill_status',
      result: { metadata: { selectedId: 'bill-1' }, data: [{ id: 'bill-2', title: 'bill-1' }] },
      serialized: '{"metadata":{"selectedId":"bill-1"},"data":[{"id":"bill-2","title":"bill-1"}]}',
    };
    expect(
      bindCitationToLedgerEntries({ n: 1, tool: entry.tool, id: 'bill-1' }, [entry]),
    ).toBeNull();
  });

  it('binds one exact document row and rejects wrong client, document, and version receipts', () => {
    const result = {
      clientId: 'client-1',
      document: { id: 'doc-1', contentHash: 'version-1' },
      coverage: { complete: true },
      records: [
        { recordId: 'row-1', payload: { text: 'Exact consulted span.' } },
        { recordId: 'row-2', payload: { text: 'Wrong row.' } },
      ],
    };
    const entry = { tool: 'read_client_documents', result, serialized: JSON.stringify(result) };
    const citation = {
      n: 1,
      tool: entry.tool,
      id: 'row-1',
      documentEvidence: {
        clientId: 'client-1',
        documentId: 'doc-1',
        contentHash: 'version-1',
        record: result.records[0]!,
        coverage: result.coverage,
        observedAt: null,
      },
    };
    expect(
      bindCitationToLedgerEntries(citation, [entry], { expectedClientId: 'client-1' }),
    ).toMatchObject({
      recordId: 'row-1',
      text: 'Exact consulted span.',
      clientId: 'client-1',
      documentId: 'doc-1',
      version: 'version-1',
      evidenceKind: 'source_passage',
    });
    expect(
      bindCitationToLedgerEntries(citation, [entry], { expectedClientId: 'client-2' }),
    ).toBeNull();
    expect(
      bindCitationToLedgerEntries(
        { ...citation, documentEvidence: { ...citation.documentEvidence, contentHash: 'stale' } },
        [entry],
      ),
    ).toBeNull();
    expect(
      bindCitationToLedgerEntries(
        { ...citation, documentEvidence: { ...citation.documentEvidence, documentId: 'doc-2' } },
        [entry],
      ),
    ).toBeNull();
  });

  it('retains approved governed memory as a structured record, not a document passage', () => {
    const result = {
      records: [
        {
          recordId: 'memory-1',
          payload: {
            sourceKind: 'governed_memory',
            value: 'Approved client objective.',
            content: { hash: 'approved-v1' },
          },
        },
      ],
    };
    expect(
      bindCitationToLedgerEntries({ n: 1, tool: 'search_memory', id: 'memory-1' }, [
        { tool: 'search_memory', result, serialized: JSON.stringify(result) },
      ]),
    ).toMatchObject({
      evidenceKind: 'structured_record',
      recordId: 'memory-1',
      version: 'content:approved-v1',
      acquisitionState: 'consulted',
    });
  });
});
