import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { DirectoryService } from '../directory/directory.service.js';
import { RepresentationResolverService } from './representation-resolver.service.js';

export interface AddTargetInput {
  memberId: string;
  source?: string;
  /** 'congress' (LegiStorm snapshot) | 'state' (OpenStates state_legislator). */
  sourceDirectory?: string;
}

/** WS-E, LegiStorm gaps/enrichment plan. */
export interface RepresentedFacility {
  id: string;
  name: string;
}

type TargetSnapshot = {
  memberName: string | null;
  party: string | null;
  state: string | null;
  chamber: string | null;
  committee: string | null;
};

const EMPTY_SNAPSHOT: TargetSnapshot = {
  memberName: null,
  party: null,
  state: null,
  chamber: null,
  committee: null,
};

/**
 * Client Targets CRUD. A target is a congressional office (directory member) a
 * team intends to engage for a client. Firm-wide per client (tenant-scoped, RLS).
 *
 * The directory is an in-memory snapshot hydrated from S3, NOT a Postgres table,
 * so we cannot FK member_id. Instead, on add we look the member up in the cached
 * directory and DENORMALIZE a compact snapshot (name/party/state/chamber/
 * committee) onto the row. That lets the portfolio card pills and Targets list
 * render without a directory round-trip and keeps them stable across directory
 * refreshes. If the member id is unknown (e.g. a stale client), the target is
 * still stored with whatever snapshot fields the caller knows — id alone is
 * enough to identify it.
 */
