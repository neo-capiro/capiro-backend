import { describe, expect, it } from '@jest/globals';
import { buildAssuredClaimLedger } from './claim-ledger';
import {
  buildAssuranceEnvelope,
  summarizeAssuranceEnvelope,
  verifyAssuranceEnvelope,
} from './envelope';
import { planGovernmentAffairsEvidence } from './evidence-plan';
import { resolveGovernmentAffairsOperatingFrame } from './operating-frame';
import { evaluateAssuranceRelease } from './risk-gate';

function fixture() {
  const operatingFrame = resolveGovernmentAffairsOperatingFrame({
    request: 'What is the FY27 request amount for PE 0605053A?',
    asOf: '2026-07-31T20:00:00.000Z',
    explicit: { clientId: 'client-a' },
  });
  const evidencePlan = planGovernmentAffairsEvidence({
    request: 'What is the FY27 request amount for PE 0605053A?',
    frame: operatingFrame,
    surface: 'workspace-gen',
  });
  const claimLedger = buildAssuredClaimLedger(
    [
      {
        id: 'claim-1',
        text: 'The FY27 request is $192.2 million.',
        type: 'fact',
        category: 'budget_amount',
        sourceIds: ['pe-1'],
      },
    ],
    [
      {
        id: 'pe-1',
        sourceType: 'program_element_year',
        sourceId: '0605053A:2027:request',
        evidenceClass: 'official_budget_exhibit_mark_law',
        primary: true,
        authoritative: true,
        requirementIds: evidencePlan.requiredRequirementIds,
        coverage: {
          description: 'Exact official budget-position record.',
          complete: true,
          truncated: false,
          failedSources: [],
        },
      },
    ],
    { plan: evidencePlan },
  );
  const gate = evaluateAssuranceRelease({
    surface: 'workspace-gen',
    plan: evidencePlan,
    ledger: claimLedger,
    findings: [],
    verificationAvailable: true,
  });
  return { operatingFrame, evidencePlan, claimLedger, gate };
}

describe('Phase 16 assurance envelope', () => {
  it('binds frame, evidence, claims, release decision, context, policy, and verifier', () => {
    const input = fixture();
    const envelope = buildAssuranceEnvelope({
      surface: 'workspace-gen',
      ...input,
      contextPacketId: 'packet-1',
      policyBinding: {
        packId: 'pack-a',
        packVersion: '3',
        ruleId: 'rule-7',
        decisionHash: 'decision-hash',
      },
      generatedAt: '2026-07-31T20:00:00.000Z',
    });

    expect(envelope.releaseDecision).toBe('deliver');
    expect(envelope.contextPacketId).toBe('packet-1');
    expect(envelope.policyBinding?.packVersion).toBe('3');
    expect(envelope.claimLedger.hash).toBe(input.claimLedger.hash);
    expect(verifyAssuranceEnvelope(envelope).valid).toBe(true);
  });

  it('detects content, context, policy, surface, and verifier drift', () => {
    const input = fixture();
    const envelope = buildAssuranceEnvelope({
      surface: 'strategy',
      ...input,
      contextPacketId: 'packet-1',
      policyBinding: { packId: 'pack-a', packVersion: '3', ruleId: 'rule-7' },
      generatedAt: '2026-07-31T20:00:00.000Z',
    });
    const tampered = {
      ...envelope,
      releaseDecision: 'deliver_with_flags' as const,
    };

    expect(verifyAssuranceEnvelope(tampered).errors).toContain('hash_mismatch');
    expect(
      verifyAssuranceEnvelope(envelope, {
        surface: 'outreach',
        contextPacketId: 'packet-2',
        policyBinding: { packId: 'pack-a', packVersion: '4', ruleId: 'rule-7' },
        verifierVersion: 'future-verifier',
      }).errors,
    ).toEqual(
      expect.arrayContaining([
        'surface_mismatch',
        'context_packet_drift',
        'policy_binding_drift',
        'verifier_version_drift',
      ]),
    );
  });

  it('attributes a section finding only to its originating section', () => {
    const input = fixture();
    const envelope = buildAssuranceEnvelope({
      surface: 'workspace-gen',
      ...input,
      findings: [
        {
          check: 'D3',
          severity: 'high',
          detail: 'The figure is inconsistent with the authoritative record.',
          attribution: { scope: 'section', subjectId: 'Funding request' },
        },
      ],
      generatedAt: '2026-07-31T20:00:00.000Z',
    });

    expect(envelope.findings).toEqual([
      expect.objectContaining({
        check: 'D3',
        attribution: { scope: 'section', subjectId: 'Funding request' },
      }),
    ]);
  });

  it('produces a bounded operational summary without claim text', () => {
    const input = fixture();
    const envelope = buildAssuranceEnvelope({
      surface: 'workspace-gen',
      ...input,
      generatedAt: '2026-07-31T20:00:00.000Z',
    });
    const summary = summarizeAssuranceEnvelope(envelope);

    expect(summary.claimCount).toBe(1);
    expect(summary.hash).toBe(envelope.hash);
    expect(JSON.stringify(summary)).not.toContain('192.2');
  });
});
