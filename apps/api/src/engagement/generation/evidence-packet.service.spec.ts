/**
 * Evidence Packet compilation + persistence (Phase 1 §3.c1, §5.3).
 *
 * The three properties worth pinning are the ones that were previously absent:
 * a deterministic hash, failures that SURVIVE instead of becoming empty context,
 * and a persistence write that fails CLOSED for external generation.
 */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import {
  EvidencePacketService,
  EvidencePacketPersistError,
  hashPacket,
  type CompileOutreachPacketRequest,
} from './evidence-packet.service.js';
import { policyForAudience } from './government-affairs-policy.registry.js';
import type {
  AuthenticatedDirective,
  EvidenceItem,
  EvidencePacketV2,
  SourceFailure,
} from './evidence-packet.types.js';

const NOW = new Date('2026-07-26T00:00:00.000Z');
const CTX = {
  tenantId: 't1',
  tenantSlug: 'tenant',
  userId: 'u1',
  clerkUserId: 'clerk_u1',
  role: 'user',
} as unknown as TenantContext;

interface Resolved {
  evidence: EvidenceItem[];
  directives: AuthenticatedDirective[];
  failures: SourceFailure[];
}

function makeService(opts: {
  resolved?: Partial<Resolved>;
  createImpl?: () => Promise<unknown>;
  compilerThrows?: boolean;
} = {}) {
  const created: Array<Record<string, unknown>> = [];
  const create = jest.fn(async (args: { data: Record<string, unknown> }) => {
    if (opts.createImpl) return opts.createImpl();
    created.push(args.data);
    return args.data;
  });
  const prisma = {
    withTenant: async (_t: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ contextPacket: { create } }),
  };
  const contextCompiler = {
    compile: jest.fn(async () => {
      if (opts.compilerThrows) throw new Error('steering unavailable');
      return {
        items: [{ layer: 'user-voice', id: 'm1', type: 'user-voice', slug: 'me', chars: 10 }],
        exclusions: [
          { layer: 'client-steering', id: 'm2', type: 'client-soul', slug: 'c', reason: 'revoked' },
        ],
        rendered: [],
      };
    }),
  };
  const sources = {
    resolveSelectedItems: jest.fn(async () => ({
      evidence: opts.resolved?.evidence ?? [],
      directives: opts.resolved?.directives ?? [],
      failures: opts.resolved?.failures ?? [],
    })),
    resolveRelevantEmail: jest.fn(async () => ({ evidence: [], failures: [] })),
  };
  const svc = new EvidencePacketService(
    prisma as never,
    contextCompiler as never,
    sources as never,
  );
  return { svc, create, created, contextCompiler, sources };
}

function request(over: Partial<CompileOutreachPacketRequest> = {}): CompileOutreachPacketRequest {
  return {
    surface: 'outreach_email',
    clientId: 'c1',
    ref: { outreachRecordId: 'r1' },
    items: [],
    policy: policyForAudience('congressional_office'),
    modelPolicy: { provider: 'anthropic', model: 'm', promptSpecVersion: 'v2.2-gateway' },
    emailScope: 'mine',
    scanRequired: false,
    wallAllowsClient: true,
    audience: 'external',
    recipientEmails: ['dana@mail.house.gov'],
    requestDirectives: [],
    enrichments: [],
    failClosedOnPersist: true,
    now: NOW,
    packetId: 'packet-1',
    recipientIdentityResolved: true,
    ...over,
  };
}

