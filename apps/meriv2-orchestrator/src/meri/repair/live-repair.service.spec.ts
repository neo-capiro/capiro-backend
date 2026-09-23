import {
  JEV_TASK_REGISTRY,
  runCalibratedCascade,
  type DecisionProvider,
  type EvidenceDecision,
  type EvidenceEnvelope,
  type EvidenceQuestion,
  type LedgerEntry,
} from '@capiro/meriv2-core';
import { computeAiCostUsd } from '@capiro/shared';
import {
  applyLiveRepair,
  buildRepairDocumentReferences,
  JEV_COST_PER_INPUT_TOKEN_USD,
  sampled,
} from './live-repair.service';

const supported: EvidenceDecision = {
  kind: 'outcome', outcome: 'supported', confidence: 0.9,
  probabilities: { supported: 0.9, contradicted: 0.03, insufficient_evidence: 0.04, conflicting_evidence: 0.03 },
  reasonCodes: [], evidenceIds: [], provider: { name: 'fake', model: 'fake', questionVersion: 'claim_support.v1' }, latencyMs: 1,
};
const insufficient: EvidenceDecision = {
  ...supported, outcome: 'insufficient_evidence', confidence: 0.9,
  probabilities: { supported: 0.03, contradicted: 0.03, insufficient_evidence: 0.9, conflicting_evidence: 0.04 },
};
const lowConfidence: EvidenceDecision = { ...insufficient, confidence: 0.4 };
const failed: EvidenceDecision = {
  kind: 'failure', state: 'judge_unavailable', reasonCodes: ['failed'],
  provider: { name: 'fake', model: 'fake', questionVersion: 'claim_support.v1' }, latencyMs: 1,
};
const cascadeEnvelope: EvidenceEnvelope = {
  envelopeVersion: 'meri-evidence-envelope-v1', claimId: 'claim', claimText: 'Claim', claimKind: 'fact',
  claimCategory: 'general_background', tenantId: 'tenant', clientId: null, scopeQualifiers: [], asOf: null, sources: [],
};
const cascadeQuestion: EvidenceQuestion = { state: {}, questions: {} };
function provider(decision: EvidenceDecision): DecisionProvider {
  return { name: 'fake', available: () => true, assess: jest.fn(async () => decision) };
}
// Real read-only tool names: live repair classifies remedies with the shared capability registry.
const plan = {
  version: 'ga-evidence-plan-v1' as const, requestCategories: ['general_background' as const],
  jurisdictions: [], requirements: [{
    id: 'general', claimCategory: 'general_background' as const, level: 'required' as const,
    evidenceClass: 'official_government_data' as const, toolFamilies: ['get_bill_status'],
    freshness: 'same_turn' as const, reason: 'test', requiredFields: [],
  }], requiredRequirementIds: ['general'], optionalRequirementIds: [], supplementalRequirementIds: [],
  unresolvedFrameFields: [], incomplete: false,
};
const documentPlan = {
  ...plan, requestCategories: ['report_language' as const],
  requirements: [{ ...plan.requirements[0]!, id: 'document', claimCategory: 'report_language' as const, toolFamilies: ['read_client_documents'] }],
  requiredRequirementIds: ['document'],
};
const ledger = {
  version: 'ga-claim-ledger-v1' as const, claims: [], evidence: [], unsupportedClaimIds: [],
  conflictedClaimIds: [], highRiskUnsupportedClaimIds: [], requiredEvidenceGaps: [], hash: 'h',
};
const logger = { log: jest.fn(), warn: jest.fn() };
const evidenceE1 = {
  id: 'e1', sourceType: 'get_bill_status', sourceId: 'titan', evidenceClass: 'official_government_data' as const,
  passage: 'TITAN entered production.', primary: true, authoritative: true, requirementIds: [],
};
function claim(id: string, category: 'general_background' | 'bill_status' | 'report_language' = 'general_background', text?: string) {
  return {
    id, text: text ?? (id === 'promoted' ? 'TITAN is not in production.' : 'Unrelated content remains.'),
    sentenceIndex: 0, clauseIndex: 0, kind: 'fact' as const, category, markers: [], evidenceIds: [] as string[],
    uncited: true, compound: false, material: true, asOf: new Date().toISOString(),
  };
}
/** A conversation id whose deterministic sample never cascades the given claims to the legacy judge. */
function unsampledConversation(...claimIds: string[]): string {
  for (let index = 0; index < 200; index += 1) {
    const candidate = `conversation-${index}`;
    if (claimIds.every((id) => !sampled(candidate, id))) return candidate;
  }
  throw new Error('no unsampled conversation id');
}
function failingExecutor() {
  return { execute: jest.fn(async () => ({ ok: false as const, state: 'retrieval_failed' as const, reason: 'unavailable' })) };
}
function base(overrides: Record<string, unknown> = {}) {
  return {
    released: 'TITAN is not in production. Unrelated content remains.', claims: [claim('promoted'), claim('other', 'bill_status')],
    ledger, citations: [], passages: {}, evidencePlan: plan, tenantId: 'tenant', conversationId: 'conversation',
    providers: { jev: provider(insufficient), legacy: provider(supported) },
    executor: failingExecutor(),
    generate: jest.fn(async () => ({ replacementText: 'TITAN entered production.', citedEvidenceIds: [] })),
    promotedCategories: new Set(['general_background' as const]),
    budget: { maxPasses: 1 as const, maxToolCalls: 3, maxMs: 8_000, maxInputTokens: 60_000 },
    logger, ...overrides,
  };
}
function entry(tool: string, result: unknown): LedgerEntry {
  return { tool, result, serialized: JSON.stringify(result) };
}
const contentRead = entry('read_client_documents', {
  tool: 'read_client_documents', clientId: 'client-1',
  document: { id: 'doc-1', fileName: 'hearing.txt', contentHash: 'abc' },
  coverage: { complete: true, truncated: false },
  records: [{ recordId: 'doc-1:abc:1:0-38', payload: { text: 'The chair promised action on the bill.' } }],
});
const listing = entry('read_client_documents', {
  tool: 'read_client_documents', clientId: 'client-1',
  coverage: { total: 2, returned: 2, truncated: false },
  documents: [
    { id: 'doc-2', fileName: 'memo.pdf', usable: false, extractionStatus: 'failed' },
    { id: 'doc-3', fileName: 'budget.xlsx', usable: true, extractionStatus: 'ready' },
  ],
});

