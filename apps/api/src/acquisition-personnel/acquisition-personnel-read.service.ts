import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { normalizeName } from './normalization/name-normalizer.js';
import {
  ListPersonnelDto,
  type PersonRoleSummaryDto,
  type PersonnelListResponseDto,
} from './dto/list-personnel.dto.js';
import type { PersonDetailDto } from './dto/person-detail.dto.js';
import {
  CONTACT_USE_LABELS,
  classifyContactUse,
  crmLinkBlockedReason,
  isCrmLinkBlocked,
  type ContactUse,
  type RoleType,
} from './contact-use.policy.js';
import { buildWhyShown } from './person-role-why-shown.js';

type MergeDecision = 'merge' | 'keep_separate' | 'reject_a' | 'reject_b';

const ROLE_TYPES: readonly RoleType[] = [
  'peo',
  'pm',
  'deputy',
  'chief_engineer',
  'contracting_officer',
  'staff',
  'other',
];

/**
 * Normalize a person's free-text role/title into the PersonRole.roleType enum
 * ('peo' | 'pm' | 'deputy' | 'chief_engineer' | 'contracting_officer' | 'staff' |
 * 'other'). Order matters: more specific signals are checked first (deputy before
 * the broader pm/peo bucket; contracting before generic staff). Defaults to 'other'.
 */
