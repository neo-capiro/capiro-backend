import type { EvidencePacketV2 } from '../../engagement/generation/evidence-packet.types.js';
import { buildOutreachV3PacketLedger } from './outreach-v3-packet-ledger.js';

function packet(): EvidencePacketV2 {
  return {
    packetId: '11111111-1111-4111-8111-111111111111',
    packetVersion: 2,
    tenantId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    clientId: null,
    surface: 'outreach_email',
    ref: { outreachV3SessionId: '44444444-4444-4444-8444-444444444444' },
    directives: [],
    evidence: [
      {
        ref: {
          sourceType: 'outreach_v3:target_profile_fact:fact-b',
          sourceId: 'fact-b',
          title: 'Fact B',
          retrievedAt: '2026-08-11T00:00:00.000Z',
          trust: 'server_record',
        },
        evidenceText: 'Exact bounded text B',
        scope: 'all',
      },
      {
        ref: {
          sourceType: 'bill',
          sourceId: '118-hr-1234',
          title: 'H.R. 1234',
          retrievedAt: '2026-08-11T00:00:00.000Z',
          trust: 'authoritative_structured',
        },
        evidenceText: 'Exact bill truth text',
        structuredTruth: { billId: '118-hr-1234', status: 'Introduced' },
        scope: 'all',
      },
    ],
    standingMemory: [],
    standingMemoryExclusions: [],
    failures: [],
    policy: {
      jurisdiction: 'federal',
      audienceType: 'congressional',
      policyId: 'test',
      version: '1',
    },
    modelPolicy: {
      provider: 'openai',
      model: 'test',
      promptSpecVersion: 'test',
    },
    criticalFailureCount: 0,
    freshestSourceAt: null,
    stalestSourceAt: null,
    compiledAt: '2026-08-11T00:00:00.000Z',
    packetHash: 'a'.repeat(64),
    emailScope: 'mine',
  };
}

describe('Outreach V3 packet-derived auditor ledger', () => {
  it('uses the exact packet evidence text rather than a parallel source copy', () => {
    const value = packet();
    const ledger = buildOutreachV3PacketLedger(value);
    expect(ledger).toHaveLength(2);
    expect(ledger.map((entry) => entry.serialized)).toEqual([
      'Exact bill truth text',
      'Exact bounded text B',
    ]);
  });

  it('preserves structured authoritative truth when the packet carries it', () => {
    const ledger = buildOutreachV3PacketLedger(packet());
    expect(ledger[0]).toEqual(
      expect.objectContaining({
        tool: 'get_bill_status',
        result: { billId: '118-hr-1234', status: 'Introduced' },
      }),
    );
  });

  it('stamps generic evidence with the packet identity used by the writer', () => {
    const value = packet();
    const ledger = buildOutreachV3PacketLedger(value);
    expect(ledger[1]).toEqual(
      expect.objectContaining({
        tool: 'outreach_evidence:outreach_v3:target_profile_fact:fact-b',
        result: expect.objectContaining({
          sourceId: 'fact-b',
          packetId: value.packetId,
          packetHash: value.packetHash,
        }),
      }),
    );
  });
});
