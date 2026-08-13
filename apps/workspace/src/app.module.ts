import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { OrgTenantResolverModule } from './auth/org-tenant-resolver.module.js';
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
import { TemplateStudioModule } from './template-studio/template-studio.module.js';
import { WorkspaceReasoningModule } from './workspace-reasoning/workspace-reasoning.module.js';
import { DocumentAgentModule } from './document-agent/document-agent.module.js';
import { DeliveryModule } from './delivery/delivery.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    PrismaModule,
    // MUST precede AuthModule: the shared TenantGuard injects
    // ORG_TENANT_RESOLVER as a REQUIRED dependency (no @Optional(), which would
    // fail open). Missing it is a boot failure, by design.
    OrgTenantResolverModule,
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
    // ── Workspace Document Agent vNext ────────────────────────────────────
    // The new conversational document-generation experience. Gated by
    // WORKSPACE_DOCUMENT_AGENT_VNEXT_ENABLED (env, default false). The
    // controllers are registered but the service-level behavior is gated
    // so existing routes remain unaffected when the flag is off.
    WorkspaceReasoningModule,
    DocumentAgentModule,
    TemplateStudioModule,
    DeliveryModule,
  ],
})
export class AppModule {}
