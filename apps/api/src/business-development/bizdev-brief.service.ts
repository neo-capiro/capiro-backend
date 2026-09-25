import { Prisma } from '@prisma/client';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { BizDevDossierService } from './bizdev-dossier.service.js';
import type { EvidenceItem } from './bizdev-evidence.types.js';
import {
  BRIEF_CITATION_CAP,
  BRIEF_MAX_VERSIONS,
  BRIEF_TITLE_MAX,
  type BriefCitation,
  type BriefClaimCheck,
  type BriefRefreshProposal,
  type BriefSectionKey,
  type BriefSections,
  type BriefSourceSnapshot,
  type BriefSummary,
  type BriefVersionConflict,
  type BriefVersionDetail,
  type BriefVersionSummary,
} from './bizdev-brief.types.js';
import {
  buildSourceSnapshot,
  citationsFromEvidence,
  checkClaimDeterministic,
  citationIdentity,
  diffSections,
  generateSections,
  hashSections,
  hashSnapshot,
  preserveUserEdits,
  sha256Hex,
  validateCitations,
  validateSections,
} from './bizdev-brief.util.js';

/**
 * Business Development Phase 4 — prospect brief service.
 *
 * Invariants:
 * 1.  One brief root per (tenant, prospect). The DB composite unique is the
 *     backstop; the service reuses the root (restore semantics), never a
 *     second row. Cross-tenant prospect ids 404 exactly like Phase 1.
 * 2.  Versions are immutable and append-only: the app never updates or
 *     deletes a version row (the DB grants capiro_app SELECT+INSERT only).
 *     `currentVersionId` on the root is the unambiguous version pointer for
 *     optimistic concurrency.
 * 3.  ALL writes are idempotent: (tenant, brief, idempotencyKey) unique. A
 *     retry/double-click returns the same logical saved version (P2002 →
 *     fetch the existing row). Version numbering is computed under a brief
 *     row lock (FOR UPDATE) so concurrent saves serialize deterministically.
 * 4.  Editing is version checked: a save with a stale expectedVersionNumber
 *     throws a typed ConflictException carrying the latest saved version.
 *     A refresh BUILDS A PROPOSAL/DIFF ONLY — it never writes; accepting is
 *     an explicit second call that is itself version-checked.
 * 5.  The dossier (Phase 2) is the only external factual source. Citation
 *     identities are validated against the authorized current dossier or the
 *     version's saved snapshot; payload/section/citation sizes are bounded.
 * 6.  BD-CLAIM Jev semantic validation stays DARK: claim checks are the
 *     deterministic checker in bizdev-brief.util.ts only. No LLM is called,
 *     no external communication is ever sent from this service.
 * 7.  Tenant-scoped reads/writes go through prisma.withTenant with explicit
 *     tenant predicates (RLS is defense in depth), same rule as Phases 1–3.
 */

