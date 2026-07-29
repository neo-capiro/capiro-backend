import { describe, expect, it, jest } from '@jest/globals';
import { ContextCompiler } from './compiler.js';
import { applyContextSurfacePolicy, contextSurfacePolicy } from './surface-policy.js';
import type {
  CompiledContextPacket,
  CompiledContextPacketV2,
  ContextRequest,
  ContextSurface,
  SteeringRow,
} from './contract.js';

const human = (heading: string, body: string) => ({ owner: 'human', heading, body });

const row = (over: Partial<SteeringRow> = {}): SteeringRow => ({
  id: 'firm-soul-1',
  type: 'firm-soul',
  slug: 'firm',
  title: 'Firm Soul',
  clientId: null,
  ownerUserId: null,
  visibility: 'tenant',
  status: 'active',
  expiresAt: null,
  updatedAt: '2026-07-20T00:00:00.000Z',
  confirmedAt: '2026-07-20T00:00:00.000Z',
  authority: 'human',
  memoryClass: 'institutional_authoritative',
  governedAuthority: 'firm_approved',
  sourceType: 'firm_playbook',
  sourceId: 'source-1',
  sourceRef: 'memory-file:firm-soul',
  sourceContentHash: 'a'.repeat(64),
  sourceVersion: 'v3',
  assertedByUserId: 'author-1',
  approvedByUserId: 'approver-1',
  approvedAt: '2026-07-20T00:00:00.000Z',
  asOf: '2026-07-20T00:00:00.000Z',
  conflictStatus: 'none',
  sensitivity: 'normal',
  instructionsAllowed: false,
  sections: [human('Identity', 'Capiro is a government-affairs operating platform.')],
  ...over,
});

const request = (over: Partial<ContextRequest> = {}): ContextRequest =>
  applyContextSurfacePolicy({
    tenantId: 'tenant-1',
    effectiveTenantId: 'tenant-1',
    actorUserId: 'actor-1',
    userId: 'user-1',
    clientId: 'client-a',
    surface: 'ga-chat',
    ref: { conversationId: 'conversation-1' },
    traceId: 'trace-1',
    promptVersion: 'prompt-v2',
    policyVersion: 'policy-v1',
    selectedItemIds: [],
    allowedSensitivities: ['normal'],
    ...over,
  });

function compilerFor(rows: SteeringRow[]) {
  const persisted: CompiledContextPacket[] = [];
  const compiler = new ContextCompiler({
    loadSteeringRows: jest.fn<() => Promise<SteeringRow[]>>().mockResolvedValue(rows),
    loadGovernedSteeringRows: jest.fn<() => Promise<SteeringRow[]>>().mockResolvedValue(rows),
    persistPacket: jest.fn(async (packet: CompiledContextPacket) => {
      persisted.push(structuredClone(packet));
    }),
  });
  return { compiler, persisted };
}

function v2(packet: CompiledContextPacket): CompiledContextPacketV2 {
  expect(packet.version).toBe(2);
  return packet as CompiledContextPacketV2;
}

