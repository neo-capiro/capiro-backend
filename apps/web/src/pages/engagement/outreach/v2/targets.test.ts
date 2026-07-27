// Locks the Cc/Bcc send semantics for SCRUM-120 (Lists & Groups):
//   • entire-list ccContacts/bccContacts copy on EVERY member's email
//   • per-member memberCcContacts/memberBccContacts copy on that one member
//   • a member therefore receives the union of both, deduped
// plus the individual-target case from SCRUM-121.

import { describe, expect, it } from 'vitest';
import {
  analyzeRecipientCollisions,
  collisionsFingerprint,
  expandContextItemScopes,
  flattenTargets,
  membershipOf,
  type CcBccContact,
  type OutreachTarget,
} from './targets.js';
import type { OutreachRecipient } from '../../OutreachView.js';

const rec = (name: string, email: string): OutreachRecipient => ({ name, email });
const contact = (name: string, email: string): CcBccContact => ({
  id: `c-${email}`,
  name,
  email,
  source: 'manual',
});

describe('flattenTargets — list Cc/Bcc (SCRUM-120)', () => {
  it('copies entire-list contacts on every member; per-member contacts only on that member', () => {
    // Story example: list of Bob, Dan, Bert. Cc Lia on the entire list, Cc Neo
    // on Dan only → Lia on all three, Dan also gets Neo.
    const listTarget: OutreachTarget = {
      key: 'L1',
      type: 'list',
      name: 'My List',
      recipients: [rec('Bob', 'bob@x.com'), rec('Dan', 'dan@x.com'), rec('Bert', 'bert@x.com')],
      cc: [],
      bcc: [],
      ccContacts: [contact('Lia', 'lia@x.com')],
      memberCcContacts: { 'dan@x.com': [contact('Neo', 'neo@x.com')] },
    };

    const byEmail = new Map(flattenTargets([listTarget]).map((r) => [r.email, r]));

    expect(byEmail.get('bob@x.com')?.cc).toEqual(['lia@x.com']);
    expect(byEmail.get('bert@x.com')?.cc).toEqual(['lia@x.com']);
    expect([...(byEmail.get('dan@x.com')?.cc ?? [])].sort()).toEqual(['lia@x.com', 'neo@x.com']);
  });

  it('supports entire-list Bcc + per-member Bcc independently', () => {
    const listTarget: OutreachTarget = {
      key: 'L2',
      type: 'list',
      name: 'L',
      recipients: [rec('Dan', 'dan@x.com'), rec('Bob', 'bob@x.com')],
      cc: [],
      bcc: [],
      bccContacts: [contact('Lia', 'lia@x.com')],
      memberBccContacts: { 'dan@x.com': [contact('Neo', 'neo@x.com')] },
    };

    const byEmail = new Map(flattenTargets([listTarget]).map((r) => [r.email, r]));
    expect(byEmail.get('bob@x.com')?.bcc).toEqual(['lia@x.com']);
    expect([...(byEmail.get('dan@x.com')?.bcc ?? [])].sort()).toEqual(['lia@x.com', 'neo@x.com']);
  });

  it('dedupes a contact added both to the whole list and to a member', () => {
    const listTarget: OutreachTarget = {
      key: 'L3',
      type: 'list',
      name: 'L',
      recipients: [rec('Dan', 'dan@x.com')],
      cc: [],
      bcc: [],
      ccContacts: [contact('Lia', 'lia@x.com')],
      memberCcContacts: { 'dan@x.com': [contact('Lia', 'LIA@x.com')] },
    };
    const [dan] = flattenTargets([listTarget]);
    expect(dan?.cc).toEqual(['lia@x.com']);
  });

  it('individual target applies its ccContacts to that recipient (SCRUM-121)', () => {
    const t: OutreachTarget = {
      key: 'i1',
      type: 'individual',
      recipients: [rec('A', 'a@x.com')],
      cc: [],
      bcc: [],
      ccContacts: [contact('Lia', 'lia@x.com')],
      bccContacts: [contact('Neo', 'neo@x.com')],
    };
    const [r] = flattenTargets([t]);
    expect(r?.cc).toEqual(['lia@x.com']);
    expect(r?.bcc).toEqual(['neo@x.com']);
  });

  it('member contacts on a non-list target are ignored (lists only)', () => {
    // memberCcContacts only applies to list targets — an individual ignores it.
    const t: OutreachTarget = {
      key: 'i2',
      type: 'individual',
      recipients: [rec('A', 'a@x.com')],
      cc: [],
      bcc: [],
      memberCcContacts: { 'a@x.com': [contact('Neo', 'neo@x.com')] },
    };
    const [r] = flattenTargets([t]);
    expect(r?.cc).toBeUndefined();
  });
});

