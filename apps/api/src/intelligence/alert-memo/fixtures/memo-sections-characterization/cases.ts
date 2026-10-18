export interface ExpectedSection {
  heading: string;
  paragraphs: Array<{ text: string; claimIds: string[] }>;
}

export interface ParserCase {
  name: string;
  text: string;
  expected?: ExpectedSection[];
  delivered?: Array<{ heading: string; paragraphs: string[] }>;
  warning?: boolean;
}

const grounded = {
  heading: '  Unexpected heading  ',
  paragraphs: [{ text: '  Grounded first.  ', claimIds: ['c2', 'c1', 'c2'] }],
};

const expectedGrounded: ExpectedSection[] = [
  {
    heading: 'Unexpected heading',
    paragraphs: [{ text: 'Grounded first.', claimIds: ['c2', 'c1', 'c2'] }],
  },
];
const deliveredGrounded = [
  { heading: 'Unexpected heading', paragraphs: ['Grounded first. [c2][c1][c2]'] },
];

const json = JSON.stringify({ sections: [grounded] });

export const PARSER_CASES: ParserCase[] = [
  {
    name: 'direct JSON trims text and preserves duplicate citation order',
    text: json,
    expected: expectedGrounded,
    delivered: deliveredGrounded,
  },
  {
    name: 'fenced prose recovers one braced JSON object',
    text: `A draft:\n\`\`\`json\n${json}\n\`\`\`\nDone.`,
    expected: expectedGrounded,
    delivered: deliveredGrounded,
  },
  {
    name: 'greedy recovery rejects two separately valid JSON objects',
    text: `Draft ${json}\n${json}`,
  },
  {
    name: 'JSON null preserves the outer generation warning and fallback',
    text: 'null',
    warning: true,
  },
  { name: 'blank provider text falls back without a generation exception', text: ' \n\t ' },
  {
    name: 'unbraced prose falls back without a generation exception',
    text: 'No structured draft was returned.',
  },
  {
    name: 'invalid braced JSON fails the inner recovery parse',
    text: 'Draft {not: valid JSON} end',
  },
  { name: 'scalar JSON has no sections and falls back', text: '42' },
  {
    name: 'non-array sections falls back',
    text: JSON.stringify({ sections: { heading: 'Not an array' } }),
  },
  {
    name: 'invalid raw sections and absent or non-array paragraphs produce no grounded section',
    text: JSON.stringify({
      sections: [
        null,
        false,
        'raw',
        [],
        {},
        { heading: 2 },
        { heading: 'Absent' },
        { heading: 'Wrong', paragraphs: 'text' },
      ],
    }),
  },
  {
    name: 'mixed paragraphs filter only invalid text and citation types before grounding',
    text: JSON.stringify({
      sections: [
        {
          heading: 'Mixed',
          paragraphs: [
            null,
            false,
            'raw',
            [],
            {},
            { text: 4, claimIds: ['c1'] },
            { text: '  ', claimIds: ['c1'] },
            { text: '  Valid mixed.  ', claimIds: [1, null, false, {}, 'c2', 'c1', 'c2'] },
            { text: 'Unknown citation must drop.', claimIds: ['c1', 'missing'] },
            { text: 'Non-array citations must drop.', claimIds: 'c1' },
            { text: 'Missing citations must drop.' },
            { text: 'No citations must drop.', claimIds: [] },
          ],
        },
      ],
    }),
    expected: [
      { heading: 'Mixed', paragraphs: [{ text: 'Valid mixed.', claimIds: ['c2', 'c1', 'c2'] }] },
    ],
    delivered: [{ heading: 'Mixed', paragraphs: ['Valid mixed. [c2][c1][c2]'] }],
  },
  {
    name: 'blank and arbitrary headings retain section and paragraph order without defaults',
    text: JSON.stringify({
      sections: [
        { heading: '  ', paragraphs: [{ text: ' Blank heading. ', claimIds: ['c1'] }] },
        {
          heading: 'Later',
          paragraphs: [
            { text: ' Second paragraph. ', claimIds: ['c2'] },
            { text: ' Third paragraph. ', claimIds: ['c1'] },
          ],
        },
      ],
    }),
    expected: [
      { heading: '', paragraphs: [{ text: 'Blank heading.', claimIds: ['c1'] }] },
      {
        heading: 'Later',
        paragraphs: [
          { text: 'Second paragraph.', claimIds: ['c2'] },
          { text: 'Third paragraph.', claimIds: ['c1'] },
        ],
      },
    ],
    delivered: [
      { heading: '', paragraphs: ['Blank heading. [c1]'] },
      { heading: 'Later', paragraphs: ['Second paragraph. [c2]', 'Third paragraph. [c1]'] },
    ],
  },
];

export type ProviderCase = 'non-text content' | 'HTTP failure' | 'fetch rejection';
export const PROVIDER_CASES: ProviderCase[] = [
  'non-text content',
  'HTTP failure',
  'fetch rejection',
];