@Injectable()
export class ClientTargetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly directory: DirectoryService,
    private readonly representation: RepresentationResolverService,
  ) {}

  private async assertClient(tx: any, ctx: TenantContext, clientId: string) {
    const client = await tx.client.findFirst({
      where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
      select: { id: true },
    });
    if (!client) throw new NotFoundException('Client not found');
  }

  async listTargets(ctx: TenantContext, clientId: string) {
    const rows = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(tx, ctx, clientId);
      return tx.clientTarget.findMany({
        where: { tenantId: ctx.tenantId, clientId },
        orderBy: { addedAt: 'asc' },
      });
    });
    const representedFacilitiesByTarget = await this.resolveRepresentedFacilities(
      ctx.tenantId,
      clientId,
      rows,
    );
    return rows.map((row) => ({
      ...row,
      representedFacilities: representedFacilitiesByTarget.get(row.id) ?? null,
    }));
  }

  /**
   * WS-E, LegiStorm gaps/enrichment plan — "does this saved target represent
   * one of the client's facilities". Resolved FRESH from the CURRENT
   * directory snapshot / state_legislator row for each target's memberId —
   * deliberately NOT from ClientTarget's own denormalized `state` snapshot
   * text (e.g. "TX-12"), which is a point-in-time value that goes stale after
   * a redistricting or a member changing seats.
   * RepresentationResolverService.facilitiesForMember is the live,
   * deterministic join (same one office-recommender and the facility-based
   * "Your representatives" block are built on).
   *
   * Returns Map<ClientTarget.id, RepresentedFacility[] | null> — null means
   * "not applicable" (a staff target — a staffer doesn't represent a
   * district themselves — or the member couldn't be resolved in current
   * data, e.g. they've left office), distinct from an empty array ("resolved
   * successfully, represents none of this client's facilities").
   */
  private async resolveRepresentedFacilities(
    tenantId: string,
    clientId: string,
    targets: Array<{ id: string; memberId: string; sourceDirectory: string }>,
  ): Promise<Map<string, RepresentedFacility[] | null>> {
    const result = new Map<string, RepresentedFacility[] | null>();
    if (!targets.length) return result;

    const congressTargets = targets.filter((t) => t.sourceDirectory === 'congress');
    const stateTargets = targets.filter((t) => t.sourceDirectory === 'state');
    for (const t of targets) {
      if (t.sourceDirectory !== 'congress' && t.sourceDirectory !== 'state') {
        result.set(t.id, null);
      }
    }

    // Batch-load CURRENT member data ONCE — never per-target — same
    // discipline as the WS-A district-nexus rep overlay.
    const [contacts, stateLegislators] = await Promise.all([
      congressTargets.length ? this.directory.getAllContacts().catch(() => []) : Promise.resolve([]),
      stateTargets.length
        ? this.prisma.stateLegislator.findMany({
            where: { id: { in: stateTargets.map((t) => t.memberId) } },
            select: { id: true, state: true, chamber: true, district: true },
          })
        : Promise.resolve([]),
    ]);
    const contactsById = new Map(contacts.map((c) => [c.id, c] as const));
    const legislatorsById = new Map(stateLegislators.map((l) => [l.id, l] as const));

    await Promise.all([
      ...congressTargets.map(async (t) => {
        const contact = contactsById.get(t.memberId);
        if (!contact || contact.chamber === 'Governor' || !contact.state) {
          result.set(t.id, null);
          return;
        }
        // Mirrors getMemberRepresentationSummary's exact at-large convention
        // for this SAME directory-snapshot field (directory.service.ts):
        // district > 0 ? district : null. Not a guess — this is the
        // already-shipped, working convention for this specific data source.
        const districtNo = Number(contact.district);
        try {
          const facilities = await this.representation.facilitiesForMember(tenantId, clientId, {
            type: 'federal',
            chamber: contact.chamber === 'Senate' ? 'senate' : 'house',
            state: contact.state,
            district: Number.isFinite(districtNo) && districtNo > 0 ? districtNo : null,
          });
          result.set(t.id, facilities);
        } catch {
          result.set(t.id, null);
        }
      }),
      ...stateTargets.map(async (t) => {
        const leg = legislatorsById.get(t.memberId);
        // Explicit 'lower'/'upper' check (not just a null-check): facilitiesForMember's
        // state branch defaults anything other than 'lower' to stateSenateDistrict, so an
        // unexpected chamber value must be treated as unresolvable, never silently as 'upper'.
        if (!leg || !leg.state || (leg.chamber !== 'lower' && leg.chamber !== 'upper')) {
          result.set(t.id, null);
          return;
        }
        try {
          const facilities = await this.representation.facilitiesForMember(tenantId, clientId, {
            type: 'state',
            chamber: leg.chamber,
            state: leg.state,
            district: leg.district,
          });
          result.set(t.id, facilities);
        } catch {
          result.set(t.id, null);
        }
      }),
    ]);

    return result;
  }

  async addTarget(ctx: TenantContext, clientId: string, input: AddTargetInput) {
    const memberId = (input.memberId ?? '').trim();
    if (!memberId) throw new BadRequestException('memberId is required');
    const source = input.source === 'meri' ? 'meri' : 'manual';
    const sourceDirectory =
      input.sourceDirectory === 'state'
        ? 'state'
        : input.sourceDirectory === 'staff'
          ? 'staff'
          : 'congress';

    // Denormalize a compact snapshot from the ORIGINATING directory (best-effort):
    // congressional member (S3 snapshot), congressional staffer (S3 snapshot), or
    // state legislator (OpenStates table).
    const snapshot =
      sourceDirectory === 'state'
        ? await this.resolveStateSnapshot(memberId)
        : sourceDirectory === 'staff'
          ? await this.resolveStaffSnapshot(memberId)
          : await this.resolveCongressSnapshot(memberId);

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(tx, ctx, clientId);
      const existing = await tx.clientTarget.findFirst({
        where: { clientId, memberId },
        select: { id: true },
      });
      // Idempotent add: a duplicate is not an error (the UI fires optimistically).
      if (existing) {
        return tx.clientTarget.findUnique({ where: { id: existing.id } });
      }
      return tx.clientTarget.create({
        data: {
          tenantId: ctx.tenantId,
          clientId,
          memberId,
          sourceDirectory,
          memberName: snapshot.memberName,
          party: snapshot.party,
          state: snapshot.state,
          chamber: snapshot.chamber,
          committee: snapshot.committee,
          source,
          addedByUserId: ctx.userId ?? null,
        },
      });
    });
  }

  /** Congressional snapshot from the in-memory S3 directory (best-effort). */
  private async resolveCongressSnapshot(memberId: string): Promise<TargetSnapshot> {
    try {
      const contacts = await this.directory.getAllContacts();
      const m = contacts.find((c) => c.id === memberId);
      if (!m) return { ...EMPTY_SNAPSHOT };
      return {
        memberName: m.fullName ?? null,
        party: m.party ?? null,
        // House includes district (e.g. "TX-12"); Senate is the bare state.
        state:
          m.chamber === 'House' && m.district
            ? m.district.includes('-')
              ? m.district
              : `${m.state}-${m.district}`
            : m.state ?? null,
        chamber: m.chamber ?? null,
        committee: m.committees?.[0] ?? null,
      };
    } catch {
      // Directory unavailable — store the id-only target; the UI can still
      // resolve display fields from its own member cache.
      return { ...EMPTY_SNAPSHOT };
    }
  }

  /** State-legislator snapshot from the OpenStates state_legislator table. */
  private async resolveStateSnapshot(memberId: string): Promise<TargetSnapshot> {
    try {
      const leg = await this.prisma.stateLegislator.findUnique({
        where: { id: memberId },
        select: { name: true, party: true, state: true, chamber: true, district: true, committees: true },
      });
      if (!leg) return { ...EMPTY_SNAPSHOT };
      const committees = Array.isArray(leg.committees) ? leg.committees : [];
      const firstCommittee =
        committees.length && committees[0] && typeof committees[0] === 'object'
          ? (String((committees[0] as { name?: unknown }).name ?? '').trim() || null)
          : null;
      const stateCode = (leg.state ?? '').toUpperCase();
      return {
        memberName: leg.name ?? null,
        party: leg.party ?? null,
        // Mirror the congressional convention of district-qualifying the state.
        state: stateCode ? (leg.district ? `${stateCode}-${leg.district}` : stateCode) : null,
        chamber: leg.chamber ?? null,
        committee: firstCommittee,
      };
    } catch {
      return { ...EMPTY_SNAPSHOT };
    }
  }

  /** Congressional staffer snapshot from the in-memory S3 directory (best-effort). */
  private async resolveStaffSnapshot(staffId: string): Promise<TargetSnapshot> {
    try {
      const staff = await this.directory.getStaffDetail(staffId);
      const name = [
        staff.identity.preferredFirstName ?? staff.identity.firstName,
        staff.identity.preferredLastName ?? staff.identity.lastName,
      ]
        .filter(Boolean)
        .join(' ')
        .trim();
      const current = staff.positions.find((p) => p.isCurrent) ?? staff.positions[0];
      return {
        memberName: name || null,
        party: staff.bioDetails.partyName ?? null,
        state: null,
        chamber: null,
        // The office/committee the staffer works in is the useful "where" for a target.
        committee: current?.officeName ?? current?.title ?? null,
      };
    } catch {
      // Not found / directory unavailable — store id-only.
      return { ...EMPTY_SNAPSHOT };
    }
  }

  /** Assign (or clear, tier=null) a target's engagement tier. */
  async setTargetTier(
    ctx: TenantContext,
    clientId: string,
    memberId: string,
    tier: number | null,
  ) {
    const mid = (memberId ?? '').trim();
    if (!mid) throw new BadRequestException('memberId is required');
    if (tier !== null && ![1, 2, 3].includes(tier)) {
      throw new BadRequestException('tier must be 1, 2, 3, or null');
    }
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(tx, ctx, clientId);
      const existing = await tx.clientTarget.findFirst({
        where: { clientId, memberId: mid },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Target not found');
      return tx.clientTarget.update({ where: { id: existing.id }, data: { tier } });
    });
  }

  async removeTarget(ctx: TenantContext, clientId: string, memberId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(tx, ctx, clientId);
      const existing = await tx.clientTarget.findFirst({
        where: { clientId, memberId },
        select: { id: true },
      });
      // Idempotent remove: absent target is a no-op success (optimistic UI).
      if (!existing) return { deleted: true };
      await tx.clientTarget.delete({ where: { id: existing.id } });
      return { deleted: true };
    });
  }
}
