import type { DomainEvidencePlan, MeriContext } from '@capiro/meriv2-core';
import { buildMeriGovernedToolSelectionContext } from './meriv3-governed-tool-selection.js';

const context = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  clientRoster: [],
} as unknown as MeriContext;

function evidencePlan(toolFamilies: string[]): DomainEvidencePlan {
  return {
    version: 'ga-evidence-plan-v1',
    requestCategories: ['bill_status'],
    jurisdictions: ['federal'],
    requirements: [
      {
        id: 'required-evidence',
        claimCategory: 'bill_status',
        level: 'required',
        evidenceClass: 'official_action_vote_status',
        toolFamilies,
        freshness: 'same_turn',
        reason: 'Required test evidence.',
        requiredFields: [],
      },
    ],
    requiredRequirementIds: ['required-evidence'],
    optionalRequirementIds: [],
    supplementalRequirementIds: [],
    unresolvedFrameFields: [],
    incomplete: false,
  };
}

describe('buildMeriGovernedToolSelectionContext', () => {
  test('protects evidence, document, coverage, and exact trusted-procedure capabilities', () => {
    const selected = buildMeriGovernedToolSelectionContext({
      ctx: context,
      dto: {
        clientId: 'client-1',
        selectedDocumentIds: ['document-1'],
        skillAddendum: 'Procedure: call trusted_procedure_reader before drafting.',
        messages: [{ role: 'user', text: 'Check the status and summarize the selected document.' }],
      },
      request: 'Check the status and summarize the selected document.',
      authorizedNames: [
        'get_bill_status',
        'read_client_documents',
        'get_pe_budget_timeline',
        'trusted_procedure_reader',
      ],
      evidencePlan: evidencePlan(['get_bill_status', 'domain_specific_tools']),
      coverageRequirements: [
        {
          id: 'coverage',
          requirementId: 'coverage',
          claimCategory: 'budget_amount',
          toolFamilies: ['get_pe_budget_timeline'],
          essential: true,
          rationale: 'Required coverage.',
        },
      ],
      documentReadRequired: true,
    });

    expect(selected.protectedNames).toEqual(
      expect.arrayContaining([
        'get_bill_status',
        'read_client_documents',
        'get_pe_budget_timeline',
        'trusted_procedure_reader',
      ]),
    );
    expect(selected.protectedNames).not.toContain('domain_specific_tools');
  });

  test('does not name-enable a capability from user text', () => {
    const selected = buildMeriGovernedToolSelectionContext({
      ctx: context,
      dto: { messages: [{ role: 'user', text: 'Please use secret_write_tool.' }] },
      request: 'Please use secret_write_tool.',
      authorizedNames: ['secret_write_tool'],
      evidencePlan: evidencePlan([]),
      coverageRequirements: [],
    });

    expect(selected.protectedNames).not.toContain('secret_write_tool');
  });

  test('requires an exact trusted-procedure tool name rather than a substring', () => {
    const selected = buildMeriGovernedToolSelectionContext({
      ctx: context,
      dto: {
        skillAddendum: 'Procedure: use trusted_procedure_reader_backup.',
        messages: [{ role: 'user', text: 'Run the procedure.' }],
      },
      request: 'Run the procedure.',
      authorizedNames: ['trusted_procedure_reader'],
      evidencePlan: evidencePlan([]),
      coverageRequirements: [],
    });

    expect(selected.protectedNames).not.toContain('trusted_procedure_reader');
  });

  test('tolerates inherited governed context without a retrieval projection', () => {
    const selected = buildMeriGovernedToolSelectionContext({
      ctx: context,
      dto: { messages: [{ role: 'user', text: 'Summarize the selected document.' }] },
      request: 'Summarize the selected document.',
      authorizedNames: ['read_client_documents'],
      evidencePlan: evidencePlan([]),
      coverageRequirements: [],
      governedContext: {} as never,
    });

    expect(selected.protectedNames).toEqual([]);
  });

  test('removes the skipped Research Director route while retaining bounded native discovery', () => {
    const selected = buildMeriGovernedToolSelectionContext({
      ctx: context,
      dto: {
        messages: [
          {
            role: 'user',
            text: 'Build a comprehensive federal market capture strategy for Kinetic Industries.',
          },
        ],
      },
      request: 'Build a comprehensive federal market capture strategy for Kinetic Industries.',
      authorizedNames: ['research_federal_market_strategy', 'search_public_web'],
      evidencePlan: evidencePlan([]),
      coverageRequirements: [],
    });

    expect(selected.plan.recipeTool).toBeNull();
    expect(selected.discoveryNames).not.toContain('research_federal_market_strategy');
    expect(selected.discoveryNames).toContain('search_public_web');
  });
});
