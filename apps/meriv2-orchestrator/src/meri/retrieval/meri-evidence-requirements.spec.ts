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
  type CoverageGap,
  type CoverageGapStatus,
  type CoverageRequirement,
} from './meri-evidence-requirements';
import type { MeriToolCoverageReceipt } from '../meriv3/meriv3-turn-coverage';

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

function receipt(overrides: Partial<MeriToolCoverageReceipt> = {}): MeriToolCoverageReceipt {
  return {
    tool: 'read_source', source: 'source', status: 'complete', recordsReturned: 1, recordsEvaluated: 1,
    paginationComplete: true, truncated: false, ...overrides,
  };
}

function entry(tool: string, result: unknown): LedgerEntry {
  return { tool, result, serialized: JSON.stringify(result) };
}

const listing = {
  tool: 'read_client_documents', clientId: 'client-1',
  coverage: { total: 30, returned: 25, truncated: true, paginationComplete: false, complete: false },
  note: 'A file listing is not evidence that its contents have been read.',
  documents: [{ id: 'doc-1', fileName: 'transcript.txt', usable: true }, { id: 'doc-2', fileName: 'memo.pdf', usable: true }],
};
const contentRead = {
  tool: 'read_client_documents', clientId: 'client-1',
  document: { id: 'doc-1', fileName: 'transcript.txt', contentHash: 'abc' },
  coverage: { complete: true, truncated: false, section: 1, sectionCount: 1 },
  records: [{ recordId: 'doc-1:abc:1:0-40', payload: { text: 'The chair promised action on the bill.' } }],
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

  it('turns a document keyword without any concrete document into a non-essential hint only', () => {
    const requirements = buildCoverageRequirements({
      plan: plan(),
      request: 'Summarize the House Appropriations Committee report language on the CDAO line.',
      frame,
      clientId: null,
    });
    const document = requirements.filter((item) => item.template === 'transcript_summary');
    expect(document).toHaveLength(1);
    expect(document[0]).toMatchObject({ essential: false, requirementId: 'document-content.hint' });
    expect(document[0]?.route).toBeUndefined();
    // A hint never produces a follow-up or a residual limitation.
    const gaps = compareCoverage({ requirements, toolsUsed: [], receipts: [], ledgerEntries: [], citations: [] });
    expect(gaps[0]).toMatchObject({ status: 'never_called', essential: false, materiality: 'supplementary' });
    expect(planFollowUp({
      gaps, requirements, request: 'Summarize the report', frame,
      toolSchemas: [{ name: 'read_client_documents', readOnly: true, input_schema: { properties: { clientId: {}, documentId: {} }, required: ['clientId'] } }],
    })).toBeNull();
    expect(appendClaimTiedCoverageDisclosure('Answer.', gaps, requirements)).toBe('Answer.');
  });

  it('treats a selected document id with no candidate manifest as a non-essential hint, not a routed fetch', () => {
    // apps/api's only producer for selectedDocumentIds (meri.service.ts) forwards every attachment on the
    // current message; that content is already inlined into the turn's prompt, and the id lives in the
    // chat-attachment table, not the client-document space read_client_documents queries. Without a
    // candidate manifest to confirm the id names a real, separately fetchable document, requiring a
    // tool-based re-read is a guaranteed 404 (see the end-to-end case below) — so it must not be essential
    // or carry a route that would send planFollowUp after it.
    const requirements = buildCoverageRequirements({
      plan: plan(),
      request: 'Summarize it.',
      frame,
      selectedDocumentIds: ['doc-9'],
      clientId: 'client-1',
    });
    const docRequirements = requirements.filter((item) => item.template === 'transcript_summary');
    expect(docRequirements).toEqual([
      expect.objectContaining({ essential: false, requirementId: 'document-content.doc-9.hint' }),
    ]);
    expect(docRequirements[0]?.route).toBeUndefined();
    // Never called (nothing in this fixture calls read_client_documents), but non-essential — so it must
    // never be planned as a follow-up and never reach the reply as a disclosure.
    const gaps = compareCoverage({ requirements: docRequirements, toolsUsed: [], receipts: [], ledgerEntries: [], citations: [] });
    expect(gaps).toEqual([expect.objectContaining({ essential: false, status: 'never_called' })]);
    expect(planFollowUp({
      gaps,
      requirements: docRequirements,
      request: 'Summarize it.',
      frame,
      toolSchemas: [{ name: 'read_client_documents', readOnly: true, input_schema: { properties: { clientId: {}, documentId: {} }, required: ['clientId'] } }],
    })).toBeNull();
    expect(appendClaimTiedCoverageDisclosure('Answer.', gaps, docRequirements)).toBe('Answer.');
  });

  it('still creates an essential routed requirement for a selected id once a manifest confirms it names a real document', () => {
    const requirements = buildCoverageRequirements({
      plan: plan(),
      request: 'Summarize it.',
      frame,
      selectedDocumentIds: ['doc-9'],
      attachments: [{ id: 'doc-9', filename: 'memo.pdf', contentState: 'metadata_only', readable: false, kind: 'client_document' }],
      clientId: 'client-1',
    });
    expect(requirements.filter((item) => item.template === 'transcript_summary')).toEqual([
      expect.objectContaining({
        essential: true,
        requirementId: 'document-content.doc-9',
        route: expect.objectContaining({ documentId: 'doc-9', clientId: 'client-1' }),
      }),
    ]);
  });

  it('creates one essential requirement per document named in the request', () => {
    const requirements = buildCoverageRequirements({
      plan: plan(),
      request: 'Compare hearing.txt with memo.pdf and tell me our exposure.',
      frame,
      attachments: [
        { id: 'doc-1', filename: 'hearing.txt', contentState: 'ready', readable: true, kind: 'client_document' },
        { id: 'doc-2', filename: 'memo.pdf', contentState: 'ready', readable: true, kind: 'client_document' },
      ],
      clientId: 'client-1',
    });
    expect(requirements.filter((item) => item.template === 'transcript_summary').map((item) => item.route?.documentId)).toEqual(['doc-1', 'doc-2']);
    expect(requirements.every((item) => item.essential)).toBe(true);
  });

  it('keeps a pronoun-only reference non-essential', () => {
    const requirements = buildCoverageRequirements({
      plan: plan(),
      request: 'Summarize the report for me.',
      frame,
      attachments: [{ id: 'doc-1', filename: 'markup.pdf', contentState: 'ready', readable: true }],
      clientId: 'client-1',
    });
    expect(requirements.filter((item) => item.template === 'transcript_summary')).toEqual([
      expect.objectContaining({ essential: false, route: expect.objectContaining({ documentId: 'doc-1' }) }),
    ]);
  });
});

