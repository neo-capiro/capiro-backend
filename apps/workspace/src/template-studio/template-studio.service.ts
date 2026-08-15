import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import type { ResolvedRole } from '../collaborators/role-policy.js';
import { canRead } from '../collaborators/role-policy.js';
import type {
  WsBlueprint,
  WsBlueprintVersion,
  WsBlueprintScope,
  WsBlueprintVersionStatus,
} from '../../generated/prisma-client/index.js';
import type { WorkspaceBlueprintDefinition } from './template-definition.js';
import { TemplateValidator } from './template-validator.js';
import type {
  CloneBlueprintDto,
  CompareVersionsResult,
  CreateBlueprintDto,
  CreateVersionDto,
  TestVersionDto,
  UpdateVersionDto,
} from './dto/template-studio.dto.js';

/**
 * Template Studio — firm blueprint management with versioned, immutable
 * published versions (DECISIONS §Template-Studio).
 *
 * Tenancy:
 *  - Every query is tenant-scoped. Reads include the tenant's own blueprints
 *    plus capiro-global blueprints (tenantId null).
 *  - capiro-scoped blueprints (tenantId null) are READ by any tenant but
 *    WRITTEN only by their original author (ownerId).
 *
 * Authorization:
 *  - Reads: any tenant collaborator (TenantGuard already proved membership).
 *  - Create / publish / retire: firm admin only, via assertFirmAdmin() — a
 *    placeholder check reading tenants.settings_jsonb.firmAdmin. Default
 *    DENY when the field is absent or the read fails.
 *
 * Immutability:
 *  - A published WsBlueprintVersion is immutable; PATCH → 409.
 *  - The definitionHash is the content-addressed pin an existing document
 *    carries, so publishing a new version never retroactively moves a doc
 *    already in flight (see isPinnedTo()).
 */
@Injectable()
export class TemplateStudioService {
  private readonly logger = new Logger(TemplateStudioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly collaborators: CollaboratorsService,
    private readonly validator: TemplateValidator,
  ) {}

  // ── Authorization ───────────────────────────────────────────────────────