describe('flattenTargets — group = one shared email', () => {
  const groupT: OutreachTarget = {
    key: 'G1',
    type: 'group',
    name: 'HASC offices',
    recipients: [rec('Gail', 'gail@x.com'), rec('Hank', 'hank@x.com')],
    cc: [],
    bcc: [],
    ccContacts: [contact('Lia', 'lia@x.com')],
  };

  it('emits ONE representative carrying every member in groupMembers (not one per member)', () => {
    const out = flattenTargets([groupT]);
    expect(out).toHaveLength(1);
    const rep = out[0]!;
    expect(rep.id).toBe('group:G1');
    expect(rep.groupMembers?.map((m) => m.email).sort()).toEqual(['gail@x.com', 'hank@x.com']);
    // The group's entire-list cc rides the single representative.
    expect(rep.cc).toEqual(['lia@x.com']);
  });

  it('a person in a group AND an individual yields both: the individual + the group rep', () => {
    const targets: OutreachTarget[] = [
      { key: 'i1', type: 'individual', recipients: [rec('Gail', 'gail@x.com')], cc: [], bcc: [] },
      groupT,
    ];
    const out = flattenTargets(targets);
    // The individual recipient AND the group representative both survive.
    expect(out.some((r) => r.email === 'gail@x.com' && r.id !== 'group:G1')).toBe(true);
    const rep = out.find((r) => r.id === 'group:G1')!;
    // The group's To still includes Gail even though she's also an individual.
    expect(rep.groupMembers?.map((m) => m.email).sort()).toEqual(['gail@x.com', 'hank@x.com']);
  });
});

describe('membershipOf — group is orthogonal to the personal To', () => {
  const targets: OutreachTarget[] = [
    { key: 'i1', type: 'individual', recipients: [rec('Alma', 'alma@x.com')], cc: [], bcc: [] },
    {
      key: 'G1',
      type: 'group',
      name: 'G',
      recipients: [rec('Gail', 'gail@x.com')],
      cc: [],
      bcc: [],
    },
  ];

  it("'all' scope sees group membership; 'personal' scope ignores it", () => {
    expect(membershipOf(targets, 'gail@x.com', 'all')).toBe('group');
    expect(membershipOf(targets, 'gail@x.com', 'personal')).toBeNull();
    // individuals/lists still count under both scopes
    expect(membershipOf(targets, 'alma@x.com', 'personal')).toBe('individual');
  });
});

describe('expandContextItemScopes — Build Context list/group scope routing', () => {
  const targets: OutreachTarget[] = [
    { key: 'ind1', type: 'individual', recipients: [rec('Alma', 'alma@x.com')], cc: [], bcc: [] },
    {
      key: 'L1',
      type: 'list',
      name: 'HASC staffers',
      recipients: [rec('Bob', 'bob@x.com'), rec('Dan', 'dan@x.com')],
      cc: [],
      bcc: [],
    },
    {
      key: 'G1',
      type: 'group',
      name: 'HASC offices',
      recipients: [rec('Gail', 'gail@x.com'), rec('Hank', 'hank@x.com')],
      cc: [],
      bcc: [],
    },
  ];
  const item = (scope: string) => ({ id: `c-${scope}`, scope, note: '' });

  it("passes 'all' and individual scopes through unchanged", () => {
    const out = expandContextItemScopes([item('all'), item('alma@x.com')], targets);
    expect(out.map((c) => c.scope)).toEqual(['all', 'alma@x.com']);
  });

  it('expands a list scope into one copy per member (keyed by recipientKey)', () => {
    const out = expandContextItemScopes([item('list:L1')], targets);
    expect(out.map((c) => c.scope).sort()).toEqual(['bob@x.com', 'dan@x.com']);
    // metadata (id/note) is preserved on each expanded copy
    expect(out.every((c) => c.id === 'c-list:L1' && c.note === '')).toBe(true);
  });

  it('expands a group scope into one copy per member', () => {
    const out = expandContextItemScopes([item('group:G1')], targets);
    expect(out.map((c) => c.scope).sort()).toEqual(['gail@x.com', 'hank@x.com']);
  });

  it('drops an item scoped to a list/group that no longer exists', () => {
    const out = expandContextItemScopes([item('list:GONE'), item('all')], targets);
    expect(out.map((c) => c.scope)).toEqual(['all']);
  });
});

