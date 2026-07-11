// Locks the Generate & Review entity model: per-entity draft slots
// (individual = 1, list = 1 per member, group = 1 shared) and the send
// projection — a group projects to ONE draft keyed to its representative
// (group:<targetKey>), sent as a single email to all members in To.

import { describe, expect, it } from 'vitest';
import { buildGenerationModel, listAidFromKey, projectDraftsForSend } from './generation.js';
import { normalizeTone } from './types.js';
import type { OutreachTarget } from './targets.js';
import type { OutreachRecipient } from '../../OutreachView.js';

const rec = (email: string): OutreachRecipient => ({ email });

const individual = (email: string): OutreachTarget => ({
  key: `t-${email}`,
  type: 'individual',
  recipients: [rec(email)],
  cc: [],
  bcc: [],
});
const list = (key: string, audienceId: string | undefined, emails: string[]): OutreachTarget => ({
  key,
  type: 'list',
  audienceId,
  name: 'L',
  recipients: emails.map(rec),
  cc: [],
  bcc: [],
});
const group = (key: string, audienceId: string | undefined, emails: string[]): OutreachTarget => ({
  key,
  type: 'group',
  audienceId,
  name: 'G',
  recipients: emails.map(rec),
  cc: [],
  bcc: [],
});

const mix: OutreachTarget[] = [
  individual('a@x.com'),
  list('L1', 'aud1', ['b@x.com', 'c@x.com']),
  group('G1', 'aud2', ['d@x.com', 'e@x.com']),
];

describe('buildGenerationModel', () => {
  it('emits one slot per individual, one per list member, one per group', () => {
    const { entities, slots } = buildGenerationModel(mix);
    expect(entities).toHaveLength(3);
    expect(slots.map((s) => s.genKey)).toEqual([
      'individual:a@x.com',
      'list:aud1:b@x.com',
      'list:aud1:c@x.com',
      'group:aud2',
    ]);
  });

  it('a group slot generates from ONE representative and carries the member listing', () => {
    const { slots } = buildGenerationModel(mix);
    const groupSlot = slots.find((s) => s.genKey === 'group:aud2')!;
    expect(groupSlot.appliesTo).toBe('group');
    expect(groupSlot.genRecipients).toHaveLength(1);
    expect(groupSlot.additionalContext).toContain('d@x.com');
    expect(groupSlot.additionalContext).toContain('e@x.com');
  });

  it('falls back to the target key when a list/group has no saved audienceId', () => {
    const { slots } = buildGenerationModel([group('tkey', undefined, ['z@x.com'])]);
    expect(slots[0]!.genKey).toBe('group:tkey');
  });
});

describe('projectDraftsForSend', () => {
  const generated = {
    'individual:a@x.com': { subject: 'SA', body: 'BA', status: 'ready' },
    'list:aud1:b@x.com': { subject: 'SB', body: 'BB', status: 'ready' },
    'list:aud1:c@x.com': { subject: 'SC', body: 'BC', status: 'ready' },
    'group:aud2': { subject: 'SG', body: 'BG', status: 'ready' },
  };

  it('one draft per individual / list member, and ONE shared draft per group', () => {
    const drafts = projectDraftsForSend(mix, generated);
    // 1 individual + 2 list members + 1 group (not fanned to its 2 members) = 4.
    expect(drafts).toHaveLength(4);
    const byId = Object.fromEntries(drafts.map((d) => [d.recipientId, d]));
    expect(byId['a@x.com']!.subject).toBe('SA');
    expect(byId['b@x.com']!.subject).toBe('SB');
    expect(byId['c@x.com']!.subject).toBe('SC');
    // The group is ONE draft keyed to its representative (group:<targetKey>),
    // NOT one per member — the send fans it to all members in the To field.
    expect(byId['group:G1']!.subject).toBe('SG');
    expect(byId['d@x.com']).toBeUndefined();
    expect(byId['e@x.com']).toBeUndefined();
  });

  it('skips drafts with no subject and no body', () => {
    const drafts = projectDraftsForSend([individual('a@x.com')], {
      'individual:a@x.com': { subject: '  ', body: '', status: 'ready' },
    });
    expect(drafts).toHaveLength(0);
  });

  it('a person in a group AND as an individual gets BOTH drafts (relaxed dedup)', () => {
    const dup = 'shared@x.com';
    const targets = [individual(dup), group('G9', 'aud9', [dup, 'other@x.com'])];
    const gen = {
      'individual:shared@x.com': { subject: 'IND', body: 'IND', status: 'ready' },
      'group:aud9': { subject: 'GRP', body: 'GRP', status: 'ready' },
    };
    const byId = Object.fromEntries(
      projectDraftsForSend(targets, gen).map((d) => [d.recipientId, d]),
    );
    // The individual keeps their own personalized draft …
    expect(byId['shared@x.com']!.subject).toBe('IND');
    // … and the group is its own single shared draft (keyed to the group rep);
    // the person rides the group's To at send without losing their own email.
    expect(byId['group:G9']!.subject).toBe('GRP');
  });
});

describe('projectDraftsForSend — failed drafts are unsendable (W0.2)', () => {
  it('excludes an individual draft that failed to generate (status "error")', () => {
    const drafts = projectDraftsForSend([individual('a@x.com')], {
      'individual:a@x.com': {
        subject: '[Placeholder] Outreach',
        body: 'This is a placeholder draft because email generation failed.',
        status: 'error',
      },
    });
    expect(drafts).toHaveLength(0);
  });

  it('excludes a group draft that failed to generate', () => {
    const drafts = projectDraftsForSend([group('G1', 'aud2', ['d@x.com', 'e@x.com'])], {
      'group:aud2': { subject: '[Placeholder]', body: 'failed', status: 'error' },
    });
    expect(drafts).toHaveLength(0);
  });

  it('includes a once-failed draft after the user edits it (status "edited")', () => {
    const drafts = projectDraftsForSend([individual('a@x.com')], {
      'individual:a@x.com': { subject: 'Fixed subject', body: 'Real content', status: 'edited' },
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.subject).toBe('Fixed subject');
  });

  it('sends only the successful drafts in a partially-failed batch', () => {
    const drafts = projectDraftsForSend([individual('a@x.com'), individual('b@x.com')], {
      'individual:a@x.com': { subject: 'OK', body: 'Ready', status: 'ready' },
      'individual:b@x.com': { subject: '[Placeholder]', body: 'failed', status: 'error' },
    });
    expect(drafts.map((d) => d.recipientId)).toEqual(['a@x.com']);
  });
});

describe('normalizeTone (W0.5 legacy-resume migration)', () => {
  it('lowercases a legacy capitalized tone from an old draft', () => {
    expect(normalizeTone('Professional')).toBe('professional');
    expect(normalizeTone('Formal')).toBe('formal');
  });
  it('passes a canonical lowercase tone through', () => {
    expect(normalizeTone('concise')).toBe('concise');
  });
  it('falls back to the default for unknown/garbage/missing values', () => {
    expect(normalizeTone('nonsense')).toBe('professional');
    expect(normalizeTone(undefined)).toBe('professional');
    expect(normalizeTone(42)).toBe('professional');
  });
});

describe('listAidFromKey', () => {
  it('extracts the colon-free audience id even when the recipientKey contains colons', () => {
    expect(listAidFromKey('list:aud1:clientperson:abc')).toBe('aud1');
  });
  it('returns null for non-list keys', () => {
    expect(listAidFromKey('group:aud2')).toBeNull();
    expect(listAidFromKey('individual:x')).toBeNull();
  });
});