describe('coverage comparison', () => {
  it.each<[CoverageGapStatus, string[], unknown, unknown]>([
    ['never_called', [], [], undefined],
    ['called_no_usable_content', ['read_source'], [], { records: [] }],
    ['truncated', ['read_source'], [receipt({ status: 'partial', recordsReturned: 0, recordsEvaluated: 2, paginationComplete: false, truncated: true })], { records: [], coverage: { truncated: true } }],
    ['unavailable', ['read_source'], [receipt({ status: 'unavailable', recordsReturned: 0, recordsEvaluated: 0, paginationComplete: null })], { records: [] }],
    ['extraction_failed', ['read_source'], [receipt({ status: 'error', recordsReturned: 0, recordsEvaluated: 0, paginationComplete: null })], { error: 'extract failed' }],
    ['satisfied', ['read_source'], [receipt()], { records: [{ id: 'a', text: 'usable' }] }],
  ])('classifies %s', (status, toolsUsed, receipts, result) => {
    const ledgerEntries: LedgerEntry[] =
      result === undefined
        ? []
        : [entry('read_source', result)];
    expect(compareCoverage({
      requirements: [requirement],
      toolsUsed,
      receipts: receipts as MeriToolCoverageReceipt[],
      ledgerEntries,
      citations: [],
    })[0]?.status).toBe(status);
  });

  it('keeps usable evidence open while the matching read is incomplete, then closes on a later complete receipt', () => {
    const usable = entry('read_source', { records: [{ id: 'a', text: 'usable rows' }] });
    const partial = receipt({ status: 'partial', source: 'report', paginationComplete: false, truncated: true });
    const open = compareCoverage({
      requirements: [requirement],
      toolsUsed: ['read_source'],
      receipts: [partial],
      ledgerEntries: [usable],
      citations: [],
    });
    expect(open[0]).toMatchObject({ status: 'truncated', evidenceIds: ['a'] });

    const gaps = compareCoverage({
      requirements: [requirement],
      toolsUsed: ['read_source'],
      receipts: [
        partial,
        receipt({ source: 'other-source' }),
        receipt({ source: 'report' }),
        receipt({ status: 'error', recordsReturned: 0, paginationComplete: null }),
      ],
      ledgerEntries: [usable],
      citations: [],
    });
    expect(gaps[0]).toMatchObject({ status: 'satisfied', evidenceIds: ['a'] });
  });

  it('keeps explicit payload continuation metadata unresolved without a matching completion receipt', () => {
    const gaps = compareCoverage({
      requirements: [requirement],
      toolsUsed: ['read_source'],
      receipts: [],
      ledgerEntries: [entry('read_source', {
        records: [{ id: 'a', text: 'usable rows' }],
        coverage: { complete: false, hasMore: true, nextCursor: 'cursor-2' },
      })],
      citations: [],
    });
    expect(gaps[0]).toMatchObject({ status: 'truncated', evidenceIds: ['a'] });
  });

  it('treats a transcript filename without content as unusable', () => {
    expect(compareCoverage({
      requirements: [{ ...requirement, toolFamilies: ['read_client_documents'] }],
      toolsUsed: ['read_client_documents'],
      receipts: [],
      ledgerEntries: [entry('read_client_documents', { document: { id: 'doc-1', fileName: 'transcript.txt' }, records: [] })],
      citations: [],
    })[0]?.status).toBe('called_no_usable_content');
  });

  it('never lets a file listing satisfy a document-content requirement', () => {
    const routed: CoverageRequirement = {
      ...requirement, id: 'doc', requirementId: 'document-content.doc-1', toolFamilies: ['read_client_documents'],
      template: 'transcript_summary', route: { documentId: 'doc-1', documentName: 'transcript.txt', clientId: 'client-1' },
    };
    const hint: CoverageRequirement = { ...routed, id: 'hint', requirementId: 'document-content.hint', route: undefined };
    const gaps = compareCoverage({
      requirements: [routed, hint],
      toolsUsed: ['read_client_documents'],
      receipts: [receipt({ tool: 'read_client_documents', source: 'client_documents', status: 'partial', paginationComplete: false, truncated: true })],
      ledgerEntries: [entry('read_client_documents', listing)],
      citations: [],
    });
    expect(gaps.map((gap) => gap.status)).toEqual(['truncated', 'truncated']);
    expect(gaps[0]?.evidenceIds).toEqual([]);
  });

  it('is satisfied by a complete content read of the routed document after a truncated listing', () => {
    const routed: CoverageRequirement = {
      ...requirement, id: 'doc', requirementId: 'document-content.doc-1', toolFamilies: ['read_client_documents'],
      template: 'transcript_summary', route: { documentId: 'doc-1', documentName: 'transcript.txt', clientId: 'client-1' },
    };
    const other: CoverageRequirement = { ...routed, id: 'other', requirementId: 'document-content.doc-2', route: { documentId: 'doc-2' } };
    const gaps = compareCoverage({
      requirements: [routed, other],
      toolsUsed: ['read_client_documents'],
      receipts: [
        receipt({ tool: 'read_client_documents', source: 'client_documents', status: 'partial', paginationComplete: false, truncated: true }),
        receipt({ tool: 'read_client_documents', source: 'client_documents', status: 'complete', paginationComplete: null }),
      ],
      ledgerEntries: [entry('read_client_documents', listing), entry('read_client_documents', contentRead)],
      citations: [],
    });
    expect(gaps[0]).toMatchObject({ status: 'satisfied', evidenceIds: ['doc-1:abc:1:0-40'] });
    expect(gaps[1]?.status).toBe('called_no_usable_content');
  });

  it('matches chamber routes against the evidence actually retrieved', () => {
    const house: CoverageRequirement = { ...requirement, id: 'h', requirementId: 'house-senate-comparison.house', toolFamilies: ['get_pe_budget_timeline'], route: { chamber: 'house' } };
    const senate: CoverageRequirement = { ...house, id: 's', requirementId: 'house-senate-comparison.senate', route: { chamber: 'senate' } };
    const gaps = compareCoverage({
      requirements: [house, senate],
      toolsUsed: ['get_pe_budget_timeline'],
      receipts: [receipt({ tool: 'get_pe_budget_timeline', source: 'program_elements' })],
      ledgerEntries: [entry('get_pe_budget_timeline', { records: [{ id: '0603851F', stage: 'SAC-D', amount: 42 }] })],
      citations: [],
    });
    expect(gaps.map((gap) => gap.status)).toEqual(['called_no_usable_content', 'satisfied']);
  });
});

