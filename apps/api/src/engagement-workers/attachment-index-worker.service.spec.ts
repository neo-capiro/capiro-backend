import { ConfigService } from '@nestjs/config';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';
import { EmbeddingsModule } from '../embeddings/embeddings.module.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';
import { AttachmentIndexWorkerService } from './attachment-index-worker.service.js';
import { EngagementWorkersModule } from './engagement-workers.module.js';

/**
 * Satisfies the config the module graph's owners read, without booting the
 * environment-backed ConfigModule. Global, exactly like the ConfigModule it stands
 * in for, so an imported module's providers can inject it. External endpoints and
 * credentials get inert values: this test mounts the graph, it never connects.
 */
@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useValue: {
        get: (key: string) => {
          if (key === 'AWS_REGION_DEFAULT') return 'us-east-1';
          if (key === 'CLIO_CLIENT_KB_ENABLED') return true;
          if (key === 'ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED') return true;
          if (key === 'ASSETS_BUCKET') return 'mg06-spec-bucket';
          if (key === 'OPENAI_MODEL') return 'gpt-6-astra';
          if (key === 'ANTHROPIC_MODEL') return 'claude-sonnet-5';
          // Inert external resources: never dialled by this test.
          if (key.endsWith('_BASE_URL') || key.endsWith('_URL')) return 'https://mount.invalid';
          if (key.endsWith('_API_KEY') || key.endsWith('_SECRET') || key.endsWith('_TOKEN')) {
            return 'not-a-real-credential';
          }
          return undefined;
        },
      },
    },
  ],
  exports: [ConfigService],
})
class ConfigStubModule {}

function runtime(enabled: boolean) {
  return {
    backgroundWorkersEnabled: jest.fn(() => enabled),
    assertBackgroundOwner: jest.fn(),
  };
}

/**
 * MG-06 durable resumer. The worker owns when a durable row is picked up; the
 * attachment row (claim + due marker) owns that it is picked up at all, so these
 * cover both the shell lifecycle and the due-discovery contract it drives.
 */
