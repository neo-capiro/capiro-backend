import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { MeriModule } from './meri/meri.module.js';

/**
 * MeriV2 Orchestrator (Option B strangler-fig service). Thin HTTP host for
 * `@capiro/meriv2-core` at `/meri-api/*`. Auth is the verbatim apps/workspace
 * clone (Clerk JWT + tenant guard); MeriModule hosts the tool registry.
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, cache: true }), AuthModule, HealthModule, MeriModule],
})
export class AppModule {}
