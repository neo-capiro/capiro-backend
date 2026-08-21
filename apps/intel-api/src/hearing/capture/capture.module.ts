import { Module } from '@nestjs/common';
import { StreamResolverService } from '../stream-resolver.service.js';
import { FfmpegDeepgramCaptureRuntime } from './ffmpeg-deepgram-capture.runtime.js';
import { PublicCaptureCredentialsAdapter } from './public-capture-credentials.adapter.js';
import { PublicCaptureWorkerHandler } from './public-capture-jobs.js';
import { PublicCaptureOrchestrator, PublicCaptureWorkerCoordinator } from './public-capture.orchestrator.js';
import { PublicCaptureQueueAdapter } from './public-capture-queue.adapter.js';
import { PublicHearingCaptureAttemptStore } from './public-hearing-capture-attempt.store.js';
import { PublicHearingCaptureStore } from './public-hearing-capture.store.js';
import { PublicHearingTranscriptStore } from './public-hearing-transcript.store.js';
import { HearingSubscriptionRepository } from './hearing-subscription.repository.js';

@Module({
  providers: [
    StreamResolverService,
    PublicHearingCaptureStore,
    PublicHearingCaptureAttemptStore,
    PublicHearingTranscriptStore,
    HearingSubscriptionRepository,
    PublicCaptureCredentialsAdapter,
    PublicCaptureQueueAdapter,
    { provide: PublicCaptureOrchestrator, useFactory: (store:PublicHearingCaptureStore,resolver:StreamResolverService,queue:PublicCaptureQueueAdapter) => new PublicCaptureOrchestrator(store,resolver,queue),
      inject:[PublicHearingCaptureStore,StreamResolverService,PublicCaptureQueueAdapter] },
    { provide: FfmpegDeepgramCaptureRuntime, useFactory: async (credentials:PublicCaptureCredentialsAdapter,sink:PublicHearingTranscriptStore) => {
      const credential=await credentials.resolve(); return new FfmpegDeepgramCaptureRuntime(credential.apiKey,sink);
    }, inject:[PublicCaptureCredentialsAdapter,PublicHearingTranscriptStore] },
    { provide: PublicCaptureWorkerCoordinator, useFactory: (store:PublicHearingCaptureStore,resolver:StreamResolverService,runtime:FfmpegDeepgramCaptureRuntime,attempts:PublicHearingCaptureAttemptStore,queue:PublicCaptureQueueAdapter) => new PublicCaptureWorkerCoordinator(store,resolver,runtime,{attempts,retryQueue:queue}),
      inject:[PublicHearingCaptureStore,StreamResolverService,FfmpegDeepgramCaptureRuntime,PublicHearingCaptureAttemptStore,PublicCaptureQueueAdapter] },
    { provide: PublicCaptureWorkerHandler, useFactory:(coordinator:PublicCaptureWorkerCoordinator)=>new PublicCaptureWorkerHandler(coordinator), inject:[PublicCaptureWorkerCoordinator] },
  ],
  exports:[PublicCaptureOrchestrator,PublicCaptureWorkerCoordinator,PublicCaptureWorkerHandler],
})
export class CaptureModule {}
