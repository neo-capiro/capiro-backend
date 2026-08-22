/**
 * Nest DI bootstrap regression test for CaptureModule.
 *
 * Production symptom (LegiWatch dark deploy 2026-08-22): the intel-api Fargate
 * task crash-looped on boot with
 *
 *   Nest can't resolve dependencies of the StreamResolverService
 *   (ConfigService, ?). Please make sure that the argument SourceDataRepository
 *   at index [1] is available in the CaptureModule context.
 *
 * Root cause: CaptureModule declared StreamResolverService as one of its own
 * providers, but StreamResolverService injects SourceDataRepository, which is
 * only provided/exported by SourceDataModule. CaptureModule did not import
 * SourceDataModule. HearingModule importing SourceDataModule does NOT make the
 * provider visible inside its sibling CaptureModule — Nest provider visibility
 * is module-scoped.
 *
 * Why the prior unit tests missed it: they hand-constructed the service
 *   new StreamResolverService(new ConfigService(), new SourceDataRepository(...))
 * which bypasses the Nest DI container entirely, so the missing module import
 * was invisible until Fargate boot compiled the real module graph.
 *
 * This test compiles CaptureModule through the REAL Nest DI container. It fails
 * against the broken wiring (no `imports: [SourceDataModule]`) and passes once
 * SourceDataModule is imported. PrismaService is stubbed so the graph compiles
 * without a live DB, and DEEPGRAM_API_KEY is set so the async
 * FfmpegDeepgramCaptureRuntime credential factory resolves — the objective is
 * real Nest dependency resolution, not provider business logic.
 */
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { PrismaModule } from '../../prisma/prisma.module.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SourceDataRepository } from '../../sourcedata/source-data.repository.js';
import { StreamResolverService } from '../stream-resolver.service.js';
import { CaptureModule } from './capture.module.js';

describe('CaptureModule (Nest DI graph)', () => {
  const prevDeepgram = process.env.DEEPGRAM_API_KEY;

  beforeAll(() => {
    // FfmpegDeepgramCaptureRuntime's async factory calls credentials.resolve(),
    // which throws without this. Not real credential resolution — just enough
    // to let the DI graph compile.
    process.env.DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY ?? 'test-di-only';
  });

  afterAll(() => {
    if (prevDeepgram === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = prevDeepgram;
  });

  it('resolves StreamResolverService with its SourceDataRepository dependency', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, cache: true }),
        PrismaModule,
        CaptureModule,
      ],
    })
      // Stub the DB client so the graph compiles without a live connection.
      .overrideProvider(PrismaService)
      .useValue({ $queryRawUnsafe: async () => [], $executeRawUnsafe: async () => 0 })
      .compile();

    // The exact provider that failed at Fargate boot.
    const resolver = moduleRef.get(StreamResolverService, { strict: false });
    expect(resolver).toBeInstanceOf(StreamResolverService);

    // Its previously-unresolvable cross-module dependency must now resolve.
    const source = moduleRef.get(SourceDataRepository, { strict: false });
    expect(source).toBeInstanceOf(SourceDataRepository);

    await moduleRef.close();
  });
});
