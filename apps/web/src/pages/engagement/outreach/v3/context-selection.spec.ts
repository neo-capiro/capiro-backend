import { describe, expect, it } from 'vitest';
import type { OutreachV3ContextCandidate } from './contracts.js';
import {
  canBeGuidance,
  canBePolicy,
  contextCandidateKey,
  contextPurposeOptions,
  contextSelectionFor,
  contextSelectionForClass,
  defaultContextPurpose,
} from './context-selection.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';

function memory(
  overrides: Partial<Extract<OutreachV3ContextCandidate, { sourceKind: 'memory' }>> = {},
): OutreachV3ContextCandidate {
  return {
    sourceKind: 'memory',
    title: 'Congressional staff writing style',
    summary: 'Use concise, direct language.',
    memoryType: 'writing_preference',
    clientId: CLIENT,
    verificationClass: 'first_party',
    sensitivity: 'normal',
    instructionsAllowed: true,
    lastVerifiedAt: '2026-08-01T12:00:00.000Z',
    selection: {
      locator: { source: 'memory_item', id: 'memory-1', clientId: CLIENT },
      contextClass: 'campaign_fact',
      scope: { kind: 'campaign' },
    },
    ...overrides,
  };
}

function government(): OutreachV3ContextCandidate {
  return {
    sourceKind: 'government',
    category: 'bill',
    id: 'hr-1234',
    title: 'H.R. 1234',
    subtitle: 'Ground robotics procurement',
    date: '2026-06-01T12:00:00.000Z',
    href: 'https://example.test/hr-1234',
    selection: {
      locator: { source: 'government_record', category: 'bill', id: 'hr-1234' },
      contextClass: 'campaign_fact',
      scope: { kind: 'campaign' },
    },
  };
}

function document(): OutreachV3ContextCandidate {
  return {
    sourceKind: 'document',
    attachmentId: 'attachment-1',
    clientId: CLIENT,
    clientName: 'Acme Robotics',
    title: 'Capability brief.pdf',
    date: '2026-07-02T12:00:00.000Z',
    selection: {
      locator: { source: 'document', id: 'attachment-1', clientId: CLIENT },
      contextClass: 'campaign_fact',
      scope: { kind: 'campaign' },
    },
  };
}

describe('canBeGuidance', () => {
  it('mirrors the server gate: only instruction-allowed memory qualifies', () => {
    expect(canBeGuidance(memory())).toBe(true);
    expect(canBeGuidance(memory({ instructionsAllowed: false }))).toBe(false);
    // Both resolvers hard-code instructionsAllowed: false.
    expect(canBeGuidance(government())).toBe(false);
    expect(canBeGuidance(document())).toBe(false);
  });
});

describe('canBePolicy', () => {
  it('rules out only what is provably unusable as evidence', () => {
    // 'unverified' comes from a pending/proposed governed status, which can never
    // satisfy the server's `approved && !conflicted && !expired`.
    expect(canBePolicy(memory({ verificationClass: 'unverified' }))).toBe(false);
    expect(canBePolicy(memory({ verificationClass: 'authoritative' }))).toBe(true);
    expect(canBePolicy(memory({ verificationClass: 'first_party' }))).toBe(true);
    // Government records resolve usableAsEvidence: true unconditionally.
    expect(canBePolicy(government())).toBe(true);
  });
});

describe('contextPurposeOptions', () => {
  it('always offers evidence and explains every refusal', () => {
    const options = contextPurposeOptions(government());
    const byValue = new Map(options.map((option) => [option.value, option]));

    expect(byValue.get('evidence')?.allowed).toBe(true);
    expect(byValue.get('guidance')?.allowed).toBe(false);
    expect(byValue.get('guidance')?.blockedReason).toBe(
      'Only institutional-memory items can carry writing instructions.',
    );
    // A blocked option must always say why — a silently disabled control is the
    // thing this stage was rewritten to remove.
    for (const option of options) {
      if (option.allowed) expect(option.blockedReason).toBeNull();
      else expect(option.blockedReason).toBeTruthy();
    }
  });

  it('never offers group_safe, which has no reachable source', () => {
    const values = contextPurposeOptions(memory()).map((option) => option.value);
    expect(values).toEqual(['evidence', 'guidance', 'policy']);
  });
});

describe('defaultContextPurpose', () => {
  it('preselects evidence only when the source cannot be guidance', () => {
    expect(defaultContextPurpose(government())).toBe('evidence');
    expect(defaultContextPurpose(document())).toBe('evidence');
    expect(defaultContextPurpose(memory({ instructionsAllowed: false }))).toBe('evidence');
    // Genuinely ambiguous: style read as a citable fact is a real governance
    // error, so refuse to guess.
    expect(defaultContextPurpose(memory())).toBeNull();
  });
});

describe('contextSelectionFor', () => {
  it('maps evidence plus a target onto target_specific with target scope', () => {
    expect(contextSelectionFor(government(), 'evidence', 'directory_staff:staff-1')).toEqual({
      locator: { source: 'government_record', category: 'bill', id: 'hr-1234' },
      contextClass: 'target_specific',
      scope: { kind: 'target', targetKey: 'directory_staff:staff-1' },
    });
  });

  it('maps evidence with no target onto campaign_fact', () => {
    expect(contextSelectionFor(government(), 'evidence', null).contextClass).toBe('campaign_fact');
    expect(contextSelectionFor(government(), 'evidence', null).scope).toEqual({ kind: 'campaign' });
  });

  it('keeps guidance and policy campaign-wide even when a target is passed', () => {
    // The server treats both as campaign-wide; sending target scope with either
    // would be rejected, so the target is dropped here rather than forwarded.
    const guidance = contextSelectionFor(memory(), 'guidance', 'directory_staff:staff-1');
    expect(guidance.contextClass).toBe('writing_guidance');
    expect(guidance.scope).toEqual({ kind: 'campaign' });

    const policy = contextSelectionFor(memory(), 'policy', 'directory_staff:staff-1');
    expect(policy.contextClass).toBe('required_policy');
    expect(policy.scope).toEqual({ kind: 'campaign' });
  });

  it('carries the locator through untouched', () => {
    const candidate = document();
    expect(contextSelectionFor(candidate, 'evidence', null).locator).toEqual(
      candidate.selection.locator,
    );
  });
});

describe('contextSelectionForClass', () => {
  it('attaches target scope only to target_specific', () => {
    expect(contextSelectionForClass(government(), 'campaign_fact', 'staff-1').scope).toEqual({
      kind: 'campaign',
    });
    expect(contextSelectionForClass(government(), 'target_specific', 'staff-1').scope).toEqual({
      kind: 'target',
      targetKey: 'staff-1',
    });
  });
});

describe('contextCandidateKey', () => {
  it('is stable across the class a candidate happens to arrive with', () => {
    const a = government();
    const b = government();
    b.selection = { ...b.selection, contextClass: 'required_policy' };
    // Identity is the source record, not how it was tentatively classified —
    // otherwise an already-accepted item would look addable again.
    expect(contextCandidateKey(a)).toBe(contextCandidateKey(b));
  });

  it('separates different records from the same source', () => {
    expect(contextCandidateKey(memory())).not.toBe(contextCandidateKey(document()));
  });
});
