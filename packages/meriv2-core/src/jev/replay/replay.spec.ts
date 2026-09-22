import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildClaimSupportQuestion } from '../claim-support-question';
import { createJevDecisionProvider } from '../jev-decision-provider';
import { createReplayDecisionProvider } from './replay-decision-provider';
import { RecordedDecisionStore } from './recorded-decision-store';
import { runPairedEvaluation } from './paired-evaluation';
import type { DecisionProvider, EvidenceEnvelope } from '../decision-contract';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const envelope: EvidenceEnvelope = { envelopeVersion: 'meri-evidence-envelope-v1', claimId: 'c1', claimText: 'A claim', claimKind: 'fact', claimCategory: 'status', tenantId: 'tenant-a', clientId: null, scopeQualifiers: [], asOf: null, sources: [] };

function tempStore(): RecordedDecisionStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'jev-replay-')); dirs.push(dir);
  return new RecordedDecisionStore(path.join(dir, 'store.jsonl'));
}

describe('Jev replay', () => {
  it('produces deterministic hashes for replay misses', async () => {
    const provider = createReplayDecisionProvider({ store: tempStore(), model: 'jev-1.13.0' });
    const legacy: DecisionProvider = { name: 'stub', available: () => true, async assess() { return { kind: 'failure', state: 'not_checked', reasonCodes: ['stub'], provider: { name: 'stub', model: 'stub', questionVersion: 'claim_support.v1' }, latencyMs: 0 }; } };
    const input = { cases: [{ id: 'case', category: 'supported', claimKind: 'fact', expectedOutcome: 'supported' as const, humanReview: { status: 'proposed' }, envelope }], providers: { jev: provider, legacy }, question: buildClaimSupportQuestion };
    expect((await runPairedEvaluation(input)).hash).toBe((await runPairedEvaluation(input)).hash);
  });

  it('refuses tenant scope without fetching', async () => {
    let calls = 0;
    const provider = createJevDecisionProvider({ model: 'jev-1.13.0', scope: { tenantId: 'tenant-b', surface: 'chat' }, client: { systemOne: async () => { calls += 1; throw new Error('unexpected'); } } as never });
    const decision = await provider.assess(envelope, buildClaimSupportQuestion(envelope));
    expect(decision.kind === 'failure' && decision.state).toBe('scope_refused');
    expect(calls).toBe(0);
  });

  it('rejects key-looking header material before writing', () => {
    const store = tempStore();
    expect(() => store.append({ envelopeHash: 'hash', questionVersion: 'q1', model: 'model', provider: 'jev', recordedAt: '2026-01-01T00:00:00Z', request: { state: { headers: { Authorization: 'Bearer secret-value' } }, questions: {} }, response: {}, latencyMs: 1 })).toThrow(/forbidden/);
    expect(() => readFileSync(store.path, 'utf8')).toThrow();
  });
});
