// Phase 2 §3.g — collision resolution mutations and the send-preflight gate.
// The panel component itself (RecipientCollisions.tsx) is exercised through
// these pure helpers rather than a full render, matching how targets.test.ts
// covers flattenTargets/analyzeRecipientCollisions.

import { describe, expect, it } from 'vitest';
import {
  collisionsResolved,
  mergePersonalOccurrences,
  removeFromGroup,
  removePersonalOccurrences,
} from './RecipientCollisions.js';
import { analyzeRecipientCollisions, collisionsFingerprint, type OutreachTarget } from './targets.js';
import type { OutreachRecipient } from '../../OutreachView.js';

const rec = (name: string, email: string, extra: Partial<OutreachRecipient> = {}): OutreachRecipient => ({
  name,
  email,
  ...extra,
});

describe('removePersonalOccurrences', () => {
  it('drops an individual target entirely when its only recipient matches', () => {
    const targets: OutreachTarget[] = [
      { key: 'i1', type: 'individual', recipients: [rec('Gail', 'gail@x.com')], cc: [], bcc: [] },
      { key: 'i2', type: 'individual', recipients: [rec('Hank', 'hank@x.com')], cc: [], bcc: [] },
    ];
    const out = removePersonalOccurrences(targets, 'gail@x.com');
    expect(out.map((t) => t.key)).toEqual(['i2']);
  });

  it('removes only the matching member from a list, keeping the rest', () => {
    const targets: OutreachTarget[] = [
      {
        key: 'L1',
        type: 'list',
        name: 'L',
        recipients: [rec('Gail', 'gail@x.com'), rec('Hank', 'hank@x.com')],
        cc: [],
        bcc: [],
      },
    ];
    const out = removePersonalOccurrences(targets, 'gail@x.com');
    expect(out).toHaveLength(1);
    expect(out[0]?.recipients.map((r) => r.email)).toEqual(['hank@x.com']);
  });

  it('never touches a group target (group is orthogonal to the personal slot)', () => {
    const targets: OutreachTarget[] = [
      {
        key: 'G1',
        type: 'group',
        name: 'G',
        recipients: [rec('Gail', 'gail@x.com')],
        cc: [],
        bcc: [],
      },
    ];
    expect(removePersonalOccurrences(targets, 'gail@x.com')).toEqual(targets);
  });
});

describe('removeFromGroup', () => {
  it('removes the member from the named group only, leaving other groups and other members intact', () => {
    const targets: OutreachTarget[] = [
      {
        key: 'G1',
        type: 'group',
        name: 'A',
        recipients: [rec('Gail', 'gail@x.com'), rec('Hank', 'hank@x.com')],
        cc: [],
        bcc: [],
      },
      { key: 'G2', type: 'group', name: 'B', recipients: [rec('Gail', 'gail@x.com')], cc: [], bcc: [] },
    ];
    const out = removeFromGroup(targets, 'gail@x.com', 'G1');
    const g1 = out.find((t) => t.key === 'G1');
    const g2 = out.find((t) => t.key === 'G2');
    expect(g1?.recipients.map((r) => r.email)).toEqual(['hank@x.com']);
    expect(g2?.recipients.map((r) => r.email)).toEqual(['gail@x.com']);
  });

  it('drops the group entirely once its last member is removed', () => {
    const targets: OutreachTarget[] = [
      { key: 'G1', type: 'group', name: 'A', recipients: [rec('Gail', 'gail@x.com')], cc: [], bcc: [] },
    ];
    expect(removeFromGroup(targets, 'gail@x.com', 'G1')).toEqual([]);
  });
});

describe('mergePersonalOccurrences', () => {
  it('keeps the first occurrence, folds in the others’ Cc/Bcc, and drops the duplicates', () => {
    const targets: OutreachTarget[] = [
      {
        key: 'i1',
        type: 'individual',
        recipients: [rec('Gail Smith', 'gail@x.com')],
        cc: ['a@x.com'],
        bcc: [],
      },
      {
        key: 'i2',
        type: 'individual',
        recipients: [{ id: 'dup-id', name: 'G. Smith', email: 'gail@x.com' }],
        cc: ['b@x.com'],
        bcc: ['c@x.com'],
      },
    ];
    const out = mergePersonalOccurrences(targets, 'gail@x.com');
    expect(out).toHaveLength(1);
    expect(out[0]?.key).toBe('i1');
    expect(out[0]?.cc.sort()).toEqual(['a@x.com', 'b@x.com']);
    expect(out[0]?.bcc).toEqual(['c@x.com']);
  });

  it('removes only the colliding member from a duplicate list target, keeping its other members', () => {
    const targets: OutreachTarget[] = [
      { key: 'i1', type: 'individual', recipients: [rec('Gail', 'gail@x.com')], cc: [], bcc: [] },
      {
        key: 'L1',
        type: 'list',
        name: 'L',
        recipients: [rec('Gail', 'gail@x.com'), rec('Hank', 'hank@x.com')],
        cc: [],
        bcc: [],
      },
    ];
    const out = mergePersonalOccurrences(targets, 'gail@x.com');
    const list = out.find((t) => t.key === 'L1');
    expect(list?.recipients.map((r) => r.email)).toEqual(['hank@x.com']);
    expect(out.some((t) => t.key === 'i1')).toBe(true);
  });

  it('is a no-op when there is only one personal occurrence', () => {
    const targets: OutreachTarget[] = [
      { key: 'i1', type: 'individual', recipients: [rec('Gail', 'gail@x.com')], cc: [], bcc: [] },
    ];
    expect(mergePersonalOccurrences(targets, 'gail@x.com')).toEqual(targets);
  });
});

describe('collisionsResolved — the send-preflight gate (§3.h will consume this)', () => {
  const withCollision: OutreachTarget[] = [
    { key: 'i1', type: 'individual', recipients: [rec('Gail', 'gail@x.com')], cc: [], bcc: [] },
    { key: 'G1', type: 'group', name: 'G', recipients: [rec('Gail', 'gail@x.com')], cc: [], bcc: [] },
  ];

  it('is true when there are no collisions at all', () => {
    const clean: OutreachTarget[] = [
      { key: 'i1', type: 'individual', recipients: [rec('Alma', 'alma@x.com')], cc: [], bcc: [] },
    ];
    expect(collisionsResolved(clean, null)).toBe(true);
  });

  it('is false when a collision exists and nothing has been acknowledged', () => {
    expect(collisionsResolved(withCollision, null)).toBe(false);
  });

  it('is true once every current collision email is in a matching-fingerprint "keep all" list', () => {
    const collisions = analyzeRecipientCollisions(withCollision);
    const fingerprint = collisionsFingerprint(collisions);
    expect(collisionsResolved(withCollision, { fingerprint, keepAllEmails: ['gail@x.com'] })).toBe(
      true,
    );
  });

  it('is false when the acknowledgement fingerprint is stale (targets changed since)', () => {
    expect(
      collisionsResolved(withCollision, { fingerprint: 'stale-fp', keepAllEmails: ['gail@x.com'] }),
    ).toBe(false);
  });

  it('is true once the collision is structurally resolved (removed), even with no acknowledgement', () => {
    const resolved = removeFromGroup(withCollision, 'gail@x.com', 'G1');
    expect(collisionsResolved(resolved, null)).toBe(true);
  });
});
