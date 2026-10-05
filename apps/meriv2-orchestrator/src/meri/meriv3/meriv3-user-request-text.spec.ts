import { inferClaimCategories } from '@capiro/meriv2-core';
import { userRequestText } from './meriv3-assistant.service.js';

describe('userRequestText (Stage 1 T4)', () => {
  const typed = 'What capability does the attached PDF describe on page 4?';
  const sheet =
    'Attached document "qa-cost-sheet.xlsx":\nSource: {"attachmentId":"a"}\nItem,Cost ($M)\nSensors,1.25';

  it('drops appended attachment text so classification sees only the typed request', () => {
    const turn = `${typed}\n\n${sheet}`;
    expect(userRequestText(turn)).toBe(typed);
    expect(inferClaimCategories(turn)).toContain('budget_amount');
    expect(inferClaimCategories(userRequestText(turn))).not.toContain('budget_amount');
  });

  it('also stops at filing references, unavailable notices and the compaction carry-over', () => {
    for (const block of [
      'Attached image "chart.png":\nSource: {}',
      'Attachment "old.pdf" (ID 1) is unavailable for this turn.',
      'Documents uploaded earlier in this chat (retained after chat summary):\n...',
    ]) {
      expect(userRequestText(`${typed}\n\n${block}`)).toBe(typed);
    }
  });

  it('leaves a turn without attachments unchanged, including quoted text', () => {
    const plain = 'Summarize: "Attached document" is a phrase, not a block.';
    expect(userRequestText(plain)).toBe(plain);
    expect(userRequestText(typed)).toBe(typed);
  });
});
