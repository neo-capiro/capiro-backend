import {
  clientImpactContext,
  impactPassages,
  verifyImpactDraft,
  verifyImpactReview,
  type ImpactVersion,
} from './bill-impact.evidence.js';
const text =
  'The Secretary may support qualification of domestic composite suppliers. '.repeat(8) +
  'This section does not appropriate funds or guarantee any supplier an award.';
const version: ImpactVersion = {
  id: 'v1',
  revision: 'r1',
  label: 'Introduced',
  sourceUrl: 'https://www.flsenate.gov/text',
  publishedDate: null,
  complete: true,
  sections: [{ locator: 'Section 1', text }],
};
const client = clientImpactContext({
  description: 'The client manufactures domestic composite structures for aircraft.',
  productDescription: null,
});
const raw = () => ({
  impacts: [
    {
      evidenceIds: ['E1'],
      clientIds: ['C1'],
      possibleImplication:
        'The supplier might consider qualification if implementing requirements apply.',
      assumptions: 'Eligibility and funding would need verification.',
      verificationStep: 'Review qualification requirements with the client.',
    },
  ],
  limitations: 'One selected bill version; review required.',
});
describe('bill impact evidence boundaries', () => {
  it('never returns fabricated model-authored limitations outside the grounding review', () => {
    const draft = { ...raw(), limitations: 'This law is enacted and no exception applies.' };
    const result = verifyImpactDraft(draft, impactPassages(version), client);
    expect(result.limitations).not.toContain('This law is enacted');
    expect(result.limitations).toContain('one selected text version');
  });
  it('retains the complete closing qualifier beyond 400 characters in server-owned evidence', () => {
    const result = verifyImpactDraft(raw(), impactPassages(version), client);
    expect(result.impacts[0]!.evidence[0]!.text).toBe(text);
    expect(result.impacts[0]!.evidence[0]!.text).toMatch(
      /does not appropriate funds or guarantee any supplier an award\.$/,
    );
  });
  it.each([false, undefined])('rejects incomplete or unknown completeness %s', (complete) => {
    expect(() => impactPassages({ ...version, complete: complete as boolean })).toThrow(
      /complete retained/,
    );
  });
  it('rejects oversize whole sections without silently truncating them', () => {
    expect(() =>
      impactPassages({
        ...version,
        sections: [{ locator: 'Whole bill', text: 'x'.repeat(18_001) }],
      }),
    ).toThrow(/exceeds/);
  });
  it('rejects oversized total text even when individual sections fit', () => {
    expect(() =>
      impactPassages({
        ...version,
        sections: Array.from({ length: 10 }, () => ({
          locator: 'Section',
          text: 'x'.repeat(10_000),
        })),
      }),
    ).toThrow(/exceeds/);
  });
  it('requires substantive stored client context, not a name/sector tag', () => {
    expect(() => clientImpactContext({ description: 'Defense', productDescription: null })).toThrow(
      /substantive/,
    );
  });
  it('never truncates a long client context', () => {
    expect(() =>
      clientImpactContext({
        description: 'Client makes products. '.repeat(500),
        productDescription: null,
      }),
    ).toThrow(/exceeds/);
  });
  it.each(['evidenceIds', 'clientIds'])('rejects unknown %s', (key) => {
    const draft = raw();
    (draft.impacts[0] as any)[key] = ['invented'];
    expect(() => verifyImpactDraft(draft, impactPassages(version), client)).toThrow(/Unverified/);
  });
  it('rejects a long generated qualification instead of chopping its ending', () => {
    const draft = raw();
    draft.impacts[0]!.assumptions = 'x'.repeat(1001);
    expect(() => verifyImpactDraft(draft, impactPassages(version), client)).toThrow(/prose/);
  });
  it.each([
    { verdicts: [{ index: 0, supported: false }] },
    { verdicts: [] },
    { verdicts: [{ index: 1, supported: true }] },
    { verdicts: [{ index: 0, supported: 'true' }] },
  ])('fails closed when substantive grounding is not affirmed: %j', (review) => {
    expect(() => verifyImpactReview(review, 1)).toThrow(/Unsupported/);
  });
  it('accepts complete grounding verdicts and rejects duplicate indexes', () => {
    expect(() =>
      verifyImpactReview({ verdicts: [{ index: 0, supported: true }] }, 1),
    ).not.toThrow();
    expect(() =>
      verifyImpactReview(
        {
          verdicts: [
            { index: 0, supported: true },
            { index: 0, supported: true },
          ],
        },
        2,
      ),
    ).toThrow();
  });
});