describe('ContextPacket v2 deterministic compilation', () => {
  it('emits source-rich governed metadata and typed data blocks', async () => {
    const packet = v2(await compilerFor([row()]).compiler.compile(request()));
    expect(packet.items).toHaveLength(1);
    expect(packet.items[0]).toEqual(
      expect.objectContaining({
        memoryClass: 'institutional_authoritative',
        scope: 'firm',
        authority: 'firm_approved',
        status: 'active',
        sourceType: 'firm_playbook',
        sourceId: 'source-1',
        sourceVersion: 'v3',
        humanApproved: true,
        sensitivity: 'normal',
        includedSections: ['Identity'],
        omittedSections: [],
        selectionTier: 'authoritative_policy',
        conflictStatus: 'none',
      }),
    );
    expect(packet.rendered[0]?.body).toContain('<context_item');
    expect(packet.rendered[0]?.body).toContain('instructions_allowed=false');
    expect(packet.rendered[0]?.body).toContain('Capiro is a government-affairs operating platform.');
    expect(packet.traceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.health.status).toBe('degraded');
    // The fixture requested client/user layers but supplied only firm identity.
    expect(packet.health.missingRequiredLayers).toEqual(
      expect.arrayContaining(['user-voice', 'client-steering', 'client-people']),
    );
  });

  it('never persists memory body text in packet items', async () => {
    const packet = v2(await compilerFor([row()]).compiler.compile(request()));
    const serializedItems = JSON.stringify(packet.items);
    expect(serializedItems).not.toContain('Capiro is a government-affairs operating platform.');
    expect(packet.items[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.rendered[0]?.body).toContain('Capiro is a government-affairs operating platform.');
  });

  it('is deterministic for shuffled input apart from packet id and timestamp', async () => {
    const rows = [
      row({ id: 'firm-compass', type: 'firm-compass', title: 'Firm Compass' }),
      row({ id: 'firm-soul', type: 'firm-soul' }),
      row({
        id: 'client-compass',
        type: 'client-compass',
        slug: 'client-a',
        title: 'Client Compass',
        clientId: 'client-a',
        memoryClass: 'client_steering',
        governedAuthority: 'client_approved',
        sourceType: 'client_record',
      }),
      row({
        id: 'client-soul',
        type: 'client-soul',
        slug: 'client-a',
        title: 'Client Soul',
        clientId: 'client-a',
        memoryClass: 'client_steering',
        governedAuthority: 'client_approved',
        sourceType: 'client_record',
      }),
    ];
    // Freshness/confirmation scoring reads wall-clock time, so pin it across
    // every permutation — otherwise the inclusionScore's fractional part (and
    // therefore traceHash) drifts by real elapsed milliseconds between calls,
    // which would fail this assertion for a reason unrelated to shuffling.
    const now = new Date('2026-07-28T00:00:00.000Z');
    const snapshots: unknown[] = [];
    for (const input of [rows, [...rows].reverse(), [rows[2]!, rows[0]!, rows[3]!, rows[1]!]]) {
      const packet = v2(
        await compilerFor(input).compiler.compile(
          request({ layers: ['firm-identity', 'client-steering'], now }),
        ),
      );
      snapshots.push({
        items: packet.items,
        exclusions: packet.exclusions,
        rendered: packet.rendered,
        health: packet.health,
        traceHash: packet.traceHash,
      });
    }
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[2]).toEqual(snapshots[0]);
  });

  it('orders explicit selection, approved policy, confirmed and inferred context by tier', async () => {
    const rows = [
      row({
        id: 'episodic',
        type: 'user-profile',
        slug: 'user-1',
        visibility: 'user',
        ownerUserId: 'user-1',
        memoryClass: 'episodic_working',
        governedAuthority: 'model_inferred',
        sourceType: 'user_message',
        approvedByUserId: null,
        approvedAt: null,
        confirmedAt: null,
        expiresAt: '2026-08-01T00:00:00.000Z',
      }),
      row({
        id: 'preference',
        type: 'user-voice',
        slug: 'user-1',
        visibility: 'user',
        ownerUserId: 'user-1',
        memoryClass: 'user_preference',
        governedAuthority: 'user_asserted',
        sourceType: 'user_message',
        approvedByUserId: null,
        approvedAt: null,
      }),
      row({ id: 'doctrine' }),
    ];
    const packet = v2(
      await compilerFor(rows).compiler.compile(
        request({
          clientId: null,
          layers: ['firm-identity', 'user-voice'],
          selectedItemIds: ['preference'],
        }),
      ),
    );
    expect(packet.items.map((item) => item.id)).toEqual(['preference', 'doctrine', 'episodic']);
    expect(packet.items.map((item) => item.selectionTier)).toEqual([
      'explicit',
      'authoritative_policy',
      'episodic_inferred',
    ]);
  });

  it('withholds unapproved, expired, conflicted, restricted and wrong-client rows before budget', async () => {
    const rows = [
      row({
        id: 'unapproved',
        approvedByUserId: null,
        approvedAt: null,
        governedAuthority: 'user_asserted',
      }),
      row({ id: 'expired', validUntil: '2026-07-01T00:00:00.000Z' }),
      row({ id: 'conflict', conflictStatus: 'open', conflictGroupId: 'g1' }),
      row({ id: 'restricted', sensitivity: 'restricted' }),
      row({
        id: 'wrong-client',
        type: 'client-soul',
        slug: 'client-b',
        clientId: 'client-b',
        memoryClass: 'client_steering',
        governedAuthority: 'client_approved',
        sourceType: 'client_record',
      }),
    ];
    const packet = v2(
      await compilerFor(rows).compiler.compile(
        request({ layers: ['firm-identity', 'client-steering'] }),
      ),
    );
    expect(packet.items).toEqual([]);
    // Lifecycle/content reasons: the caller already has legitimate visibility
    // into these rows, so the exclusion may safely name which one and why.
    const disclosed = packet.exclusions.filter(
      (item) => item.reason !== 'sensitivity-denied' && item.reason !== 'wrong-client',
    );
    expect(Object.fromEntries(disclosed.map((item) => [item.id, item.reason]))).toEqual({
      unapproved: 'unapproved',
      expired: 'invalid-until',
      conflict: 'conflicted',
    });
    // Authorization reasons: identity must never leak, so id/type/slug are
    // omitted and only the reason + aggregate count are visible.
    const withheld = packet.exclusions.filter(
      (item) => item.reason === 'sensitivity-denied' || item.reason === 'wrong-client',
    );
    expect(withheld.map((item) => item.reason).sort()).toEqual(['sensitivity-denied', 'wrong-client']);
    expect(withheld.every((item) => item.id === undefined)).toBe(true);
    expect(withheld.every((item) => item.type === undefined)).toBe(true);
    expect(withheld.every((item) => item.slug === undefined)).toBe(true);
  });

  it('records token budgeting, omitted sections and incomplete health', async () => {
    const packet = v2(
      await compilerFor([
        row({ sections: [human('Short', 'keep'), human('Long', 'x'.repeat(4_000))] }),
      ]).compiler.compile(
        request({ clientId: null, layers: ['firm-identity'], tokenBudget: 20 }),
      ),
    );
    expect(packet.items[0]?.includedSections).toEqual(['Short']);
    expect(packet.items[0]?.omittedSections).toEqual(['Long']);
    expect(packet.truncated).toBe(true);
    expect(packet.incomplete).toBe(true);
    expect(packet.health.status).toBe('incomplete');
    expect(packet.usedTokens).toBeLessThanOrEqual(20);
  });

  it('allows instructions only for approved firm playbook records', async () => {
    const packet = v2(
      await compilerFor([
        row({
          id: 'playbook',
          type: 'playbook',
          instructionsAllowed: true,
          governedAuthority: 'firm_approved',
          memoryClass: 'institutional_authoritative',
        }),
        row({
          id: 'client',
          type: 'client-compass',
          slug: 'client-a',
          clientId: 'client-a',
          instructionsAllowed: true,
          governedAuthority: 'client_approved',
          memoryClass: 'client_steering',
          sourceType: 'client_record',
        }),
      ]).compiler.compile(
        request({ layers: ['firm-playbook', 'client-steering'] }),
      ),
    );
    expect(packet.items.find((item) => item.id === 'playbook')?.instructionsAllowed).toBe(true);
    expect(packet.items.find((item) => item.id === 'client')?.instructionsAllowed).toBe(false);
    expect(packet.rendered.find((item) => item.id === 'playbook')?.body).toContain(
      'instructions_allowed=true',
    );
    expect(packet.rendered.find((item) => item.id === 'client')?.body).toContain(
      'instructions_allowed=false',
    );
  });

  it('advertises a packet id only after synchronous persistence succeeds', async () => {
    const { compiler, persisted } = compilerFor([row()]);
    const packet = v2(
      await compiler.compile(request({ clientId: null, layers: ['firm-identity'] })),
    );
    expect(packet.persisted).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.packetId).toBe(packet.packetId);

    const failing = new ContextCompiler({
      loadSteeringRows: jest.fn<() => Promise<SteeringRow[]>>().mockResolvedValue([row()]),
      loadGovernedSteeringRows: jest
        .fn<() => Promise<SteeringRow[]>>()
        .mockResolvedValue([row()]),
      persistPacket: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('db down')),
    });
    await expect(
      failing.compile(
        request({
          clientId: null,
          layers: ['firm-identity'],
          persistence: 'required',
        }),
      ),
    ).rejects.toThrow('db down');
  });
});

describe('cross-surface context parity', () => {
  it.each(['ga-chat', 'in-editor', 'workspace-gen', 'strategy'] as const)(
    '%s selects the same authoritative client item',
    async (surface: ContextSurface) => {
      const rows = [
        row({ id: 'firm' }),
        row({
          id: 'client-authoritative',
          type: 'client-compass',
          slug: 'client-a',
          title: 'Approved Client Compass',
          clientId: 'client-a',
          memoryClass: 'client_steering',
          governedAuthority: 'client_approved',
          sourceType: 'client_record',
        }),
      ];
      const policy = contextSurfacePolicy(surface);
      const packet = v2(
        await compilerFor(rows).compiler.compile(
          request({ surface, layers: policy.layers, tokenBudget: policy.tokenBudget }),
        ),
      );
      expect(packet.items.find((item) => item.id === 'client-authoritative')).toEqual(
        expect.objectContaining({
          memoryClass: 'client_steering',
          authority: 'client_approved',
          clientId: 'client-a',
          selectionTier: 'authoritative_policy',
        }),
      );
    },
  );
});
