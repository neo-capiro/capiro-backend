import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TangoModule } from './tango.module.js';
import { TangoGatewayService } from './tango.client.js';
import { TangoStoreService } from './tango-store.service.js';
import { TANGO_GATEWAY, type TangoGateway } from './tango.types.js';
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