describe('analyzeRecipientCollisions (Phase 2 §3.g)', () => {
  it('reports nothing when every email appears exactly once', () => {
    const targets: OutreachTarget[] = [
      { key: 'i1', type: 'individual', recipients: [rec('Alma', 'alma@x.com')], cc: [], bcc: [] },
      {
        key: 'L1',
        type: 'list',
        name: 'L',
        recipients: [rec('Bob', 'bob@x.com')],
        cc: [],
        bcc: [],
      },
    ];
    expect(analyzeRecipientCollisions(targets)).toEqual([]);
  });

  it('flags a person who is both an individual target AND a group member — the INTENTIONALLY allowed case', () => {
    const targets: OutreachTarget[] = [
      { key: 'i1', type: 'individual', recipients: [rec('Gail', 'gail@x.com')], cc: [], bcc: [] },
      {
        key: 'G1',
        type: 'group',
        name: 'HASC offices',
        recipients: [rec('Gail', 'gail@x.com'), rec('Hank', 'hank@x.com')],
        cc: [],
        bcc: [],
      },
    ];
    const [collision] = analyzeRecipientCollisions(targets);
    expect(collision?.email).toBe('gail@x.com');
    expect(collision?.toMessageIds).toHaveLength(2);
    expect(collision?.individualToCount).toBe(1);
    expect(collision?.groupToCount).toBe(1);
    expect(collision?.ccOverlapsOwnTo).toBe(false);
    // Never silently deduped: both appearances are preserved.
    expect(collision?.appearances).toHaveLength(2);
  });

  it('flags a person who belongs to two DIFFERENT groups (two separate shared emails)', () => {
    const targets: OutreachTarget[] = [
      {
        key: 'G1',
        type: 'group',
        name: 'Group A',
        recipients: [rec('Gail', 'gail@x.com')],
        cc: [],
        bcc: [],
      },
      {
        key: 'G2',
        type: 'group',
        name: 'Group B',
        recipients: [rec('Gail', 'gail@x.com')],
        cc: [],
        bcc: [],
      },
    ];
    const [collision] = analyzeRecipientCollisions(targets);
    expect(collision?.toMessageIds.sort()).toEqual(['group:G1', 'group:G2']);
    expect(collision?.groupToCount).toBe(2);
  });

  it('flags Cc/Bcc overlap with the same message’s To recipient', () => {
    const targets: OutreachTarget[] = [
      {
        key: 'i1',
        type: 'individual',
        recipients: [rec('Alma', 'alma@x.com')],
        cc: ['alma@x.com'],
        bcc: [],
      },
    ];
    const [collision] = analyzeRecipientCollisions(targets);
    expect(collision?.email).toBe('alma@x.com');
    expect(collision?.ccOverlapsOwnTo).toBe(true);
    // Still only ONE outgoing message — this is a Cc mistake, not a duplicate send.
    expect(collision?.toMessageIds).toHaveLength(1);
  });

  it('flags the same email recorded under two different display names (likely duplicate contacts)', () => {
    const targets: OutreachTarget[] = [
      {
        key: 'i1',
        type: 'individual',
        recipients: [rec('Gail Smith', 'gail@x.com')],
        cc: [],
        bcc: [],
      },
      {
        key: 'i2',
        type: 'individual',
        recipients: [{ id: 'other-id', name: 'G. Smith', email: 'gail@x.com' }],
        cc: [],
        bcc: [],
      },
    ];
    const [collision] = analyzeRecipientCollisions(targets);
    expect(collision?.identityMismatch).toBe(true);
  });

  it('is case/whitespace-insensitive when normalizing email identity', () => {
    const targets: OutreachTarget[] = [
      { key: 'i1', type: 'individual', recipients: [rec('A', ' Gail@X.com ')], cc: [], bcc: [] },
      {
        key: 'G1',
        type: 'group',
        name: 'G',
        recipients: [rec('A', 'gail@x.com')],
        cc: [],
        bcc: [],
      },
    ];
    const collisions = analyzeRecipientCollisions(targets);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.email).toBe('gail@x.com');
  });

  it('sorts most-appearances first, then alphabetically', () => {
    const targets: OutreachTarget[] = [
      { key: 'i1', type: 'individual', recipients: [rec('Z', 'zed@x.com')], cc: [], bcc: [] },
      { key: 'i2', type: 'individual', recipients: [rec('A', 'aaa@x.com')], cc: [], bcc: [] },
      {
        key: 'G1',
        type: 'group',
        name: 'G',
        recipients: [rec('Z', 'zed@x.com'), rec('A', 'aaa@x.com')],
        cc: [],
        bcc: [],
      },
      {
        key: 'G2',
        type: 'group',
        name: 'G2',
        recipients: [rec('Z', 'zed@x.com')],
        cc: [],
        bcc: [],
      },
    ];
    const collisions = analyzeRecipientCollisions(targets);
    // zed@x.com has 3 appearances (individual + 2 groups); aaa@x.com has 2.
    expect(collisions.map((c) => c.email)).toEqual(['zed@x.com', 'aaa@x.com']);
  });
});

describe('collisionsFingerprint (Phase 2 §3.g)', () => {
  it('is stable for the same collision set and changes when a collision is resolved', () => {
    const withGroup: OutreachTarget[] = [
      { key: 'i1', type: 'individual', recipients: [rec('Gail', 'gail@x.com')], cc: [], bcc: [] },
      {
        key: 'G1',
        type: 'group',
        name: 'G',
        recipients: [rec('Gail', 'gail@x.com')],
        cc: [],
        bcc: [],
      },
    ];
    const withoutGroup: OutreachTarget[] = [withGroup[0]!];

    const fp1 = collisionsFingerprint(analyzeRecipientCollisions(withGroup));
    const fp2 = collisionsFingerprint(analyzeRecipientCollisions(withGroup));
    const fp3 = collisionsFingerprint(analyzeRecipientCollisions(withoutGroup));

    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(fp3);
    expect(fp3).toBe(''); // no collisions left once the group is removed
  });
});
