import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TangoGatewayService } from './tango.client.js';
import { TANGO_GATEWAY } from './tango.types.js';

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
  ],
  exports: [TANGO_GATEWAY],
})
export class TangoModule {}