export function inferRoleType(role?: string | null, title?: string | null): RoleType {
  const text = `${role ?? ''} ${title ?? ''}`.toLowerCase();
  if (!text.trim()) return 'other';

  // Exact-enum passthrough if the role field already carries a canonical value.
  const exact = (role ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if ((ROLE_TYPES as readonly string[]).includes(exact)) return exact as RoleType;

  if (/\bdeputy\b/.test(text)) return 'deputy';
  if (/contracting officer|\bco\b|contract officer/.test(text)) return 'contracting_officer';
  if (/chief engineer|\bcheng\b|chief\s+engineer/.test(text)) return 'chief_engineer';
  if (/program executive officer|\bpeo\b/.test(text)) return 'peo';
  if (/program manager|product manager|project manager|\bpm\b|\bpdm\b|\bppm\b/.test(text)) {
    return 'pm';
  }
  if (/staff|specialist|analyst|engineer|officer|lead|director/.test(text)) return 'staff';
  return 'other';
}

@Injectable()
export class AcquisitionPersonnelReadService {
  constructor(private readonly prisma: PrismaService) {}

  async listPersonnel(
    query: ListPersonnelDto,
    ctx: TenantContext,
  ): Promise<PersonnelListResponseDto> {
    const page = this.normalizePage(query.page);
    const limit = this.normalizeLimit(query.limit);

    const where: Prisma.AcquisitionPersonnelWhereInput = {
      // Hide soft-superseded people (old DoW-directory rows the updated directory
      // dropped) unless an admin explicitly opts in via include_superseded=true.
      ...(query.include_superseded === 'true' ? {} : { supersededAt: null }),
      ...(query.service ? { service: query.service } : {}),
      ...(query.organization
        ? {
            organization: {
              contains: query.organization,
              mode: 'insensitive',
            },
          }
        : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.pe_code
        ? {
            OR: [{ pePrimary: query.pe_code }, { peSecondary: { has: query.pe_code } }],
          }
        : {}),
      ...(query.pe_aligned === 'aligned'
        ? { OR: [{ pePrimary: { not: null } }, { peSecondary: { isEmpty: false } }] }
        : {}),
      ...(query.pe_aligned === 'unaligned'
        ? { pePrimary: null, peSecondary: { isEmpty: true } }
        : {}),
    };

    // PE-aligned-first ordering (default for the DoW directory): rows with a confirmed
    // pePrimary sort ahead of unaligned ones. Postgres sorts NULLs last on ASC by
    // default, but to be explicit and stable we sort by a computed flag via raw is-null
    // ordering isn't expressible in Prisma orderBy, so we approximate with pePrimary
    // desc (non-null strings sort before NULL under 'desc' nulls-last) then confidence.
    const orderBy: Prisma.AcquisitionPersonnelOrderByWithRelationInput[] =
      query.sort === 'confidence'
        ? [{ confidence: 'desc' }, { updatedAt: 'desc' }]
        : [
            { pePrimary: { sort: 'desc', nulls: 'last' } },
            { confidence: 'desc' },
            { updatedAt: 'desc' },
          ];

    const { total, people } = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const trgmIds = query.q?.trim()
        ? await this.findIdsByFuzzyName(query.q.trim(), (page - 1) * limit, limit, tx)
        : null;

      const [count, rows] = await Promise.all([
        trgmIds ? Promise.resolve(trgmIds.length) : tx.acquisitionPersonnel.count({ where }),
        trgmIds
          ? tx.acquisitionPersonnel.findMany({
              where: {
                AND: [where, { id: { in: trgmIds } }],
              },
              include: {
                sources: {
                  select: { id: true },
                },
              },
            })
          : tx.acquisitionPersonnel.findMany({
              where,
              include: {
                sources: {
                  select: { id: true },
                },
              },
              orderBy,
              skip: (page - 1) * limit,
              take: limit,
            }),
      ]);

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'acquisition_personnel.list',
          entityType: 'acquisition_personnel',
          entityId: null,
          after: {
            filters: {
              service: query.service ?? null,
              organization: query.organization ?? null,
              role: query.role ?? null,
              peCode: query.pe_code ?? null,
              q: query.q ?? null,
            },
            page,
            limit,
            total: count,
          },
        },
      });

      const orderedRows = trgmIds ? this.orderByIds(rows, trgmIds) : rows;
      return { total: count, people: orderedRows, trgmIds };
    });

    return {
      data: people.map((p) => ({
        id: p.id,
        fullName: p.fullName,
        service: p.service,
        organization: p.organization,
        title: p.title,
        role: p.role,
        pePrimary: p.pePrimary,
        peSecondary: p.peSecondary,
        emailDomain: p.emailDomain,
        email: ctx.role === 'capiro_admin' ? (p.email ?? null) : null,
        publicProfileUrl: p.publicProfileUrl,
        headshotUrl:
          p.metadata && typeof p.metadata === 'object' && !Array.isArray(p.metadata)
            ? (((p.metadata as Record<string, unknown>).headshotUrl as string | undefined) ?? null)
            : null,
        confidence: p.confidence,
        status: p.status,
        firstSeenAt: p.firstSeenAt.toISOString(),
        lastSeenAt: p.lastSeenAt.toISOString(),
        sourceCount: p.sources.length,
      })),
      total,
      page,
      limit,
    };
  }

  async getPersonDetail(id: string, ctx: TenantContext): Promise<PersonDetailDto> {
    const person = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const found = await tx.acquisitionPersonnel.findUnique({
        where: { id },
        include: {
          sources: {
            orderBy: { observedAt: 'desc' },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'acquisition_personnel.detail',
          entityType: 'acquisition_personnel',
          entityId: id,
          after: Prisma.JsonNull,
        },
      });

      return found;
    });

    if (!person) throw new NotFoundException(`Acquisition personnel ${id} not found`);

    return {
      id: person.id,
      fullName: person.fullName,
      nameKey: person.nameKey,
      service: person.service,
      organization: person.organization,
      title: person.title,
      role: person.role,
      programOfRecord: person.programOfRecord,
      pePrimary: person.pePrimary,
      peSecondary: person.peSecondary,
      emailDomain: person.emailDomain,
      publicProfileUrl: person.publicProfileUrl,
      confidence: person.confidence,
      status: person.status,
      firstSeenAt: person.firstSeenAt.toISOString(),
      lastSeenAt: person.lastSeenAt.toISOString(),
      metadata: person.metadata,
      sources: person.sources.map((s) => ({
        id: s.id,
        source: s.source,
        sourceUrl: s.sourceUrl,
        snippet: s.snippet,
        observedAt: s.observedAt.toISOString(),
        confidence: s.confidence,
        metadata: s.metadata,
      })),
    };
  }

  async getProgramElementPersonnel(
    peCode: string,
    ctx: TenantContext,
  ): Promise<PersonnelListResponseDto['data']> {
    // Role-chain selection (plan §8): a person also belongs on this PE when an
    // accepted role reaches it through an accepted program mapping —
    //   PersonRole.programId --(accepted PeProgramMatch)--> peCode, or
    //   PersonRole.officeId --(accepted ProgramOfficeProgramLink)--> program --(accepted PeProgramMatch)--> peCode.
    // Previously the chain was DISPLAY-only and selection used pePrimary/peSecondary
    // alone; this unions in the chain-reachable people so the 3.3k accepted roles
    // actually surface. Global reference tables (no RLS) -> base client.
    const chainPersonIds = await this.resolveChainPersonIds(peCode);

    const rows = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const found = await tx.acquisitionPersonnel.findMany({
        where: {
          // Don't surface superseded people on a PE's team panel.
          supersededAt: null,
          OR: [
            { pePrimary: peCode },
            { peSecondary: { has: peCode } },
            ...(chainPersonIds.length ? [{ id: { in: chainPersonIds } }] : []),
          ],
        },
        include: {
          sources: {
            select: { id: true },
          },
        },
        orderBy: [{ confidence: 'desc' }, { lastSeenAt: 'desc' }],
        take: 10,
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'program_element.personnel.list',
          entityType: 'program_element',
          entityId: peCode,
          after: { count: found.length },
        },
      });

      return found;
    });

    // Attach the role chain (plan §8: people hang off OFFICES and ROLES, never
    // directly off a PE). ProgramOffice / PersonRole / Program are GLOBAL reference
    // tables (no RLS), so this read uses the base client. All person_role rows for
    // the returned people are fetched in ONE batched query (no N+1), left-joining the
    // office (officeName) and program (programName) names.
    const rolesByPerson = await this.fetchRolesByPerson(
      rows.map((p) => p.id),
      peCode,
    );

    // Full email is PII: expose it ONLY to capiro_admin; everyone else gets domain.
    const isAdmin = ctx.role === 'capiro_admin';
    return rows.map((p) => {
      const roles = rolesByPerson.get(p.id) ?? [];
      // Legacy fallback: the person is on this PE only via the old pe_primary
      // shortcut (no PersonRole chain yet). Surface a single explanatory entry.
      const legacySource =
        roles.length === 0 ? (p.pePrimary === peCode ? 'pe_primary link' : null) : null;
      const crm = this.evaluateCrmLinkForPeRoles(roles);
      return {
        id: p.id,
        fullName: p.fullName,
        service: p.service,
        organization: p.organization,
        title: p.title,
        role: p.role,
        pePrimary: p.pePrimary,
        peSecondary: p.peSecondary,
        emailDomain: p.emailDomain,
        email: isAdmin ? (p.email ?? null) : null,
        publicProfileUrl: p.publicProfileUrl,
        headshotUrl:
          p.metadata && typeof p.metadata === 'object' && !Array.isArray(p.metadata)
            ? (((p.metadata as Record<string, unknown>).headshotUrl as string | undefined) ?? null)
            : null,
        confidence: p.confidence,
        status: p.status,
        firstSeenAt: p.firstSeenAt.toISOString(),
        lastSeenAt: p.lastSeenAt.toISOString(),
        sourceCount: p.sources.length,
        roles,
        crmLinkBlocked: crm.blocked,
        crmLinkBlockedReason: crm.reason,
      };
    });
  }

  /**
   * People reachable from a PE via an ACCEPTED program mapping (plan §8):
   *   PersonRole.programId --(accepted PeProgramMatch)--> peCode, OR
   *   PersonRole.officeId --(accepted ProgramOfficeProgramLink)--> program --(accepted PeProgramMatch)--> peCode.
   * Returns distinct personIds from non-quarantined roles; empty when nothing maps.
   * Global reference tables (no RLS) -> base client.
   */
  private async resolveChainPersonIds(peCode: string): Promise<string[]> {
    const matches = await this.prisma.peProgramMatch.findMany({
      where: { peCode, status: 'accepted' },
      select: { programId: true },
    });
    const programIds = Array.from(new Set(matches.map((m) => m.programId)));
    if (programIds.length === 0) return [];

    const officeLinks = await this.prisma.programOfficeProgramLink.findMany({
      where: { programId: { in: programIds }, reviewStatus: 'accepted' },
      select: { officeId: true },
    });
    const officeIds = Array.from(new Set(officeLinks.map((l) => l.officeId)));

    const roles = await this.prisma.personRole.findMany({
      where: {
        reviewStatus: { not: 'quarantined' },
        OR: [
          { programId: { in: programIds } },
          ...(officeIds.length ? [{ officeId: { in: officeIds } }] : []),
        ],
      },
      select: { personId: true },
    });
    return Array.from(new Set(roles.map((r) => r.personId)));
  }

  /**
   * Batch-fetch the PersonRole chain for a set of people and flatten each row into a
   * PersonRoleSummaryDto. ONE query for the roles (with office/program names joined),
   * plus one batched lookup each for accepted office->program links and accepted
   * program->PE matches — no per-person/per-role round trips.
   *
   * People with no person_role rows are simply absent from the returned map (the
   * caller treats absence as `roles: []`).
   */
  private async fetchRolesByPerson(
    personIds: string[],
    peCode: string,
  ): Promise<Map<string, PersonRoleSummaryDto[]>> {
    const byPerson = new Map<string, PersonRoleSummaryDto[]>();
    if (personIds.length === 0) return byPerson;

    const roleRows = await this.prisma.personRole.findMany({
      // Display surface: show accepted + candidate roles (candidate is badged
      // "requires review" in the UI); HIDE quarantined roles (data explicitly
      // flagged as suspect must never surface). Recommendation-audience exclusion
      // (procurement POC / stale roles) is enforced separately by the Step 3.2
      // action-recommendation generator, not on this display panel.
      where: { personId: { in: personIds }, reviewStatus: { not: 'quarantined' } },
      include: {
        office: { select: { name: true } },
        program: { select: { canonicalName: true } },
      },
      orderBy: [{ observedAt: 'desc' }],
    });
    if (roleRows.length === 0) return byPerson;

    // Resolve the upper two hops in batches.
    // Hop "office manages program": accepted ProgramOfficeProgramLink for (officeId, programId).
    const linkPairs = roleRows.filter((r) => r.officeId && r.programId);
    const officeIds = Array.from(new Set(linkPairs.map((r) => r.officeId as string)));
    const linkProgramIds = Array.from(new Set(linkPairs.map((r) => r.programId as string)));
    const acceptedLinks = officeIds.length
      ? await this.prisma.programOfficeProgramLink.findMany({
          where: {
            officeId: { in: officeIds },
            programId: { in: linkProgramIds },
            reviewStatus: 'accepted',
          },
          select: { officeId: true, programId: true },
        })
      : [];
    const acceptedLinkKeys = new Set(acceptedLinks.map((l) => `${l.officeId}:${l.programId}`));

    // Hop "program maps to PE": accepted PeProgramMatch for (programId, peCode).
    const matchProgramIds = Array.from(
      new Set(roleRows.filter((r) => r.programId).map((r) => r.programId as string)),
    );
    const acceptedMatches = matchProgramIds.length
      ? await this.prisma.peProgramMatch.findMany({
          where: {
            programId: { in: matchProgramIds },
            peCode,
            status: 'accepted',
          },
          select: { programId: true },
        })
      : [];
    const acceptedMatchPrograms = new Set(acceptedMatches.map((m) => m.programId));

    for (const r of roleRows) {
      const contactUse = r.contactUse;
      const contactUseLabel = CONTACT_USE_LABELS[contactUse as ContactUse] ?? contactUse;
      const officeName = r.office?.name ?? null;
      const programName = r.program?.canonicalName ?? null;
      const officeManagesProgram = Boolean(
        r.officeId && r.programId && acceptedLinkKeys.has(`${r.officeId}:${r.programId}`),
      );
      const programMappedToPe = Boolean(r.programId && acceptedMatchPrograms.has(r.programId));

      const summary: PersonRoleSummaryDto = {
        id: r.id,
        roleTitle: r.roleTitle,
        roleType: r.roleType,
        officeName,
        programName,
        contactUse,
        contactUseLabel,
        reviewStatus: r.reviewStatus,
        observedAt: r.observedAt.toISOString(),
        staleAt: r.staleAt ? r.staleAt.toISOString() : null,
        whyShown: buildWhyShown({
          roleTitle: r.roleTitle,
          roleType: r.roleType,
          officeName,
          programName,
          officeManagesProgram,
          programMappedToPe,
          peCode,
        }),
      };

      const list = byPerson.get(r.personId);
      if (list) list.push(summary);
      else byPerson.set(r.personId, [summary]);
    }

    return byPerson;
  }

  /**
   * Find (never create) the ProgramOffice that matches a person's organization
   * string. Tries an exact match first, then a case-insensitive match. Returns null
   * when there's no organization or no matching office. We never upsert here: the
   * program_office functional-unique (name, service, COALESCE(valid_from,-infinity))
   * key is a raw SQL index Prisma cannot express.
   */
  private async resolveOfficeId(
    tx: Prisma.TransactionClient,
    organization: string | null,
  ): Promise<string | null> {
    const name = organization?.trim();
    if (!name) return null;

    const exact = await tx.programOffice.findFirst({
      where: { name },
      select: { id: true },
    });
    if (exact) return exact.id;

    const ci = await tx.programOffice.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    return ci?.id ?? null;
  }

  async linkCrmContact(
    personId: string,
    engagementContactId: string,
    peCodeRaw: string,
    ctx: TenantContext,
  ): Promise<{ linked: true }> {
    const peCode = (peCodeRaw ?? '').trim().toUpperCase();
    if (!peCode) {
      throw new BadRequestException('peCode is required for CRM linking from a Program Element page');
    }
    if (peCode.length > 16) {
      throw new BadRequestException('peCode is too long');
    }

    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [person, contact] = await Promise.all([
        this.prisma.acquisitionPersonnel.findUnique({
          where: { id: personId },
          select: { id: true },
        }),
        tx.engagementContact.findFirst({
          where: {
            id: engagementContactId,
            tenantId: ctx.tenantId,
          },
          select: { id: true, tenantId: true },
        }),
      ]);

      if (!person) throw new NotFoundException(`Acquisition personnel ${personId} not found`);
      if (!contact)
        throw new NotFoundException(`Engagement contact ${engagementContactId} not found`);

      // Applicable roles for THIS peCode only (never another PE's roles).
      // Includes quarantined so quarantine still blocks even when UI hides them.
      const roleRows = await this.prisma.personRole.findMany({
        where: { personId },
        select: {
          id: true,
          contactUse: true,
          reviewStatus: true,
          programId: true,
          officeId: true,
        },
      });

      const applicable = await this.filterRolesApplicableToPe(roleRows, peCode);
      const decision = this.evaluateCrmLinkGate(applicable.map((r) => r.contactUse));

      if (decision.blocked) {
        await tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            actorRole: ctx.role,
            action: 'acquisition_personnel.crm_link.blocked',
            entityType: 'acquisition_personnel',
            entityId: personId,
            after: {
              peCode,
              engagementContactIdPresent: true,
              // No names / emails / free text — classifications only.
              blockedContactUses: decision.blockedUses,
              reasonCode: decision.reasonCode,
              applicableRoleCount: applicable.length,
              // No admin bypass exists for this gate.
              adminBypass: false,
            },
          },
        });
        throw new BadRequestException(decision.message);
      }

      const updated = await tx.engagementContact.update({
        where: { id: contact.id },
        data: { acquisitionPersonnelId: personId },
        select: { id: true },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'acquisition_personnel.crm_link',
          entityType: 'engagement_contacts',
          entityId: updated.id,
          after: {
            // No PII: ids + pe only.
            acquisitionPersonnelId: personId,
            peCode,
            allowedContactUses: decision.allowedUses,
          },
        },
      });
    });

    return { linked: true };
  }

  /**
   * Roles that authorize CRM linking for a PE: accepted chain onto peCode
   * (program match or office→program→pe), excluding nothing yet — caller may
   * still include quarantined for block evaluation. Roles whose program maps
   * only to a *different* PE are not applicable.
   */
  private async filterRolesApplicableToPe(
    roleRows: Array<{
      id: string;
      contactUse: string;
      reviewStatus: string;
      programId: string | null;
      officeId: string | null;
    }>,
    peCode: string,
  ): Promise<Array<{ id: string; contactUse: string; reviewStatus: string }>> {
    if (roleRows.length === 0) return [];

    const programIds = Array.from(
      new Set(roleRows.map((r) => r.programId).filter((id): id is string => Boolean(id))),
    );
    const acceptedMatches = programIds.length
      ? await this.prisma.peProgramMatch.findMany({
          where: { programId: { in: programIds }, peCode, status: 'accepted' },
          select: { programId: true },
        })
      : [];
    const programsOnPe = new Set(acceptedMatches.map((m) => m.programId));

    // Office-only roles: accept when office manages a program that maps to peCode.
    const officeIds = Array.from(
      new Set(roleRows.map((r) => r.officeId).filter((id): id is string => Boolean(id))),
    );
    const officeProgramLinks = officeIds.length
      ? await this.prisma.programOfficeProgramLink.findMany({
          where: { officeId: { in: officeIds }, reviewStatus: 'accepted' },
          select: { officeId: true, programId: true },
        })
      : [];
    const officePrograms = new Map<string, string[]>();
    for (const link of officeProgramLinks) {
      const list = officePrograms.get(link.officeId) ?? [];
      list.push(link.programId);
      officePrograms.set(link.officeId, list);
    }
    const officeProgramIds = Array.from(new Set(officeProgramLinks.map((l) => l.programId)));
    const officePeMatches = officeProgramIds.length
      ? await this.prisma.peProgramMatch.findMany({
          where: { programId: { in: officeProgramIds }, peCode, status: 'accepted' },
          select: { programId: true },
        })
      : [];
    const officeProgramsOnPe = new Set(officePeMatches.map((m) => m.programId));

    return roleRows.filter((r) => {
      if (r.programId && programsOnPe.has(r.programId)) return true;
      if (r.officeId) {
        const managed = officePrograms.get(r.officeId) ?? [];
        if (managed.some((pid) => officeProgramsOnPe.has(pid))) return true;
      }
      return false;
    });
  }

  private evaluateCrmLinkGate(contactUses: string[]): {
    blocked: boolean;
    message: string;
    reasonCode: string;
    blockedUses: string[];
    allowedUses: string[];
  } {
    const blockedUses = contactUses.filter((u) => isCrmLinkBlocked(u));
    const allowedUses = contactUses.filter((u) => !isCrmLinkBlocked(u));

    // Allowed if any non-blocked applicable role exists. Blocked if every
    // applicable role is blocked OR there are no applicable PE roles.
    if (allowedUses.length > 0) {
      return {
        blocked: false,
        message: '',
        reasonCode: 'allowed',
        blockedUses,
        allowedUses,
      };
    }

    if (contactUses.length === 0) {
      return {
        blocked: true,
        message:
          'CRM linking is blocked: no accepted role connects this person to the requested Program Element.',
        reasonCode: 'no_applicable_role',
        blockedUses: [],
        allowedUses: [],
      };
    }

    const primary = blockedUses[0] ?? contactUses[0]!;
    return {
      blocked: true,
      message: crmLinkBlockedReason(primary),
      reasonCode: primary,
      blockedUses,
      allowedUses: [],
    };
  }

  private evaluateCrmLinkForPeRoles(roles: PersonRoleSummaryDto[]): {
    blocked: boolean;
    reason: string | null;
  } {
    // Display roles already exclude quarantined; treat empty as blocked pending mapping.
    const uses = roles.map((r) => r.contactUse);
    const decision = this.evaluateCrmLinkGate(uses);
    return {
      blocked: decision.blocked,
      reason: decision.blocked ? decision.message : null,
    };
  }

  async listMergeQueue(
    status: string | undefined,
    pageRaw: number | undefined,
    limitRaw: number | undefined,
    ctx: TenantContext,
  ) {
    const page = this.normalizePage(pageRaw);
    const limit = this.normalizeLimit(limitRaw);

    const where: Prisma.AcquisitionPersonnelMergeCandidateWhereInput = status ? { status } : {};

    const { total, rows } = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [count, items] = await Promise.all([
        tx.acquisitionPersonnelMergeCandidate.count({ where }),
        tx.acquisitionPersonnelMergeCandidate.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'acquisition_personnel.merge_queue.list',
          entityType: 'acquisition_personnel_merge_candidate',
          entityId: null,
          after: { status: status ?? null, page, limit, total: count },
        },
      });

      return { total: count, rows: items };
    });

    // Hydrate each candidate with both persons' detail (name, organization,
    // title, role, status, sources) so the admin merge UI can render a
    // side-by-side comparison. AcquisitionPersonnel is a GLOBAL table, so this
    // read uses the base client (no tenant scoping).
    const personIds = Array.from(
      new Set(rows.flatMap((r) => [r.primaryPersonId, r.secondaryPersonId])),
    );
    const persons = personIds.length
      ? await this.prisma.acquisitionPersonnel.findMany({
          where: { id: { in: personIds } },
          select: {
            id: true,
            fullName: true,
            organization: true,
            title: true,
            role: true,
            service: true,
            status: true,
            confidence: true,
            sources: {
              select: { source: true, sourceUrl: true, observedAt: true },
              orderBy: { observedAt: 'desc' },
              take: 10,
            },
          },
        })
      : [];
    const personById = new Map(persons.map((p) => [p.id, p]));

    const data = rows.map((r) => ({
      ...r,
      primaryPerson: personById.get(r.primaryPersonId) ?? null,
      secondaryPerson: personById.get(r.secondaryPersonId) ?? null,
    }));

    return {
      data,
      total,
      page,
      limit,
    };
  }

  async resolveMergeQueue(
    id: string,
    decision: MergeDecision,
    notes: string | undefined,
    ctx: TenantContext,
    mergePersons: (primaryId: string, secondaryId: string, userId: string) => Promise<void>,
  ): Promise<{ resolved: true }> {
    const candidate = await this.prisma.acquisitionPersonnelMergeCandidate.findUnique({
      where: { id },
    });

    if (!candidate) throw new NotFoundException(`Merge queue candidate ${id} not found`);

    if (decision === 'merge') {
      await mergePersons(candidate.primaryPersonId, candidate.secondaryPersonId, ctx.userId);
    }

    await this.prisma.acquisitionPersonnelMergeCandidate.update({
      where: { id },
      data: {
        status: decision === 'merge' ? 'merged' : decision,
        resolvedByUserId: ctx.userId,
        resolvedAt: new Date(),
        decisionNotes: notes ?? null,
      },
    });

    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'acquisition_personnel.merge_queue.resolve',
          entityType: 'acquisition_personnel_merge_candidate',
          entityId: id,
          after: { decision, notes: notes ?? null },
        },
      });
    });

    return { resolved: true };
  }

  // ── Phase 1b: person -> Program Element link candidate review queue ──────────
  // Candidates are proposed by the deterministic matcher (generate-pe-person-candidates).
  // Confirming one applies the link (sets pe_primary) AND records a citation source
  // so the link is defensible/auditable. Rejecting just closes the candidate.

  async listPersonCandidates(
    status: string,
    pageRaw: number | undefined,
    limitRaw: number | undefined,
    ctx: TenantContext,
  ) {
    const page = this.normalizePage(pageRaw);
    const limit = this.normalizeLimit(limitRaw);
    const where: Prisma.ProgramElementPersonCandidateWhereInput = status ? { status } : {};

    const [total, rows] = await Promise.all([
      this.prisma.programElementPersonCandidate.count({ where }),
      this.prisma.programElementPersonCandidate.findMany({
        where,
        orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    // Enrich with person + PE display fields for the reviewer UI.
    const personIds = Array.from(new Set(rows.map((r) => r.personId)));
    const peCodes = Array.from(new Set(rows.map((r) => r.peCode)));
    const [people, pes] = await Promise.all([
      this.prisma.acquisitionPersonnel.findMany({
        where: { id: { in: personIds } },
        select: { id: true, fullName: true, organization: true, title: true, pePrimary: true },
      }),
      this.prisma.programElement.findMany({
        where: { peCode: { in: peCodes } },
        select: { peCode: true, title: true, service: true },
      }),
    ]);
    const personById = new Map(people.map((p) => [p.id, p]));
    const peByCode = new Map(pes.map((p) => [p.peCode, p]));

    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'program_element.person_candidate.list',
          entityType: 'program_element_person_candidate',
          entityId: null,
          after: { status: status ?? null, page, limit, total },
        },
      });
    });

    return {
      data: rows.map((r) => ({
        ...r,
        person: personById.get(r.personId) ?? null,
        programElement: peByCode.get(r.peCode) ?? null,
      })),
      total,
      page,
      limit,
    };
  }

  async resolvePersonCandidate(
    id: string,
    decision: 'confirm' | 'reject',
    notes: string | undefined,
    ctx: TenantContext,
  ): Promise<{ resolved: true; linked: boolean }> {
    const candidate = await this.prisma.programElementPersonCandidate.findUnique({ where: { id } });
    if (!candidate) throw new NotFoundException(`Person-PE candidate ${id} not found`);

    // Idempotent guard: a candidate that is already resolved is a no-op. This
    // prevents a double-click / retry from appending duplicate provenance
    // (acquisition_personnel_source) rows. Re-suggested candidates are reset to
    // 'open' (see suggestPersonForProgramElement), so they re-enter here normally.
    if (candidate.status !== 'open') {
      return { resolved: true, linked: candidate.status === 'confirmed' };
    }

    let linked = false;

    if (decision === 'confirm') {
      // Look up an R-2 citation for this PE (if any) so the link carries provenance.
      const r2 = await this.prisma.programElementSource.findFirst({
        where: { peCode: candidate.peCode, exhibitType: { in: ['R-2', 'R-2A'] } },
        orderBy: [{ pageNumber: 'asc' }],
        select: { sourceUrl: true, pageNumber: true },
      });
      const citationUrl =
        r2?.sourceUrl && r2.pageNumber
          ? `${r2.sourceUrl}#page=${r2.pageNumber}`
          : (r2?.sourceUrl ?? null);

      await this.prisma.$transaction(async (tx) => {
        // Apply the link only if the person isn't already mapped (don't clobber).
        await tx.acquisitionPersonnel.updateMany({
          where: { id: candidate.personId, pePrimary: null },
          data: { pePrimary: candidate.peCode },
        });
        // Record a citable source explaining WHY this link exists.
        await tx.acquisitionPersonnelSource.create({
          data: {
            personId: candidate.personId,
            source: 'pe_match_confirmed',
            sourceUrl: citationUrl,
            snippet: `Linked to PE ${candidate.peCode} (review-confirmed). Match basis: ${candidate.matchBasis ?? 'n/a'}.`,
            observedAt: new Date(),
            confidence: candidate.score,
            metadata: {
              candidateId: candidate.id,
              peCode: candidate.peCode,
              score: candidate.score,
              confirmedByUserId: ctx.userId,
            },
          },
        });

        // Matcher evolution (plan §8): a confirmed match also materializes a
        // PersonRole row so the person hangs off a ROLE/OFFICE, not just the legacy
        // pe_primary shortcut. programId stays null — PE<->program is a separate
        // graph resolved elsewhere. Idempotent: dedupe on (personId, roleTitle, source).
        const SOURCE = 'pe_match_confirmed';
        const person = await tx.acquisitionPersonnel.findUnique({
          where: { id: candidate.personId },
          select: { organization: true, title: true, role: true },
        });
        const roleTitle = (person?.title || person?.role || 'Program team member').trim();
        const existingRole = await tx.personRole.findFirst({
          where: { personId: candidate.personId, roleTitle, source: SOURCE },
          select: { id: true },
        });
        if (!existingRole) {
          // Resolve the office from the person's organization (find-or-nothing: a
          // ProgramOffice whose name matches exactly or case-insensitively). We never
          // create offices here. The functional-unique (name, service, valid_from)
          // index is raw SQL, so we never upsert against it.
          const officeId = await this.resolveOfficeId(tx, person?.organization ?? null);
          const roleType = inferRoleType(person?.role, person?.title);
          await tx.personRole.create({
            data: {
              personId: candidate.personId,
              officeId,
              programId: null,
              roleTitle,
              roleType,
              source: SOURCE,
              sourceUrl: null,
              observedAt: new Date(),
              confidence: candidate.score ?? 0.7,
              reviewStatus: 'accepted',
              // contact_use is NOT NULL with no DB default — set it explicitly via the policy.
              contactUse: classifyContactUse({
                roleType,
                source: SOURCE,
                reviewStatus: 'accepted',
              }),
            },
          });
        }

        // Close the candidate ATOMICALLY with the link writes: if the process
        // dies mid-confirm, the whole unit rolls back, so the candidate stays
        // 'open' with NO half-applied provenance and a retry re-runs cleanly.
        await tx.programElementPersonCandidate.update({
          where: { id },
          data: {
            status: 'confirmed',
            resolvedByUserId: ctx.userId,
            resolvedAt: new Date(),
            decisionNotes: notes ?? null,
          },
        });
      });
      linked = true;
    } else {
      // Reject: just close the candidate (no link writes to coordinate).
      await this.prisma.programElementPersonCandidate.update({
        where: { id },
        data: {
          status: 'rejected',
          resolvedByUserId: ctx.userId,
          resolvedAt: new Date(),
          decisionNotes: notes ?? null,
        },
      });
    }

    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'program_element.person_candidate.resolve',
          entityType: 'program_element_person_candidate',
          entityId: id,
          after: {
            decision,
            peCode: candidate.peCode,
            personId: candidate.personId,
            linked,
            notes: notes ?? null,
          },
        },
      });
    });

    return { resolved: true, linked };
  }

  /**
   * user_admin suggestion: a tenant admin proposes a person they know for a PE.
   * Creates a low-confidence person (status=unknown, source=user_suggested) + an
   * OPEN candidate for capiro_admin review. Never auto-applies a link.
   */
  async suggestPersonForProgramElement(
    peCode: string,
    input: { fullName: string; roleTitle?: string; organization?: string; notes?: string },
    ctx: TenantContext,
  ): Promise<{ suggested: true; candidateId: string }> {
    const fullName = (input.fullName ?? '').trim();
    if (!fullName) throw new BadRequestException('fullName is required');

    const pe = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!pe) throw new NotFoundException(`Program Element ${peCode} not found`);

    const nameKey = normalizeName(fullName).nameKey;

    const result = await this.prisma.$transaction(async (tx) => {
      // Reuse an existing person by nameKey if present; otherwise create one.
      let person = await tx.acquisitionPersonnel.findFirst({
        where: { nameKey },
        select: { id: true },
      });
      if (!person) {
        person = await tx.acquisitionPersonnel.create({
          data: {
            fullName,
            nameKey,
            organization: input.organization ?? null,
            title: input.roleTitle ?? null,
            role: 'OTHER',
            confidence: 0.3,
            status: 'unknown',
            metadata: { suggestedByUserId: ctx.userId, suggestedForPe: peCode },
          },
          select: { id: true },
        });
        await tx.acquisitionPersonnelSource.create({
          data: {
            personId: person.id,
            source: 'user_suggested',
            sourceUrl: null,
            snippet: `Suggested for PE ${peCode} by tenant admin${input.notes ? `: ${input.notes}` : ''}`,
            observedAt: new Date(),
            confidence: 0.3,
            metadata: { suggestedByUserId: ctx.userId, tenantId: ctx.tenantId },
          },
        });
      }

      const candidate = await tx.programElementPersonCandidate.upsert({
        where: { personId_peCode: { personId: person.id, peCode } },
        create: {
          personId: person.id,
          peCode,
          score: 0.3,
          matchBasis: `user-suggested by tenant admin${input.roleTitle ? ` (${input.roleTitle})` : ''}`,
          scoreBreakdown: {
            source: 'user_suggested',
            notes: input.notes ?? null,
          } as unknown as object,
          status: 'open',
        },
        update: {
          // Re-open and refresh basis: a re-suggested person must re-enter the
          // capiro_admin review queue (default filter status='open'), otherwise a
          // previously-rejected candidate stays permanently invisible. Re-opening a
          // confirmed candidate is harmless — the admin simply sees it again.
          matchBasis: `user-suggested by tenant admin${input.roleTitle ? ` (${input.roleTitle})` : ''}`,
          status: 'open',
        },
        select: { id: true },
      });

      return candidate.id;
    });

    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'program_element.person_candidate.suggest',
          entityType: 'program_element_person_candidate',
          entityId: result,
          after: {
            peCode,
            fullName,
            roleTitle: input.roleTitle ?? null,
            organization: input.organization ?? null,
          },
        },
      });
    });

    return { suggested: true, candidateId: result };
  }

  private normalizePage(page?: number): number {
    const p = Number(page ?? 1);
    if (!Number.isFinite(p) || p < 1) return 1;
    return Math.floor(p);
  }

  private normalizeLimit(limit?: number): number {
    const l = Number(limit ?? 50);
    if (!Number.isFinite(l) || l < 1) return 50;
    return Math.min(100, Math.floor(l));
  }

  private async findIdsByFuzzyName(
    query: string,
    skip: number,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
      FROM acquisition_personnel
      WHERE similarity(name_key, ${query}) > 0.2
      ORDER BY similarity(name_key, ${query}) DESC, confidence DESC
      OFFSET ${skip}
      LIMIT ${take}
    `);
    return rows.map((r) => r.id);
  }

  private orderByIds<T extends { id: string }>(rows: T[], ids: string[]): T[] {
    const map = new Map(rows.map((r) => [r.id, r] as const));
    const ordered: T[] = [];
    for (const id of ids) {
      const found = map.get(id);
      if (found) ordered.push(found);
    }
    return ordered;
  }
}
