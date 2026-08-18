import { ContextPlaneAuditService } from './context-plane-audit.service.js';

describe('ContextPlaneAuditService Phase 18', () => {
  test('writes one tenant-scoped bounded decision record and no context bodies', async () => {
    const execute = jest.fn().mockResolvedValue(1);
    const prisma = {
      withTenant: jest.fn().mockImplementation(async (_tenantId, run) =>
        run({ $executeRaw: execute }),
      ),
    };
    const service = new ContextPlaneAuditService(prisma as never);

    await service.record({
      tenantId: '11111111-1111-1111-1111-111111111111',
      actorUserId: '22222222-2222-2222-2222-222222222222',
      requestId: 'req-18',
      product: 'meri',
      resolverSurface: 'research',
      rolloutMode: 'enforce',
      decision: {
        allowed: true,
        reason: 'governed_packet',
        operationId: 'meri.research',
        surface: 'research',
        mode: 'packet_required',
        migrationExceptionId: null,
        migrationTargetPhase: null,
      },
      packet: {
        version: 2,
        packetId: '33333333-3333-3333-3333-333333333333',
        traceHash: 'trace-hash',
        persisted: true,
        retrievalCompleteness: 'complete',
        retrievalStopReason: 'complete',
      },
    });

    expect(prisma.withTenant).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      expect.any(Function),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    const serializedArguments = JSON.stringify(execute.mock.calls[0]);
    expect(serializedArguments).toContain('context_plane.operation.');
    expect(serializedArguments).toContain('governed_packet');
    expect(serializedArguments).toContain('trace-hash');
    expect(serializedArguments).not.toContain('promptBody');
    expect(serializedArguments).not.toContain('retrievalPayload');
    expect(serializedArguments).not.toContain('memoryBody');
  });

  test('fails closed when the audit row cannot be written', async () => {
    const prisma = {
      withTenant: jest.fn().mockImplementation(async (_tenantId, run) =>
        run({ $executeRaw: jest.fn().mockResolvedValue(0) }),
      ),
    };
    const service = new ContextPlaneAuditService(prisma as never);

    await expect(
      service.record({
        tenantId: '11111111-1111-1111-1111-111111111111',
        actorUserId: '22222222-2222-2222-2222-222222222222',
        product: null,
        resolverSurface: 'research',
        rolloutMode: 'enforce',
        decision: {
          allowed: false,
          reason: 'operation_not_registered',
          operationId: 'rogue.rag',
          surface: null,
          mode: null,
          migrationExceptionId: null,
          migrationTargetPhase: null,
        },
      }),
    ).rejects.toThrow('context_plane_audit_write_failed');
  });
});
