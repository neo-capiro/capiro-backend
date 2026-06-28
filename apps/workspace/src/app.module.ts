import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { CascadeModule } from './cascade/cascade.module.js';
import { TemplatesModule } from './templates/templates.module.js';
import { DraftsModule } from './drafts/drafts.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { CommentsModule } from './comments/comments.module.js';
import { CollaboratorsModule } from './collaborators/collaborators.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { ContextModule } from './context/context.module.js';
import { GenerationModule } from './generation/generation.module.js';
import { ExportModule } from './export/export.module.js';
import { ChecksModule } from './checks/checks.module.js';
import { VersionsModule } from './versions/versions.module.js';
import { EditLockModule } from './edit-lock/edit-lock.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    PrismaModule,
    AuthModule,
    HealthModule,
    CascadeModule,
    TemplatesModule,
    DraftsModule,
    DocumentsModule,
    CommentsModule,
    CollaboratorsModule,
    NotificationsModule,
    ContextModule,
    GenerationModule,
    ExportModule,
    ChecksModule,
    VersionsModule,
    EditLockModule,
  ],
})
export class AppModule {}
