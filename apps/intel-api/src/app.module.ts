import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module.js';
import { HearingModule } from './hearing/hearing.module.js';
import { WatchlistModule } from './watchlist/watchlist.module.js';
import { TrackerModule } from './tracker/tracker.module.js';
import { UpcomingHearingsModule } from './upcoming-hearings/upcoming-hearings.module.js';

/**
 * Intel API root module.
 *
 * Auth (verbatim port of the workspace Clerk guard), global Prisma, tenant
 * feature gating, the ungated /health endpoint, and the Live Hearing capability
 * (REST + WebSocket gateway + Deepgram STT + orchestrator-driven extraction).
 * Future intel capabilities register here.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    PrismaModule,
    AuthModule,
    FeatureFlagsModule,
    HealthModule,
    HearingModule,
    WatchlistModule,
    TrackerModule,
    UpcomingHearingsModule,
  ],
})
export class AppModule {}