/** Rows this service is allowed to select from brief tables. */
const briefSelect = {
  id: true,
  tenantId: true,
  prospectId: true,
  title: true,
  status: true,
  currentVersionId: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BusinessDevelopmentBriefSelect;

const versionSummarySelect = {
  id: true,
  versionNumber: true,
  sectionsHash: true,
  citations: true,
  createdByUserId: true,
  createdAt: true,
} satisfies Prisma.BusinessDevelopmentBriefVersionSelect;

const versionDetailSelect = {
  id: true,
  versionNumber: true,
  sections: true,
  sectionsHash: true,
  sourceSnapshot: true,
  snapshotHash: true,
  citations: true,
  idempotencyKey: true,
  idempotencyOp: true,
  idempotencyFingerprint: true,
  createdByUserId: true,
  createdAt: true,
} satisfies Prisma.BusinessDevelopmentBriefVersionSelect;

@Injectable()
export class BizDevBriefService {
  private readonly logger = new Logger(BizDevBriefService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dossier: BizDevDossierService,
  ) {}

  // ── helpers ──────────────────────────────────────────────────────────────

  private toSummary(row: {
    id: string;
    tenantId: string;
    prospectId: string;
    title: string;
    status: string;
    currentVersionId: string | null;
    createdByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): BriefSummary {
    return {
      id: row.id,
      tenantId: row.tenantId,
      prospectId: row.prospectId,
      title: row.title,
      status: row.status === 'archived' ? 'archived' : 'draft',
      currentVersionId: row.currentVersionId,
      currentVersionNumber: null, // filled by callers that join the version
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      createdByUserId: row.createdByUserId,
    };
  }

  private toVersionSummary(row: {
    id: string;
    versionNumber: number;
    sectionsHash: string;
    citations: unknown;
    createdByUserId: string | null;
    createdAt: Date;
  }): BriefVersionSummary {
    return {
      id: row.id,
      versionNumber: row.versionNumber,
      sectionsHash: row.sectionsHash,
      citationCount: Array.isArray(row.citations) ? row.citations.length : 0,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toVersionDetail(row: {
    id: string;
    versionNumber: number;
    sections: unknown;
    sectionsHash: string;
    sourceSnapshot: unknown;
    snapshotHash: string;
    citations: unknown;
    idempotencyKey?: string;
    idempotencyOp?: string;
    idempotencyFingerprint?: string;
    createdByUserId: string | null;
    createdAt: Date;
  }): BriefVersionDetail {
    return {
      id: row.id,
      versionNumber: row.versionNumber,
      sectionsHash: row.sectionsHash,
      citationCount: Array.isArray(row.citations) ? row.citations.length : 0,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt.toISOString(),
      sections: row.sections as BriefSections,
      citations: (Array.isArray(row.citations) ? row.citations : []) as BriefCitation[],
      sourceSnapshot: row.sourceSnapshot as BriefSourceSnapshot,
      snapshotHash: row.snapshotHash,
    };
  }

  /** Typed optimistic-concurrency conflict carrying the latest saved version. */
  private versionConflict(
    briefId: string,
    expected: number,
    latest: BriefVersionSummary,
  ): ConflictException {
    const conflict: BriefVersionConflict = {
      code: 'BIZDEV_BRIEF_VERSION_CONFLICT',
      message:
        'This brief was updated by someone else since you loaded it. The latest saved version is included; review the changes and save again on top of it.',
      briefId,
      expectedVersionNumber: expected,
      latestVersion: latest,
    };
    return new ConflictException(conflict);
  }

  /** Resolve the same-tenant prospect or throw the safe 404. */
  private async requireProspect(ctx: TenantContext, prospectId: string) {
    const prospect = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.businessDevelopmentProspect.findFirst({
        where: { tenantId: ctx.tenantId, id: prospectId },
        select: {
          id: true,
          tenantId: true,
          displayName: true,
          canonicalEntityId: true,
          status: true,
        },
      }),
    );
    if (!prospect) throw new NotFoundException('Prospect not found');
    return prospect;
  }

  /**
   * Build the authorized evidence set for a prospect from the CURRENT
   * dossier: the dossier is the only external factual source. Fail-soft on
   * section errors is inherent — the dossier returns honest section states.
   */
  private async authorizedEvidenceFor(
    ctx: TenantContext,
    prospect: {
      id: string;
      displayName: string;
      canonicalEntityId: string | null;
    },
  ): Promise<{
    evidence: EvidenceItem[];
    identityName: string | null;
    identityBasis: string;
    canonicalEntityId: string | null;
    canonicalName: string | null;
  }> {
    const dossier = await this.dossier.prospectDossier(
      ctx,
      prospect.id,
      undefined,
      /* suppressJev */ true,
    );
    const evidence: EvidenceItem[] = [];
    for (const section of Object.values(dossier.sections)) {
      if (section?.evidence) evidence.push(...section.evidence);
    }
    return {
      evidence,
      identityName: dossier.canonicalName ?? prospect.displayName,
      identityBasis: dossier.identityBasis,
      canonicalEntityId: dossier.canonicalEntityId,
      canonicalName: dossier.canonicalName,
    };
  }

  /** Deterministic title for a generated brief (bounded). */
  private generatedTitle(prospectName: string): string {
    return `Prospect brief — ${prospectName}`.slice(0, BRIEF_TITLE_MAX);
  }

  // ── 1. get current brief for a prospect ────────────────────────────────────

  async getCurrentBrief(ctx: TenantContext, prospectId: string): Promise<{
    brief: BriefSummary | null;
    currentVersion: BriefVersionDetail | null;
  }> {
    await this.requireProspect(ctx, prospectId);
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.businessDevelopmentBrief.findFirst({
        where: { tenantId: ctx.tenantId, prospectId },
        select: {
          ...briefSelect,
          currentVersion: { select: versionDetailSelect },
        },
      }),
    );
    if (!row) return { brief: null, currentVersion: null };
    const summary = this.toSummary(row);
    const detail = row.currentVersion
      ? this.toVersionDetail(row.currentVersion)
      : null;
    return {
      brief: { ...summary, currentVersionNumber: detail?.versionNumber ?? null },
      currentVersion: detail,
    };
  }

  // ── 2. create/generate an initial saved version (idempotent) ───────────────

  async createInitialVersion(
    ctx: TenantContext,
    prospectId: string,
    input: { idempotencyKey: string; title?: string },
  ): Promise<{
    brief: BriefSummary;
    version: BriefVersionDetail;
    created: boolean;
  }> {
    const prospect = await this.requireProspect(ctx, prospectId);

    // Idempotency FIRST: an existing (tenant, key) pair returns the one
    // logical result without regenerating anything — but ONLY when the
    // attempted operation and content fingerprint match; otherwise the key
    // is being reused for different content and must conflict explicitly.
    // Fingerprint the attempt BEFORE any lookup: a retry with identical
    // content replays; the same key with different content is an explicit
    // conflict (never silent reuse).
    const fingerprint = this.createFingerprint(input.title);
    const existing = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.businessDevelopmentBriefVersion.findFirst({
        where: {
          tenantId: ctx.tenantId,
          idempotencyKey: input.idempotencyKey,
          brief: { prospectId },
        },
        select: {
          ...versionDetailSelect,
          idempotencyOp: true,
          idempotencyFingerprint: true,
          brief: { select: { ...briefSelect } },
        },
      }),
    );
    if (existing) {
      const conflict = this.idempotencyReplayConflict(
        input.idempotencyKey,
        { op: 'create', fingerprint },
        {
          idempotencyOp: existing.idempotencyOp,
          idempotencyFingerprint: existing.idempotencyFingerprint,
        },
      );
      if (conflict) throw conflict;
      return {
        brief: this.toSummary(existing.brief),
        version: this.toVersionDetail(existing),
        created: false,
      };
    }

    // Build from the authorized current dossier.
    const auth = await this.authorizedEvidenceFor(ctx, prospect);
    const sections = generateSections({
      identityName: auth.identityName,
      identityBasis: auth.identityBasis,
      evidence: auth.evidence,
    });
    const citations = citationsFromEvidence(auth.evidence);
    const generatedAt = new Date().toISOString();
    const snapshot = buildSourceSnapshot(
      generatedAt,
      {
        canonicalEntityId: auth.canonicalEntityId,
        canonicalName: auth.canonicalName,
        identityBasis: auth.identityBasis,
      },
      auth.evidence,
    );

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // Serialize per (tenant, brief) with the brief row lock. For the first
      // version there may be no row yet; the prospect-level advisory lock
      // (same key space as Phase 1's tenant+canonical lock, keyed on the
      // prospect id) serializes creates for the same prospect.
      await tx.$queryRaw`SELECT "id" FROM "business_development_prospects"
        WHERE "id" = ${prospect.id}::uuid AND "tenant_id" = ${ctx.tenantId}::uuid
        FOR UPDATE`;

      const title = (input.title?.trim() || this.generatedTitle(prospect.displayName)).slice(
        0,
        BRIEF_TITLE_MAX,
      );

      // Reuse-or-create the root: exactly one brief per (tenant, prospect).
      let root = await tx.businessDevelopmentBrief.findFirst({
        where: { tenantId: ctx.tenantId, prospectId: prospect.id },
        select: briefSelect,
      });
      if (root && root.status === 'archived') {
        // Restore an archived root — never a second row (DB composite unique
        // is the backstop).
        root = await tx.businessDevelopmentBrief.update({
          where: { id: root.id },
          data: { status: 'draft', title },
          select: briefSelect,
        });
      }
      if (!root) {
        root = await tx.businessDevelopmentBrief.create({
          data: {
            tenantId: ctx.tenantId,
            prospectId: prospect.id,
            title,
            createdByUserId: ctx.userId,
          },
          select: briefSelect,
        });
      } else if (root.currentVersionId) {
        throw new ConflictException({
          code: 'BIZDEV_BRIEF_ALREADY_EXISTS',
          message: 'This prospect already has a brief. Open the current brief or save a new version.',
          briefId: root.id,
          currentVersionId: root.currentVersionId,
        });
      }

      // A retry racing past the early idempotency read still lands on the
      // unique index; treat P2002 as the same logical result.
      try {
        const versionNumber = 1;
        const created = await tx.businessDevelopmentBriefVersion.create({
          data: {
            tenantId: ctx.tenantId,
            briefId: root.id,
            versionNumber,
            sections: sections as unknown as Prisma.InputJsonValue,
            sectionsHash: hashSections(sections),
            sourceSnapshot: snapshot as unknown as Prisma.InputJsonValue,
            snapshotHash: hashSnapshot(snapshot),
            citations: citations as unknown as Prisma.InputJsonValue,
            idempotencyKey: input.idempotencyKey,
            idempotencyOp: 'create',
            idempotencyFingerprint: fingerprint,
            createdByUserId: ctx.userId,
          },
          select: versionDetailSelect,
        });
        await tx.businessDevelopmentBrief.update({
          where: { id: root.id },
          data: { currentVersionId: created.id, updatedAt: new Date() },
          select: briefSelect,
        });
        return {
          brief: this.toSummary({
            ...root,
            currentVersionId: created.id,
          }),
          version: this.toVersionDetail(created),
          created: true,
        };
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          const raced = await tx.businessDevelopmentBriefVersion.findFirst({
            where: {
              tenantId: ctx.tenantId,
              briefId: root.id,
              idempotencyKey: input.idempotencyKey,
            },
            select: { ...versionDetailSelect, brief: { select: briefSelect } },
          });
          if (raced) {
            // Same key + same create content = the one logical replay;
            // anything else (including a same-key different-title create, or
            // the (brief,version_number) unique firing on a brief that
            // already has version 1) is an explicit conflict — never a
            // fabricated replay and never a silent overwrite.
            const conflict = this.idempotencyReplayConflict(
              input.idempotencyKey,
              { op: 'create', fingerprint },
              {
                idempotencyOp: raced.idempotencyOp ?? '',
                idempotencyFingerprint: raced.idempotencyFingerprint ?? '',
              },
            );
            if (conflict) throw conflict;
            return {
              brief: this.toSummary(raced.brief),
              version: this.toVersionDetail(raced),
              created: false,
            };
          }
        }
        throw error;
      }
    });
  }

  // ── 3. save an edited version (expected version + idempotency) ─────────────

  async saveEditedVersion(
    ctx: TenantContext,
    prospectId: string,
    input: {
      idempotencyKey: string;
      expectedVersionNumber: number;
      sections: unknown;
      title?: string;
    },
  ): Promise<{ brief: BriefSummary; version: BriefVersionDetail; created: boolean }> {
    const prospect = await this.requireProspect(ctx, prospectId);

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // Lock the prospect row so brief operations for the same prospect
      // serialize (creates and saves share this lock).
      await tx.$queryRaw`SELECT "id" FROM "business_development_prospects"
        WHERE "id" = ${prospect.id}::uuid AND "tenant_id" = ${ctx.tenantId}::uuid
        FOR UPDATE`;

      const root = await tx.businessDevelopmentBrief.findFirst({
        where: { tenantId: ctx.tenantId, prospectId: prospect.id },
        select: { ...briefSelect, currentVersion: { select: versionSummarySelect } },
      });
      if (!root) {
        throw new NotFoundException('Brief not found');
      }

      // Idempotency: the same key already saved is the same logical result
      // ONLY for the same operation and content fingerprint; anything else
      // is an explicit conflict (no silent reuse).
      const already = await tx.businessDevelopmentBriefVersion.findFirst({
        where: {
          tenantId: ctx.tenantId,
          briefId: root.id,
          idempotencyKey: input.idempotencyKey,
        },
        select: versionDetailSelect,
      });
      if (already) {
        const conflict = this.idempotencyReplayConflict(
          input.idempotencyKey,
          {
            op: 'edit',
            fingerprint: this.editFingerprint(input.sections, input.title),
          },
          {
            idempotencyOp: already.idempotencyOp ?? '',
            idempotencyFingerprint: already.idempotencyFingerprint ?? '',
          },
        );
        if (conflict) throw conflict;
        return {
          brief: this.toSummary(root),
          version: this.toVersionDetail(already),
          created: false,
        };
      }

      if (!root.currentVersion) {
        throw new BadRequestException(
          'This brief has no saved version yet; create the initial version first.',
        );
      }

      // Version check — a stale expectation is a typed conflict carrying the
      // latest saved version, never a silent overwrite.
      if (root.currentVersion.versionNumber !== input.expectedVersionNumber) {
        throw this.versionConflict(
          root.id,
          input.expectedVersionNumber,
          this.toVersionSummary(root.currentVersion),
        );
      }

      // Authorization basis: the saved snapshot of the version being built on.
      // Citations are validated against it AND the current dossier; the
      // stricter set is what the user may cite.
      const basis = await tx.businessDevelopmentBriefVersion.findUnique({
        where: { briefId_versionNumber: { briefId: root.id, versionNumber: input.expectedVersionNumber } },
        select: versionDetailSelect,
      });
      if (!basis) throw new NotFoundException('Base version not found');

      // Citation identities are server-owned. An edit may change section text,
      // provenance, and which existing citation indexes it references, but it
      // cannot submit or replace citation records. This makes fabricated source
      // ids and dates unpersistable through the edit API.
      const submittedCitations = (Array.isArray(basis.citations)
        ? basis.citations
        : []) as unknown as BriefCitation[];
      const authorized = this.unionAuthorized(
        submittedCitations,
        (basis.sourceSnapshot as unknown as BriefSourceSnapshot)?.evidence ?? [],
      );

      const citationIssues = validateCitations(submittedCitations, authorized);
      if (citationIssues.length > 0) {
        throw new BadRequestException({
          code: 'BIZDEV_BRIEF_CITATION_REJECTED',
          message:
            'Some citations could not be matched to the authorized dossier evidence for this brief.',
          issues: citationIssues,
        });
      }

      const sectionIssues = validateSections(input.sections, submittedCitations.length);
      if (sectionIssues.length > 0) {
        throw new BadRequestException({
          code: 'BIZDEV_BRIEF_SECTIONS_INVALID',
          message: 'The submitted brief sections do not match the brief contract.',
          issues: sectionIssues,
        });
      }

      const sections = input.sections as BriefSections;
      const versionNumber = root.currentVersion.versionNumber + 1;
      if (versionNumber > BRIEF_MAX_VERSIONS) {
        throw new BadRequestException(
          `This brief has reached its version limit (${BRIEF_MAX_VERSIONS}).`,
        );
      }

      // The saved snapshot is preserved unchanged for the base version; the
      // new version inherits it (edits rest on the same evidence) — old
      // snapshots are never rewritten.
      const snapshot = basis.sourceSnapshot as unknown as BriefSourceSnapshot;

      try {
        const created = await tx.businessDevelopmentBriefVersion.create({
          data: {
            tenantId: ctx.tenantId,
            briefId: root.id,
            versionNumber,
            sections: sections as unknown as Prisma.InputJsonValue,
            sectionsHash: hashSections(sections),
            sourceSnapshot: snapshot as unknown as Prisma.InputJsonValue,
            snapshotHash: basis.snapshotHash,
            citations: submittedCitations as unknown as Prisma.InputJsonValue,
            idempotencyKey: input.idempotencyKey,
            idempotencyOp: 'edit',
            idempotencyFingerprint: this.editFingerprint(input.sections, input.title),
            createdByUserId: ctx.userId,
          },
          select: versionDetailSelect,
        });
        const title =
          input.title?.trim().slice(0, BRIEF_TITLE_MAX) ?? root.title;
        const updatedRoot = await tx.businessDevelopmentBrief.update({
          where: { id: root.id },
          data: { currentVersionId: created.id, title, updatedAt: new Date() },
          select: briefSelect,
        });
        return {
          brief: this.toSummary({ ...updatedRoot, currentVersionId: created.id }),
          version: this.toVersionDetail(created),
          created: true,
        };
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          const raced = await tx.businessDevelopmentBriefVersion.findFirst({
            where: {
              tenantId: ctx.tenantId,
              briefId: root.id,
              idempotencyKey: input.idempotencyKey,
            },
            select: versionDetailSelect,
          });
          if (raced) {
            return {
              brief: this.toSummary(root),
              version: this.toVersionDetail(raced),
              created: false,
            };
          }
        }
        throw error;
      }
    });
  }

  /** Authorized citations = saved citations ∪ citations derivable from the
   * saved snapshot's evidence. The union keeps refresh-accepted versions able
   * to re-cite anything the dossier originally authorized. */
  private unionAuthorized(savedCitations: BriefCitation[], evidence: EvidenceItem[]): BriefCitation[] {
    const fromEvidence = citationsFromEvidence(evidence);
    const seen = new Set<string>();
    const out: BriefCitation[] = [];
    for (const c of [...savedCitations, ...fromEvidence]) {
      const id = citationIdentity(c);
      const key = `${id.sourceFamily}::${id.recordId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out.slice(0, BRIEF_CITATION_CAP * 2);
  }

  /**
   * Idempotency discriminator: a saved (tenant, brief, key) row is only the
   * same logical result when the operation AND its content fingerprint
   * match. Anything else is an explicit ConflictException — a key is never
   * silently reused for different content or a different operation.
   */
  private idempotencyMismatch(
    rawKey: string,
    savedOp: string,
    attemptedOp: string,
  ): ConflictException {
    return new ConflictException({
      code: 'BIZDEV_BRIEF_IDEMPOTENCY_MISMATCH',
      message:
        'This idempotency key was already used for a different brief save. Use a new key for the new save.',
      idempotencyKey: rawKey,
      savedOperation: savedOp,
      attemptedOperation: attemptedOp,
    });
  }

  /**
   * Returns the saved-row conflict when the attempt does not match the
   * saved operation/fingerprint, or null when it is a genuine replay.
   */
  private idempotencyReplayConflict(
    rawKey: string,
    attempted: { op: 'create' | 'edit' | 'accept'; fingerprint: string },
    saved: { idempotencyOp: string; idempotencyFingerprint: string },
  ): ConflictException | null {
    if (
      saved.idempotencyOp !== attempted.op ||
      saved.idempotencyFingerprint !== attempted.fingerprint
    ) {
      return this.idempotencyMismatch(rawKey, saved.idempotencyOp, attempted.op);
    }
    return null;
  }

  /** Content fingerprint for a create attempt (client controls only title). */
  private createFingerprint(title: string | undefined): string {
    return sha256Hex({ op: 'create', title: title?.trim() || null });
  }

  /** Content fingerprint for an edit attempt (sections + title). */
  private editFingerprint(sections: unknown, title: string | undefined): string {
    return sha256Hex({ op: 'edit', sections, title: title?.trim() || null });
  }

  /** Content fingerprint for a refresh-accept attempt. */
  private acceptFingerprint(keepUserEdits: boolean | undefined): string {
    return sha256Hex({ op: 'accept', keepUserEdits: keepUserEdits ?? true });
  }

  // ── 4. build a refresh proposal/diff (no writes) ───────────────────────────

  async buildRefreshProposal(
    ctx: TenantContext,
    prospectId: string,
  ): Promise<BriefRefreshProposal> {
    const prospect = await this.requireProspect(ctx, prospectId);
    const current = await this.currentVersionRowFor(ctx, prospect.id);
    if (!current?.currentVersion) {
      throw new NotFoundException('Brief not found');
    }
    const base = this.toVersionDetail(current.currentVersion);

    const auth = await this.authorizedEvidenceFor(ctx, prospect);
    const fresh = generateSections({
      identityName: auth.identityName,
      identityBasis: auth.identityBasis,
      evidence: auth.evidence,
    });

    // NEVER overwrite user edits: sections the user edited keep their text in
    // the proposal; the diff shows what the fresh generation would say.
    const proposed = preserveUserEdits(base.sections, fresh);
    const snapshot = buildSourceSnapshot(
      new Date().toISOString(),
      {
        canonicalEntityId: auth.canonicalEntityId,
        canonicalName: auth.canonicalName,
        identityBasis: auth.identityBasis,
      },
      auth.evidence,
    );

    return {
      baseVersionNumber: base.versionNumber,
      proposed,
      diff: diffSections(base.sections, fresh),
      sourceSnapshot: snapshot,
      snapshotHash: hashSnapshot(snapshot),
    };
  }

  /** Current version detail for a prospect's brief (tenant-scoped). */
  private async currentVersionRowFor(ctx: TenantContext, prospectId: string) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.businessDevelopmentBrief.findFirst({
        where: { tenantId: ctx.tenantId, prospectId },
        select: {
          id: true,
          currentVersionId: true,
          currentVersion: { select: versionDetailSelect },
        },
      }),
    );
  }

  // ── 5. explicitly accept/save a refresh proposal as a new version ─────────

  async acceptRefreshProposal(
    ctx: TenantContext,
    prospectId: string,
    input: {
      idempotencyKey: string;
      expectedVersionNumber: number;
      keepUserEdits?: boolean;
    },
  ): Promise<{ brief: BriefSummary; version: BriefVersionDetail; created: boolean }> {
    const prospect = await this.requireProspect(ctx, prospectId);
    const proposal = await this.buildRefreshProposalInternal(ctx, prospect);

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "business_development_prospects"
        WHERE "id" = ${prospect.id}::uuid AND "tenant_id" = ${ctx.tenantId}::uuid
        FOR UPDATE`;

      const root = await tx.businessDevelopmentBrief.findFirst({
        where: { tenantId: ctx.tenantId, prospectId: prospect.id },
        select: { ...briefSelect, currentVersion: { select: versionSummarySelect } },
      });
      if (!root || !root.currentVersion) {
        throw new NotFoundException('Brief not found');
      }

      // Idempotency: same key + same accept content replays; different
      // operation or content is an explicit conflict.
      const already = await tx.businessDevelopmentBriefVersion.findFirst({
        where: {
          tenantId: ctx.tenantId,
          briefId: root.id,
          idempotencyKey: input.idempotencyKey,
        },
        select: versionDetailSelect,
      });
      if (already) {
        const conflict = this.idempotencyReplayConflict(
          input.idempotencyKey,
          { op: 'accept', fingerprint: this.acceptFingerprint(input.keepUserEdits) },
          {
            idempotencyOp: already.idempotencyOp ?? '',
            idempotencyFingerprint: already.idempotencyFingerprint ?? '',
          },
        );
        if (conflict) throw conflict;
        return {
          brief: this.toSummary(root),
          version: this.toVersionDetail(already),
          created: false,
        };
      }

      if (root.currentVersion.versionNumber !== input.expectedVersionNumber) {
        throw this.versionConflict(
          root.id,
          input.expectedVersionNumber,
          this.toVersionSummary(root.currentVersion),
        );
      }

      const versionNumber = root.currentVersion.versionNumber + 1;
      if (versionNumber > BRIEF_MAX_VERSIONS) {
        throw new BadRequestException(
          `This brief has reached its version limit (${BRIEF_MAX_VERSIONS}).`,
        );
      }

      // Citations for the accepted proposal: derive from the fresh evidence
      // (validated above against the same authorized source the proposal
      // was built from).
      const citations = citationsFromEvidence(proposal.evidence);
      const sections = input.keepUserEdits === false ? proposal.fresh : proposal.merged;

      try {
        const created = await tx.businessDevelopmentBriefVersion.create({
          data: {
            tenantId: ctx.tenantId,
            briefId: root.id,
            versionNumber,
            sections: sections as unknown as Prisma.InputJsonValue,
            sectionsHash: hashSections(sections),
            sourceSnapshot: proposal.snapshot as unknown as Prisma.InputJsonValue,
            snapshotHash: proposal.snapshotHash,
            citations: citations as unknown as Prisma.InputJsonValue,
            idempotencyKey: input.idempotencyKey,
            idempotencyOp: 'accept',
            idempotencyFingerprint: this.acceptFingerprint(input.keepUserEdits),
            createdByUserId: ctx.userId,
          },
          select: versionDetailSelect,
        });
        const updatedRoot = await tx.businessDevelopmentBrief.update({
          where: { id: root.id },
          data: { currentVersionId: created.id, updatedAt: new Date() },
          select: briefSelect,
        });
        return {
          brief: this.toSummary({ ...updatedRoot, currentVersionId: created.id }),
          version: this.toVersionDetail(created),
          created: true,
        };
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          const raced = await tx.businessDevelopmentBriefVersion.findFirst({
            where: {
              tenantId: ctx.tenantId,
              briefId: root.id,
              idempotencyKey: input.idempotencyKey,
            },
            select: versionDetailSelect,
          });
          if (raced) {
            const conflict = this.idempotencyReplayConflict(
              input.idempotencyKey,
              { op: 'accept', fingerprint: this.acceptFingerprint(input.keepUserEdits) },
              {
                idempotencyOp: raced.idempotencyOp ?? '',
                idempotencyFingerprint: raced.idempotencyFingerprint ?? '',
              },
            );
            if (conflict) throw conflict;
            return {
              brief: this.toSummary(root),
              version: this.toVersionDetail(raced),
              created: false,
            };
          }
        }
        throw error;
      }
    });
  }

  /** Internal proposal builder shared by build (read-only) and accept. */
  private async buildRefreshProposalInternal(
    ctx: TenantContext,
    prospect: { id: string; displayName: string; canonicalEntityId: string | null },
  ): Promise<{
    merged: BriefSections;
    fresh: BriefSections;
    snapshot: BriefSourceSnapshot;
    snapshotHash: string;
    evidence: EvidenceItem[];
  }> {
    const current = await this.currentVersionRowFor(ctx, prospect.id);
    if (!current?.currentVersion) {
      throw new NotFoundException('Brief not found');
    }
    const base = this.toVersionDetail(current.currentVersion);
    const auth = await this.authorizedEvidenceFor(ctx, prospect);
    const fresh = generateSections({
      identityName: auth.identityName,
      identityBasis: auth.identityBasis,
      evidence: auth.evidence,
    });
    const merged = preserveUserEdits(base.sections, fresh);
    const snapshot = buildSourceSnapshot(
      new Date().toISOString(),
      {
        canonicalEntityId: auth.canonicalEntityId,
        canonicalName: auth.canonicalName,
        identityBasis: auth.identityBasis,
      },
      auth.evidence,
    );
    return {
      merged,
      fresh,
      snapshot,
      snapshotHash: hashSnapshot(snapshot),
      evidence: auth.evidence,
    };
  }

  // ── 6. list version summaries + get a specific saved version ───────────────

  async listVersions(
    ctx: TenantContext,
    prospectId: string,
  ): Promise<{ brief: BriefSummary; versions: BriefVersionSummary[] }> {
    const prospect = await this.requireProspect(ctx, prospectId);
    const root = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.businessDevelopmentBrief.findFirst({
        where: { tenantId: ctx.tenantId, prospectId: prospect.id },
        select: {
          ...briefSelect,
          versions: {
            select: versionSummarySelect,
            orderBy: { versionNumber: 'asc' as const },
          },
        },
      }),
    );
    if (!root) throw new NotFoundException('Brief not found');
    const versions = root.versions.map((v) => this.toVersionSummary(v));
    const currentNumber = versions.find(
      (v) => v.id === root.currentVersionId,
    )?.versionNumber ?? null;
    return {
      brief: { ...this.toSummary(root), currentVersionNumber: currentNumber },
      versions,
    };
  }

  async getVersion(
    ctx: TenantContext,
    prospectId: string,
    versionNumber: number,
  ): Promise<BriefVersionDetail> {
    const prospect = await this.requireProspect(ctx, prospectId);
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.businessDevelopmentBriefVersion.findFirst({
        where: {
          tenantId: ctx.tenantId,
          versionNumber,
          brief: { prospectId: prospect.id, tenantId: ctx.tenantId },
        },
        select: versionDetailSelect,
      }),
    );
    if (!row) throw new NotFoundException('Brief version not found');
    return this.toVersionDetail(row);
  }

  // ── 7. resolve a saved citation to an inspectable source / limitation ──────

  async resolveCitation(
    ctx: TenantContext,
    prospectId: string,
    citationIndex: number,
  ): Promise<
    | {
        resolvable: true;
        citation: BriefCitation;
        sourceSnapshotEvidence: EvidenceItem | null;
        currentDossierEvidence: EvidenceItem | null;
      }
    | {
        resolvable: false;
        limitation:
          | 'citation_index_out_of_range'
          | 'brief_not_found'
          | 'source_changed';
        message: string;
        citation: BriefCitation | null;
      }
  > {
    const current = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.businessDevelopmentBrief.findFirst({
        where: { tenantId: ctx.tenantId, prospectId },
        select: { currentVersion: { select: versionDetailSelect } },
      }),
    );
    if (!current?.currentVersion) {
      return {
        resolvable: false,
        limitation: 'brief_not_found',
        message: 'No saved brief exists for this prospect yet.',
        citation: null,
      };
    }
    const detail = this.toVersionDetail(current.currentVersion);
    const citation = detail.citations[citationIndex];
    if (!citation) {
      return {
        resolvable: false,
        limitation: 'citation_index_out_of_range',
        message: `This brief version has ${detail.citations.length} citation(s); index ${citationIndex} does not exist.`,
        citation: null,
      };
    }

    const snapshotMatch =
      detail.sourceSnapshot.evidence.find(
        (e) =>
          (e.recordId ?? e.originalSourceId ?? '(no record id)') === citation.recordId &&
          e.sourceFamily === citation.sourceFamily,
      ) ?? null;

    // Is the citation still in the authorized current dossier?
    const prospect = await this.requireProspect(ctx, prospectId);
    const auth = await this.authorizedEvidenceFor(ctx, prospect);
    const currentMatch =
      auth.evidence.find(
        (e) =>
          (e.recordId ?? e.originalSourceId ?? '(no record id)') === citation.recordId &&
          e.sourceFamily === citation.sourceFamily,
      ) ?? null;

    if (!snapshotMatch && !currentMatch) {
      return {
        resolvable: false,
        limitation: 'source_changed',
        message:
          'The cited record is not in the saved snapshot or the current dossier — the source may have changed or been withdrawn since this version was saved.',
        citation,
      };
    }

    return {
      resolvable: true,
      citation,
      sourceSnapshotEvidence: snapshotMatch,
      currentDossierEvidence: currentMatch,
    };
  }

  // ── deterministic claim check (BD-CLAIM Jev stays DARK) ───────────────────

  async checkClaim(
    ctx: TenantContext,
    input: {
      prospectId: string;
      versionNumber: number;
      citationIndex: number;
      claimType: 'identity' | 'citation' | 'exact_amount' | 'date' | 'stage';
      expected?: string;
    },
  ): Promise<BriefClaimCheck> {
    const version = await this.getVersion(ctx, input.prospectId, input.versionNumber);
    const citation = version.citations[input.citationIndex] ?? null;
    // Deterministic checker only — no Jev semantic validation is called or
    // enabled from this path (Phase 3 BD-CLAIM remains dark).
    return checkClaimDeterministic({
      claimType: input.claimType,
      citation,
      expected: input.expected,
    });
  }

  // ── archive (soft lifecycle on the root; versions untouched) ──────────────

  async archive(ctx: TenantContext, prospectId: string): Promise<BriefSummary> {
    const prospect = await this.requireProspect(ctx, prospectId);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const root = await tx.businessDevelopmentBrief.findFirst({
        where: { tenantId: ctx.tenantId, prospectId: prospect.id },
        select: briefSelect,
      });
      if (!root) throw new NotFoundException('Brief not found');
      const updated = await tx.businessDevelopmentBrief.update({
        where: { id: root.id },
        data: { status: 'archived', updatedAt: new Date() },
        select: briefSelect,
      });
      return this.toSummary(updated);
    });
  }

  /** Stable hash exposure for callers that need content identity checks. */
  hash(value: unknown): string {
    return sha256Hex(value);
  }
}
