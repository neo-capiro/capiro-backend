import type {
  DomainEvidencePlan,
  GovernmentAffairsOperatingFrame,
  LedgerEntry,
} from '@capiro/meriv2-core';
import {
  appendClaimTiedCoverageDisclosure,
  buildCoverageRequirements,
  compareCoverage,
  planFollowUp,
  type CoverageGapStatus,
  type CoverageRequirement,
} from './meri-evidence-requirements';

const frame = {
  jurisdictions: ['federal'],
  missingRequired: [],
  clientId: 'client-1',
} as unknown as GovernmentAffairsOperatingFrame;

function plan(overrides: Partial<DomainEvidencePlan> = {}): DomainEvidencePlan {
  return {
    version: 'ga-evidence-plan-v1',
    requestCategories: ['general_background'],
    jurisdictions: ['federal'],
    requirements: [],
    requiredRequirementIds: [],
    optionalRequirementIds: [],
    supplementalRequirementIds: [],
    unresolvedFrameFields: [],
    incomplete: false,
    ...overrides,
  };
}

const requirement: CoverageRequirement = {
  id: 'req',
  requirementId: 'required.source',
  claimCategory: 'general_background',
  toolFamilies: ['read_source'],
  essential: true,
  rationale: 'House figure for CDAO was not retrieved from the committee report.',
};

describe('coverage requirements', () => {
  it.each([
    ['Compare House vs Senate marks for PE 0603851F', 'house_senate_comparison', 2],
    ['Compare HAC-D and SAC-D for PE 0603851F', 'house_senate_comparison', 2],
    ['Summarize the attached transcript', 'transcript_summary', 1],
    ['What is currently in production?', 'current_status', 1],
    ['What is PE 0603851F?', undefined, 0],
  ])('detects task templates: %s', (request, template, count) => {
    const requirements = buildCoverageRequirements({
      plan: plan(),
      request,
      frame,
      attachments: request.includes('transcript')
        ? [
            {
              id: 'doc-1',
              filename: 'transcript.txt',
              contentState: 'metadata_only',
              readable: false,
              selected: true,
            },
          ]
        : [],
      clientId: 'client-1',
    });
    expect(requirements.filter((item) => item.template === template)).toHaveLength(count);
  });

  it('includes every plan-required requirement before templates', () => {
    const requirements = buildCoverageRequirements({
      plan: plan({
        requirements: [
          {
            id: 'bill-status.official-status',
            claimCategory: 'bill_status',
            level: 'required',
            evidenceClass: 'official_action_vote_status',
            toolFamilies: ['get_bill_status'],
            freshness: 'same_turn',
            reason: 'Official status required.',
            requiredFields: ['status'],
          },
        ],
        requiredRequirementIds: ['bill-status.official-status'],
      }),
      request: 'Status of H.R. 1?',
      frame,
      clientId: null,
    });
    expect(requirements[0]).toEqual(expect.objectContaining({
      requirementId: 'bill-status.official-status',
      toolFamilies: ['get_bill_status'],
      essential: true,
    }));
  });
});

describe('coverage comparison', () => {
  it.each<[CoverageGapStatus, string[], unknown, unknown]>([
    ['never_called', [], [], undefined],
    ['called_no_usable_content', ['read_source'], [], { records: [] }],
    ['truncated', ['read_source'], [{ tool: 'read_source', status: 'partial', recordsReturned: 1, recordsEvaluated: 2, paginationComplete: false, truncated: true, source: 'source' }], { records: [{ id: 'a' }] }],
    ['unavailable', ['read_source'], [{ tool: 'read_source', status: 'unavailable', recordsReturned: 0, recordsEvaluated: 0, paginationComplete: null, truncated: false, source: 'source' }], { records: [] }],
    ['extraction_failed', ['read_source'], [{ tool: 'read_source', status: 'error', recordsReturned: 0, recordsEvaluated: 0, paginationComplete: null, truncated: false, source: 'source' }], { error: 'extract failed' }],
    ['satisfied', ['read_source'], [{ tool: 'read_source', status: 'complete', recordsReturned: 1, recordsEvaluated: 1, paginationComplete: true, truncated: false, source: 'source' }], { records: [{ id: 'a', text: 'usable' }] }],
  ])('classifies %s', (status, toolsUsed, receipts, result) => {
    const ledgerEntries: LedgerEntry[] =
      result === undefined
        ? []
        : [{ tool: 'read_source', result, serialized: JSON.stringify(result) }];
    expect(compareCoverage({
      requirements: [requirement],
      toolsUsed,
      receipts: receipts as never,
      ledgerEntries,
      citations: [],
    })[0]?.status).toBe(status);
  });

  it('treats a transcript filename without content as unusable', () => {
    expect(compareCoverage({
      requirements: [{ ...requirement, toolFamilies: ['read_client_documents'] }],
      toolsUsed: ['read_client_documents'],
      receipts: [],
      ledgerEntries: [{
        tool: 'read_client_documents',
        result: { document: { id: 'doc-1', fileName: 'transcript.txt' }, records: [] },
        serialized: '{}',
      }],
      citations: [],
    })[0]?.status).toBe('called_no_usable_content');
  });
});

describe('coverage follow-up and disclosure', () => {
  it('plans at most two concrete essential read-only calls', () => {
    const gaps = [
      { requirementId: 'house', essential: true, status: 'never_called' as const, materiality: 'changes_answer' as const, evidenceIds: [] },
      { requirementId: 'senate', essential: true, status: 'never_called' as const, materiality: 'changes_answer' as const, evidenceIds: [] },
      { requirementId: 'extra', essential: false, status: 'never_called' as const, materiality: 'supplementary' as const, evidenceIds: [] },
    ];
    const requirements = gaps.map((gap) => ({
      ...requirement,
      id: gap.requirementId,
      requirementId: gap.requirementId,
      essential: gap.essential,
      toolFamilies: ['get_pe_budget_timeline'],
    }));
    const followUp = planFollowUp({
      gaps,
      requirements,
      toolSchemas: [{
        name: 'get_pe_budget_timeline',
        readOnly: true,
        input_schema: { type: 'object', properties: { peCode: { type: 'string' } }, required: ['peCode'] },
      }],
      request: 'Compare House vs Senate for PE 0603851F',
      frame,
    });
    expect(followUp?.calls).toHaveLength(2);
    expect(followUp?.calls.every((call) => call.arguments.peCode === '0603851F')).toBe(true);
  });

  it('fails closed for non-read-only tools and missing concrete routes', () => {
    expect(planFollowUp({
      gaps: [{ requirementId: 'x', essential: true, status: 'never_called', materiality: 'changes_answer', evidenceIds: [] }],
      requirements: [{ ...requirement, requirementId: 'x' }],
      toolSchemas: [{ name: 'read_source', readOnly: false, input_schema: { required: ['id'], properties: { id: {} } } }],
      request: 'Get it',
      frame,
    })).toBeNull();
  });

  it('adds one marker-free claim-tied limitation only for essential residual gaps', () => {
    const gap = { requirementId: requirement.requirementId, essential: true, status: 'never_called' as const, materiality: 'changes_answer' as const, evidenceIds: [] };
    const disclosed = appendClaimTiedCoverageDisclosure('Senate mark is $2.', [gap], [requirement]);
    expect(disclosed).toContain('House figure for CDAO');
    expect(disclosed).not.toMatch(/\[\d+\]/);
    expect(appendClaimTiedCoverageDisclosure('Answer.', [{ ...gap, essential: false }], [requirement])).toBe('Answer.');
  });
});
