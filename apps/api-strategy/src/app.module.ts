import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

/**
 * Root module for the api-strategy service.
 *
 * Phase-1 (G1) scope: platform wiring only — global config, tenant-scoped
 * Prisma, the shared Clerk auth module (so G2 controllers can `@UseGuards`),
 * and the liveness endpoint. Feature modules (strategies, nodes, versions,
 * firm-phases, reference-calendars) arrive in G2+.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    PrismaModule,
    AuthModule,
    HealthModule,
  ],
})
export class AppModule {}