describe('attachment indexing resumer', () => {
  describe('worker shell', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    it('starts exactly one owner timer, is idempotent and clears it', () => {
      const service = new AttachmentIndexWorkerService(
        { runDueAttachmentIndexSweep: jest.fn().mockResolvedValue({ selected: 0 }) } as never,
        runtime(true) as never,
      );
      service.onModuleInit();
      service.onModuleInit();
      expect(jest.getTimerCount()).toBe(1);
      service.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('starts nothing when the existing runtime policy says this process is not the owner', () => {
      const kb = { runDueAttachmentIndexSweep: jest.fn() };
      const service = new AttachmentIndexWorkerService(kb as never, runtime(false) as never);
      service.onModuleInit();
      expect(jest.getTimerCount()).toBe(0);
      expect(kb.runDueAttachmentIndexSweep).not.toHaveBeenCalled();
    });

    it('skips a tick that overlaps a sweep which is still in flight', () => {
      const kb = { runDueAttachmentIndexSweep: jest.fn(() => new Promise(() => undefined)) };
      const service = new AttachmentIndexWorkerService(kb as never, runtime(true) as never);
      service.onModuleInit();
      jest.advanceTimersByTime(60_000);
      jest.advanceTimersByTime(60_000);
      expect(kb.runDueAttachmentIndexSweep).toHaveBeenCalledTimes(1);
      service.onModuleDestroy();
    });

    it('stops claiming new work once shutdown began', () => {
      const kb = { runDueAttachmentIndexSweep: jest.fn().mockResolvedValue({ selected: 0 }) };
      const service = new AttachmentIndexWorkerService(kb as never, runtime(true) as never);
      service.onModuleInit();
      service.onModuleDestroy();
      jest.advanceTimersByTime(120_000);
      expect(kb.runDueAttachmentIndexSweep).not.toHaveBeenCalled();
    });

    it('contains a sweep failure instead of tearing down the timer', async () => {
      const kb = {
        runDueAttachmentIndexSweep: jest.fn().mockRejectedValue(new Error('policy denied')),
      };
      const service = new AttachmentIndexWorkerService(kb as never, runtime(true) as never);
      service.onModuleInit();
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      expect(jest.getTimerCount()).toBe(1);
      service.onModuleDestroy();
    });
  });

  describe('due discovery', () => {
    function kbFixture(enabled = true) {
      const query = jest.fn().mockResolvedValue([]);
      const withSystem = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ $queryRawUnsafe: query }),
      );
      const service = Object.create(ClientKbService.prototype) as ClientKbService;
      Object.assign(service, {
        config: {
          get: jest.fn((key: string) => (key === 'CLIO_CLIENT_KB_ENABLED' ? enabled : false)),
        },
        prisma: { withSystem, withTenant: jest.fn() },
        indexAttachment: jest.fn(),
        logger: { warn: jest.fn(), log: jest.fn() },
      });
      return { service, withSystem, query };
    }

    it('does no discovery at all while the existing KB switch is off', async () => {
      const f = kbFixture(false);
      const result = await f.service.runDueAttachmentIndexSweep();
      expect(result).toEqual({ selected: 0, indexed: 0, metadataOnly: 0, failed: 0 });
      expect(f.withSystem).not.toHaveBeenCalled();
    });

    it('discovers a finite, deterministically ordered batch of genuinely due rows', async () => {
      const f = kbFixture();
      await f.service.runDueAttachmentIndexSweep(1000);

      // Privileged discovery is read-only; execution re-reads the guards itself.
      expect(f.withSystem.mock.calls[0]![1]).toEqual({ readOnly: true });
      const sql = String(f.query.mock.calls[0]![0]);
      // Finite batch even when a caller asks for more.
      expect(sql).toContain('LIMIT 25');
      // Deterministic, fair order: never-attempted first, then oldest due.
      expect(sql).toContain(
        'ORDER BY index_next_attempt_at ASC NULLS FIRST, created_at ASC, id ASC',
      );
      // A live claim is never re-selected; an expired one is (process loss).
      expect(sql).toContain('index_claim_expires_at <= clock_timestamp()');
      // Unfinished work only, so a completed metadata-only row cannot spin.
      expect(sql).toContain("coalesce(extraction_status, '') <> 'empty'");
      expect(sql).toContain('indexed_at IS NULL');
      // Deliberately ineligible rows are never even candidates.
      expect(sql).toContain("viewer_mode = 'all'");
      expect(sql).toContain("lifecycle_status IN ('ready', 'legacy_ready')");
      expect(sql).toContain('client_id IS NOT NULL');
      expect(sql).toContain('superseded_by_attachment_id IS NULL');
      expect(sql).toContain('prospect_id IS NULL');
    });

    it('reports each outcome and isolates one failing document from the rest of the batch', async () => {
      const f = kbFixture();
      const index = jest
        .fn()
        .mockResolvedValueOnce('indexed')
        .mockRejectedValueOnce(new Error('bedrock throttled'))
        .mockResolvedValueOnce('metadata_only');
      f.service.indexAttachment = index;
      f.query.mockResolvedValue([
        { tenantId: 'tenant-1', id: 'a' },
        { tenantId: 'tenant-1', id: 'b' },
        { tenantId: 'tenant-2', id: 'c' },
      ]);

      const result = await f.service.runDueAttachmentIndexSweep();

      expect(result).toEqual({ selected: 3, indexed: 1, metadataOnly: 1, failed: 1 });
      // Tenant-scoped execution per candidate, in discovery order.
      expect(index.mock.calls).toEqual([
        ['tenant-1', 'a'],
        ['tenant-1', 'b'],
        ['tenant-2', 'c'],
      ]);
    });
  });

  describe('module binding', () => {
    function runtimeStub() {
      return { backgroundWorkersEnabled: () => false, assertBackgroundOwner: jest.fn() };
    }

    it('resolves ClientKbService for the worker through the EmbeddingsModule import', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [PrismaModule, EmbeddingsModule, ConfigStubModule],
        providers: [
          AttachmentIndexWorkerService,
          { provide: EngagementRuntimePolicyService, useValue: runtimeStub() },
        ],
      })
        .overrideProvider(PrismaService)
        .useValue({ withTenant: jest.fn(), withSystem: jest.fn() })
        .compile();

      expect(moduleRef.get(ClientKbService)).toBeInstanceOf(ClientKbService);
      expect(moduleRef.get(AttachmentIndexWorkerService)).toBeInstanceOf(
        AttachmentIndexWorkerService,
      );
      await moduleRef.close();
    });

    it('mounts the actual EngagementWorkersModule and resolves its index worker', async () => {
      // Qualify the actual graph, including its direct EmbeddingsModule edge.
      // Removing that import must fail DI, not merely a metadata assertion.
      const moduleRef = await Test.createTestingModule({
        imports: [ConfigStubModule, EngagementWorkersModule],
      })
        .overrideProvider(PrismaService)
        .useValue({ withTenant: jest.fn(), withSystem: jest.fn() })
        .overrideProvider(EngagementRuntimePolicyService)
        .useValue(runtimeStub())
        .compile();
      try {
        expect(moduleRef.get(AttachmentIndexWorkerService)).toBeInstanceOf(AttachmentIndexWorkerService);
        expect(moduleRef.get(ClientKbService)).toBeInstanceOf(ClientKbService);
      } finally {
        // No app.init: constructor/DI qualification never starts background work.
        await moduleRef.close();
      }
    });

    it('cannot resolve the worker without EmbeddingsModule — the splice this shell depends on', async () => {
      // Witness for the test above: the direct EmbeddingsModule import is what
      // makes ClientKbService resolvable for this shell. EngagementModule imports
      // Embeddings WITHOUT re-exporting it, so relying on the transitive import
      // leaves the worker unresolvable exactly like this — a failure a
      // direct-constructor test would never show.
      await expect(
        Test.createTestingModule({
          imports: [PrismaModule, ConfigStubModule],
          providers: [
            AttachmentIndexWorkerService,
            { provide: EngagementRuntimePolicyService, useValue: runtimeStub() },
          ],
        })
          .overrideProvider(PrismaService)
          .useValue({ withTenant: jest.fn(), withSystem: jest.fn() })
          .compile(),
      ).rejects.toThrow(/ClientKbService/);
    });
  });
});
