import {
  createGeneratePublishedRecordBriefTool,
  publishedRecordInput,
} from './generate-published-record-brief';
import type { LlmClient } from '../../llm/llm-client';
import type { MeriContext } from '../../registry/types';
const ctx = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  clerkUserId: 'owner-a',
  role: 'standard_user',
} as MeriContext;
const input = publishedRecordInput.parse({
  mode: 'reconcile',
  eventId: 'event',
  title: 'Synthetic qualification',
  sourceSnapshotHash: 'snapshot',
  observations: [{ id: 'original', text: 'The bill passed.' }],
  records: [
    {
      id: 'vote',
      hash: 'v1',
      locator: 'record',
      text: 'The committee recommended the bill favorably.',
      billId: 'fl-2026-s0474',
      association: 'bill_context_only',
    },
  ],
  coverage: 'Exact synthetic source; event unconfirmed',
});
const claim = {
  id: 'atomic',
  parentClaimId: 'original',
  kind: 'fact',
  scope: 'bill_record',
  billId: 'fl-2026-s0474',
  text: 'The committee recommended the bill favorably.',
  section: 'developments',
  references: [{ id: 'vote', hash: 'v1', locator: 'record' }],
  outcome: 'supported',
  rationale: 'Exact recommendation; floor passage is a separate action.',
  supported: ['Recommendation'],
  unresolved: [],
};
const run = (claims: unknown[], extra = {}) =>
  createGeneratePublishedRecordBriefTool({
    completeWithSchema: async () => ({
      input: { claims },
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  } as unknown as LlmClient).handler({ ...input, ...extra }, ctx);
describe('published-record Meri output boundary', () => {
  it('preserves exact source and original observation references', async () => {
    expect((await run([claim])).claims[0]).toMatchObject(claim);
  });
  it('holds a model contradiction based only on amendments not marked adopted', async () => {
    const result = await run(
      [{ ...claim, outcome: 'contradicted', text: 'The amendment was adopted.' }],
      { records: [{ ...input.records[0], amendmentDisposition: 'not_marked_adopted' }] },
    );
    expect(result.claims[0]!.outcome).toBe('needs_review');
    expect(result.claims[0]!.rationale).toContain('not rejection');
    expect(result.claims[0]!.supported).toEqual([]);
  });
  it('treats a null parent as no association without accepting invented parents', async () => {
    expect(
      (await run([{ ...claim, parentClaimId: null }])).claims[0]!.parentClaimId,
    ).toBeUndefined();
  });
  it.each([
    [
      'unknown revision',
      { references: [{ id: 'vote', hash: 'different', locator: 'record' }] },
      'INVALID_PUBLISHED_RECORD_REFERENCE',
    ],
    [
      'unknown locator',
      { references: [{ id: 'vote', hash: 'v1', locator: 'page:999' }] },
      'INVALID_PUBLISHED_RECORD_REFERENCE',
    ],
    ['wrong bill', { billId: 'fl-2026-h1211' }, 'INVALID_PUBLISHED_RECORD_REFERENCE'],
    [
      'unsupported hearing association',
      { scope: 'hearing_event' },
      'UNQUALIFIED_HEARING_ASSOCIATION',
    ],
    [
      'invented quotation',
      { kind: 'quote', text: 'The legislature enacted the bill.' },
      'QUOTE_CHANGED_SOURCE_TEXT',
    ],
    ['lost original parent', { parentClaimId: 'not-the-original' }, 'UNKNOWN_OBSERVATION_CLAIM'],
    ['uncited consequential fact', { references: [] }, 'FACT_REQUIRES_RECORD_EVIDENCE'],
  ])('rejects %s', async (_name, edit, error) => {
    await expect(run([{ ...claim, ...edit }])).rejects.toThrow(error as string);
  });
  it('permits explicit uncertainty and unqualified evidence only for review', async () => {
    expect(
      (await run([{ ...claim, scope: 'hearing_event', outcome: 'needs_review' }])).claims[0]!
        .outcome,
    ).toBe('needs_review');
  });
  it('rejects duplicate claims and output over the bounded chunk budget', async () => {
    await expect(run([claim, claim])).rejects.toThrow('DUPLICATE_RECORD_CLAIM');
    await expect(run([claim, { ...claim, id: 'second' }], { maxClaims: 1 })).rejects.toThrow(
      'RECORD_OUTPUT_CLAIM_BUDGET_EXCEEDED',
    );
  });
  it('requires explicit observation and source limits at the authoritative tool schema', () => {
    expect(
      publishedRecordInput.safeParse({
        ...input,
        observations: Array.from({ length: 101 }, (_, i) => ({
          id: String(i),
          text: 'Observation',
        })),
      }).success,
    ).toBe(false);
    expect(
      publishedRecordInput.safeParse({
        ...input,
        records: [{ ...input.records[0], text: 'x'.repeat(20001) }],
      }).success,
    ).toBe(false);
  });
});
