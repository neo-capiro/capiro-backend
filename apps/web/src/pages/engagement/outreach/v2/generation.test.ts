// Locks the Generate & Review entity model: per-entity draft slots
// (individual = 1, list = 1 per member, group = 1 shared) and the send
// projection — a group projects to ONE draft keyed to its representative
// (group:<targetKey>), sent as a single email to all members in To.

import { describe, expect, it } from 'vitest';
import {
  buildGenerateTasks,
  buildGenerationModel,
  listAidFromKey,
  partitionGenerationResults,
  projectDraftsForSend,
  type BatchDraftResult,
} from './generation.js';
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

  it('LEGACY path only: a locally-edited draft is sendable when versioning is OFF', () => {
    // This is the pre-Phase-0 contract, retained for the flag-off path. Under
    // versioned outreach the equivalent case is covered by
    // versioned-drafts.test.ts, where a local edit is NOT sendable until the
    // server returns a new audited version.
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

describe('buildGenerateTasks (shared sync + async task split, W4.4)', () => {
  it('chunks unique flat recipients and emits one group task with its context', () => {
    const { slots } = buildGenerationModel(mix); // individual a; list b,c; group d,e
    const tasks = buildGenerateTasks(slots, 100);
    // 1 flat chunk (a,b,c unique) + 1 group task.
    expect(tasks).toHaveLength(2);
    const flat = tasks.find((t) => !t.audienceKind)!;
    expect(flat.recipients.map((r) => r.email).sort()).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
    expect(flat.chunkSlots).toHaveLength(3);
    const group = tasks.find((t) => t.audienceKind === 'group')!;
    expect(group.recipients).toHaveLength(1); // one representative
    expect(group.additionalContext).toContain('d@x.com');
    expect(group.chunkSlots).toHaveLength(1);
  });

  it('splits flat recipients across chunks at batchMax', () => {
    const { slots } = buildGenerationModel([
      individual('a@x.com'),
      individual('b@x.com'),
      individual('c@x.com'),
    ]);
    const tasks = buildGenerateTasks(slots, 2);
    expect(tasks).toHaveLength(2); // 3 recipients / 2 per chunk
    expect(tasks[0]!.recipients).toHaveLength(2);
    expect(tasks[1]!.recipients).toHaveLength(1);
  });

  it('a person in two lists is ONE unique recipient but both slots ride in chunkSlots', () => {
    const dup = 'shared@x.com';
    const targets = [list('L1', 'a1', [dup]), list('L2', 'a2', [dup])];
    const { slots } = buildGenerationModel(targets);
    const tasks = buildGenerateTasks(slots, 100);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.recipients).toHaveLength(1); // deduped by resultId
    expect(tasks[0]!.chunkSlots).toHaveLength(2); // both list-member slots
  });
});

describe('partitionGenerationResults (W0.2 same-batch failure routing)', () => {
  const slots = [
    { genKey: 'individual:a', resultId: 'a' },
    { genKey: 'individual:b', resultId: 'b' },
  ];

  it('routes a status:error item to failedGenKeys and a ready item to drafts', () => {
    const results: BatchDraftResult[] = [
      { recipientId: 'a', subject: 'SA', body: 'BA', status: 'ready' },
      { recipientId: 'b', subject: '', body: '', status: 'error', error: 'boom' },
    ];
    const { drafts, failedGenKeys } = partitionGenerationResults(slots, results);
    expect(drafts).toEqual([{ genKey: 'individual:a', subject: 'SA', body: 'BA' }]);
    expect(failedGenKeys).toEqual(['individual:b']);
  });

  it('routes a slot with NO matching result (backend dropped it) to failedGenKeys', () => {
    const results: BatchDraftResult[] = [
      { recipientId: 'a', subject: 'SA', body: 'BA', status: 'ready' },
      // no entry for 'b'
    ];
    const { drafts, failedGenKeys } = partitionGenerationResults(slots, results);
    expect(drafts.map((d) => d.genKey)).toEqual(['individual:a']);
    expect(failedGenKeys).toEqual(['individual:b']);
  });

  it('all ready → no failures; all error → no drafts', () => {
    const allReady: BatchDraftResult[] = [
      { recipientId: 'a', subject: 'SA', body: 'BA', status: 'ready' },
      { recipientId: 'b', subject: 'SB', body: 'BB', status: 'ready' },
    ];
    expect(partitionGenerationResults(slots, allReady).failedGenKeys).toEqual([]);
    const allError: BatchDraftResult[] = [
      { recipientId: 'a', subject: '', body: '', status: 'error' },
      { recipientId: 'b', subject: '', body: '', status: 'error' },
    ];
    expect(partitionGenerationResults(slots, allError).drafts).toEqual([]);
    expect(partitionGenerationResults(slots, allError).heldDrafts).toEqual([]);
  });

  it('PRESERVES a status:held item instead of collapsing it into a failure (Phase 0 g2)', () => {
    const results: BatchDraftResult[] = [
      { recipientId: 'a', subject: 'SA', body: 'BA', status: 'ready' },
      // A held draft has REAL content that a reviewer must read. Routing it to
      // failedGenKeys made the wizard overwrite it with a "generation failed"
      // placeholder, destroying the very text under review.
      {
        recipientId: 'b',
        subject: 'SB',
        body: 'BB',
        status: 'held',
        contextNote: 'Unverified — 1 grounding finding',
      },
    ];
    const { drafts, heldDrafts, failedGenKeys, heldGenKeys } = partitionGenerationResults(
      slots,
      results,
    );
    expect(drafts).toEqual([{ genKey: 'individual:a', subject: 'SA', body: 'BA' }]);
    // NOT a failure…
    expect(failedGenKeys).toEqual([]);
    // …and the content survives, with its internal note.
    expect(heldGenKeys).toEqual(['individual:b']);
    expect(heldDrafts).toEqual([
      {
        genKey: 'individual:b',
        subject: 'SB',
        body: 'BB',
        contextNote: 'Unverified — 1 grounding finding',
      },
    ]);
  });

  it('a held draft is still NOT sendable (it never reaches `drafts`)', () => {
    const results: BatchDraftResult[] = [
      { recipientId: 'a', subject: 'SA', body: 'BA', status: 'held' },
    ];
    const { drafts, heldDrafts } = partitionGenerationResults(
      [{ genKey: 'individual:a', resultId: 'a' }],
      results,
    );
    expect(drafts).toEqual([]);
    expect(heldDrafts).toHaveLength(1);
  });

  it('a genuine failure and a dropped slot both remain failures', () => {
    const { drafts, heldDrafts, failedGenKeys } = partitionGenerationResults(slots, [
      { recipientId: 'a', subject: '', body: '', status: 'error', error: 'boom' },
      // nothing for 'b'
    ]);
    expect(drafts).toEqual([]);
    expect(heldDrafts).toEqual([]);
    expect(failedGenKeys.sort()).toEqual(['individual:a', 'individual:b']);
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

// ── Phase 1 §3.j / §5.5 — the Context Used manifest travels with each result ──

describe('partitionGenerationResults carries the source manifest', () => {
  const manifest = (packetId: string) =>
    ({
      contextPacketId: packetId,
      packetHash: 'h',
      evidenceCountsByType: { bill: 1 },
      included: [],
      exclusions: [],
      failures: [],
      criticalFailures: [],
      oldestSourceAt: null,
      newestSourceAt: null,
      policy: {
        policyId: 'federal.congressional_office',
        version: 'ga-policy-v1',
        label: 'Federal congressional office',
        jurisdiction: 'federal',
        audienceType: 'congressional_office',
      },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      planModel: null,
      promptSpecVersion: 'v2.2-gateway',
      emailScopeLabel: 'My mailbox',
      standingMemoryCount: 0,
      criticalMissingContext: [],
      disclosures: [],
    }) as NonNullable<BatchDraftResult['manifest']>;

  const slots = [
    { genKey: 'individual:a', resultId: 'a' },
    { genKey: 'individual:b', resultId: 'b' },
    { genKey: 'individual:c', resultId: 'c' },
  ];

  it('attaches the manifest to a READY draft', () => {
    const out = partitionGenerationResults(slots.slice(0, 1), [
      { recipientId: 'a', subject: 's', body: 'b', status: 'ready', manifest: manifest('pkt-a') },
    ]);
    expect(out.drafts[0]?.manifest?.contextPacketId).toBe('pkt-a');
    expect(out.manifests.get('individual:a')?.contextPacketId).toBe('pkt-a');
  });

  it('attaches the manifest to a HELD draft', () => {
    const out = partitionGenerationResults(slots.slice(1, 2), [
      { recipientId: 'b', subject: 's', body: 'b', status: 'held', manifest: manifest('pkt-b') },
    ]);
    expect(out.heldDrafts[0]?.manifest?.contextPacketId).toBe('pkt-b');
  });

  it('keeps the manifest for a FAILED slot — that is when it is most needed', () => {
    // A blocked generation is exactly when the user needs to see which source
    // failed; dropping the manifest with the draft would leave an unexplained
    // error on screen.
    const out = partitionGenerationResults(slots.slice(2, 3), [
      {
        recipientId: 'c',
        subject: '',
        body: '',
        status: 'error',
        error: 'CRITICAL_SOURCE_FAILURE',
        manifest: manifest('pkt-c'),
      },
    ]);
    expect(out.failedGenKeys).toEqual(['individual:c']);
    expect(out.manifests.get('individual:c')?.contextPacketId).toBe('pkt-c');
  });

  it('is absent on the flag-off path, without breaking partitioning', () => {
    const out = partitionGenerationResults(slots.slice(0, 1), [
      { recipientId: 'a', subject: 's', body: 'b', status: 'ready' },
    ]);
    expect(out.drafts[0]?.manifest).toBeUndefined();
    expect(out.manifests.size).toBe(0);
  });
});
