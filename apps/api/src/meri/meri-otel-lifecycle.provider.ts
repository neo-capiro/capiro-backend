import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import {
  createMeriOtelRuntime,
  type MeriOtelRuntime,
} from '@capiro/meriv2-core/observability/otel';
import { getMeriOtelRuntime, setMeriOtelRuntime } from './meri-telemetry.runtime.js';

/** Explicit trace endpoint opt-in; Nest owns initialization and bounded shutdown. */
@Injectable()
export class MeriOtelLifecycleProvider implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MeriOtelLifecycleProvider.name);
  private runtime: MeriOtelRuntime | undefined;
  private initialized = false;

  async onModuleInit(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
    if (!endpoint) return;
    this.runtime = createMeriOtelRuntime({
      serviceName: 'capiro-api',
      tracesEndpoint: endpoint,
      release: process.env.RELEASE_SHA ?? process.env.GIT_SHA ?? process.env.IMAGE_TAG,
    });
    await setMeriOtelRuntime(this.runtime);
    if (!this.runtime.isEnabled())
      this.logger.warn(
        'Meri trace export could not initialize; request handling remains available.',
      );
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.runtime) return;
    const owned = this.runtime;
    this.runtime = undefined;
    if (getMeriOtelRuntime() === owned) await setMeriOtelRuntime(undefined);
    else await owned.shutdown();
  }
}
