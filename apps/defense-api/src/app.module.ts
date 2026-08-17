import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '@capiro/auth';
import { loadDefenseConfig } from './config/defense-config.js';
import { HealthModule } from './health/health.module.js';
import { InternalAuthModule } from './internal-auth/internal-auth.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RequestContextModule } from './request-context/request-context.module.js';
import { OrgTenantResolverModule } from './auth/org-tenant-resolver.module.js';
import { JsonLogger } from './observability/json-logger.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [() => ({ defense: loadDefenseConfig() })],
    }),
    PrismaModule,
    OrgTenantResolverModule,
    AuthModule,
    RequestContextModule,
    InternalAuthModule,
    HealthModule,
  ],
  providers: [JsonLogger],
})
export class AppModule {}
