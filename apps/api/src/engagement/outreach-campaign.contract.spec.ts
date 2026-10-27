import { describe, expect, test } from '@jest/globals';
import {
  expandCampaignUnits,
  outreachCampaignStateSchema,
  parseCampaign,
} from './outreach-campaign.contract.js';

export const savedCampaignFixture = {
  title: 'Synthetic campaign',
  direction: 'on-behalf' as const,
  clientId: null,
  templateId: null,
  mainIdea: 'Arrange a meeting',
  tone: 'professional' as const,
  length: 'standard' as const,
  recipients: [
    {
      id: 'one',
      kind: 'individual' as const,
      role: 'to' as const,
      name: 'One',
      email: 'one@example.test',
    },
  ],
  contextItems: [
    {
      id: 'note-one',
      kind: 'note' as const,
      scope: 'individual:one',
      customNoteText: 'Use this only for One',
      noteUse: 'instruction' as const,
    },
  ],
  styleSamples: [],
  attachmentIds: [],
  sender: { connectionId: null, signature: 'Author' },
  lastStep: 4,
};
describe('saved Outreach state and unit contracts', () => {
  test('round-trips scoped fact/instruction and full state without reducing it to hints', () => {
    expect(
      parseCampaign(outreachCampaignStateSchema, JSON.parse(JSON.stringify(savedCampaignFixture))),
    ).toEqual(savedCampaignFixture);
  });
  test('list creates separate units, group one unit, and Cc/Bcc remain explicit', () => {
    const member = (id: string, role: 'to' | 'cc' | 'bcc' = 'to') => ({
      id,
      role,
      name: id,
      email: `${id}@example.test`,
    });
    const state = parseCampaign(outreachCampaignStateSchema, {
      ...savedCampaignFixture,
      recipients: [
        { ...member('copy', 'cc'), kind: 'individual' },
        {
          ...member('list'),
          kind: 'list',
          members: [member('a'), member('b'), member('hidden', 'bcc')],
        },
        {
          ...member('group'),
          kind: 'group',
          members: [member('c'), member('d'), member('private', 'bcc')],
        },
      ],
    });
    const units = expandCampaignUnits(state);
    expect(units.map((u) => u.generationKey)).toEqual([
      'list:list:a',
      'list:list:b',
      'group:group',
    ]);
    expect(units[0]?.recipient).toMatchObject({
      cc: ['copy@example.test'],
      bcc: ['hidden@example.test'],
    });
    expect(units[2]?.recipient).toMatchObject({
      groupMembers: [
        { name: 'c', email: 'c@example.test' },
        { name: 'd', email: 'd@example.test' },
      ],
      bcc: ['private@example.test'],
    });
  });
  test('rejects external source bodies and duplicate unit keys', () => {
    expect(() =>
      parseCampaign(outreachCampaignStateSchema, {
        ...savedCampaignFixture,
        contextItems: [{ id: 'bill', kind: 'bill', scope: 'all', body: 'Invented status' }],
      }),
    ).toThrow();
    expect(() =>
      expandCampaignUnits({
        ...savedCampaignFixture,
        recipients: [...savedCampaignFixture.recipients, ...savedCampaignFixture.recipients],
      }),
    ).toThrow('unique');
  });
});
