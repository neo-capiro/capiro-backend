import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TangoModule } from './tango.module.js';
import { TangoGatewayService } from './tango.client.js';
import { TangoResilienceService } from './tango-resilience.service.js';
import { TangoStoreService } from './tango-store.service.js';
import { TANGO_GATEWAY, TANGO_RESILIENT_GATEWAY, type TangoGateway } from './tango.types.js';
import { TangoNotConfiguredError } from './tango.errors.js';
import { PrismaModule } from '../../prisma/prisma.module.js';

/**
 * The module wiring.
 *
 * The one property worth a test of its own: an API instance with no
 * `TANGO_API_KEY` must BOOT. Conditional registration is the tempting shape and
 * it fails in the worst possible way — a missing environment variable becomes a
 * Nest dependency-resolution error at startup, so the whole API refuses to start
 * because an additive, dark provider is not configured yet.
 */

async function build(env: Record<string, string | undefined>) {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const moduleRef = await Test.createTestingModule({
      // PrismaModule is @Global() in the real app (imported once by AppModule),
      // but Nest's isolated testing module builder does not pull in a global
      // module unless something in the tested graph actually imports it — so an
      // isolated TangoModule test has to import it explicitly, the same way any
      // OTHER consumer of a global module would if it were tested alone.
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true }), PrismaModule, TangoModule],
    }).compile();
    return moduleRef;
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('the module boots with or without a key', () => {
  test('it resolves with NO key at all', async () => {
    const moduleRef = await build({ TANGO_API_KEY: undefined, TANGO_API_BASE_URL: undefined });
    const gateway = moduleRef.get<TangoGateway>(TANGO_GATEWAY);
    expect(gateway).toBeInstanceOf(TangoGatewayService);
    expect(gateway.configured).toBe(false);
    await moduleRef.close();
  });

  test('an unconfigured gateway is still injectable, and fails only when CALLED', async () => {
    // The distinction the whole design rests on: absence is a state the container
    // can hold, not a wiring error.
    const moduleRef = await build({ TANGO_API_KEY: undefined });
    const gateway = moduleRef.get<TangoGateway>(TANGO_GATEWAY);
    await expect(gateway.getVersion()).rejects.toBeInstanceOf(TangoNotConfiguredError);
    await moduleRef.close();
  });

  test('it picks the key up from config when one exists', async () => {
    const moduleRef = await build({ TANGO_API_KEY: 'sk_test_NOTAREALKEY_module' });
    const gateway = moduleRef.get<TangoGateway>(TANGO_GATEWAY);
    expect(gateway.configured).toBe(true);
    await moduleRef.close();
  });

  test('an EMPTY key is unconfigured, not a key', async () => {
    const moduleRef = await build({ TANGO_API_KEY: '' });
    const gateway = moduleRef.get<TangoGateway>(TANGO_GATEWAY);
    expect(gateway.configured).toBe(false);
    await moduleRef.close();
  });

  test('the exported token is the INTERFACE token, not the implementation class', async () => {
    // Consumers inject TANGO_GATEWAY and receive TangoGateway. They cannot reach
    // the implementation's privates, cannot see the SDK, and in tests can be given
    // a fixture-backed fake with no DI gymnastics.
    const moduleRef = await build({ TANGO_API_KEY: undefined });
    expect(() => moduleRef.get(TangoGatewayService)).toThrow();
    expect(moduleRef.get(TANGO_GATEWAY)).toBeDefined();
    await moduleRef.close();
  });

  test('TangoStoreService (P15) is also exported, and needs no key at all', async () => {
    // Provider-owned persistence depends only on PrismaService — no config, no
    // network — so it is resolvable in EVERY configuration, including no key.
    const moduleRef = await build({ TANGO_API_KEY: undefined });
    expect(moduleRef.get(TangoStoreService)).toBeInstanceOf(TangoStoreService);
    await moduleRef.close();
  });

  test('nothing in the module reads a secret at construction time', async () => {
    // Boot must not depend on Secrets Manager, an env file, or a network call. The
    // factory reads ConfigService and stops.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(__dirname, 'tango.module.ts'), 'utf8');
    expect(source).not.toMatch(/SecretsManager|getSecretValue|fetch\(|https?:\/\//);
  });
});

describe('the resilient wrapper (P18) is exported and config-driven', () => {
  test('it resolves with NO key at all, same as the raw gateway', async () => {
    const moduleRef = await build({ TANGO_API_KEY: undefined });
    const resilient = moduleRef.get<TangoGateway>(TANGO_RESILIENT_GATEWAY);
    expect(resilient).toBeInstanceOf(TangoResilienceService);
    expect(resilient.configured).toBe(false);
    await moduleRef.close();
  });

  test('an unconfigured wrapped gateway still fails only when CALLED, with the SAME error type', async () => {
    const moduleRef = await build({ TANGO_API_KEY: undefined });
    const resilient = moduleRef.get<TangoGateway>(TANGO_RESILIENT_GATEWAY);
    await expect(resilient.getVersion()).rejects.toBeInstanceOf(TangoNotConfiguredError);
    await moduleRef.close();
  });

  test('it wraps a DIFFERENT instance than the raw TANGO_GATEWAY token', async () => {
    // The two tokens are deliberately not aliases of the same object — see
    // tango-resilience.service.ts's class doc on why both continue to exist.
    const moduleRef = await build({ TANGO_API_KEY: undefined });
    const raw = moduleRef.get(TANGO_GATEWAY);
    const resilient = moduleRef.get(TANGO_RESILIENT_GATEWAY);
    expect(resilient).not.toBe(raw);
    expect(raw).toBeInstanceOf(TangoGatewayService);
    expect(resilient).toBeInstanceOf(TangoResilienceService);
    await moduleRef.close();
  });

  test('the request ceiling and breaker settings are picked up from config, not hard-coded', async () => {
    // This harness's bare ConfigModule.forRoot (no `validate:` schema hook,
    // unlike app.module.ts's real wiring two files up) does not coerce env
    // strings to numbers the way the real app's Zod schema does — that
    // coercion is already proven by config.schema.spec.ts. This test only
    // proves the WIRING reaches the service instead of a hard-coded value,
    // so it compares numerically rather than assuming either representation.
    const moduleRef = await build({
      TANGO_API_KEY: undefined,
      TANGO_REQUEST_CEILING_PER_RUN: '17',
      TANGO_CIRCUIT_BREAKER_THRESHOLD: '3',
      TANGO_CIRCUIT_BREAKER_COOLDOWN_MS: '9000',
    });
    const resilient = moduleRef.get<TangoResilienceService>(TANGO_RESILIENT_GATEWAY);
    const health = resilient.getHealth();
    expect(Number(health.requestCeiling)).toBe(17);
    expect(Number(health.breakerThreshold)).toBe(3);
    await moduleRef.close();
  });

  test('with no override, the documented defaults apply', async () => {
    const moduleRef = await build({ TANGO_API_KEY: undefined });
    const resilient = moduleRef.get<TangoResilienceService>(TANGO_RESILIENT_GATEWAY);
    const health = resilient.getHealth();
    expect(health.requestCeiling).toBe(5_000);
    expect(health.breakerThreshold).toBe(5);
    expect(health.breakerState).toBe('closed');
    await moduleRef.close();
  });

  test('TangoStoreService (P15) is also exported', async () => {
    const moduleRef = await build({ TANGO_API_KEY: undefined });
    expect(moduleRef.get(TangoStoreService)).toBeInstanceOf(TangoStoreService);
    await moduleRef.close();
  });
});
