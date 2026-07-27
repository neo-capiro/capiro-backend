/**
 * Context Used panel + the send gate it drives (Phase 1 §3.j2, §5.5).
 *
 * The gate assertions matter more than the rendering ones: a panel that DISPLAYS
 * a critical source failure while Send stays enabled would be worse than no
 * panel at all, because it would look like the problem had been handled.
 */
import { describe, expect, it } from 'vitest';
import { manifestBlocksSend } from './ContextUsedPanel.js';
import {
  DRAFT_BLOCK_COPY,
  draftBlockReason,
  isDraftSendable,
} from './versioned-drafts.js';
import type { GeneratedDraft, GenerationSourceManifest, SourceFailure } from './types.js';

function manifest(over: Partial<GenerationSourceManifest> = {}): GenerationSourceManifest {
  return {
    contextPacketId: 'pkt-1',
    packetHash: 'hash',
    evidenceCountsByType: { bill: 1, email: 2 },
    included: [
      {
        sourceType: 'bill',
        sourceId: 'hr1234-119',
        title: 'HR 1234',
        trust: 'authoritative_structured',
        asOf: '2026-07-20T00:00:00.000Z',
        scope: 'all',
      },
    ],
    exclusions: [],
    failures: [],
    criticalFailures: [],
    oldestSourceAt: '2026-01-01T00:00:00.000Z',
    newestSourceAt: '2026-07-20T00:00:00.000Z',
    policy: {
      policyId: 'federal.congressional_office',
      version: 'ga-policy-v1',
      label: 'Federal congressional office',
      jurisdiction: 'federal',
      audienceType: 'congressional_office',
    },
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    planModel: 'claude-haiku-4-5-20251001',
    promptSpecVersion: 'v2.2-gateway',
    emailScopeLabel: 'My mailbox',
    standingMemoryCount: 2,
    criticalMissingContext: [],
    disclosures: [],
    ...over,
  };
}

const CRITICAL: SourceFailure = {
  sourceType: 'bill',
  severity: 'critical',
  code: 'BILL_NOT_ON_RECORD',
  userMessage: 'Capiro has no record of the bill you selected.',
};

const IMPORTANT: SourceFailure = {
  sourceType: 'trackedBills',
  severity: 'important',
  code: 'TRACKEDBILLS_UNAVAILABLE',
  userMessage: 'Tracked legislation could not be loaded.',
};

/** A draft the audit layer considers perfectly sendable. */
function cleanDraft(over: Partial<GeneratedDraft> = {}): GeneratedDraft {
  return {
    subject: 'A meeting',
    body: 'Hi Dana —',
    versionId: 'v1',
    artifactId: 'a1',
    version: 1,
    generationStatus: 'generated',
    auditStatus: 'passed',
    approvalStatus: 'not_required',
    sendable: true,
    dirty: false,
    ...over,
  };
}

describe('manifestBlocksSend', () => {
  it('is false with no manifest (flag-off path is unaffected)', () => {
    expect(manifestBlocksSend(undefined)).toBe(false);
  });

  it('is false when nothing critical failed', () => {
    expect(manifestBlocksSend(manifest({ failures: [IMPORTANT] }))).toBe(false);
  });

  it('is true on a critical failure', () => {
    expect(
      manifestBlocksSend(manifest({ failures: [CRITICAL], criticalFailures: [CRITICAL] })),
    ).toBe(true);
  });
});

describe('a critical source failure blocks Send', () => {
  it('overrides a CLEAN audit verdict', () => {
    // The audit can legitimately pass BECAUSE the missing source produced nothing
    // to contradict. "Defensible given what we saw" and "we saw what we needed"
    // are different claims, and only the second licenses a send.
    const draft = cleanDraft({
      manifest: manifest({ failures: [CRITICAL], criticalFailures: [CRITICAL] }),
    });
    expect(draft.sendable).toBe(true); // the server's audit verdict
    expect(isDraftSendable(draft)).toBe(false); // …but the gate still refuses
  });

  it('reports source_failure as the reason, with actionable copy', () => {
    const draft = cleanDraft({
      manifest: manifest({ failures: [CRITICAL], criticalFailures: [CRITICAL] }),
    });
    expect(draftBlockReason(draft)).toBe('source_failure');
    expect(DRAFT_BLOCK_COPY.source_failure).toMatch(/cannot be sent/);
    expect(DRAFT_BLOCK_COPY.source_failure).toMatch(/Source failures/);
  });

  it('does NOT block on a non-critical failure', () => {
    const draft = cleanDraft({ manifest: manifest({ failures: [IMPORTANT] }) });
    expect(isDraftSendable(draft)).toBe(true);
    expect(draftBlockReason(draft)).toBeNull();
  });

  it('leaves a draft with no manifest exactly as before', () => {
    expect(isDraftSendable(cleanDraft())).toBe(true);
    expect(draftBlockReason(cleanDraft())).toBeNull();
  });

  it('unsaved keystrokes still win over everything else', () => {
    const draft = cleanDraft({
      dirty: true,
      manifest: manifest({ failures: [CRITICAL], criticalFailures: [CRITICAL] }),
    });
    expect(draftBlockReason(draft)).toBe('dirty');
    expect(isDraftSendable(draft)).toBe(false);
  });

  it('the gate and the banner agree on the reason', () => {
    // Two copies of "is this blocked" is how a UI ends up explaining one thing
    // and enforcing another.
    const draft = cleanDraft({
      manifest: manifest({ failures: [CRITICAL], criticalFailures: [CRITICAL] }),
    });
    expect(isDraftSendable(draft)).toBe(false);
    expect(draftBlockReason(draft)).not.toBeNull();
  });
});

describe('held drafts keep their verifier findings visible', () => {
  it('a held draft carries its contextNote and stays non-sendable', () => {
    const draft = cleanDraft({
      auditStatus: 'held',
      approvalStatus: 'pending',
      sendable: false,
      contextNote: '⚠️ Held for review — 1 verification finding: unresolved placeholder.',
      manifest: manifest(),
    });
    expect(isDraftSendable(draft)).toBe(false);
    expect(draftBlockReason(draft)).toBe('held');
    expect(draft.contextNote).toMatch(/Held for review/);
  });
});

describe('the manifest surfaces what the panel renders', () => {
  it('carries inclusions, freshness, policy, model and mailbox scope', () => {
    const m = manifest();
    expect(m.included).toHaveLength(1);
    expect(m.oldestSourceAt).toBe('2026-01-01T00:00:00.000Z');
    expect(m.newestSourceAt).toBe('2026-07-20T00:00:00.000Z');
    expect(m.policy.label).toBe('Federal congressional office');
    expect(m.emailScopeLabel).toBe('My mailbox');
    expect(m.provider).toBe('anthropic');
    expect(m.standingMemoryCount).toBe(2);
  });

  it('names the remediation for each critical failure', () => {
    const m = manifest({
      failures: [CRITICAL],
      criticalFailures: [CRITICAL],
      criticalMissingContext: [CRITICAL.userMessage],
    });
    expect(m.criticalMissingContext).toEqual(['Capiro has no record of the bill you selected.']);
  });

  it('exposes an unscanned-attachment disclosure rather than staying silent', () => {
    const m = manifest({
      disclosures: ['This file was NOT virus-scanned (no scanner is configured).'],
    });
    expect(m.disclosures[0]).toMatch(/NOT virus-scanned/);
  });
});
