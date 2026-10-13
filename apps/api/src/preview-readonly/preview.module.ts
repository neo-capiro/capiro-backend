import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ClerkService } from '../auth/clerk.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import { UsersController } from '../users/users.controller.js';
import { PREVIEW_CONFIG, type PreviewConfig } from './preview.config.js';
import { PreviewReadOnlyController } from './preview.controller.js';
import { PreviewReadOnlyInterceptor } from './preview.interceptor.js';

@Module({})
export class PreviewReadOnlyModule {
  static register(config: PreviewConfig): DynamicModule {
    return {
      module: PreviewReadOnlyModule,
      controllers: [PreviewReadOnlyController],
      providers: [
        { provide: PREVIEW_CONFIG, useValue: config },
        { provide: ConfigService, useValue: new ConfigService(config.app) },
        { provide: PrismaService, useFactory: () => new PrismaService({
          datasources: { db: { url: config.preview.PREVIEW_READONLY_DATABASE_URL } },
        }) },
        ClerkService,
        TenantContextStore,
        // Provider only: UsersController's mutation routes are not registered.
        UsersController,
        { provide: APP_INTERCEPTOR, useClass: PreviewReadOnlyInterceptor },
      ],
    };
  }
}
