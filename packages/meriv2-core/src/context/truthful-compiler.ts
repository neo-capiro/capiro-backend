import { ContextCompiler } from './compiler';
import type {
  CompiledContextPacket,
  ContextRequest,
  ContextStoreAdapter,
  TruthfulCompiledContextPacket,
  TruthfulContextStoreAdapter,
} from './contract';

const SAFE_PERSISTENCE_CODE = /^context_packet_[a-z0-9_]{1,64}$/;

/**
 * Bounded failure used at release boundaries. It deliberately carries no packet
 * bodies, SQL, provider response, or raw adapter message.
 */
export class ContextPacketPersistenceError extends Error {
  readonly code: string;
  readonly generatedPacketId: string;
  readonly surface: string;

  constructor(code: string, generatedPacketId: string, surface: string) {
    super(`Context packet persistence failed (${code})`);
    this.name = 'ContextPacketPersistenceError';
    this.code = code;
    this.generatedPacketId = generatedPacketId;
    this.surface = surface;
  }
}

export function isContextPacketPersistenceError(
  error: unknown,
): error is ContextPacketPersistenceError {
  return error instanceof ContextPacketPersistenceError;
}

/** Convert arbitrary adapter failures to a bounded, non-sensitive reason code. */
export function contextPacketPersistenceErrorCode(error: unknown): string {
  if (error instanceof ContextPacketPersistenceError) return error.code;
  if (error instanceof Error && SAFE_PERSISTENCE_CODE.test(error.message)) return error.message;
  const name = error instanceof Error ? error.name : 'PersistenceError';
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `context_packet_${normalized || 'persistence_error'}`.slice(0, 80);
}

/**
 * Phase 7 persistence owner.
 *
 * The deterministic ContextCompiler still owns selection/rendering. This wrapper
 * deliberately supplies it an adapter WITHOUT persistPacket, then owns the one
 * persistence decision after compilation. That keeps v1/v2 selection byte-stable
 * while ensuring no generated UUID is exposed as a durable packet ID.
 */
export class TruthfulContextCompiler {
  private readonly compiler: ContextCompiler;

  constructor(private readonly store: TruthfulContextStoreAdapter) {
    const deterministicStore: ContextStoreAdapter = {
      loadSteeringRows: (req) => store.loadSteeringRows(req),
      ...(store.loadGovernedSteeringRows
        ? {
            loadGovernedSteeringRows: (req: ContextRequest) => store.loadGovernedSteeringRows!(req),
          }
        : {}),
    };
    this.compiler = new ContextCompiler(deterministicStore);
  }

  async compile(req: ContextRequest): Promise<TruthfulCompiledContextPacket> {
    const compiled = await this.compiler.compile(req);
    const generatedPacketId = compiled.packetId;
    if (!generatedPacketId) {
      throw new ContextPacketPersistenceError(
        'context_packet_generated_id_missing',
        'unavailable',
        req.surface,
      );
    }

    const packet = compiled as TruthfulCompiledContextPacket;
    packet.generatedPacketId = generatedPacketId;
    packet.packetId = null;
    packet.persistedPacketId = null;
    packet.persisted = false;
    packet.persistenceErrorCode = null;

    if (!this.store.persistPacket) {
      return this.fail(req, packet, 'context_packet_adapter_unavailable');
    }

    try {
      const persistedPacketId = await this.store.persistPacket(packet);
      if (persistedPacketId !== generatedPacketId) {
        throw new Error('context_packet_persisted_id_mismatch');
      }
      packet.packetId = persistedPacketId;
      packet.persistedPacketId = persistedPacketId;
      packet.persisted = true;
      packet.persistenceErrorCode = null;
      return packet;
    } catch (error) {
      return this.fail(req, packet, contextPacketPersistenceErrorCode(error));
    }
  }

  private fail(
    req: ContextRequest,
    packet: TruthfulCompiledContextPacket,
    code: string,
  ): TruthfulCompiledContextPacket {
    packet.packetId = null;
    packet.persistedPacketId = null;
    packet.persisted = false;
    packet.persistenceErrorCode = code;

    if (packet.version === 2) {
      const reason = `Context packet persistence unavailable (${code})`;
      if (!packet.health.reasons.includes(reason)) packet.health.reasons.push(reason);
      if (packet.health.status === 'healthy') packet.health.status = 'degraded';
      packet.incomplete = true;
    }

    if (req.persistence === 'required') {
      throw new ContextPacketPersistenceError(code, packet.generatedPacketId, req.surface);
    }
    return packet;
  }
}

/** Read a durable packet ID without accidentally falling back to a generated UUID. */
export function durableContextPacketId(packet: CompiledContextPacket): string | null {
  return packet.persisted === true && typeof packet.persistedPacketId === 'string'
    ? packet.persistedPacketId
    : null;
}