describe('live bounded repair', () => {
  it.each([
    ['Jev outcome without escalation', supported, null, supported],
    ['historically non-escalated conflict', { ...insufficient, outcome: 'conflicting_evidence' as const }, null,
      { ...insufficient, outcome: 'conflicting_evidence' as const }],
    ['legacy outcome wins', supported, insufficient, insufficient],
    ['legacy failure falls back to Jev outcome', supported, failed, supported],
    ['both providers fail returns legacy failure', failed, failed, failed],
    ['unavailable Jev returns legacy outcome', null, supported, supported],
  ])('preserves the original live-repair decision rule: %s', async (_label, jevDecision, legacyDecision, expected) => {
    // Independent copy of the original selectDecision removed by the refactor.
    const oldSelectDecision = (jev: EvidenceDecision | null, legacy: EvidenceDecision | null): EvidenceDecision => {
      if (legacy?.kind === 'outcome') return legacy;
      if (jev?.kind === 'outcome') return jev;
      return legacy ?? jev ?? failed;
    };
    const result = await runCalibratedCascade({
      claim: { id: 'claim', category: 'general_background', compound: legacyDecision !== null },
      jev: jevDecision === null ? null : provider(jevDecision),
      legacy: provider(legacyDecision ?? failed),
      envelope: cascadeEnvelope,
      question: cascadeQuestion,
      registration: {
        ...JEV_TASK_REGISTRY.claim_support,
        cascade: { ...JEV_TASK_REGISTRY.claim_support.cascade!, auditSampleRate: 0 },
      },
      sampleKey: 'equivalence',
      legacyLiveRepairCompatibility: true,
    });
    expect(result.decision).toEqual(oldSelectDecision(jevDecision, legacyDecision));
    expect(result.decision).toEqual(expected);
  });

  it('assesses only promoted categories and preserves unrelated text byte-identically', async () => {
    const result = await applyLiveRepair(base());
    expect(result.reply).toContain('Unrelated content remains.');
    expect(Object.keys(result.outcomes)).toEqual(['promoted']);
  });

  it('corrects a promoted claim after bounded evidence retrieval', async () => {
    const result = await applyLiveRepair(base({
      providers: { jev: provider(insufficient), legacy: provider(supported) },
      executor: { execute: jest.fn(async () => ({ ok: true as const, evidence: [evidenceE1] })) },
      generate: async () => ({ replacementText: 'TITAN entered production.', citedEvidenceIds: ['e1'] }),
    }));
    expect(result.reply).toBe('TITAN entered production. Unrelated content remains.');
    expect(result.toolCalls).toBeLessThanOrEqual(3);
    expect(result.passes).toBe(1);
    expect(result.metrics.repairs).toMatchObject({ attempted: 1, corrected: 1, qualified: 0, omitted: 0 });
  });

  it('deterministically samples exactly one tenth of stable claim ids', () => {
    const values = Array.from({ length: 1000 }, (_, index) => sampled('conversation', String(index)));
    expect(values.filter(Boolean).length).toBeGreaterThan(70);
    expect(values.filter(Boolean).length).toBeLessThan(130);
    expect(values).toEqual(Array.from({ length: 1000 }, (_, index) => sampled('conversation', String(index))));
  });

  it.each([
    ['low confidence', lowConfidence, false],
    ['compound claim', insufficient, true],
  ])('cascades %s assessments to the legacy provider', async (_label, jevDecision, compound) => {
    const legacy = provider(supported);
    await applyLiveRepair(base({
      claims: [{ ...claim('promoted'), compound }],
      providers: { jev: provider(jevDecision), legacy },
    }));
    expect(legacy.assess).toHaveBeenCalledTimes(1);
  });

  it('leaves a high-risk category untouched when it is not promoted', async () => {
    const executor = { execute: jest.fn() };
    const result = await applyLiveRepair(base({ claims: [claim('bill', 'bill_status')], executor }));
    expect(result.reply).toBe('TITAN is not in production. Unrelated content remains.');
    expect(result.outcomes).toEqual({});
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('does not retrieve or change the reply when both providers fail', async () => {
    const executor = { execute: jest.fn() };
    const result = await applyLiveRepair(base({
      providers: { jev: provider(failed), legacy: provider(failed) }, executor,
    }));
    expect(result.reply).toBe('TITAN is not in production. Unrelated content remains.');
    expect(executor.execute).not.toHaveBeenCalled();
  });

  describe('document references', () => {
    const documentClaim = claim('transcript', 'report_language', 'The transcript says the chair promised action.');
    const conversationId = unsampledConversation('transcript');

    it('reads a referenced readable document during repair instead of asking for it', async () => {
      const references = buildRepairDocumentReferences({
        ledgerEntries: [contentRead], citations: [], selectedDocumentIds: ['doc-1'], clientId: 'client-1',
      });
      const jev = provider(insufficient);
      const legacy = provider(supported);
      const executor = { execute: jest.fn(async () => ({ ok: true as const, evidence: [{
        ...evidenceE1, id: 'd1', sourceType: 'read_client_documents', sourceId: 'doc-1:abc:1:0-38',
        passage: 'The chair promised action on the bill.',
      }] })) };
      const result = await applyLiveRepair(base({
        released: `${documentClaim.text} Unrelated content remains.`, claims: [documentClaim], conversationId, clientId: 'client-1',
        promotedCategories: new Set(['report_language' as const]), providers: { jev, legacy }, executor, evidencePlan: documentPlan,
        generate: async () => ({ replacementText: 'The transcript shows the chair promised action on the bill.', citedEvidenceIds: ['d1'] }),
        documentReferences: references,
      }));
      expect(jev.assess).toHaveBeenCalledTimes(1);
      expect(executor.execute).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'read_client_documents', args: expect.objectContaining({ documentId: 'doc-1' }) }),
        expect.anything(),
      );
      expect(result.reply).toBe('The transcript shows the chair promised action on the bill. Unrelated content remains.');
      expect(result.metrics.repairs).toMatchObject({ attempted: 1, corrected: 1, documentRequested: 0 });
    });

    it('requests the named document, without provider or tool calls, when the turn knows it is unreadable', async () => {
      const references = buildRepairDocumentReferences({
        ledgerEntries: [listing], citations: [], selectedDocumentIds: ['doc-2'], clientId: 'client-1',
      });
      expect(references).toEqual([expect.objectContaining({ id: 'doc-2', filename: 'memo.pdf', readable: false, contentState: 'unsupported' })]);
      const jev = provider(insufficient);
      const legacy = provider(supported);
      const executor = failingExecutor();
      const result = await applyLiveRepair(base({
        released: `${documentClaim.text} Unrelated content remains.`, claims: [documentClaim], conversationId, clientId: 'client-1',
        promotedCategories: new Set(['report_language' as const]), providers: { jev, legacy }, executor, evidencePlan: documentPlan,
        documentReferences: references,
      }));
      expect(jev.assess).not.toHaveBeenCalled();
      expect(legacy.assess).not.toHaveBeenCalled();
      expect(executor.execute).not.toHaveBeenCalled();
      expect(result.reply).toBe(`To confirm “${documentClaim.text}”, attach the 'memo.pdf' transcript. Unrelated content remains.`);
      expect(result.metrics.repairs).toMatchObject({ attempted: 1, qualified: 1, documentRequested: 1 });
    });

    it('assesses a document-flavoured claim normally when the turn touched no document', async () => {
      const jev = provider(insufficient);
      const legacy = provider(supported);
      const executor = failingExecutor();
      const result = await applyLiveRepair(base({
        released: `${documentClaim.text} Unrelated content remains.`, claims: [documentClaim], conversationId,
        promotedCategories: new Set(['report_language' as const]), providers: { jev, legacy }, executor, evidencePlan: documentPlan,
        documentReferences: buildRepairDocumentReferences({ ledgerEntries: [entry('get_bill_status', { data: [] })], citations: [] }),
      }));
      expect(jev.assess).toHaveBeenCalledTimes(1);
      expect(result.reply).not.toMatch(/attach the/);
      expect(result.reply).toContain('Unrelated content remains.');
      expect(result.metrics.repairs.documentRequested).toBe(0);
    });
  });

  describe('deterministic short-circuit', () => {
    const amountLedger = {
      ...ledger,
      evidence: [{ id: 'e1', sourceType: 'get_pe_budget_timeline', sourceId: 'pe-1', evidenceClass: 'official_government_data' as const,
        primary: true, authoritative: true, requirementIds: [] }],
    };

    it('bypasses the judges only for an exact value contradicted by a passage bound to the claim', async () => {
      const bound = { ...claim('amount', 'general_background', 'The House mark is $42M.'), evidenceIds: ['e1'], uncited: false, markers: [1] };
      const jev = provider(insufficient);
      const legacy = provider(supported);
      const executor = failingExecutor();
      const result = await applyLiveRepair(base({
        released: `${bound.text} Unrelated content remains.`, claims: [bound], ledger: amountLedger,
        passages: { e1: { text: 'The House mark is $43M.' } }, providers: { jev, legacy }, executor,
        conversationId: unsampledConversation('amount'),
      }));
      expect(jev.assess).not.toHaveBeenCalled();
      expect(legacy.assess).not.toHaveBeenCalled();
      expect(result.outcomes).toEqual({ amount: 'contradicted' });
      expect(executor.execute).toHaveBeenCalledTimes(1);
      // A ledger-supported sentence is qualified, never deleted.
      expect(result.reply).toContain('The House mark is $42M');
      expect(result.reply).toContain('Unrelated content remains.');
    });

    it('routes an unbound exact value to the judges instead of declaring it insufficient', async () => {
      const uncited = claim('uncited', 'general_background', 'The House mark is $42M.');
      const jev = provider(insufficient);
      const executor = failingExecutor();
      const result = await applyLiveRepair(base({
        released: `${uncited.text} Unrelated content remains.`, claims: [uncited],
        providers: { jev, legacy: provider(supported) }, executor, conversationId: unsampledConversation('uncited'),
      }));
      expect(jev.assess).toHaveBeenCalledTimes(1);
      expect(result.outcomes).toEqual({ uncited: 'insufficient_evidence' });
      expect(result.reply).toContain('Unrelated content remains.');
    });
  });

  it('never plans a remedy through a mutating tool, even when the plan lists it first', async () => {
    const executor = { execute: jest.fn() };
    const result = await applyLiveRepair(base({
      evidencePlan: { ...plan, requirements: [{ ...plan.requirements[0]!, toolFamilies: ['save_note', 'get_bill_status'] }] },
      executor,
    }));
    expect(executor.execute).not.toHaveBeenCalled();
    expect(result.reply).toContain('Unrelated content remains.');
    expect(result.reply).toContain('Evidence limitation for “TITAN is not in production”');
    expect(result.metrics.repairs).toMatchObject({ attempted: 1, qualified: 1, omitted: 0 });
  });

  it('reports one terminal outcome per attempted claim', async () => {
    const second = claim('second', 'general_background', 'Senate funding is 30.');
    const executor = { execute: jest.fn(async (call: { args: Record<string, unknown> }) =>
      (call.args.claimIds as string[])[0] === 'promoted'
        ? { ok: true as const, evidence: [evidenceE1] }
        : { ok: true as const, evidence: [] }) };
    const result = await applyLiveRepair(base({
      released: 'TITAN is not in production. Senate funding is 30. Unrelated content remains.',
      claims: [claim('promoted'), second], conversationId: unsampledConversation('promoted', 'second'),
      providers: { jev: provider(insufficient), legacy: provider(supported) }, executor,
      generate: async () => ({ replacementText: 'TITAN entered production.', citedEvidenceIds: ['e1'] }),
    }));
    expect(result.metrics.repairs).toMatchObject({ attempted: 2, corrected: 1, qualified: 0, omitted: 0 });
    expect(result.metrics.unresolved).toBe(1);
    expect(result.metrics.claimOutcomes).toEqual([
      { claimId: 'promoted', outcome: 'corrected' },
      { claimId: 'second', outcome: 'unresolved', reason: 'no_new_evidence' },
    ]);
    expect(result.reply).toBe('TITAN entered production. Senate funding is 30. Unrelated content remains.');
  });

  it('prices Jev tokens at the Jev rate and judge, recheck and revision tokens at the LLM rate', async () => {
    const jevDecision: EvidenceDecision = { ...insufficient, usage: { inputTokens: 1000, outputTokens: 10 } };
    const legacyDecision: EvidenceDecision = { ...supported, usage: { inputTokens: 500, outputTokens: 5 } };
    const result = await applyLiveRepair(base({
      providers: { jev: provider(jevDecision), legacy: provider(legacyDecision) },
      executor: { execute: jest.fn(async () => ({ ok: true as const, evidence: [evidenceE1] })) },
      generate: async () => ({ replacementText: 'TITAN entered production.', citedEvidenceIds: ['e1'], usage: { inputTokens: 300, outputTokens: 50 } }),
      pricing: { llmModel: 'gpt-4.1-mini' },
    }));
    expect(result.metrics).toMatchObject({ jevInputTokens: 1000, recheckInputTokens: 500, revisionInputTokens: 300, revisionOutputTokens: 50 });
    const expected = 1000 * JEV_COST_PER_INPUT_TOKEN_USD
      + computeAiCostUsd('gpt-4.1-mini', result.metrics.legacyInputTokens + 500 + 300, 50);
    expect(result.metrics.estimatedCostUsd).toBeCloseTo(expected, 12);
    expect(result.metrics.estimatedCostUsd).toBeGreaterThan(result.metrics.inputTokens * JEV_COST_PER_INPUT_TOKEN_USD);
  });

  it('returns the original reply on external abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await applyLiveRepair(base({ signal: controller.signal }));
    expect(result.reply).toBe('TITAN is not in production. Unrelated content remains.');
    expect(result.toolCalls).toBe(0);
  });

  it('starts neither Jev nor legacy when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const jev = provider(insufficient);
    const legacy = provider(supported);
    await applyLiveRepair(base({ signal: controller.signal, providers: { jev, legacy } }));
    expect(jev.assess).not.toHaveBeenCalled();
    expect(legacy.assess).not.toHaveBeenCalled();
  });

  it('never retrieves or changes the reply in shadow mode and reports no attempt', async () => {
    const executor = { execute: jest.fn() };
    const result = await applyLiveRepair(base({ mode: 'shadow', executor }));
    expect(result.reply).toBe('TITAN is not in production. Unrelated content remains.');
    expect(executor.execute).not.toHaveBeenCalled();
    expect(result.metrics.repairs).toMatchObject({ attempted: 0, corrected: 0, qualified: 0, omitted: 0 });
    expect(result.metrics.wouldAttempt).toBe(1);
  });

  it('is an identity operation in off mode', async () => {
    const executor = { execute: jest.fn() };
    const result = await applyLiveRepair(base({ mode: 'off', executor }));
    expect(result).toMatchObject({ reply: 'TITAN is not in production. Unrelated content remains.', changed: false, toolCalls: 0, passes: 0 });
    expect(executor.execute).not.toHaveBeenCalled();
  });
});

