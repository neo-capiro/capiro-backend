import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { joinWithLabels, readShadowEvents, type EvidenceShadowEvent } from './shadow-events';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });

function event(): EvidenceShadowEvent {
  const outcome = (value: 'supported' | 'contradicted') => ({
    kind: 'outcome' as const, outcome: value, confidence: 0.9,
    probabilities: { supported: 0.9, contradicted: 0.05, insufficient_evidence: 0.03, conflicting_evidence: 0.02 },
    reasonCodes: [], model: 'model-v1', questionVersion: 'claim_support.v1', latencyMs: 1, inputTokens: 4,
  });
  return { event: 'meri.evidence_shadow', schemaVersion: 'meri.evidence_shadow.v1', conversationId: 'c', turnId: 't', claimId: 'claim-1', claimKind: 'fact', claimCategory: 'amount', envelopeHash: 'hash-1', eligibility: { eligible: true, reason: 'ok' }, jev: outcome('supported'), legacy: outcome('contradicted'), agreement: false, legacyAdapterVersion: 'legacy-skeptic-adapter.v1', proposedAction: { jev: 'retain', legacy: 'qualify' }, source: 'live' };
}

describe('shadow event ingestion', () => {
  it('parses structured logger shapes while counting junk and unrelated lines', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'jev-events-'));
    directories.push(directory);
    const file = path.join(directory, 'events.jsonl');
    writeFileSync(file, [
      'not-json',
      JSON.stringify({ message: 'some.other.event', fields: {} }),
      JSON.stringify({ message: 'meri.evidence_shadow', fields: event() }),
      JSON.stringify({ message: 'meri.evidence_shadow', fields: { claimId: 1 } }),
    ].join('\n'));
    const result = readShadowEvents(file);
    expect(result.events).toHaveLength(1);
    expect(result.rejected).toBe(2);
    expect(result.unrelated).toBe(1);
  });

  it('preserves additive cascade fields when reading shadow events', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'jev-cascade-events-'));
    directories.push(directory);
    const file = path.join(directory, 'events.jsonl');
    writeFileSync(file, JSON.stringify({
      message: 'meri.evidence_shadow', fields: {
        ...event(), escalated: true, escalationReasons: ['low_confidence', 'audit_sample'],
        audited: true, auditDisagreement: true,
      },
    }));
    expect(readShadowEvents(file).events[0]).toMatchObject({
      escalated: true, escalationReasons: ['low_confidence', 'audit_sample'],
      audited: true, auditDisagreement: true,
    });
  });

  it('reads the versioned freshness split and preserves linked-ledger temporal values', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'jev-freshness-events-'));
    directories.push(directory);
    const file = path.join(directory, 'events.jsonl');
    writeFileSync(file, JSON.stringify({
      message: 'meri.evidence_shadow', fields: {
        ...event(), schemaVersion: 'meri.evidence_shadow.v2',
        freshness: {
          requiredDocumentEligible: false, claimLinkedEvidencePresent: true, sourceDateKnown: false,
          eligibleSourceFreshness: { state: 'unknown', ageDays: null, basis: 'none' },
          linkedLedgerTemporalInformation: { state: 'fresh', ageDays: null, basis: 'none' },
        },
      },
    }));
    expect(readShadowEvents(file).events[0]).toMatchObject({
      schemaVersion: 'meri.evidence_shadow.v2',
      freshness: {
        requiredDocumentEligible: false,
        eligibleSourceFreshness: { state: 'unknown' },
        linkedLedgerTemporalInformation: { state: 'fresh', basis: 'none' },
      },
    });
  });

  it('defaults old events to legacy adapter v1', () => {
    const old = { ...event() } as Partial<EvidenceShadowEvent>;
    delete old.legacyAdapterVersion;
    const directory = mkdtempSync(path.join(tmpdir(), 'jev-old-events-'));
    directories.push(directory);
    const file = path.join(directory, 'events.jsonl');
    writeFileSync(file, JSON.stringify({ message: 'meri.evidence_shadow', fields: old }));
    expect(readShadowEvents(file).events[0]).toMatchObject({ legacyAdapterVersion: 'legacy-skeptic-adapter.v1' });
  });

  it('preserves stop reasons on turn events and accepts older turn events without them', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'jev-turn-events-'));
    directories.push(directory);
    const file = path.join(directory, 'events.jsonl');
    const oldTurn = {
      event: 'meri.evidence_shadow.turn', conversationId: 'c', turnId: 't', selected: 1, skipped: 0,
      budgetExhausted: false, durationMs: 12, inputTokens: 10, estimatedCostUsd: 0.000001, sampled: true,
    };
    const newTurn = { ...oldTurn, stopReason: 'max_input_tokens' };
    writeFileSync(file, [
      JSON.stringify({ message: 'meri.evidence_shadow.turn', fields: oldTurn }),
      JSON.stringify({ message: 'meri.evidence_shadow.turn', fields: newTurn }),
    ].join('\n'));

    const result = readShadowEvents(file);
    expect(result.rejected).toBe(0);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).not.toHaveProperty('stopReason');
    expect(result.events[1]).toMatchObject({ stopReason: 'max_input_tokens' });
  });

  it('parses provider lifecycle events without requiring lifecycle metadata on older claim events', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'jev-provider-lifecycle-'));
    directories.push(directory);
    const file = path.join(directory, 'events.jsonl');
    const lifecycle = {
      event: 'meri.evidence_shadow.provider_lifecycle', lifecycleId: 'sha256:abc:jev',
      conversationId: 'c', turnId: 't', claimId: 'claim-1', envelopeHash: 'sha256:abc',
      provider: 'jev', dispatchBoundary: 'decision_provider_assess', eligible: true,
      waitState: 'cancelled_by_shared_budget', providerState: 'pending', cancellationReason: 'shared_deadline',
      eligibilityCheckedAt: '2026-09-25T12:00:00.000Z', eligibleAt: '2026-09-25T12:00:00.000Z',
      attemptedAt: '2026-09-25T12:00:00.001Z', dispatchedAt: '2026-09-25T12:00:00.002Z',
      settledAt: null, cancelledAt: '2026-09-25T12:00:06.000Z', actualUsage: null,
      usageStatus: 'unknown_due_cancellation', costStatus: 'unknown_due_cancellation',
    };
    writeFileSync(file, JSON.stringify({ message: lifecycle.event, fields: lifecycle }));
    const result = readShadowEvents(file);
    expect(result.rejected).toBe(0);
    expect(result.events).toMatchObject([{ ...lifecycle }]);
  });

  it('prefers approved override labels and ignores proposed labels', () => {
    const rows = joinWithLabels([event()], undefined, {
      version: 'jev_human_labels_v1', labels: [
        { claimId: 'claim-1', label: 'contradicted', status: 'proposed', reviewer: 'A', reviewedAt: '2026-09-22T00:00:00.000Z', note: 'draft' },
        { envelopeHash: 'hash-1', label: 'supported', status: 'approved', reviewer: 'B', reviewedAt: '2026-09-22T00:00:00.000Z', note: 'reviewed' },
      ],
    });
    expect(rows[0]).toMatchObject({ humanLabel: 'supported', labelSource: 'override', reviewer: 'B' });
  });
});
