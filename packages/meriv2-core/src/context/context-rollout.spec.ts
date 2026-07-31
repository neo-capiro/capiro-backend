import { describe, expect, it, jest } from '@jest/globals';
import type { ContextRequest, SteeringRow, TruthfulCompiledContextPacket } from './contract';
import {
  ContextPacketRolloutCompiler,
  type ContextPacketShadowComparison,
} from './context-rollout';

const approvedFirm = (over: Partial<SteeringRow> = {}): SteeringRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  type: 'firm-soul',
  slug: 'firm',
  title: 'Firm Soul',
  clientId: null,
  ownerUserId: null,
  visibility: 'tenant',
  status: 'active',
  expiresAt: null,
  updatedAt: '2026-07-30T00:00:00.000Z',
  confirmedAt: '2026-07-30T00:00:00.000Z',
  authority: 'human',
  sections: [
    {
      owner: 'human',
      heading: 'Identity',
      body: 'We advise government-affairs teams.',
    },
  ],
  memoryClass: 'institutional_authoritative',
  governedAuthority: 'firm_approved',
  sourceType: 'firm_playbook',
  sourceId: 'source-1',
  sourceContentHash: 'a'.repeat(64),
  sourceVersion: 'v1',
  assertedByUserId: '22222222-2222-4222-8222-222222222222',
  approvedByUserId: '33333333-3333-4333-8333-333333333333',
  approvedAt: '2026-07-30T00:00:00.000Z',
  asOf: '2026-07-30T00:00:00.000Z',
  sensitivity: 'normal',
  conflictStatus: 'none',
  instructionsAllowed: false,
  ...over,
});

const request = (over: Partial<ContextRequest> = {}): ContextRequest => ({
  tenantId: 'tenant-1',
  userId: 'user-1',
  clientId: null,
  surface: 'ga-chat',
  layers: ['firm-identity', 'user-voice'],
  ref: { conversationId: 'conversation-1' },
  now: new Date('2026-07-30T12:00:00.000Z'),
  ...over,
});

function harness(
  rows: SteeringRow[],
  options: { failV2Persistence?: boolean; v2Rows?: SteeringRow[] } = {},
) {
  const persisted: TruthfulCompiledContextPacket[] = [];
  const comparisons: ContextPacketShadowComparison[] = [];
  const comparisonPacketIds: string[] = [];
  const loadV1 = jest.fn(async () => rows);
  const loadV2 = jest.fn(async () => options.v2Rows ?? rows);
  const compiler = new ContextPacketRolloutCompiler({
    loadSteeringRows: loadV1,
    loadGovernedSteeringRows: loadV2,
    persistPacket: jest.fn(async (packet: TruthfulCompiledContextPacket) => {
      if (options.failV2Persistence && packet.version === 2) {
        throw new Error('private database detail');
      }
      persisted.push(structuredClone(packet));
      return packet.generatedPacketId;
    }),
    persistShadowComparison: jest.fn(
      async ({
        comparisonPacketId,
        comparison,
      }: {
        comparisonPacketId: string;
        comparison: ContextPacketShadowComparison;
      }) => {
        comparisonPacketIds.push(comparisonPacketId);
        comparisons.push(structuredClone(comparison));
      },
    ),
  });
  return { compiler, persisted, comparisons, comparisonPacketIds, loadV1, loadV2 };
}