describe('buildRepairDocumentReferences', () => {
  it('returns nothing when the turn touched no document', () => {
    expect(buildRepairDocumentReferences({ ledgerEntries: [entry('get_bill_status', { data: [{ id: 'x' }] })], citations: [] })).toEqual([]);
  });

  it('describes a content read as readable with its passage ids and a listing row as metadata only', () => {
    const references = buildRepairDocumentReferences({
      ledgerEntries: [contentRead, listing],
      citations: [{ id: 'doc-1:abc:1:0-38', n: 1, tool: 'read_client_documents', type: 'document', title: 'hearing.txt', stableId: 'stable-1',
        documentEvidence: { clientId: 'client-1', documentId: 'doc-1', contentHash: 'abc', record: {}, coverage: {}, observedAt: null } } as never],
      selectedDocumentIds: ['doc-3'],
      request: 'Summarize hearing.txt',
      clientId: 'client-1',
    });
    expect(references).toEqual([
      expect.objectContaining({
        kind: 'client_document', id: 'doc-1', filename: 'hearing.txt', version: 'abc', readable: true, contentState: 'ready',
        relevantPassageIds: ['doc-1:abc:1:0-38', 'stable-1'], resolution: 'filename', clientId: 'client-1', requestedClientId: 'client-1',
      }),
      expect.objectContaining({
        kind: 'client_document', id: 'doc-3', filename: 'budget.xlsx', readable: true, contentState: 'indexed_or_extracted',
        relevantPassageIds: [], resolution: 'explicit_id',
      }),
    ]);
  });

  it('keeps a partially read document readable and marks an empty extraction failed', () => {
    const partial = entry('read_client_documents', {
      tool: 'read_client_documents', clientId: 'client-1', document: { id: 'doc-4', fileName: 'long.pdf', contentHash: 'h4' },
      coverage: { complete: false, nextCursor: 'page:2' },
      records: [{ recordId: 'doc-4:h4:1:0-10', payload: { text: 'Page one.' } }],
    });
    const empty = entry('read_client_documents', {
      tool: 'read_client_documents', clientId: 'client-1', document: { id: 'doc-5', fileName: 'scan.pdf', contentHash: 'h5' },
      coverage: { extractedSectionEmpty: true, continuationBlocked: true, missingContent: true },
      records: [],
    });
    expect(buildRepairDocumentReferences({ ledgerEntries: [partial, empty], citations: [], clientId: 'client-1' })).toEqual([
      expect.objectContaining({ id: 'doc-4', readable: true, contentState: 'partial' }),
      expect.objectContaining({ id: 'doc-5', readable: false, contentState: 'failed' }),
    ]);
  });
});
