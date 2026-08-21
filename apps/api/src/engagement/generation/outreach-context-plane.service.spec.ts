import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  OutreachContextPlaneService,
  planOutreachGeneration,
} from './outreach-context-plane.service.js';

const CTX = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
} as unknown as TenantContext;

function makeService(opts: {
  gatewayImpl?: () => Promise<unknown>;
  clients?: Array<{ id: string }>;
  mailboxes?: Array<{ id: string }>;
} = {}) {
  const requestContext = jest.fn(
    opts.gatewayImpl ??
      (async () => ({
        kind: 'governed_packet',
        context: {
          resolution: {
            status: 'ready',
            stopReason: 'resolved',
            subjectScope: { kind: 'client', source: 'explicit', clientIds: ['c1'] },
            retrievalAllowed: true,
          },
          retrieval: {
            records: [
              {
                domain: 'clients',
                recordId: 'client-c1',
                payload: { name: 'Aperture Defense', summary: 'Prime contractor' },
                provenance: { source: 'clients' },
                occurredAt: new Date('2026-08-01T00:00:00.000Z'),
              },
              {
                domain: 'mail',
                recordId: 'thread-1',
                payload: { subject: 'Hill follow-up', snippet: 'Thanks for the meeting.' },
                provenance: { mailboxConnectionId: 'mbox-1' },
                occurredAt: new Date('2026-08-10T00:00:00.000Z'),
              },
            ],
            coverage: {
              requestedDomains: ['clients', 'mail', 'meetings'],
              searchedDomains: ['clients', 'mail', 'meetings'],
              requestedEntityCount: 1,
              searchedEntityCount: 1,
              recordsEvaluated: 2,
              recordsReturned: 2,
              paginationComplete: true,
              unavailableSources: [],
              sources: [
                {
                  domain: 'clients',
                  sourceStatus: 'healthy',
                  stopReason: 'complete',
                  coverageComplete: true,
                  paginationComplete: true,
                  truncated: false,
                },
                {
                  domain: 'mail',
                  sourceStatus: 'healthy',
                  stopReason: 'complete',
                  coverageComplete: true,
                  paginationComplete: true,
                  truncated: false,
                },
                {
                  domain: 'meetings',
                  sourceStatus: 'healthy',
                  stopReason: 'complete',
                  coverageComplete: true,
                  paginationComplete: true,
                  truncated: false,
                },
              ],
              complete: true,
              stopReason: 'complete',
            },
          },
        },
        packet: {
          version: 2,
          packetId: 'packet-gov-1',
          persistedPacketId: 'packet-gov-1',
          persisted: true,
          surface: 'outreach',
          tenantId: CTX.tenantId,
          clientId: 'c1',
          items: [
            {
              layer: 'user-voice',
              id: 'mem-1',
              type: 'user-voice',
              slug: 'voice',
              chars: 12,
            },
          ],
          exclusions: [],
          rendered: [
            {
              layer: 'user-voice',
              type: 'user-voice',
              body: 'Write in a concise Hill register.',
            },
          ],
          health: { status: 'healthy', reasons: [] },
          retrievalCompleteness: 'complete',
          retrievalStopReason: 'complete',
          incomplete: false,
          truncated: false,
          coverageManifest: {
            requestedDomains: ['clients', 'mail', 'meetings'],
            searchedDomains: ['clients', 'mail', 'meetings'],
            unavailableSources: [],
            complete: true,
            stopReason: 'complete',
          },
        },
      })),
  );
  const prisma = {
    withTenantUser: async (_t: string, _u: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        client: {
          findMany: async () => opts.clients ?? [{ id: 'c1' }],
          findFirst: async () => ({ name: 'Aperture Defense' }),
        },
        integrationConnection: {
          findMany: async () => opts.mailboxes ?? [{ id: 'mbox-1' }],
        },
      }),
    withTenant: async (_t: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        client: { findFirst: async () => ({ name: 'Aperture Defense' }) },
      }),
  };
  const svc = new OutreachContextPlaneService(prisma as never, { requestContext } as never);
  return { svc, requestContext };
}

