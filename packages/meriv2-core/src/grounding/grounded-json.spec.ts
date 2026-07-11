import { z } from 'zod';
import {
  checkGroundedCitations,
  generateGroundedJson,
  type GroundedClaim,
  type GroundedEvidence,
} from './grounded-json';
import type { LlmClient } from '../llm/llm-client';

const EVIDENCE: GroundedEvidence[] = [
  { id: 'e1', text: 'The committee voted 12-8 to advance the bill.' },
  { id: 'e2', text: 'The sponsor is Rep. Jane Doe of the 4th district.' },
];

describe('checkGroundedCitations', () => {
  it('keeps a claim whose quoted substring appears verbatim in its cited evidence', () => {
    const claims: GroundedClaim[] = [
      { text: 'The committee "voted 12-8 to advance the bill."', evidenceIds: ['e1'] },
    ];
    const { kept, dropped } = checkGroundedCitations(claims, EVIDENCE);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('drops a claim citing an evidence id that does not exist', () => {
    const claims: GroundedClaim[] = [{ text: 'Some fact.', evidenceIds: ['e999'] }];
    const { kept, dropped } = checkGroundedCitations(claims, EVIDENCE);
    expect(kept).toHaveLength(0);
    expect(dropped).toEqual([{ claim: claims[0], reason: 'unknown_evidence_id' }]);
  });

  it('drops a claim citing zero evidence — never guesses grounding', () => {
    const claims: GroundedClaim[] = [{ text: 'An unsupported assertion.', evidenceIds: [] }];
    const { dropped } = checkGroundedCitations(claims, EVIDENCE);
    expect(dropped).toEqual([{ claim: claims[0], reason: 'no_evidence_cited' }]);
  });

  it('PINNED: drops a claim whose quoted text does NOT appear verbatim in its cited evidence (a fabricated quote)', () => {
    const claims: GroundedClaim[] = [
      { text: 'The committee "voted unanimously to reject it."', evidenceIds: ['e1'] },
    ];
    const { kept, dropped } = checkGroundedCitations(claims, EVIDENCE);
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.reason).toBe('quote_not_found_in_evidence');
    expect(dropped[0]?.quote).toBe('voted unanimously to reject it.');
  });

  it('a claim with no quoted substrings passes on evidence-id validity alone', () => {
    const claims: GroundedClaim[] = [
      { text: 'The bill advanced out of committee.', evidenceIds: ['e1'] },
    ];
    const { kept } = checkGroundedCitations(claims, EVIDENCE);
    expect(kept).toHaveLength(1);
  });

  it("checks a quote against ALL of a claim's cited evidence, not just the first", () => {
    const claims: GroundedClaim[] = [
      { text: 'Rep. "Jane Doe" sponsored it.', evidenceIds: ['e1', 'e2'] },
    ];
    const { kept } = checkGroundedCitations(claims, EVIDENCE);
    expect(kept).toHaveLength(1);
  });

  it('PINNED (W3.2): a FABRICATED quote written with SMART/CURLY quotes is dropped (fails HEAD — the old extractor only saw straight quotes)', () => {
    // Before W3.2 the extractor regex matched only straight quotes, so a
    // fabricated quotation rendered with U+201C/U+201D was never extracted and
    // silently passed the gate. Normalizing curly→straight before extraction
    // catches it.
    const claims: GroundedClaim[] = [
      { text: 'The committee “voted unanimously to reject it.”', evidenceIds: ['e1'] },
    ];
    const { kept, dropped } = checkGroundedCitations(claims, EVIDENCE);
    expect(kept).toHaveLength(0);
    expect(dropped[0]?.reason).toBe('quote_not_found_in_evidence');
  });

  it('PINNED (W3.2): a GENUINE quote survives a straight-vs-curly mismatch (model curly-quotes text the evidence stores with straight quotes)', () => {
    const claims: GroundedClaim[] = [
      { text: 'The committee “voted 12-8 to advance the bill.”', evidenceIds: ['e1'] },
    ];
    const { kept } = checkGroundedCitations(claims, EVIDENCE);
    expect(kept).toHaveLength(1);
  });

  it('W3.2: a genuine quote survives when the EVIDENCE is the curly-quoted side', () => {
    const curlyEvidence: GroundedEvidence[] = [
      { id: 'c1', text: 'The chair said “we will advance this bill.”' },
    ];
    const claims: GroundedClaim[] = [
      { text: 'The chair said "we will advance this bill."', evidenceIds: ['c1'] },
    ];
    const { kept } = checkGroundedCitations(claims, curlyEvidence);
    expect(kept).toHaveLength(1);
  });
});

const Schema = z.object({
  headline: z.string(),
  claims: z.array(z.object({ text: z.string(), evidenceIds: z.array(z.string()) })),
});
type Brief = z.infer<typeof Schema>;

function fakeLlm(responses: Array<{ input: unknown } | Error>): LlmClient {
  let call = 0;
  return {
    completeJson: async () => ({}),
    completeWithSchema: async () => {
      const r = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (!r || r instanceof Error) throw r ?? new Error('no fake response configured');
      return { input: r.input, usage: { inputTokens: 100, outputTokens: 40 } };
    },
  };
}

const FALLBACK: Brief = { headline: 'fallback', claims: [] };

// W3.2 / D-10: extract + remove are now one sub-object (compile-time impossible
// to supply one without the other). Shared across the tests that check claims.
const claimsHooks = {
  extract: (d: Brief) => d.claims,
  remove: (d: Brief, dropped: GroundedClaim[]) => ({
    ...d,
    claims: d.claims.filter((c) => !dropped.some((x) => x.text === c.text)),
  }),
};

describe('generateGroundedJson', () => {
  it('PINNED: a valid first attempt passes, no retry, citation check keeps a grounded claim', async () => {
    const llm = fakeLlm([
      {
        input: {
          headline: 'Committee advances bill',
          claims: [
            { text: 'The committee "voted 12-8 to advance the bill."', evidenceIds: ['e1'] },
          ],
        },
      },
    ]);
    const out = await generateGroundedJson({
      llm,
      system: 'sys',
      prompt: 'prompt',
      toolName: 'emit_brief',
      toolDescription: 'desc',
      inputSchema: {},
      schema: Schema,
      evidence: EVIDENCE,
      claims: claimsHooks,
      fallback: FALLBACK,
    });
    expect(out.validationStatus).toBe('passed');
    expect(out.usedFallback).toBe(false);
    expect(out.attempts).toBe(1);
    expect(out.droppedClaims).toHaveLength(0);
    expect(out.data.headline).toBe('Committee advances bill');
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 40 });
  });

  it('retries ONCE when the first attempt fails schema validation, and accumulates usage across both calls', async () => {
    const llm = fakeLlm([
      { input: { headline: 123, claims: 'not an array' } }, // fails schema
      { input: { headline: 'Retried OK', claims: [] } },
    ]);
    const out = await generateGroundedJson({
      llm,
      system: 'sys',
      prompt: 'prompt',
      toolName: 'emit_brief',
      toolDescription: 'desc',
      inputSchema: {},
      schema: Schema,
      evidence: EVIDENCE,
      claims: claimsHooks,
      fallback: FALLBACK,
    });
    expect(out.validationStatus).toBe('passed');
    expect(out.attempts).toBe(2);
    expect(out.data.headline).toBe('Retried OK');
    expect(out.usage).toEqual({ inputTokens: 200, outputTokens: 80 });
  });

  it('PINNED: falls back to the deterministic value when BOTH attempts fail validation — never fabricates a passing result', async () => {
    const llm = fakeLlm([
      { input: { headline: 1, claims: 'x' } },
      { input: { headline: 2, claims: 'y' } },
    ]);
    const out = await generateGroundedJson({
      llm,
      system: 'sys',
      prompt: 'prompt',
      toolName: 'emit_brief',
      toolDescription: 'desc',
      inputSchema: {},
      schema: Schema,
      evidence: EVIDENCE,
      claims: claimsHooks,
      fallback: FALLBACK,
    });
    expect(out.validationStatus).toBe('failed');
    expect(out.usedFallback).toBe(true);
    expect(out.attempts).toBe(2);
    expect(out.data).toEqual(FALLBACK);
    expect(out.droppedClaims).toHaveLength(0);
  });

  it('calls the lazy fallback producer (not a static value) when both attempts fail', async () => {
    const llm = fakeLlm([{ input: { headline: 1 } }, { input: { headline: 2 } }]);
    const fallbackFn = jest.fn(() => ({ headline: 'produced', claims: [] }) as Brief);
    const out = await generateGroundedJson({
      llm,
      system: 'sys',
      prompt: 'prompt',
      toolName: 'emit_brief',
      toolDescription: 'desc',
      inputSchema: {},
      schema: Schema,
      evidence: EVIDENCE,
      claims: claimsHooks,
      fallback: fallbackFn,
    });
    expect(fallbackFn).toHaveBeenCalledTimes(1);
    expect(out.data.headline).toBe('produced');
  });

  it('PINNED: a fabricated quote is stripped from the returned data via claims.remove, and reported in droppedClaims', async () => {
    const llm = fakeLlm([
      {
        input: {
          headline: 'Brief',
          claims: [
            { text: 'The committee "voted 12-8 to advance the bill."', evidenceIds: ['e1'] },
            { text: 'The sponsor "single-handedly wrote the whole bill."', evidenceIds: ['e2'] },
          ],
        },
      },
    ]);
    const out = await generateGroundedJson({
      llm,
      system: 'sys',
      prompt: 'prompt',
      toolName: 'emit_brief',
      toolDescription: 'desc',
      inputSchema: {},
      schema: Schema,
      evidence: EVIDENCE,
      claims: claimsHooks,
      fallback: FALLBACK,
    });
    expect(out.validationStatus).toBe('passed');
    expect(out.droppedClaims).toHaveLength(1);
    expect(out.droppedClaims[0]?.reason).toBe('quote_not_found_in_evidence');
    expect(out.data.claims).toHaveLength(1);
    expect(out.data.claims[0]?.text).toContain('voted 12-8');
  });

  it('a schema with nothing claim-like (claims.extract returns []) skips the citation check entirely', async () => {
    const llm = fakeLlm([{ input: { headline: 'No claims here', claims: [] } }]);
    const out = await generateGroundedJson({
      llm,
      system: 'sys',
      prompt: 'prompt',
      toolName: 'emit_brief',
      toolDescription: 'desc',
      inputSchema: {},
      schema: Schema,
      evidence: [],
      claims: { extract: () => [], remove: (d) => d },
      fallback: FALLBACK,
    });
    expect(out.validationStatus).toBe('passed');
    expect(out.droppedClaims).toHaveLength(0);
  });
});
