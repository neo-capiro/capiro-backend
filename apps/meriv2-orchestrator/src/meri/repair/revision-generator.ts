import type { RevisionGenerator } from '@capiro/meriv2-core';
import type { RequestScopedLlmClient } from '../request-scoped-llm.client.js';

const REVISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['replacementText', 'citedEvidenceIds'],
  properties: {
    replacementText: { type: 'string' },
    citedEvidenceIds: { type: 'array', items: { type: 'string' } },
  },
};

export function createRevisionGenerator(
  llm: Pick<RequestScopedLlmClient, 'completeWithSchema'>,
  remainingMs: () => number,
): RevisionGenerator {
  return async (input, options) => {
    const timeoutMs = Math.max(1, Math.min(8_000, remainingMs()));
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('cancelled');
    const evidence = input.evidence.map((item) => ({
      id: item.id,
      passage: item.passage,
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      publishedAt: item.publishedAt ?? null,
      effectiveAt: item.effectiveAt ?? null,
      retrievedAt: item.retrievedAt ?? null,
      citationMarker: item.locator ?? null,
    }));
    const completion = llm.completeWithSchema({
      system: [
        'Revise only the affected claim and its listed dependent sentences.',
        'Use only the evidence passages supplied. Never invent a value.',
        'Return cited evidence ids separately. In replacementText, cite facts only with the corresponding citationMarker; never print an evidence id as a citation. Preserve unrelated text byte-for-byte.',
      ].join(' '),
      prompt: JSON.stringify({
        affectedText: input.affectedText,
        claim: input.claim.text,
        dependentSentences: input.dependentSentences,
        allowedEvidenceIds: input.allowedEvidenceIds,
        evidence,
      }),
      toolName: 'submit_claim_revision',
      toolDescription: 'Return a bounded claim-local replacement and the evidence ids it uses.',
      inputSchema: REVISION_SCHEMA,
      maxTokens: 1_024,
      timeoutMs,
      strict: true,
    });
    const result = await raceAbort(completion, options.signal);
    const parsed = result.input as { replacementText?: unknown; citedEvidenceIds?: unknown };
    if (typeof parsed.replacementText !== 'string' || !Array.isArray(parsed.citedEvidenceIds)) {
      throw new Error('revision_malformed');
    }
    const citedEvidenceIds = parsed.citedEvidenceIds.filter(
      (id): id is string => typeof id === 'string',
    );
    return { replacementText: parsed.replacementText, citedEvidenceIds };
  };
}

async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason ?? new Error('cancelled');
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
