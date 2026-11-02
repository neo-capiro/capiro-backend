import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import {
  configureApiHttpApp,
  configureApiHttpServerTimeouts,
} from './bootstrap/configure-api-http-app.js';
import { assertEngagementRuntimeEnvironment } from './engagement/runtime/engagement-runtime-env.js';
import { EngagementRuntimePolicyService } from './engagement/runtime/engagement-runtime-policy.service.js';
import { installMailHandoffShutdownJoin } from './engagement/runtime/engagement-mail-handoff-shutdown.js';
import { disablePersistedMeriPolicyPackEnforcement } from './meri/meri-policy-pack-runtime.js';
import { coreRosterPreviewHttpGate } from './auth/core-roster-preview-http-gate.js';

disablePersistedMeriPolicyPackEnforcement();

async function bootstrap() {
  // Fail before Nest constructs providers, connects to the database, or starts
  // an OnModuleInit hook when an Engagement runtime control is malformed.
  assertEngagementRuntimeEnvironment(process.env as Record<string, unknown>);

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(coreRosterPreviewHttpGate(
    process.env.CORE_ROSTER_PREVIEW_ENABLED === 'true',
    process.env.PREVIEW_NATIVE_GETS_ENABLED === 'true',
  ));
  const logger = new Logger('Bootstrap');
  const runtimePolicy = app.get(EngagementRuntimePolicyService);
  if (runtimePolicy.mailHandoffObservation()) {
    // Selected handoff: this join owns SIGTERM/SIGINT so already-admitted mail work
    // drains before Nest destroys providers. Nest's own shutdown hooks are NOT
    // enabled, because their signal callback calls callDestroyHook() directly and
    // would bypass the drain.
    installMailHandoffShutdownJoin(app, runtimePolicy, logger);
  } else {
    // Default (handoff unset): unchanged graceful-shutdown behavior.
    app.enableShutdownHooks();
  }

  configureApiHttpApp(app, {
    serviceHeader: undefined,
    releaseShaHeader: process.env.RELEASE_SHA ?? process.env.GIT_SHA,
    includeClerkRawBody: true,
    includeRecallRawBody: true,
    includeTangoRawBody: true,
    includeObjectiveDecisionRawBody: true,
    includeMeriReadDelegationRawBody: true,
    includeEmailSignatureLargeBody: true,
    defaultJsonLimit: '1mb',
  });

  const port = Number.parseInt(process.env.API_PORT ?? '4000', 10);
  const host = process.env.API_BIND_HOST ?? '0.0.0.0';
  await app.listen(port, host);
  configureApiHttpServerTimeouts(app.getHttpServer());
  logger.log(`Capiro API listening on http://${host}:${port}`);
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