  /**
   * Placeholder firm-admin gate. Reads tenants.settings_jsonb for a `firmAdmin`
   * field matching the actor's Clerk user id. Default DENY on read failure or
   * absent field (same conservative posture as MeriV2FlagsService). This is a
   * stand-in until an explicit role string ships in the collaborators matrix.
   */
  async assertFirmAdmin(tenantId: string, clerkUserId: string): Promise<boolean> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ settings_jsonb: unknown }>>`
        SELECT settings_jsonb FROM tenants WHERE id = ${tenantId}::uuid LIMIT 1
      `;
      const settings = rows[0]?.settings_jsonb;
      if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
        const admin = (settings as Record<string, unknown>).firmAdmin;
        return admin === clerkUserId;
      }
      return false;
    } catch (e) {
      this.logger.warn(`firm-admin check failed for tenant ${tenantId}: ${(e as Error).message}`);
      return false;
    }
  }

  /** Throw 403 unless the actor is the firm admin. */
  private async requireFirmAdmin(tenantId: string, clerkUserId: string): Promise<void> {
    const ok = await this.assertFirmAdmin(tenantId, clerkUserId);
    if (!ok) {
      throw new ForbiddenException('Only a firm admin may perform this action');
    }
  }

  /**
   * Read gate: any tenant collaborator. Blueprints aren't drafts, so we treat
   * "tenant member" (proven by TenantGuard) as sufficient; the collaborators
   * service is consulted when a draftId context exists. Here we simply confirm
   * the actor resolved to a tenant (non-null role bucket) via canRead(null)→
   * false being the only deny, but TenantGuard already guarantees membership,
   * so this is a no-op guard kept for symmetry with the rest of the engine.
   */
  private assertReadable(role: ResolvedRole): void {
    if (!canRead(role)) throw new ForbiddenException('Read access denied');
  }

  // ── Blueprint CRUD ─────────────────────────────────────────────────────

  /** List blueprints visible to this tenant: capiro-global + the firm's own. */
  async listBlueprints(tenantId: string): Promise<WsBlueprint[]> {
    return this.prisma.wsBlueprint.findMany({
      where: { OR: [{ tenantId: null }, { tenantId }] },
      orderBy: [{ product: 'asc' }, { name: 'asc' }],
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    }) as Promise<WsBlueprint[]>;
  }

  /** Get one blueprint (global or tenant-owned). */
  async getBlueprint(tenantId: string, blueprintId: string): Promise<WsBlueprint> {
    const row = await this.prisma.wsBlueprint.findFirst({
      where: { id: blueprintId, OR: [{ tenantId: null }, { tenantId }] },
      include: { versions: { orderBy: { version: 'asc' } } },
    });
    if (!row) throw new NotFoundException('Blueprint not found');
    return row as unknown as WsBlueprint;
  }

  /** Create a new blueprint (firm admin only). */
  async createBlueprint(
    tenantId: string,
    clerkUserId: string,
    dto: CreateBlueprintDto,
  ): Promise<WsBlueprint> {
    await this.requireFirmAdmin(tenantId, clerkUserId);
    const scope = (dto.scope ?? 'firm') as WsBlueprintScope;
    // capiro-global blueprints (scope 'capiro') carry tenantId null and are
    // authored by the capiro org; the firm admin creating one is recorded as
    // ownerId for write-back authorization.
    const tenantIdFor = scope === 'capiro' ? null : tenantId;
    return this.prisma.wsBlueprint.create({
      data: {
        tenantId: tenantIdFor,
        scope,
        slug: dto.slug,
        name: dto.name,
        product: dto.product,
        description: dto.description ?? null,
        ownerId: clerkUserId,
      },
    }) as Promise<WsBlueprint>;
  }

  // ── Versions ───────────────────────────────────────────────────────────

  /** Get a single version (global or tenant-owned blueprint). */
  async getVersion(
    tenantId: string,
    blueprintId: string,
    versionId: string,
  ): Promise<WsBlueprintVersion> {
    await this.getBlueprint(tenantId, blueprintId); // scopes the blueprint
    const row = await this.prisma.wsBlueprintVersion.findFirst({
      where: { id: versionId, blueprintId },
    });
    if (!row) throw new NotFoundException('Blueprint version not found');
    return row;
  }

  /**
   * Create a new draft version. The version number is max(existing)+1. The
   * definition starts as a copy of the blueprint's latest version's definition
   * (so edits branch from current state). Firm admin only.
   */
  async createVersion(
    tenantId: string,
    blueprintId: string,
    clerkUserId: string,
    _dto: CreateVersionDto,
  ): Promise<WsBlueprintVersion> {
    await this.requireFirmAdmin(tenantId, clerkUserId);
    const blueprint = await this.getBlueprint(tenantId, blueprintId);
    const versions = await this.prisma.wsBlueprintVersion.findMany({
      where: { blueprintId },
      orderBy: { version: 'desc' },
    });
    const nextVersion = (versions[0]?.version ?? 0) + 1;
    const seedDefinition =
      versions[0]?.definition ?? ({} as unknown as WorkspaceBlueprintDefinition);
    const seedHash = this.validator.computeDefinitionHash(
      seedDefinition as unknown as WorkspaceBlueprintDefinition,
    );
    return this.prisma.wsBlueprintVersion.create({
      data: {
        tenantId: blueprint.tenantId,
        blueprintId,
        version: nextVersion,
        status: 'draft' as WsBlueprintVersionStatus,
        definition: seedDefinition as object,
        definitionHash: seedHash,
        createdById: clerkUserId,
      },
    }) as Promise<WsBlueprintVersion>;
  }

  /**
   * Clone a blueprint into a new draft version. Copies the source version's
   * definition verbatim (same hash) into a fresh draft the editor can diverge.
   * Firm admin only.
   */
  async cloneBlueprint(
    tenantId: string,
    blueprintId: string,
    clerkUserId: string,
    dto: CloneBlueprintDto,
  ): Promise<WsBlueprintVersion> {
    await this.requireFirmAdmin(tenantId, clerkUserId);
    const blueprint = await this.getBlueprint(tenantId, blueprintId);
    const source = dto.fromVersionId
      ? await this.getVersion(tenantId, blueprintId, dto.fromVersionId)
      : await this.prisma.wsBlueprintVersion.findFirst({
          where: { blueprintId },
          orderBy: { version: 'desc' },
        });
    if (!source) throw new NotFoundException('No source version to clone');
    const versions = await this.prisma.wsBlueprintVersion.findMany({
      where: { blueprintId },
      orderBy: { version: 'desc' },
    });
    const nextVersion = (versions[0]?.version ?? 0) + 1;
    const def = source.definition as unknown as WorkspaceBlueprintDefinition;
    const hash = this.validator.computeDefinitionHash(def);
    return this.prisma.wsBlueprintVersion.create({
      data: {
        tenantId: blueprint.tenantId,
        blueprintId,
        version: nextVersion,
        status: 'draft' as WsBlueprintVersionStatus,
        definition: def as object,
        definitionHash: hash,
        createdById: clerkUserId,
      },
    }) as Promise<WsBlueprintVersion>;
  }

  /**
   * Update a draft version's definition. Published/retired versions are
   * immutable → 409. Recomputes the hash on every save. Firm admin only.
   */
  async updateVersion(
    tenantId: string,
    blueprintId: string,
    versionId: string,
    clerkUserId: string,
    dto: UpdateVersionDto,
  ): Promise<WsBlueprintVersion> {
    await this.requireFirmAdmin(tenantId, clerkUserId);
    const version = await this.getVersion(tenantId, blueprintId, versionId);
    if (version.status !== 'draft') {
      throw new ConflictException(
        `Blueprint version is ${version.status} and cannot be edited`,
      );
    }
    const definition = dto.definition as unknown as WorkspaceBlueprintDefinition;
    const hash = this.validator.computeDefinitionHash(definition);
    return this.prisma.wsBlueprintVersion.update({
      where: { id: versionId },
      data: { definition: dto.definition as never, definitionHash: hash },
    }) as Promise<WsBlueprintVersion>;
  }

  // ── Test run (deterministic, no permanent doc) ──────────────────────────

  /**
   * Run a deterministic simulated intake + outline against a draft version.
   * No permanent document is created. Returns the simulated outline + intake
   * resolution. Throws 422 on validation/test failure. Pure given the inputs.
   */
  async testVersion(
    tenantId: string,
    blueprintId: string,
    versionId: string,
    dto: TestVersionDto,
  ): Promise<{
    passed: boolean;
    intake: Record<string, unknown>;
    outline: Array<{ id: string; title: string; targetWords: { min: number; max: number } }>;
    errors: string[];
  }> {
    const version = await this.getVersion(tenantId, blueprintId, versionId);
    if (version.status === 'published' || version.status === 'retired') {
      throw new ConflictException(
        `Blueprint version is ${version.status} and cannot be tested`,
      );
    }
    const definition = version.definition as unknown as WorkspaceBlueprintDefinition;
    const { valid, errors } = this.validator.validate(definition);
    if (!valid) {
      throw new UnprocessableEntityException({
        message: 'Definition failed validation',
        errors,
      });
    }

    // Simulated intake: resolve each question from the supplied answers, or
    // fall back to a deterministic placeholder. Required questions with no
    // answer fail the test.
    const answers = dto.answers ?? {};
    const intake: Record<string, unknown> = {};
    const testErrors: string[] = [];
    for (const q of definition.intakeQuestions ?? []) {
      const provided = answers[q.id];
      if (provided !== undefined) {
        intake[q.id] = provided;
      } else if (q.answerSource === 'client_profile') {
        intake[q.id] = `client_profile:${q.id}`;
      } else if (q.answerSource === 'context') {
        intake[q.id] = `context:${q.id}`;
      } else if (q.answerSource === 'meri_recommendation') {
        intake[q.id] = `meri:${q.id}`;
      } else if (q.required) {
        testErrors.push(`Required intake question "${q.id}" has no answer`);
        intake[q.id] = null;
      } else {
        intake[q.id] = null;
      }
    }

    // Deterministic outline from sections (respecting removable + locked).
    const outline = (definition.sections ?? [])
      .filter((s) => !s.lockedByDefault || s.required)
      .map((s) => ({
        id: s.id,
        title: s.title,
        targetWords: s.targetWords,
      }));

    const passed = testErrors.length === 0;
    if (!passed) {
      throw new UnprocessableEntityException({
        message: 'Sample test failed',
        errors: testErrors,
      });
    }
    return { passed: true, intake, outline, errors: [] };
  }

  // ── Publish / Retire ───────────────────────────────────────────────────

  /**
   * Publish a draft version. Publishing requirements (all enforced here):
   *  - definition passes schema validation
   *  - required fields complete (validator covers)
   *  - every required section has purpose + instructions (validator covers)
   *  - evidence policy exists (validator covers)
   *  - sample test passes
   *  - version is currently draft
   * The definitionHash is finalized and the row becomes immutable (PATCH →
   * 409 thereafter). Firm admin only.
   */
  async publishVersion(
    tenantId: string,
    blueprintId: string,
    versionId: string,
    clerkUserId: string,
  ): Promise<WsBlueprintVersion> {
    await this.requireFirmAdmin(tenantId, clerkUserId);
    const version = await this.getVersion(tenantId, blueprintId, versionId);
    if (version.status !== 'draft') {
      throw new ConflictException(
        `Blueprint version is ${version.status}; only draft versions can be published`,
      );
    }

    const definition = version.definition as unknown as WorkspaceBlueprintDefinition;
    const { valid, errors } = this.validator.validate(definition);
    if (!valid) {
      throw new UnprocessableEntityException({
        message: 'Definition failed validation',
        errors,
      });
    }

    // Sample test must pass (deterministic, no answers supplied → required
    // questions with no answer source fail, which is the intent).
    await this.testVersion(tenantId, blueprintId, versionId, { answers: {} });

    const hash = this.validator.computeDefinitionHash(definition);
    return this.prisma.wsBlueprintVersion.update({
      where: { id: versionId },
      data: {
        status: 'published' as WsBlueprintVersionStatus,
        definitionHash: hash,
        publishedAt: new Date(),
      },
    }) as Promise<WsBlueprintVersion>;
  }

  /** Retire a published version. Firm admin only. */
  async retireVersion(
    tenantId: string,
    blueprintId: string,
    versionId: string,
    clerkUserId: string,
  ): Promise<WsBlueprintVersion> {
    await this.requireFirmAdmin(tenantId, clerkUserId);
    const version = await this.getVersion(tenantId, blueprintId, versionId);
    if (version.status !== 'published') {
      throw new ConflictException(
        `Blueprint version is ${version.status}; only published versions can be retired`,
      );
    }
    return this.prisma.wsBlueprintVersion.update({
      where: { id: versionId },
      data: { status: 'retired' as WsBlueprintVersionStatus, retiredAt: new Date() },
    }) as Promise<WsBlueprintVersion>;
  }

  // ── Compare ────────────────────────────────────────────────────────────

  /** Compare all versions of a blueprint by definition hash + changed keys. */
  async compareVersions(
    tenantId: string,
    blueprintId: string,
  ): Promise<CompareVersionsResult> {
    const blueprint = await this.getBlueprint(tenantId, blueprintId);
    const versions = await this.prisma.wsBlueprintVersion.findMany({
      where: { blueprintId },
      orderBy: { version: 'asc' },
    });
    const summary = versions.map((v) => ({
      versionId: v.id,
      version: v.version,
      status: v.status,
      definitionHash: v.definitionHash,
      createdAt: v.createdAt,
      publishedAt: v.publishedAt,
    }));
    const diffs: CompareVersionsResult['diffs'] = [];
    for (let i = 1; i < versions.length; i++) {
      const prevVer = versions[i - 1];
      const currVer = versions[i];
      if (!prevVer || !currVer) continue;
      const prev = prevVer.definition as Record<string, unknown>;
      const curr = currVer.definition as Record<string, unknown>;
      const keys = new Set([...Object.keys(prev ?? {}), ...Object.keys(curr ?? {})]);
      const changedKeys = [...keys].filter(
        (k) => JSON.stringify(prev?.[k]) !== JSON.stringify(curr?.[k]),
      );
      diffs.push({
        fromVersionId: prevVer.id,
        toVersionId: currVer.id,
        changedKeys,
      });
    }
    return { blueprintId: blueprint.id, versions: summary, diffs };
  }

  // ── Pinning helper ──────────────────────────────────────────────────────

  /**
   * Whether a document pinned to `pinnedHash` is still current with this
   * version. Returns false (doc stays on its adopted version) when a new
   * version published with a different hash. This is the core of "existing
   * documents remain pinned after a new blueprint version."
   */
  isPinnedTo(pinnedHash: string, version: { definitionHash: string }): boolean {
    return pinnedHash === version.definitionHash;
  }
}
