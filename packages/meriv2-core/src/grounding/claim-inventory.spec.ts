import { describe, expect, it } from '@jest/globals';
import { extractMaterialClaims, segmentReply } from './claim-inventory';

const citations = [
  { n: 1, tool: 'get_bill_status', id: 'bill-1', stableId: 'stable-bill-1' },
  { n: 2, tool: 'get_funding_positions', id: 'funding-2' },
];
const extract = (replyText: string) =>
  extractMaterialClaims({ replyText, citations, asOf: '2026-09-22T00:00:00.000Z' });

describe('claim inventory', () => {
  it.each([
    ['Sen. Smith chairs the panel [1]. The bill passed [2].', 2],
    ['H.R. 123 passed [1]. Dr. Jones was present [2].', 2],
    ['1. The program received $4 million [1].\n2. Funding is due June 4 [2].', 2],
    ['- The rule is final [1].\n- The deadline is October 2 [2].', 2],
  ])('segments citations, abbreviations, and lists: %s', (text, expected) => {
    expect(segmentReply(text)).toHaveLength(expected);
  });

  it.each([
    ['Hello!', 'greeting'],
    ['Thanks.', 'greeting'],
    ['What is the bill status?', 'question'],
    ['Can you review the memo?', 'question'],
    ['Ideas:', 'brainstorm'],
    ['Options:', 'brainstorm'],
    ['Recommendations:', 'labelled_recommendation'],
    ['Next steps:', 'labelled_recommendation'],
    ['Sources:', 'meta'],
    ['Summary:', 'meta'],
  ])('labels non-material text: %s', (text, exclusion) => {
    expect(extract(text)[0]).toMatchObject({ material: false, exclusion });
  });

  it.each([
    ['Recommendations: Acme was awarded $5 million.', 'fact'],
    ['Options: H.R. 42 has been enacted.', 'fact'],
  ])('retains factual assertions beneath excluded labels: %s', (text, kind) => {
    expect(extract(text)[0]).toMatchObject({ material: true, kind });
  });

  it.each([
    ['The bill passed.', 'bill_status'],
    ['Acme received $8 million.', 'budget_amount'],
  ])('keeps uncited positive assertions material: %s', (text, category) => {
    expect(extract(text)[0]).toMatchObject({ material: true, uncited: true, category, evidenceIds: [] });
  });

  it.each([
    ['H.R. 1 passed [1]; funding fell [2].', 2],
    ['H.R. 1 passed [1], while Acme received $3 million [2].', 2],
    ['H.R. 1 passed [1] and Acme received $3 million [2].', 2],
  ])('splits compound factual clauses: %s', (text, expected) => {
    const claims = extract(text);
    expect(claims).toHaveLength(expected);
    expect(claims.every((claim) => claim.compound && claim.parentId)).toBe(true);
  });

  it.each([
    ['The measure may pass.', 'inference'],
    ['The program could expand.', 'inference'],
    ['I recommend contacting the chair.', 'recommendation'],
    ['You should request the report.', 'recommendation'],
    ['The deadline is unknown.', 'uncertainty'],
    ['The current status is unclear.', 'uncertainty'],
  ])('uses existing lexical claim-kind cues: %s', (text, kind) => {
    expect(extract(text)[0]?.kind).toBe(kind);
  });

  it('maps markers to stable ids first and tool ids second', () => {
    const claims = extract('H.R. 1 passed [1], while funding is $3 million [2].');
    expect(claims[0]?.evidenceIds).toEqual(['stable-bill-1']);
    expect(claims[1]?.evidenceIds).toEqual(['get_funding_positions:funding-2']);
  });

  it('is deterministic', () => {
    expect(extract('The bill passed [1].')).toEqual(extract('The bill passed [1].'));
  });
});