describe('planOutreachGeneration', () => {
  test('a client-scoped draft requests the government-affairs retrieval domains', () => {
    const plan = planOutreachGeneration({
      objective: 'Request a meeting before markup on the NDAA plus-up.',
      clientId: 'c1',
      clientName: 'Aperture Defense',
      recipientName: 'Dana Reed',
      recipientEmail: 'dana.reed@mail.house.gov',
    });

    expect(plan.subjectScope).toBe('client');
    expect(plan.queryClass).toBe('relationship_history');
    expect(plan.requestedDomains).toEqual([
      'clients',
      'institutional_knowledge',
      'contacts',
      'outreach',
      'mail',
      'meetings',
      'strategies_work',
    ]);
    expect(plan.requireComplete).toBe(false);
  });

  test('a draft without a selected client stays general and still searches shared domains', () => {
    const plan = planOutreachGeneration({
      objective: 'Follow up after the hearing.',
      clientId: null,
      clientName: null,
      recipientName: null,
      recipientEmail: null,
    });
    expect(plan.subjectScope).toBe('general');
    expect(plan.requestedDomains).toContain('institutional_knowledge');
    expect(plan.requestedDomains).toContain('outreach');
  });
});

describe('OutreachContextPlaneService.resolve', () => {
  test('builds a server-owned outreach.generate request and consumes the governed packet', async () => {
    const { svc, requestContext } = makeService();
    const resolved = await svc.resolve(CTX, {
      clientId: 'c1',
      recipientName: 'Dana Reed',
      recipientEmail: 'dana.reed@mail.house.gov',
      objective: 'Request a meeting before markup.',
      outreachRecordId: 'rec-1',
      wallAllowsClient: true,
    });

    expect(requestContext).toHaveBeenCalledTimes(1);
    const first = (requestContext.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
    const call = first as {
      operationId: string;
      currentPhase: number;
      resolverRequest: {
        tenantId: string;
        actorUserId: string;
        surface: string;
        securityScope: {
          authorizedClientIds: string[];
          authorizedMailboxConnectionIds: string[];
        };
        clientId?: string;
        retrieval?: { requestedDomains: string[] };
      };
      contextRequest: { tenantId: string; actorUserId: string; surface: string; clientId?: string };
    };
    expect(call.operationId).toBe('outreach.generate');
    expect(call.currentPhase).toBe(20);
    expect(call.resolverRequest.tenantId).toBe(CTX.tenantId);
    expect(call.resolverRequest.actorUserId).toBe(CTX.userId);
    expect(call.resolverRequest.surface).toBe('outreach');
    expect(call.resolverRequest.clientId).toBe('c1');
    expect(call.resolverRequest.securityScope.authorizedClientIds).toEqual(['c1']);
    expect(call.resolverRequest.securityScope.authorizedMailboxConnectionIds).toEqual(['mbox-1']);
    expect(call.contextRequest.surface).toBe('outreach');
    expect(call.contextRequest.tenantId).toBe(CTX.tenantId);
    expect(call.contextRequest.actorUserId).toBe(CTX.userId);

    expect(resolved.packetId).toBe('packet-gov-1');
    expect(resolved.retrievalCompleteness).toBe('complete');
    expect(resolved.evidence).toHaveLength(2);
    expect(resolved.evidence[0]?.ref.sourceType).toBe('context_plane:clients');
    expect(resolved.evidence[0]?.ref.trust).toBe('server_record');
    expect(resolved.evidence[1]?.ref.trust).toBe('external_untrusted');
    expect(resolved.standingMemory).toHaveLength(1);
    expect(resolved.failures).toEqual([]);
    expect(resolved.promptBlock).toContain('COVERAGE:');
    expect(resolved.promptBlock).toContain('complete=true');
  });

  test('fails closed when the gateway still returns a Phase 20 migration exception', async () => {
    const { svc } = makeService({
      gatewayImpl: async () => ({ kind: 'migration_exception' }),
    });
    await expect(
      svc.resolve(CTX, {
        clientId: 'c1',
        recipientName: 'Dana Reed',
        recipientEmail: 'dana.reed@mail.house.gov',
        objective: 'Request a meeting.',
        wallAllowsClient: true,
      }),
    ).rejects.toThrow('context_plane_phase20_operation_not_adopted:outreach.generate');
  });

  test('zero records with incomplete coverage is not treated as complete history', async () => {
    const { svc } = makeService({
      gatewayImpl: async () => ({
        kind: 'governed_packet',
        context: {
          resolution: {
            status: 'ready',
            stopReason: 'resolved',
            subjectScope: { kind: 'client', source: 'explicit', clientIds: ['c1'] },
          },
          retrieval: {
            records: [],
            coverage: {
              requestedDomains: ['mail', 'meetings', 'strategies_work'],
              searchedDomains: ['mail'],
              requestedEntityCount: 1,
              searchedEntityCount: 1,
              recordsEvaluated: 0,
              recordsReturned: 0,
              paginationComplete: false,
              unavailableSources: ['meetings', 'strategies_work'],
              sources: [
                {
                  domain: 'mail',
                  sourceStatus: 'degraded',
                  stopReason: 'pagination_incomplete',
                  coverageComplete: false,
                  paginationComplete: false,
                  truncated: true,
                },
                {
                  domain: 'meetings',
                  sourceStatus: 'unavailable',
                  stopReason: 'source_unavailable',
                  coverageComplete: false,
                  paginationComplete: false,
                  truncated: false,
                },
                {
                  domain: 'strategies_work',
                  sourceStatus: 'unavailable',
                  stopReason: 'source_unavailable',
                  coverageComplete: false,
                  paginationComplete: false,
                  truncated: false,
                },
              ],
              complete: false,
              stopReason: 'source_unavailable',
            },
          },
        },
        packet: {
          version: 2,
          packetId: 'packet-incomplete',
          persisted: true,
          items: [],
          exclusions: [],
          rendered: [],
          health: { status: 'incomplete', reasons: ['retrieval_incomplete'] },
          retrievalCompleteness: 'incomplete',
          retrievalStopReason: 'source_unavailable',
          incomplete: true,
          truncated: true,
        },
      }),
    });

    const resolved = await svc.resolve(CTX, {
      clientId: 'c1',
      recipientName: 'Dana Reed',
      recipientEmail: 'dana.reed@mail.house.gov',
      objective: 'Follow up after the hearing.',
      wallAllowsClient: true,
    });

    expect(resolved.retrievalCompleteness).toBe('incomplete');
    expect(resolved.evidence).toHaveLength(0);
    expect(resolved.coverage.complete).toBe(false);
    expect(resolved.failures.map((f) => f.code)).toEqual(
      expect.arrayContaining([
        'CONTEXT_PLANE_INCOMPLETE',
        'CONTEXT_PLANE_SOURCE_UNAVAILABLE',
      ]),
    );
    expect(resolved.failures.some((f) => f.userMessage.toLowerCase().includes('no history'))).toBe(
      false,
    );
    expect(resolved.promptBlock).toContain('complete=false');
    expect(resolved.promptBlock).toContain('missingDomains=meetings,strategies_work');
  });

  test('unauthorized client scope is not placed on the resolver subject', async () => {
    const { svc, requestContext } = makeService({ clients: [] });
    await svc.resolve(CTX, {
      clientId: 'c-forbidden',
      recipientName: 'Dana Reed',
      recipientEmail: 'dana.reed@mail.house.gov',
      objective: 'Request a meeting.',
      wallAllowsClient: false,
    });
    const first = (requestContext.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
    const call = first as {
      resolverRequest: { clientId?: string; subjectScope?: string };
    };
    expect(call.resolverRequest.clientId).toBeUndefined();
    expect(call.resolverRequest.subjectScope).toBe('general');
  });

  test('gateway tenant/actor denial fails closed', async () => {
    const { svc } = makeService({
      gatewayImpl: async () => {
        throw new ForbiddenException({ reason: 'operation_scope_mismatch' });
      },
    });
    await expect(
      svc.resolve(CTX, {
        clientId: 'c1',
        recipientName: 'Dana Reed',
        recipientEmail: 'dana.reed@mail.house.gov',
        objective: 'Request a meeting.',
        wallAllowsClient: true,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
