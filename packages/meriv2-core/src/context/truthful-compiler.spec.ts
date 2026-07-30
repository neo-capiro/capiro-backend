import { describe, expect, it, jest } from '@jest/globals';
import type {
  ContextRequest,
  SteeringRow,
  TruthfulCompiledContextPacket,
} from './contract';
import {
  ContextPacketPersistenceError,
  TruthfulContextCompiler,
  durableContextPacketId,
} from './truthful-compiler';

const request = (over: Partial<ContextRequest> = {}): ContextRequest => ({
  tenantId: 'tenant-1',
  effectiveTenantId: 'tenant-1',
  userId: 'user-1',
  actorUserId: 'user-1',
  clientId: null,
  surface: 'ga-chat',
  layers: [],
  contractVersion: 2,
  ethicalWallAllowed: false,
  persistence: 'best-effort',
  ...over,
});

const emptyRows = jest.fn<() => Promise<SteeringRow[]>>().mockResolvedValue([]);

describe('TruthfulContextCompiler', () => {
  it('publishes a packet id only after the adapter returns the exact durable id', async () => {
    let attempted: TruthfulCompiledContextPacket | null = null;
    const compiler = new TruthfulContextCompiler({
      loadSteeringRows: emptyRows,
      loadGovernedSteeringRows: emptyRows,
      persistPacket: jest.fn(async (packet) => {
        attempted = structuredClone(packet);
        return packet.generatedPacketId;
      }),
    });

    const packet = await compiler.compile(request());

    expect(attempted).not.toBeNull();
    expect(attempted!.generatedPacketId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(attempted!.packetId).toBeNull();
    expect(attempted!.persisted).toBe(false);
    expect(packet.persisted).toBe(true);
    expect(packet.packetId).toBe(packet.generatedPacketId);
    expect(packet.persistedPacketId).toBe(packet.generatedPacketId);
    expect(durableContextPacketId(packet)).toBe(packet.generatedPacketId);
  });

  it('lets best-effort chat continue with truthful degraded provenance and no packet id', async () => {
    const compiler = new TruthfulContextCompiler({
      loadSteeringRows: emptyRows,
      loadGovernedSteeringRows: emptyRows,
      persistPacket: jest.fn(async () => {
        throw new Error('database response with sensitive details');
      }),
    });

    const packet = await compiler.compile(request({ surface: 'ga-chat', persistence: 'best-effort' }));

    expect(packet.generatedPacketId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(packet.packetId).toBeNull();
    expect(packet.persistedPacketId).toBeNull();
    expect(packet.persisted).toBe(false);
    expect(packet.persistenceErrorCode).toBe('context_packet_error');
    expect(durableContextPacketId(packet)).toBeNull();
    expect(packet.version).toBe(2);
    if (packet.version === 2) {
      expect(packet.health.status).toBe('degraded');
      expect(packet.incomplete).toBe(true);
      expect(packet.health.reasons.join(' ')).not.toContain('sensitive details');
    }
  });

  it('holds a required external surface before any durable packet id is exposed', async () => {
    const compiler = new TruthfulContextCompiler({
      loadSteeringRows: emptyRows,
      loadGovernedSteeringRows: emptyRows,
      persistPacket: jest.fn(async () => {
        throw new Error('db down');
      }),
    });

    await expect(
      compiler.compile(request({ surface: 'workspace-gen', persistence: 'required' })),
    ).rejects.toMatchObject({
      name: 'ContextPacketPersistenceError',
      code: 'context_packet_error',
      surface: 'workspace-gen',
    });
  });

  it('rejects an adapter that returns a different id than the row it was asked to persist', async () => {
    const compiler = new TruthfulContextCompiler({
      loadSteeringRows: emptyRows,
      loadGovernedSteeringRows: emptyRows,
      persistPacket: jest.fn(async () => 'different-id'),
    });

    await expect(
      compiler.compile(request({ surface: 'strategy', persistence: 'required' })),
    ).rejects.toBeInstanceOf(ContextPacketPersistenceError);
  });

  it('fails required persistence when no adapter is configured', async () => {
    const compiler = new TruthfulContextCompiler({
      loadSteeringRows: emptyRows,
      loadGovernedSteeringRows: emptyRows,
    });

    await expect(
      compiler.compile(request({ surface: 'in-editor', persistence: 'required' })),
    ).rejects.toMatchObject({ code: 'context_packet_adapter_unavailable' });
  });
});
