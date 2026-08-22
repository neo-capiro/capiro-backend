import { Module } from '@nestjs/common';
import { SourceDataModule } from '../../sourcedata/source-data.module.js';
import { StreamResolverService } from '../stream-resolver.service.js';
import { FfmpegDeepgramCaptureRuntime } from './ffmpeg-deepgram-capture.runtime.js';
import { PublicCaptureAutomaticResolverAdapter } from './public-capture-automatic-resolver.adapter.js';
import { PublicCaptureCredentialsAdapter } from './public-capture-credentials.adapter.js';
import { PublicCaptureWorkerHandler } from './public-capture-jobs.js';
import {
  PublicCaptureOrchestrator,
  PublicCaptureWorkerCoordinator,
} from './public-capture.orchestrator.js';
import { PublicCapturePersistentQueueAdapter } from './public-capture-persistent-queue.adapter.js';
import { PublicHearingCaptureAttemptStore } from './public-hearing-capture-attempt.store.js';
import { PublicHearingCaptureStore } from './public-hearing-capture.store.js';
import { PublicHearingTranscriptStore } from './public-hearing-transcript.store.js';
import { HearingSubscriptionRepository } from './hearing-subscription.repository.js';

/**
 * Global public-hearing capture runtime. No tenant/client context is admitted:
 * tenant demand terminates at HearingSubscription, after which one durable job,
 * one fenced capture, and one canonical transcript serve every subscriber.
 */
@Module({
  imports: [SourceDataModule],
  providers: [
    StreamResolverService,
    PublicCaptureAutomaticResolverAdapter,
    PublicHearingCaptureStore,
    PublicHearingCaptureAttemptStore,
    PublicHearingTranscriptStore,
    HearingSubscriptionRepository,
    PublicCaptureCredentialsAdapter,
    PublicCapturePersistentQueueAdapter,
    {
      provide: PublicCaptureOrchestrator,
      useFactory: (
        store: PublicHearingCaptureStore,
        resolver: PublicCaptureAutomaticResolverAdapter,
        queue: PublicCapturePersistentQueueAdapter,
      ) => new PublicCaptureOrchestrator(store, resolver, queue),
      inject: [
        PublicHearingCaptureStore,
        PublicCaptureAutomaticResolverAdapter,
        PublicCapturePersistentQueueAdapter,
      ],
    },
    {
      provide: FfmpegDeepgramCaptureRuntime,
      useFactory: async (
        credentials: PublicCaptureCredentialsAdapter,
        sink: PublicHearingTranscriptStore,
      ) => {
        const credential = await credentials.resolve();
        return new FfmpegDeepgramCaptureRuntime(credential.apiKey, sink);
      },
      inject: [PublicCaptureCredentialsAdapter, PublicHearingTranscriptStore],
    },
    {
      provide: PublicCaptureWorkerCoordinator,
      useFactory: (
        store: PublicHearingCaptureStore,
        resolver: PublicCaptureAutomaticResolverAdapter,
        runtime: FfmpegDeepgramCaptureRuntime,
        attempts: PublicHearingCaptureAttemptStore,
        queue: PublicCapturePersistentQueueAdapter,
      ) =>
        new PublicCaptureWorkerCoordinator(store, resolver, runtime, {
          attempts,
          retryQueue: queue,
        }),
      inject: [
        PublicHearingCaptureStore,
        PublicCaptureAutomaticResolverAdapter,
        FfmpegDeepgramCaptureRuntime,
        PublicHearingCaptureAttemptStore,
        PublicCapturePersistentQueueAdapter,
      ],
    },
    {
      provide: PublicCaptureWorkerHandler,
      useFactory: (coordinator: PublicCaptureWorkerCoordinator) =>
        new PublicCaptureWorkerHandler(coordinator),
      inject: [PublicCaptureWorkerCoordinator],
    },
  ],
  exports: [
    PublicCaptureAutomaticResolverAdapter,
    PublicCapturePersistentQueueAdapter,
    PublicCaptureOrchestrator,
    PublicCaptureWorkerCoordinator,
    PublicCaptureWorkerHandler,
  ],
})
export class CaptureModule {}