describe('ContextPacketRolloutCompiler', () => {
  it('off is one byte-compatible v1 compile and never reads governed columns', async () => {
    const h = harness([approvedFirm()]);
    const packet = await h.compiler.compile(request(), 'off');
    expect(packet.version).toBe(1);
    expect(packet).not.toHaveProperty('rolloutMode');
    expect(packet).not.toHaveProperty('shadowComparison');
    expect(h.loadV1).toHaveBeenCalledTimes(1);
    expect(h.loadV2).not.toHaveBeenCalled();
    expect(h.persisted).toHaveLength(1);
    expect(packet.rendered[0]?.body).toBe('Identity: We advise government-affairs teams.');
  });

  it('shadow persists v1 and v2 but returns the exact v1 model input', async () => {
    const offHarness = harness([approvedFirm()]);
    const off = await offHarness.compiler.compile(request(), 'off');
    const shadowHarness = harness([approvedFirm()]);
    const shadow = await shadowHarness.compiler.compile(request(), 'shadow');

    expect(shadow.version).toBe(1);
    expect(shadow).not.toHaveProperty('rolloutMode');
    expect(shadow).not.toHaveProperty('shadowComparison');
    expect(shadow.rendered).toEqual(off.rendered);
    expect(shadow.items).toEqual(off.items);
    expect(shadow.traceHash).toBe(off.traceHash);
    expect(shadowHarness.persisted.map((packet) => packet.version)).toEqual([1, 2]);
    expect(shadowHarness.comparisons).toEqual([
      expect.objectContaining({
        mode: 'shadow',
        shadowHealth: 'healthy',
        confidentialityRegression: false,
        relevanceRegression: false,
      }),
    ]);
    expect(shadowHarness.comparisonPacketIds).toEqual([
      shadowHarness.persisted[1]!.generatedPacketId,
    ]);
  });

  it('a failed shadow write cannot change or block v1 and records bounded regression evidence', async () => {
    const h = harness([approvedFirm()], { failV2Persistence: true });
    const packet = await h.compiler.compile(request(), 'shadow');
    expect(packet.version).toBe(1);
    expect(packet.rendered[0]?.body).toContain('We advise government-affairs teams.');
    expect(h.persisted).toHaveLength(1);
    expect(h.comparisons).toEqual([
      expect.objectContaining({
        shadowPacketId: null,
        shadowErrorCode: 'context_packet_error',
        relevanceRegression: true,
      }),
    ]);
    expect(JSON.stringify(h.comparisons)).not.toContain('private database detail');
    expect(h.comparisonPacketIds).toEqual([h.persisted[0]!.generatedPacketId]);
  });

  it('marks a missing required v2 item as a relevance regression', async () => {
    const h = harness([approvedFirm()], { v2Rows: [] });
    await h.compiler.compile(request(), 'shadow');
    expect(h.comparisons[0]).toEqual(
      expect.objectContaining({
        shadowHealth: 'degraded',
        missingRequiredLayers: ['firm-identity'],
        relevanceRegression: true,
      }),
    );
  });

  it('enforce feeds the v2 packet and optional absence does not degrade health', async () => {
    const h = harness([approvedFirm()]);
    const packet = await h.compiler.compile(request(), 'enforce');
    expect(packet.version).toBe(2);
    if (packet.version !== 2) throw new Error('expected v2');
    expect(packet.health.status).toBe('healthy');
    expect(packet.health.sourceFailureCount).toBe(0);
    expect(packet.health.missingRequiredLayers).toEqual([]);
    expect((packet.health as { missingOptionalLayers?: string[] }).missingOptionalLayers).toContain(
      'user-voice',
    );
    expect(packet.requiredLayers).toEqual(['firm-identity']);
  });

  it('missing required context degrades and identifies the required layer', async () => {
    const h = harness([]);
    const packet = await h.compiler.compile(request(), 'enforce');
    expect(packet.version).toBe(2);
    if (packet.version !== 2) throw new Error('expected v2');
    expect(packet.health.status).toBe('degraded');
    expect(packet.health.missingRequiredLayers).toEqual(['firm-identity']);
    expect(packet.health.sourceFailureCount).toBe(0);
    expect(packet.incomplete).toBe(true);
  });

  it('external deliverables never receive literal context_item envelopes', async () => {
    const external = await harness([approvedFirm()]).compiler.compile(
      request({ surface: 'memo', layers: ['firm-identity'] }),
      'enforce',
    );
    expect(external.version).toBe(2);
    expect(external.rendered[0]?.body).not.toContain('<context_item');
    expect(external.rendered[0]?.body).toContain('We advise government-affairs teams.');

    const internal = await harness([approvedFirm()]).compiler.compile(request(), 'enforce');
    expect(internal.rendered[0]?.body).toContain('<context_item');
  });

  it('bounded shadow evidence treats optional governed withholding as confidentiality-safe and relevance-safe', async () => {
    const restrictedVoice = approvedFirm({
      id: '44444444-4444-4444-8444-444444444444',
      type: 'user-voice',
      slug: 'voice',
      title: 'Restricted writing sample',
      ownerUserId: 'user-1',
      visibility: 'user',
      memoryClass: 'user_private',
      governedAuthority: 'user_asserted',
      sourceType: 'explicit_user',
      sensitivity: 'restricted',
      approvedByUserId: null,
      approvedAt: null,
      sections: [{ owner: 'human', heading: 'Secret', body: 'Never disclose this body.' }],
    });
    const h = harness([approvedFirm(), restrictedVoice]);
    await h.compiler.compile(request(), 'shadow');
    expect(h.comparisons[0]?.confidentialityRegression).toBe(false);
    expect(h.comparisons[0]?.relevanceRegression).toBe(false);
    expect(JSON.stringify(h.comparisons)).not.toContain('Never disclose this body.');
    expect(JSON.stringify(h.comparisons)).not.toContain('Restricted writing sample');
  });
});
