import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TangoGatewayService } from './tango.client.js';
import { TangoResilienceService } from './tango-resilience.service.js';
import { TangoStoreService } from './tango-store.service.js';
import { TANGO_GATEWAY, TANGO_RESILIENT_GATEWAY, type TangoGateway } from './tango.types.js';

/**
 * The MakeGov/Tango provider boundary, as a module.
 *
 * ── Registered unconditionally, configured optionally ────────────────────────
 *
 * The module always loads. The gateway inside it is constructed with whatever
 * config exists, and with NO key that construction still succeeds — it makes no
 * network call and reads no secret at boot. A deployment without `TANGO_API_KEY`
 * therefore boots identically to one with it, and every product read keeps
 * serving local data.
 *
 * The alternative — conditional registration — fails in the worst possible way:
 * a missing environment variable becomes a Nest dependency-resolution error at
 * startup, so the API refuses to boot because an ADDITIVE, dark provider is not
 * configured yet.
 *
 * ── Why the token is the interface, not the class ────────────────────────────
 *
 * Consumers inject `TANGO_GATEWAY` and receive `TangoGateway`. They cannot reach
 * `TangoGatewayService`'s privates, cannot see the SDK, and in tests can be given
 * a fixture-backed fake with no DI gymnastics.
 *
 * ── Global, deliberately ─────────────────────────────────────────────────────
 *
 * Several unrelated modules will consume this (sync scripts, the diagnostics
 * commands, later the enrichment services). `@Global` avoids re-importing it in
 * each, which is the pattern PrismaModule already uses here.
 *
 * `TangoStoreService` (P15) is the OTHER export: provider-owned persistence, not
 * the API gateway. It depends only on `PrismaService`, needs no key and no
 * config, and is registered here for the same reason — later phases (P19, P22,
 * P24, P27) inject it without any module-wiring change of their own.
 *
 * `TANGO_RESILIENT_GATEWAY` (P18) wraps `TANGO_GATEWAY` with retry, a circuit
 * breaker, a per-run request ceiling, and usage recording into
 * `TangoStoreService` — see tango-resilience.service.ts's class doc for the
 * full reasoning. Later phases that make real Tango calls (P19, P22, P24,
 * P27) should inject THIS token, not the raw `TANGO_GATEWAY`, unless they
 * have a specific, documented reason not to want that protection.
 */
@Global()
@Module({
  // Imported EXPLICITLY even though AppModule registers ConfigModule as global.
  // A module that only resolves inside one host application is a module that
  // cannot be unit-tested, and the failure mode is a startup-time
  // "Nest can't resolve dependencies" rather than anything a reader would trace
  // back to a missing import.
  imports: [ConfigModule],
  providers: [
    {
      provide: TANGO_GATEWAY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new TangoGatewayService({
          // `?? null` rather than a default: an unset key must produce the
          // unconfigured state, never an empty-string key that gets sent as a
          // header and comes back 401.
          apiKey: config.get<string>('TANGO_API_KEY') ?? null,
          baseUrl: config.get<string>('TANGO_API_BASE_URL'),
          timeoutMs: config.get<number>('TANGO_TIMEOUT_MS'),
        }),
    },
    // The provider-owned persistence substrate (P15). Depends only on
    // PrismaService, which PrismaModule already exports globally — no key, no
    // config, no network. Nothing calls it yet; it is wired here so the later
    // phases that DO (P19, P22, P24, P27) find it already registered rather
    // than needing their own module-wiring change.
    TangoStoreService,
    // The resilient wrapper (P18). Config-driven ceiling/breaker values, so a
    // deployment can tune them without a code change; unset envs fall back to
    // this class's own documented defaults (same optionality posture as every
    // other TANGO_* key — see config.schema.ts).
    {
      provide: TANGO_RESILIENT_GATEWAY,
      inject: [TANGO_GATEWAY, TangoStoreService, ConfigService],
      useFactory: (gateway: TangoGateway, store: TangoStoreService, config: ConfigService) =>
        new TangoResilienceService(gateway, store, {
          requestCeiling: config.get<number>('TANGO_REQUEST_CEILING_PER_RUN'),
          breakerThreshold: config.get<number>('TANGO_CIRCUIT_BREAKER_THRESHOLD'),
          breakerCooldownMs: config.get<number>('TANGO_CIRCUIT_BREAKER_COOLDOWN_MS'),
        }),
    },
  ],
  exports: [TANGO_GATEWAY, TangoStoreService, TANGO_RESILIENT_GATEWAY],
})
export class TangoModule {}
