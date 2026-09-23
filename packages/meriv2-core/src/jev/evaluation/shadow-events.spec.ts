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
  return { event: 'meri.evidence_shadow', conversationId: 'c', turnId: 't', claimId: 'claim-1', claimKind: 'fact', claimCategory: 'amount', envelopeHash: 'hash-1', eligibility: { eligible: true, reason: 'ok' }, jev: outcome('supported'), legacy: outcome('contradicted'), agreement: false, legacyAdapterVersion: 'legacy-skeptic-adapter.v1', proposedAction: { jev: 'retain', legacy: 'qualify' }, source: 'live' };
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

  it('defaults old events to legacy adapter v1', () => {
    const old = { ...event() } as Partial<EvidenceShadowEvent>;
    delete old.legacyAdapterVersion;
    const directory = mkdtempSync(path.join(tmpdir(), 'jev-old-events-'));
    directories.push(directory);
    const file = path.join(directory, 'events.jsonl');
    writeFileSync(file, JSON.stringify({ message: 'meri.evidence_shadow', fields: old }));
    expect(readShadowEvents(file).events[0]).toMatchObject({ legacyAdapterVersion: 'legacy-skeptic-adapter.v1' });
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
