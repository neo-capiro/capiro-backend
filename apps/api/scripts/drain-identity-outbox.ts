/**
 * Drain the identity outbox — retry Clerk de-provisioning calls that did not
 * land at removal time.
 *
 * Run out-of-band, NOT in-process:
 *   aws ecs run-task --cluster capiro-dev \
 *     --task-definition capiro-dev-api-oneoff \
 *     --overrides 'containerOverrides=[{name=api,command=["drain-identity-outbox"]}]'
 *
 * apps/api has no scheduler (@nestjs/schedule is not a dependency and no @Cron
 * exists anywhere in the service), and adding an in-process one would have every
 * ECS task racing on the same rows. This mirrors the existing verb pattern in
 * scripts/entrypoint.sh.
 *
 * Idempotent and safe to run concurrently: each job is claimed with an atomic
 * conditional UPDATE, so a row can only be processed once.
 *
 * Exit code is 0 when every due job succeeded, 1 when any remain failed — so a
 * scheduled invocation surfaces as a task failure.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { IdentityOutboxService } from '../src/auth/identity-outbox.service.js';

async function main(): Promise<void> {
  const limitArg = process.argv[2];
  const limit = limitArg ? Number.parseInt(limitArg, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`Invalid limit: ${String(limitArg)}`);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const outbox = app.get(IdentityOutboxService);
    const { processed, succeeded } = await outbox.drainPending(limit);
    const failed = processed - succeeded;
    console.log(
      JSON.stringify({
        event: 'identity_outbox.drain',
        processed,
        succeeded,
        failed,
      }),
    );
    if (failed > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error('drain-identity-outbox failed:', err);
  process.exit(1);
});
