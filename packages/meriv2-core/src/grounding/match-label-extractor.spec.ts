import { describe, expect, it } from '@jest/globals';
import { extractMatchFindings } from './match-label-extractor';

describe('extractMatchFindings', () => {
  it('extracts realistic headings and bullets with citation markers', () => {
    expect(extractMatchFindings(`
## Direct match
- Secure sustainment directly meets the forecast requirement [1] [2].
* A second pursuit is supported [2].

### Conditional niche
1. Pursue through a cleared partner [3].

## Adjacency
- Monitor the related autonomy portfolio.
`)).toEqual([
      { tier: 'direct_match', findingText: 'Secure sustainment directly meets the forecast requirement [1] [2].', citationRefs: [1, 2] },
      { tier: 'direct_match', findingText: 'A second pursuit is supported [2].', citationRefs: [2] },
      { tier: 'conditional_niche', findingText: 'Pursue through a cleared partner [3].', citationRefs: [3] },
      { tier: 'adjacency', findingText: 'Monitor the related autonomy portfolio.', citationRefs: [] },
    ]);
  });

  it('extracts inline tier forms and tolerates unrelated replies', () => {
    expect(extractMatchFindings('**Direct match:** Pursue the sustainment notice [4].\nAdjacency — Track policy activity [5].'))
      .toEqual([
        { tier: 'direct_match', findingText: 'Pursue the sustainment notice [4].', citationRefs: [4] },
        { tier: 'adjacency', findingText: 'Track policy activity [5].', citationRefs: [5] },
      ]);
    expect(extractMatchFindings('No ranked opportunities were found.')).toEqual([]);
  });
});