describe('coverage follow-up and disclosure', () => {
  const documentSchema = {
    name: 'read_client_documents',
    readOnly: true,
    input_schema: { type: 'object', properties: { clientId: { type: 'string' }, documentId: { type: 'string' }, query: {}, cursor: { type: 'string' } }, required: ['clientId'] },
  };
  function gap(requirementId: string, essential = true): CoverageGap {
    return { requirementId, essential, status: 'never_called', materiality: essential ? 'changes_answer' : 'supplementary', evidenceIds: [] };
  }

  it('plans every concrete essential read-only call up to the caller safety ceiling', () => {
    const gaps = [gap('house'), gap('senate'), gap('conference')];
    const requirements = gaps.map((item) => ({
      ...requirement,
      id: item.requirementId,
      requirementId: item.requirementId,
      essential: item.essential,
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
    expect(followUp?.calls).toHaveLength(3);
    expect(followUp?.calls.every((call) => call.arguments.peCode === '0603851F')).toBe(true);
  });

  it('fails closed for non-read-only tools and missing concrete routes', () => {
    expect(planFollowUp({
      gaps: [gap('x')],
      requirements: [{ ...requirement, requirementId: 'x' }],
      toolSchemas: [{ name: 'read_source', readOnly: false, input_schema: { required: ['id'], properties: { id: {} } } }],
      request: 'Get it',
      frame,
    })).toBeNull();
  });

  it('never plans a bare document listing for a content requirement without a document route', () => {
    const unrouted: CoverageRequirement = {
      ...requirement, requirementId: 'document-content.requested', toolFamilies: ['read_client_documents'], template: 'transcript_summary',
    };
    expect(planFollowUp({
      gaps: [gap('document-content.requested')],
      requirements: [unrouted],
      toolSchemas: [documentSchema],
      request: 'Review the Q3 compliance memo and tell me our exposure',
      frame,
    })).toBeNull();
  });

  it('plans a document read only with the concrete document id', () => {
    const routed: CoverageRequirement = {
      ...requirement, requirementId: 'document-content.doc-1', toolFamilies: ['read_client_documents'],
      template: 'transcript_summary', route: { documentId: 'doc-1', documentName: 'transcript.txt', clientId: 'client-1' },
    };
    const followUp = planFollowUp({ gaps: [gap('document-content.doc-1')], requirements: [routed], toolSchemas: [documentSchema], request: 'Summarize transcript.txt', frame });
    expect(followUp?.calls).toEqual([{
      name: 'read_client_documents',
      arguments: { clientId: 'client-1', documentId: 'doc-1' },
      requirementId: 'document-content.doc-1',
    }]);
  });

  it('retains the concrete route when planning continuation for an incomplete read', () => {
    const routed: CoverageRequirement = {
      ...requirement,
      requirementId: 'document-content.doc-1',
      toolFamilies: ['read_client_documents'],
      template: 'transcript_summary',
      route: { documentId: 'doc-1', clientId: 'client-1' },
    };
    const followUp = planFollowUp({
      gaps: [{ ...gap(routed.requirementId), status: 'truncated' }],
      requirements: [routed],
      toolSchemas: [documentSchema],
      request: 'Summarize transcript.txt',
      frame,
    });
    expect(followUp?.calls[0]?.arguments).toEqual({ clientId: 'client-1', documentId: 'doc-1' });
  });

  it('adds the latest concrete continuation cursor to a routed follow-up', () => {
    const routed: CoverageRequirement = {
      ...requirement,
      requirementId: 'document-content.doc-1',
      toolFamilies: ['read_client_documents'],
      template: 'transcript_summary',
      route: { documentId: 'doc-1', clientId: 'client-1' },
    };
    const followUp = planFollowUp({
      gaps: [{ ...gap(routed.requirementId), status: 'truncated' }],
      requirements: [routed],
      toolSchemas: [documentSchema],
      request: 'Summarize transcript.txt',
      frame,
      ledgerEntries: [entry('read_client_documents', {
        document: { id: 'doc-1' },
        coverage: { complete: false, nextCursor: 'page:5000' },
        records: [{ recordId: 'doc-1:0-5000', payload: { text: 'partial' } }],
      })],
    });
    expect(followUp?.calls[0]?.arguments).toEqual({
      clientId: 'client-1',
      documentId: 'doc-1',
      cursor: 'page:5000',
    });
  });

  it('adds one marker-free claim-tied limitation only for essential residual gaps', () => {
    const residual = gap(requirement.requirementId);
    const disclosed = appendClaimTiedCoverageDisclosure('Senate mark is $2.', [residual], [requirement]);
    expect(disclosed).toContain('House figure for CDAO');
    expect(disclosed).not.toMatch(/\[\d+\]/);
    expect(appendClaimTiedCoverageDisclosure('Answer.', [{ ...residual, essential: false }], [requirement])).toBe('Answer.');
  });
});
