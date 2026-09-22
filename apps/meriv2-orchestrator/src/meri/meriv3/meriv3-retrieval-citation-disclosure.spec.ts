import { finalizeMeriRetrievalReply } from './meriv3-retrieval-assistant.service.js';

describe('retrieval disclosure citation validation', () => {
  const appendDisclosure = (reply: string) => `${reply}\n\nCoverage note with orphan [7].`;

  it('revalidates after disclosure append under enforce', () => {
    expect(finalizeMeriRetrievalReply('Answer.', [], 'enforce', appendDisclosure)).toBe(
      'Answer.\n\nCoverage note with orphan .',
    );
  });

  it('leaves the appended disclosure unchanged under off', () => {
    expect(finalizeMeriRetrievalReply('Answer.', [], 'off', appendDisclosure)).toBe(
      'Answer.\n\nCoverage note with orphan [7].',
    );
  });
});