describe('deterministic packet hash', () => {
  test('two identical requests produce an identical hash', async () => {
    const a = await makeService().svc.compileOutreachPacket(CTX, request());
    const b = await makeService().svc.compileOutreachPacket(CTX, request());
    expect(a.packetHash).toBe(b.packetHash);
    expect(a.packetHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the hash EXCLUDES packet id and compile time, which are per-invocation', async () => {
    const a = await makeService().svc.compileOutreachPacket(CTX, request({ packetId: 'x' }));
    const b = await makeService().svc.compileOutreachPacket(
      CTX,
      request({ packetId: 'y', now: new Date('2027-01-01T00:00:00.000Z') }),
    );
    // Only identity/time differ, so the CONTENT hash must match. Without this,
    // the hash would change every call and prove nothing.
    expect(a.packetHash).toBe(b.packetHash);
  });

  test('changing the evidence changes the hash', async () => {
    const withEvidence = makeService({
      resolved: {
        evidence: [
          {
            ref: {
              sourceType: 'bill',
              sourceId: 'hr1',
              title: 'HR 1',
              trust: 'authoritative_structured',
              retrievedAt: NOW.toISOString(),
            },
            evidenceText: 'text',
            scope: 'all',
          },
        ],
      },
    });
    const a = await makeService().svc.compileOutreachPacket(CTX, request());
    const b = await withEvidence.svc.compileOutreachPacket(CTX, request());
    expect(a.packetHash).not.toBe(b.packetHash);
  });

  test('hashPacket ignores per-item retrievedAt', () => {
    const base: EvidencePacketV2 = {
      packetId: 'p',
      packetVersion: 2,
      tenantId: 't',
      userId: 'u',
      clientId: null,
      surface: 'outreach_email',
      ref: {},
      directives: [],
      evidence: [
        {
          ref: {
            sourceType: 'bill',
            sourceId: 'b',
            title: 'B',
            trust: 'authoritative_structured',
            retrievedAt: '2026-01-01T00:00:00.000Z',
          },
          evidenceText: 't',
          scope: 'all',
        },
      ],
      standingMemory: [],
      standingMemoryExclusions: [],
      failures: [],
      policy: { jurisdiction: 'federal', audienceType: 'congressional_office', policyId: 'p', version: 'v' },
      modelPolicy: { provider: 'a', model: 'm', promptSpecVersion: 'v' },
      criticalFailureCount: 0,
      freshestSourceAt: null,
      stalestSourceAt: null,
      compiledAt: '2026-01-01T00:00:00.000Z',
      packetHash: '',
      emailScope: 'mine',
    };
    const later: EvidencePacketV2 = {
      ...base,
      evidence: [
        { ...base.evidence[0]!, ref: { ...base.evidence[0]!.ref, retrievedAt: '2030-01-01T00:00:00.000Z' } },
      ],
    };
    expect(hashPacket(base)).toBe(hashPacket(later));
  });
});

describe('failures are never silently converted to empty context', () => {
  test('a throwing enrichment becomes a recorded SourceFailure', async () => {
    const { svc } = makeService();
    const packet = await svc.compileOutreachPacket(
      CTX,
      request({
        enrichments: [
          {
            sourceType: 'trackedBills',
            title: 'Tracked legislation',
            trust: 'server_record',
            scope: 'all',
            load: async () => {
              throw new Error('timeout');
            },
            failureCode: 'TRACKEDBILLS_UNAVAILABLE',
            failureMessage: 'Tracked legislation could not be loaded.',
          },
        ],
      }),
    );
    expect(packet.failures.map((f) => f.code)).toContain('TRACKEDBILLS_UNAVAILABLE');
    // And no phantom empty evidence item was created for it.
    expect(packet.evidence).toHaveLength(0);
  });

  test('a legitimately EMPTY channel is not a failure', async () => {
    const { svc } = makeService();
    const packet = await svc.compileOutreachPacket(
      CTX,
      request({
        enrichments: [
          {
            sourceType: 'trackedBills',
            title: 'Tracked legislation',
            trust: 'server_record',
            scope: 'all',
            load: async () => null,
          },
        ],
      }),
    );
    expect(packet.failures).toHaveLength(0);
    expect(packet.evidence).toHaveLength(0);
  });

  test('an unresolvable recipient identity is CRITICAL (delivery would fail)', async () => {
    const { svc } = makeService();
    const packet = await svc.compileOutreachPacket(
      CTX,
      request({ recipientIdentityResolved: false }),
    );
    expect(packet.criticalFailureCount).toBe(1);
    expect(packet.failures[0]?.code).toBe('RECIPIENT_IDENTITY_UNRESOLVED');
  });

  test('a steering-memory failure is recorded but is NOT critical', async () => {
    const { svc } = makeService({ compilerThrows: true });
    const packet = await svc.compileOutreachPacket(CTX, request());
    expect(packet.failures.map((f) => f.code)).toContain('STEERING_MEMORY_UNAVAILABLE');
    expect(packet.criticalFailureCount).toBe(0);
  });
});

describe('persistence', () => {
  test('the packet is written as version 2 with the v1 trace columns intact', async () => {
    const { svc, created } = makeService();
    await svc.compileOutreachPacket(CTX, request());
    const row = created[0]!;
    expect(row.packetVersion).toBe(2);
    expect(row.packetHash).toEqual(expect.any(String));
    // The legacy steering-trace columns keep working for existing readers.
    expect(row.itemCount).toBe(1);
    expect(row.exclusionCount).toBe(1);
  });

  test('FAIL CLOSED: a persistence failure aborts external generation (§4.7)', async () => {
    const { svc } = makeService({
      createImpl: async () => {
        throw new Error('db down');
      },
    });
    await expect(svc.compileOutreachPacket(CTX, request())).rejects.toBeInstanceOf(
      EvidencePacketPersistError,
    );
  });

  test('with the gateway OFF, a persistence failure degrades instead of throwing', async () => {
    const { svc } = makeService({
      createImpl: async () => {
        throw new Error('db down');
      },
    });
    const packet = await svc.compileOutreachPacket(
      CTX,
      request({ failClosedOnPersist: false }),
    );
    expect(packet.packetId).toBe('packet-1');
  });
});

describe('standing memory rides through the Context Compiler', () => {
  test('the compiler is called rather than memory_items being queried directly', async () => {
    const { svc, contextCompiler } = makeService();
    const packet = await svc.compileOutreachPacket(CTX, request());
    expect(contextCompiler.compile).toHaveBeenCalledTimes(1);
    expect(packet.standingMemory).toHaveLength(1);
    expect(packet.standingMemoryExclusions).toHaveLength(1);
  });
});

describe('freshness window', () => {
  test('oldest and newest as-of dates are derived from the evidence', async () => {
    const { svc } = makeService({
      resolved: {
        evidence: [
          {
            ref: {
              sourceType: 'bill',
              sourceId: 'a',
              title: 'A',
              trust: 'authoritative_structured',
              retrievedAt: NOW.toISOString(),
              authoritativeAsOf: '2026-07-01T00:00:00.000Z',
            },
            evidenceText: 'a',
            scope: 'all',
          },
          {
            ref: {
              sourceType: 'bill',
              sourceId: 'b',
              title: 'B',
              trust: 'authoritative_structured',
              retrievedAt: NOW.toISOString(),
              authoritativeAsOf: '2026-01-01T00:00:00.000Z',
            },
            evidenceText: 'b',
            scope: 'all',
          },
        ],
      },
    });
    const packet = await svc.compileOutreachPacket(CTX, request());
    expect(packet.freshestSourceAt).toBe('2026-07-01T00:00:00.000Z');
    expect(packet.stalestSourceAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
