import { gunzipSync } from 'node:zlib';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { DirectoryContactMapper, type MemberBioOverlay } from './directory-contact-mapper.js';
import { DirectoryBrowse } from './directory-browse.js';
import { membershipsForPerson, projectMemberDetail, projectRosterOnlyStaffDetail, projectStaffDetail } from './directory-detail-projection.js';
import { buildCommitteeIndex } from './directory-committee-index.js';
import { uniqueSorted } from './directory-collection.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { matchFacilityDistrictCode, UNRESOLVABLE_HOUSE_SENTINELS } from '../common/district-code.util.js';
import { US_HOUSE_SEATS } from '../common/us-congressional-districts.js';
import { manifestKey, artifactKey, type BoundaryManifest } from './boundary-artifact.util.js';
import { FEC_DISCLAIMER } from '../intelligence/fec-disclaimer.js';
import { RepresentationResolverService } from '../clients/representation-resolver.service.js';
import {
  buildDirectoryIndexes,
  selectCurrentMemberOffice,
  normalizePersonName,
  type DirectoryCommitteeMembership,
  type DirectoryIndexes,
} from './directory-indexes.js';
import {
  parsePhotoOverlay,
  resolveMemberPhoto,
  resolveStaffPhoto,
  type DirectoryPhotoOverlay,
} from './directory-photo.js';
import type {
  DirectoryCommitteeDetail,
  DirectoryContactTripSummary,
  DirectoryContactTripsPayload,
  DirectoryDistrictDetail,
  DirectoryDistrictMemberSummary,
  DirectoryMemberDetail,
  DirectoryPeoplePayload,
  DirectoryPersonResult,
  DirectoryStaffDetail,
} from './directory-detail.types.js';

import type {
  Chamber,
  DirectoryContact,
  MemberPressOverlay,
  MemberNewsItem,
  MemberNewsPayload,
  DirectoryQuery,
  DirectoryTotals,
  DirectoryStaffer,
  DirectoryStaffersPayload,
  StaffersQuery,
  DirectoryCommittee,
  DirectoryCommitteeStaffer,
  CommitteesQuery,
  DirectoryCommitteesPayload,
  CommitteeStaffQuery,
  DirectoryCommitteeStaffPayload,
  DirectoryAvailableFilters,
  DirectoryPayload,
  DirectoryEmailMatch,
  DirectoryMemberContext,
  DirectoryStafferContext,
  DirectoryCommitteeStaffEmailMatch,
  DirectoryBrowsePayload,
  CreateDirectoryContactNoteInput,
} from './directory.types.js';

export type {
  CommitteeChamber,
  CommitteeKind,
  DirectoryAddress,
  DirectoryLink,
  DirectoryStaffMember,
  DirectoryContact,
  MemberNewsItem,
  MemberNewsPayload,
  DirectoryQuery,
  DirectoryTotals,
  DirectoryStaffer,
  DirectoryStaffersPayload,
  StaffersQuery,
  CommitteeMemberRef,
  DirectoryCommittee,
  DirectoryCommitteeStaffer,
  CommitteesQuery,
  DirectoryCommitteesPayload,
  CommitteeStaffQuery,
  DirectoryCommitteeStaffPayload,
  DirectoryAvailableFilters,
  DirectoryPayload,
  DirectoryEmailMatch,
  DirectoryMemberContext,
  DirectoryStafferContext,
  DirectoryCommitteeStaffEmailMatch,
  DirectoryBrowseContact,
  DirectoryBrowsePayload,
  CreateDirectoryContactNoteInput,
} from './directory.types.js';

interface CachedContacts {
  expiresAt: number;
  data: {
    sourceId: string;
    contacts: DirectoryContact[];
    staffers: DirectoryStaffer[];
    committees: DirectoryCommittee[];
    committeeStaff: Map<string, DirectoryCommitteeStaffer[]>; // committee id -> roster
    indexes: DirectoryIndexes; // raw rows + full memberships + reverse/name indexes
    photoOverlay: DirectoryPhotoOverlay; // read-only additive contact photos
    totals: DirectoryTotals;
    availableStates: string[];
    availableFilters: DirectoryAvailableFilters;
  };
}

/** Minimal read-side view of LATEST.json (the publisher writes the full 2.0.0 schema). */
interface DirectorySnapshotPointer {
  snapshot_prefix?: unknown;
  previous_snapshot_prefix?: unknown;
}

/**
 * Fallback pointer key + snapshot prefix used until the refresh pipeline publishes
 * a LATEST.json. Keeps the live directory working during the Phase 2 rollout.
 */
const DEFAULT_DIRECTORY_LATEST_KEY = 'UPDATED DIRECTORY/LATEST.json';
const DEFAULT_DIRECTORY_PREFIX =
  'UPDATED DIRECTORY/snapshots/active-current-20260501T024354Z';

@Injectable()
export class DirectoryService implements OnModuleInit {
  private static readonly DEFAULT_PAGE_SIZE = 24;
  private static readonly MAX_PAGE_SIZE = 20_000;
  private readonly logger = new Logger(DirectoryService.name);
  private readonly contactMapper = new DirectoryContactMapper();
  private readonly browse = new DirectoryBrowse();
  private readonly s3: S3Client;
  private readonly bucket: string;
  /** Emergency pin (DIRECTORY_S3_PREFIX); when null the prefix is resolved from LATEST.json. */
  private readonly explicitPrefix: string | null;
  private readonly latestKey: string;
  private readonly bioOverlayKey: string;
  private readonly pressOverlayKey: string;
  private readonly photoOverlayKey: string;
  private cache: CachedContacts | null = null;

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly representation: RepresentationResolverService,
  ) {
    const region = config.get('AWS_REGION_DEFAULT', { infer: true });
    this.s3 = new S3Client({ region });
    this.bucket = process.env.DIRECTORY_S3_BUCKET ?? 'updated-directory-967807252336-us-east-1';
    // Pointer-driven snapshot resolution (Phase 2): an explicit DIRECTORY_S3_PREFIX is
    // an emergency PIN; otherwise the prefix is resolved from LATEST.json on each cache
    // rebuild so the reader follows validated snapshot rotation with a rollback path.
    this.explicitPrefix = process.env.DIRECTORY_S3_PREFIX?.trim() || null;
    this.latestKey = process.env.DIRECTORY_S3_LATEST_KEY ?? DEFAULT_DIRECTORY_LATEST_KEY;
    this.bioOverlayKey =
      process.env.DIRECTORY_BIO_OVERLAY_KEY ?? 'UPDATED DIRECTORY/overlays/member-bios-v1.json';
    this.pressOverlayKey =
      process.env.DIRECTORY_PRESS_OVERLAY_KEY ?? 'UPDATED DIRECTORY/overlays/member-press-v1.json';
    this.photoOverlayKey =
      process.env.DIRECTORY_PHOTO_OVERLAY_KEY ?? 'UPDATED DIRECTORY/overlays/contact-photos-v1.json';
  }

  /**
   * Pre-warm the directory cache at boot so the FIRST contacts/typeahead request
   * doesn't pay the cold S3-pull + gunzip + index-build cost (which made the
   * Setup "Target offices" search take minutes). Non-blocking and best-effort:
   * a transient S3 failure here must not crash startup — getDirectoryData()
   * already throws ServiceUnavailable on the live request path.
   */
  onModuleInit(): void {
    void this.getDirectoryData().catch((error) => {
      this.logger.warn(
        `Directory cache pre-warm failed (will lazy-load on first request): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  async getContacts(query: DirectoryQuery = {}): Promise<DirectoryPayload> {
    const page = this.browse.toPositiveInt(query.page, 1);
    const pageSize = this.browse.toPositiveInt(
      query.pageSize,
      DirectoryService.DEFAULT_PAGE_SIZE,
      DirectoryService.MAX_PAGE_SIZE,
    );
    const base = await this.getDirectoryData();
    return this.browse.toPagedPayload(base, query, page, pageSize);
  }

  /**
   * Trimmed, bridge-safe version of {@link getContacts} for the internal
   * Directory browse route (Hill Day's "select a member directly" picker —
   * same browsing behaviour as Outreach's Directory tab: A–Z by default,
   * search/state/chamber filters, paginated). Delegates to the SAME
   * `getContacts` every authenticated user hits at `/directory/contacts`, so
   * results are identical; this only reshapes the response.
   */
  async getContactsForBridge(query: DirectoryQuery): Promise<DirectoryBrowsePayload> {
    const payload = await this.getContacts(query);
    return {
      contacts: payload.contacts.map((c) => ({
        id: c.id,
        fullName: c.fullName,
        honorific: c.honorific,
        title: c.title,
        office: c.office,
        chamber: c.chamber,
        state: c.state,
        district: c.district,
        party: c.party,
        partyName: c.partyName,
        email: c.email,
        phone: c.phone,
        committees: c.committees,
        leadershipPositions: c.leadershipPositions,
        staff: c.staff.map((s) => ({
          id: s.id,
          fullName: s.fullName,
          title: s.title,
          roles: s.roles,
          issueAreas: s.issueAreas,
          email: s.email,
          phone: s.phone,
          officeLocation: s.officeLocation,
          isCurrent: s.isCurrent,
        })),
      })),
      total: payload.total,
      page: payload.page,
      pageSize: payload.pageSize,
      availableStates: payload.availableStates,
      availableChambers: payload.availableFilters.chambers,
    };
  }

  /**
   * The full, unpaginated congressional member list from the cached directory
   * snapshot. Used by the Office Recommender to score every member against a
   * client's tracked-bill committees, issue overlap, and facility geography.
   * Read-only — callers must not mutate the returned objects.
   */
  async getAllContacts(): Promise<DirectoryContact[]> {
    const base = await this.getDirectoryData();
    return base.contacts;
  }

  /**
   * WS-G, LegiStorm gaps/enrichment plan (optional temporal enrichment) —
   * every CURRENT committee membership across the whole snapshot (members
   * and staff, leadership and plain members alike). Read-only reuse of the
   * already-built index — zero new S3/processing cost beyond what
   * buildDirectoryIndexes already computes for the detail/dictionary
   * endpoints. `membershipsByCommitteeId` includes FORMER memberships too
   * (per its own doc comment on committeesByPersonId: "current or former"),
   * so this filters to endedAt === null — the same unambiguous "still
   * active" signal used throughout this codebase (e.g. member_offices'
   * end_date === null), rather than trusting a status string whose exact
   * values aren't guaranteed.
   *
   * Called from a plain script (emit-committee-changes.ts) via a NestJS
   * application context (NestFactory.createApplicationContext + app.get(...,
   * {strict:false}) — the same pattern sync-hearing-transcripts.ts already
   * uses to reuse GovInfoService), never re-implemented standalone.
   */
  async getAllCommitteeMemberships(): Promise<DirectoryCommitteeMembership[]> {
    const base = await this.getDirectoryData();
    return Array.from(base.indexes.membershipsByCommitteeId.values())
      .flat()
      .filter((m) => m.endedAt === null);
  }

  // Search across the flattened staffer index (built once at cache time).
  // In-memory filter over the cached dataset — fast even at ~20k staffers.
  async getStaffers(query: StaffersQuery = {}): Promise<DirectoryStaffersPayload> {
    const page = this.browse.toPositiveInt(query.page, 1);
    const pageSize = this.browse.toPositiveInt(
      query.pageSize,
      DirectoryService.DEFAULT_PAGE_SIZE,
      DirectoryService.MAX_PAGE_SIZE,
    );
    const base = await this.getDirectoryData();
    return this.browse.toStaffersPayload(base.staffers, query, page, pageSize);
  }

  // Committee directory: federal House/Senate/Joint committees and subcommittees,
  // sorted by current staff headcount (then name). Filterable by chamber/kind/text.
  async getCommittees(query: CommitteesQuery = {}): Promise<DirectoryCommitteesPayload> {
    const page = this.browse.toPositiveInt(query.page, 1);
    const pageSize = this.browse.toPositiveInt(
      query.pageSize,
      DirectoryService.DEFAULT_PAGE_SIZE,
      DirectoryService.MAX_PAGE_SIZE,
    );
    const base = await this.getDirectoryData();
    return this.browse.toCommitteesPayload(base.committees, query, page, pageSize);
  }

  // Roster for a single committee. Current staffers first, then alphabetical.
  async getCommitteeStaff(
    committeeId: string,
    query: CommitteeStaffQuery = {},
  ): Promise<DirectoryCommitteeStaffPayload> {
    const page = this.browse.toPositiveInt(query.page, 1);
    const pageSize = this.browse.toPositiveInt(
      query.pageSize,
      DirectoryService.DEFAULT_PAGE_SIZE,
      DirectoryService.MAX_PAGE_SIZE,
    );
    const base = await this.getDirectoryData();
    return this.browse.toCommitteeStaffPayload(
      committeeId,
      base.committees,
      base.committeeStaff,
      query,
      page,
      pageSize,
    );
  }

  /**
   * A committee staffer's locator carries only the staffer id — no committee
   * id — because Outreach's `committee_staff` target source resolves a person,
   * not a roster row. `committeeStaff` is keyed by committee, so this scans
   * every roster for a matching `staff-${id}`. The dataset is a few hundred
   * rows at most (Congressional committee staff), so a linear scan here costs
   * nothing worth caching separately from `getDirectoryData()`'s own cache.
   */
  async getCommitteeStafferById(
    staffId: string,
  ): Promise<{ staffer: DirectoryCommitteeStaffer; sourceId: string } | null> {
    const base = await this.getDirectoryData();
    for (const roster of base.committeeStaff.values()) {
      const found = roster.find((staffer) => staffer.id === staffId);
      if (found) return { staffer: found, sourceId: base.sourceId };
    }
    return null;
  }

  // ---------------------------------------------------------------- Detail + dictionary APIs (Task 12)

  /** Unified people search: name-inverts to members AND staff, optional committee filter. */
  async getPeople(query: {
    q?: string;
    committeeId?: string;
    personType?: string;
    current?: string;
    page?: string;
    pageSize?: string;
  }): Promise<DirectoryPeoplePayload> {
    const base = await this.getDirectoryData();
    const idx = base.indexes;
    const q = String(query.q ?? '').trim();
    const normalizedQ = normalizePersonName(q);
    const personType = this.normalizePersonTypeFilter(query.personType);
    const currentOnly = query.current === 'true';
    const page = this.browse.toPositiveInt(query.page, 1);
    const pageSize = this.browse.toPositiveInt(query.pageSize, DirectoryService.DEFAULT_PAGE_SIZE, 200);

    // Candidate person ids: committee roster (if committeeId) intersected with name match.
    let candidateIds: string[];
    if (query.committeeId) {
      candidateIds = (idx.membershipsByCommitteeId.get(query.committeeId) ?? []).map((m) => m.person.id);
    } else {
      candidateIds = [...idx.membersById.keys()]
        .map((id) => `member-${id}`)
        .concat([...idx.staffById.keys()].map((id) => `staff-${id}`));
    }

    const seen = new Set<string>();
    const results = candidateIds
      .filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
      .map((id) => this.personResult(base, id))
      .filter((r): r is DirectoryPersonResult => r !== null)
      .filter((r) => personType === 'all' || r.personType === personType)
      .filter((r) => !currentOnly || r.isCurrent)
      .filter((r) => !normalizedQ || normalizePersonName(r.fullName).includes(normalizedQ));

    results.sort((a, b) => a.fullName.localeCompare(b.fullName));
    const total = results.length;
    const start = (Math.min(page, Math.max(1, Math.ceil(total / pageSize))) - 1) * pageSize;
    return { people: results.slice(start, start + pageSize), total, page, pageSize };
  }

  async getMemberDetail(memberId: string): Promise<DirectoryMemberDetail> {
    const base = await this.getDirectoryData();
    // Committee rosters identify legislators by Bioguide ID. Their row UUID is
    // a committee membership, not a Directory person. Resolve the explicit
    // official ID through the existing snapshot index and retain the canonical
    // member identity for photos, committees, and related-data endpoints.
    const row = /^[a-z]\d{6}$/i.test(memberId)
      ? base.indexes.membersByBioguideId.get(memberId.toUpperCase())
      : base.indexes.membersById.get(Number(String(memberId).replace(/^member-/, '')));
    if (!row) throw new NotFoundException('Directory member not found');
    return projectMemberDetail(base, row);
  }

  async getStaffDetail(staffId: string): Promise<DirectoryStaffDetail> {
    const base = await this.getDirectoryData();
    const numericId = Number(String(staffId).replace(/^staff-/, ''));
    const row = base.indexes.staffById.get(numericId);
    // A staffer can appear in the directory via a member's roster
    // (staffer_roles/staffer_issues) without having a /staff/list row. Rather than
    // 404 that profile, render a minimal one from the member-side data we do have.
    if (!row) {
      const name = base.indexes.staffNamesByStaffId.get(numericId);
      if (!name) throw new NotFoundException('Directory staffer not found');
      return projectRosterOnlyStaffDetail(base, numericId, name);
    }
    return projectStaffDetail(base, row, numericId);
  }

  async getCommitteeDetail(committeeId: string): Promise<DirectoryCommitteeDetail> {
    const base = await this.getDirectoryData();
    const committee = base.committees.find((c) => c.id === committeeId);
    if (!committee) throw new NotFoundException('Committee not found');
    const parent = committee.parentOfficeId
      ? base.committees.find((c) => c.officeId === committee.parentOfficeId)
      : undefined;
    const subcommittees = base.committees.filter((c) => c.parentOfficeId === committee.officeId);
    const contacts = base.indexes.membershipsByCommitteeId.get(committeeId) ?? [];
    return {
      ...committee,
      parentCommittee: parent
        ? { id: parent.id, officeId: parent.officeId, name: parent.name, kind: parent.kind }
        : null,
      subcommittees: subcommittees.map((c) => ({
        id: c.id,
        officeId: c.officeId,
        name: c.name,
        kind: c.kind,
      })),
      contacts,
      memberCount: contacts.filter((m) => m.membershipType === 'member').length,
      currentStaffCount: contacts.filter((m) => m.membershipType === 'staff' && m.person.isCurrent).length,
    };
  }

  async getCommitteeContacts(
    committeeId: string,
    query: { personType?: string; current?: string; q?: string; role?: string; page?: string; pageSize?: string },
  ): Promise<{ committee: DirectoryCommittee | null; contacts: DirectoryCommitteeMembership[]; total: number; page: number; pageSize: number }> {
    const base = await this.getDirectoryData();
    const committee = base.committees.find((c) => c.id === committeeId) ?? null;
    const roster = base.indexes.membershipsByCommitteeId.get(committeeId) ?? [];
    const personType = this.normalizePersonTypeFilter(query.personType);
    const currentOnly = query.current === 'true';
    const q = normalizePersonName(query.q);
    const role = String(query.role ?? '').trim().toLowerCase();
    const filtered = roster
      .filter((m) => personType === 'all' || m.membershipType === personType)
      .filter((m) => !currentOnly || m.person.isCurrent)
      .filter((m) => !role || (m.position ?? '').toLowerCase().includes(role))
      .filter((m) => !q || normalizePersonName(m.person.fullName).includes(q));
    const page = this.browse.toPositiveInt(query.page, 1);
    const pageSize = this.browse.toPositiveInt(query.pageSize, DirectoryService.DEFAULT_PAGE_SIZE, 500);
    const total = filtered.length;
    const start = (Math.min(page, Math.max(1, Math.ceil(total / pageSize))) - 1) * pageSize;
    return { committee, contacts: filtered.slice(start, start + pageSize), total, page, pageSize };
  }

  private normalizePersonTypeFilter(raw: unknown): 'all' | 'member' | 'staff' {
    return raw === 'member' || raw === 'staff' ? raw : 'all';
  }

  private membershipsForPerson(idx: DirectoryIndexes, personId: string): DirectoryCommitteeMembership[] {
    return membershipsForPerson(idx, personId);
  }

  private personResult(base: CachedContacts['data'], personId: string): DirectoryPersonResult | null {
    if (personId.startsWith('member-')) {
      const id = Number(personId.replace(/^member-/, ''));
      const row = base.indexes.membersById.get(id);
      if (!row) return null;
      const member = (row.member ?? {}) as Record<string, any>;
      const profile = (member.profile ?? {}) as Record<string, any>;
      const office = selectCurrentMemberOffice(row.member_offices) as Record<string, any> | null;
      const overlay = base.photoOverlay.people[personId] ?? null;
      return {
        personType: 'member',
        id: personId,
        fullName: [profile.preferred_first_name ?? profile.first_name, profile.preferred_last_name ?? profile.last_name]
          .filter(Boolean)
          .join(' ')
          .trim(),
        title: office?.office?.name ? String(office.office.name) : '',
        photoUrl: resolveMemberPhoto(row.photos, overlay).url,
        party: typeof office?.party === 'string' ? office.party : null,
        state: typeof office?.state_id === 'string' ? office.state_id : null,
        district: office?.district_no == null ? null : String(office.district_no),
        isCurrent: true,
      };
    }
    const id = Number(personId.replace(/^staff-/, ''));
    const row = base.indexes.staffById.get(id);
    if (!row) return null;
    const staff = (row.staff ?? {}) as Record<string, any>;
    const positions = Array.isArray(row.positions) ? row.positions : [];
    const current = positions.find((p: any) => p?.is_current) ?? positions[0];
    const overlay = base.photoOverlay.people[personId] ?? null;
    return {
      personType: 'staff',
      id: personId,
      fullName: [staff.preferred_first_name ?? staff.first_name, staff.preferred_last_name ?? staff.last_name]
        .filter(Boolean)
        .join(' ')
        .trim(),
      title: current ? String(current.position_title ?? current.position_type ?? 'Staff') : '',
      photoUrl: resolveStaffPhoto(null, overlay).url,
      party: null,
      state: null,
      district: null,
      isCurrent: positions.some((p: any) => p?.is_current === true),
    };
  }

  /** Keep the service seam used by snapshot loading and its characterization tests. */
  private buildCommitteeIndex(officeRaw: unknown, staffRaw: unknown[], membersRaw: unknown[]) {
    return buildCommitteeIndex(officeRaw, staffRaw, membersRaw);
  }

  private buildStafferIndex(contacts: DirectoryContact[]): DirectoryStaffer[] {
    const out: DirectoryStaffer[] = [];
    for (const contact of contacts) {
      const member = {
        id: contact.id,
        fullName: contact.fullName,
        memberName: contact.memberName,
        chamber: contact.chamber,
        state: contact.state,
        district: contact.district,
        party: contact.party,
        partyName: contact.partyName,
        photoUrl: contact.photoUrl,
        title: contact.title,
      };
      for (const staffer of contact.staff) {
        out.push({
          id: staffer.id,
          fullName: staffer.fullName,
          title: staffer.title,
          roles: staffer.roles,
          issueAreas: staffer.issueAreas,
          email: staffer.email,
          phone: staffer.phone,
          officeLocation: staffer.officeLocation || contact.officeLocation,
          member,
        });
      }
    }
    return out.sort((left, right) => left.fullName.localeCompare(right.fullName));
  }

  async findContactsByEmails(emails: string[], limit = 10): Promise<DirectoryEmailMatch[]> {
    const normalizedEmails = uniqueSorted(
      emails
        .map((email) => normalizeEmailAddress(email))
        .filter((email): email is string => Boolean(email)),
    );
    if (!normalizedEmails.length) return [];

    const emailSet = new Set(normalizedEmails);
    const base = await this.getDirectoryData();
    const matches: DirectoryEmailMatch[] = [];
    const seen = new Set<string>();

    for (const contact of base.contacts) {
      const memberEmail = normalizeEmailAddress(contact.email);
      if (memberEmail && emailSet.has(memberEmail)) {
        const key = `${memberEmail}:${contact.id}:member`;
        if (!seen.has(key)) {
          seen.add(key);
          matches.push({
            attendeeEmail: memberEmail,
            matchKind: 'member',
            directoryContactId: contact.id,
            directoryContactName: contact.fullName,
            member: this.toDirectoryMemberContext(contact),
          });
        }
      }

      for (const staffer of contact.staff) {
        const staffEmail = normalizeEmailAddress(staffer.email);
        if (!staffEmail || !emailSet.has(staffEmail)) continue;
        const key = `${staffEmail}:${contact.id}:${staffer.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({
          attendeeEmail: staffEmail,
          matchKind: 'staff',
          directoryContactId: contact.id,
          directoryContactName: contact.fullName,
          member: this.toDirectoryMemberContext(contact),
          staff: {
            id: staffer.id,
            fullName: staffer.fullName,
            title: staffer.title,
            email: staffer.email,
            phone: staffer.phone,
            officeLocation: staffer.officeLocation || contact.officeLocation,
            issueAreas: staffer.issueAreas,
            roles: staffer.roles,
          },
        });
      }
    }

    return matches.slice(0, Math.max(1, Math.min(limit, 500)));
  }

  private async getDirectoryData(): Promise<CachedContacts['data']> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.data;
    }

    const { prefix, previousPrefix } = await this.resolveSnapshotPrefixes();
    // Try the resolved snapshot, then the previous validated snapshot as a rollback
    // path, so a broken/partial current snapshot never blanks the directory.
    const candidates =
      previousPrefix && previousPrefix !== prefix ? [prefix, previousPrefix] : [prefix];

    for (const candidate of candidates) {
      try {
        const payload = await this.loadSnapshot(candidate);
        // 30 min TTL: the cold build (3 gzip S3 pulls + full index build) is
        // expensive and the snapshot changes slowly. With onModuleInit pre-warm,
        // typeahead search stays fast.
        this.cache = { data: payload, expiresAt: now + 30 * 60_000 };
        return payload;
      } catch (error) {
        this.logger.error(
          `Failed to load directory snapshot from s3://${this.bucket}/${candidate}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    // Every candidate failed. Prefer a STALE cache over an empty directory so a
    // transient S3/snapshot problem degrades gracefully instead of blanking the UI.
    if (this.cache) {
      this.logger.warn(
        `Serving STALE directory cache after snapshot load failure (candidates: ${candidates.join(
          ', ',
        )})`,
      );
      return this.cache.data;
    }
    throw new ServiceUnavailableException('Directory data is temporarily unavailable');
  }

  /**
   * Resolve which snapshot prefix to read on this cache rebuild.
   *   - DIRECTORY_S3_PREFIX set  -> emergency PIN (no LATEST.json read, no fallback).
   *   - else                     -> LATEST.json's snapshot_prefix (+ previous for rollback).
   *   - LATEST.json absent/bad   -> the documented default prefix, so the live
   *                                 directory keeps working until the pipeline publishes.
   * Resolved per rebuild (NOT once in the constructor) so rotation is picked up
   * within one cache cycle.
   */
  private async resolveSnapshotPrefixes(): Promise<{
    prefix: string;
    previousPrefix: string | null;
  }> {
    if (this.explicitPrefix) {
      return { prefix: this.explicitPrefix, previousPrefix: null };
    }
    const pointer = await this.fetchJsonSafe<DirectorySnapshotPointer>(this.latestKey);
    const prefix = typeof pointer?.snapshot_prefix === 'string' ? pointer.snapshot_prefix : null;
    if (!prefix) {
      return { prefix: DEFAULT_DIRECTORY_PREFIX, previousPrefix: null };
    }
    const previousPrefix =
      typeof pointer?.previous_snapshot_prefix === 'string' ? pointer.previous_snapshot_prefix : null;
    return { prefix, previousPrefix };
  }

  /** Load + build the full directory payload for one snapshot prefix. */
  private async loadSnapshot(prefix: string): Promise<CachedContacts['data']> {
    const [members, staff, offices] = await Promise.all([
      this.fetchGzipJson<unknown[]>(`${prefix}/combined/member-list-current.json.gz`),
      this.fetchGzipJson<unknown[]>(`${prefix}/combined/staff-list-current.json.gz`),
      this.fetchGzipJson<unknown>(`${prefix}/combined/office-list-current.json.gz`),
    ]);

    const [bioOverlay, pressOverlay] = await Promise.all([
      this.loadBioOverlay(),
      this.loadPressOverlay(),
    ]);
    const photoOverlay = parsePhotoOverlay(await this.fetchJsonSafe<unknown>(this.photoOverlayKey));
    const contacts = this.contactMapper.buildContacts(members, staff, bioOverlay, pressOverlay);
    const staffers = this.buildStafferIndex(contacts);
    const { committees, committeeStaff } = this.buildCommitteeIndex(offices, staff, members);
    // Full person/committee indexes (raw rows + every membership + reverse lookups)
    // layered on the identified committees — powers the detail/dictionary endpoints.
    const indexes = buildDirectoryIndexes({ members, staff, committees });
    const availableStates = uniqueSorted(contacts.map((contact) => contact.state));
    const availableFilters = this.browse.buildAvailableFilters(contacts);
    const totals: DirectoryTotals = {
      all: contacts.length,
      house: contacts.filter((contact) => contact.chamber === 'House').length,
      senate: contacts.filter((contact) => contact.chamber === 'Senate').length,
      governors: contacts.filter((contact) => contact.chamber === 'Governor').length,
      staff: new Set(staffers.map((staffer) => staffer.id)).size,
    };
    // Resolved snapshot prefix is carried in sourceId for provenance/debugging.
    const sourceId = `${this.bucket}/${prefix}`;
    return {
      sourceId,
      contacts,
      staffers,
      committees,
      committeeStaff,
      indexes,
      photoOverlay,
      totals,
      availableStates,
      availableFilters,
    };
  }

  private toDirectoryMemberContext(contact: DirectoryContact): DirectoryEmailMatch['member'] {
    return {
      id: contact.id,
      bioguideId: contact.bioguideId,
      fullName: contact.fullName,
      memberName: contact.memberName,
      title: contact.title,
      chamber: contact.chamber,
      state: contact.state,
      district: contact.district,
      partyName: contact.partyName,
      officeLocation: contact.officeLocation,
      phone: contact.phone,
      email: contact.email,
      bio: contact.bio,
      committees: contact.committees,
      leadershipPositions: contact.leadershipPositions,
      focusAreas: contact.focusAreas,
      addresses: contact.addresses,
    };
  }

  // ── Internal bridge (apps/workspace Hill Day workflow) ────────────────────
  // The workspace service cannot read the LegiStorm snapshot (S3 + this
  // in-memory cache), so it resolves attendee addresses through these
  // backend-only reads. All of them are pure lookups over the cached data.

  /**
   * Committee staff by email. Committee staffers live on committee rosters,
   * not on any member's staff list, so findContactsByEmails never sees them —
   * a SASC professional staff member on an invite would otherwise resolve to
   * "no Directory record".
   */
  async findCommitteeStaffByEmails(
    emails: string[],
    limit = 200,
  ): Promise<DirectoryCommitteeStaffEmailMatch[]> {
    const wanted = new Set(
      emails.map((e) => normalizeEmailAddress(e)).filter((e): e is string => Boolean(e)),
    );
    if (!wanted.size) return [];
    const base = await this.getDirectoryData();
    const names = new Map(base.committees.map((c) => [c.id, c.name]));
    const out: DirectoryCommitteeStaffEmailMatch[] = [];
    const seen = new Set<string>();
    for (const [committeeId, roster] of base.committeeStaff) {
      for (const staffer of roster) {
        const email = normalizeEmailAddress(staffer.email);
        if (!email || !wanted.has(email)) continue;
        const key = `${email}:${staffer.id}:${committeeId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          attendeeEmail: email,
          staff: {
            id: staffer.id,
            fullName: staffer.fullName,
            title: staffer.title,
            email: staffer.email,
            isCurrent: staffer.isCurrent,
          },
          committee: {
            id: committeeId,
            name: names.get(committeeId) ?? staffer.committee.name,
            chamber: staffer.committee.chamber,
            kind: staffer.committee.kind,
          },
        });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** One member (contact id `member-123`, or the bare number) in the bridge shape. */
  async getMemberContextById(contactId: string): Promise<DirectoryMemberContext | null> {
    const id = normalizeContactId(contactId);
    const key = /^member-/.test(id) ? id : `member-${id}`;
    const base = await this.getDirectoryData();
    const contact = base.contacts.find((c) => c.id === key);
    return contact ? this.toMemberContext(base, contact) : null;
  }

  /** Member search for the "change office" / invite-domain flows. */
  async searchMemberContexts(
    q: string,
    chamber: string | undefined,
    limit = 10,
  ): Promise<DirectoryMemberContext[]> {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const base = await this.getDirectoryData();
    const chamberFilter = chamber?.trim().toLowerCase() || null;
    const hits = base.contacts.filter((c) => {
      if (chamberFilter && c.chamber.toLowerCase() !== chamberFilter) return false;
      const blob = [c.fullName, c.memberName, c.state, c.district, c.office]
        .join(' ')
        .toLowerCase();
      return blob.includes(needle);
    });
    return hits.slice(0, Math.max(1, Math.min(limit, 50))).map((c) => this.toMemberContext(base, c));
  }

  /** One staffer (`staff-123`) with their member's context, for the assign flow. */
  async getStafferContextById(staffId: string): Promise<DirectoryStafferContext | null> {
    const id = normalizeContactId(staffId);
    const key = /^staff-/.test(id) ? id : `staff-${id}`;
    const base = await this.getDirectoryData();
    const staffer = base.staffers.find((s) => s.id === key);
    if (!staffer) return null;
    return this.toStafferContext(base, staffer);
  }

  async searchStafferContexts(q: string, limit = 12): Promise<DirectoryStafferContext[]> {
    const payload = await this.getStaffers({ q, pageSize: Math.max(1, Math.min(limit, 50)) });
    const base = await this.getDirectoryData();
    return payload.staffers.map((s) => this.toStafferContext(base, s));
  }

  private toStafferContext(
    base: CachedContacts['data'],
    staffer: DirectoryStaffer,
  ): DirectoryStafferContext {
    const contact = base.contacts.find((c) => c.id === staffer.member.id) ?? null;
    return {
      id: staffer.id,
      fullName: staffer.fullName,
      title: staffer.title,
      roles: staffer.roles,
      issueAreas: staffer.issueAreas,
      email: staffer.email,
      officeLocation: staffer.officeLocation,
      member: contact ? this.toMemberContext(base, contact) : null,
    };
  }

  private toMemberContext(
    base: CachedContacts['data'],
    contact: DirectoryContact,
  ): DirectoryMemberContext {
    const memberships = this.membershipsForPerson(base.indexes, contact.id).filter(
      (m) => m.endedAt === null,
    );
    const committeeNames = new Map(base.committees.map((c) => [c.id, c.name]));
    const committeesWithRole = memberships.map((m) => ({
      name: committeeNames.get(m.committeeId) ?? m.committeeId,
      role: m.position && !/^member$/i.test(m.position) ? m.position : null,
    }));
    return {
      id: contact.id,
      bioguideId: contact.bioguideId,
      fullName: contact.fullName,
      memberName: contact.memberName,
      honorific: contact.honorific,
      title: contact.title,
      chamber: contact.chamber,
      state: contact.state,
      district: contact.district,
      party: contact.party,
      partyName: contact.partyName,
      officeLocation: contact.officeLocation,
      phone: contact.phone,
      email: contact.email,
      bioNarrative: contact.bio?.narrative ?? '',
      committees: contact.committees,
      committeesWithRole,
      committeeLeadership: contact.committeeLeadership,
      leadershipPositions: contact.leadershipPositions,
      focusAreas: contact.focusAreas,
      topIssues: contact.topIssues,
      staff: contact.staff.map((s) => ({
        id: s.id,
        fullName: s.fullName,
        title: s.title,
        roles: s.roles,
        issueAreas: s.issueAreas,
        email: s.email,
        isCurrent: s.isCurrent,
      })),
    };
  }

  listContactNotes(ctx: TenantContext, contactId: string) {
    const normalizedContactId = normalizeContactId(contactId);
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.directoryContactNote.findMany({
        where: {
          tenantId: ctx.tenantId,
          directoryContactId: normalizedContactId,
        },
        select: {
          id: true,
          directoryContactId: true,
          directoryContactName: true,
          body: true,
          createdAt: true,
          createdBy: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /**
   * District Impact Engine (Phase 1 M1.4) — "Represents client facilities":
   * for one directory member, every client (tenant-wide, any client) with at
   * least one facility in this member's district. Deterministic (PD2) — the
   * exact join discovery confirmed "does NOT exist today" (facility-district
   * <-> directory member had no live path). House at-large uses the same
   * sentinel rule as the forward resolver (`districtNo > 0` here mirrors
   * `formatDistrict`'s own convention for "this member has no numbered
   * district").
   */
  async getMemberRepresentationSummary(ctx: TenantContext, contactId: string) {
    const normalizedContactId = normalizeContactId(contactId);
    const { contacts } = await this.getDirectoryData();
    const contact = contacts.find((c) => c.id === normalizedContactId);
    if (!contact || contact.chamber === 'Governor' || !contact.bioguideId) return { clients: [] };
    const clients = await this.representation.clientsRepresentedByMember(ctx.tenantId, {
      bioguideId: contact.bioguideId,
      chamber: contact.chamber === 'Senate' ? 'senate' : 'house',
      state: contact.state,
      district: this.houseDistrictNoForRepresentation(contact),
    });
    return { clients };
  }

  /**
   * Recover the bare House district number from a directory contact's DISPLAY
   * `district` (built by `formatDistrict` as 'FL-8' for a real seat, or the
   * bare state 'FL' for Senate/at-large/unresolvable). `Number(contact.district)`
   * cannot parse the 'FL-8' display form (NaN), which previously collapsed a
   * real House member's district to null and broke the House inverse join while
   * leaving Senators unaffected.
   *
   * At-largeness is derived from US_HOUSE_SEATS (a single-seat state's 'ST'
   * display maps to null), matching the resolver's '00' <-> null convention; a
   * multi-seat state with no parseable district number stays null rather than
   * guessing a seat.
   */
  private houseDistrictNoForRepresentation(contact: {
    chamber: Chamber;
    state: string;
    district: string;
  }): number | null {
    if (contact.chamber !== 'House') return null;
    const state = (contact.state ?? '').trim().toUpperCase();
    if (US_HOUSE_SEATS[state] === 1) return null;
    const raw = (contact.district ?? '').trim().toUpperCase();
    // Strictly the observed display forms: a bare integer ('8' / '08') or the
    // state-prefixed 'FL-8' built by formatDistrict. A state prefix must match
    // the contact's own state; anything else (junk prefix, 3+ digits, sentinel
    // codes) is not a House seat we can assert — stay null, never guess.
    const parse = (digits: string): number | null => {
      if (UNRESOLVABLE_HOUSE_SENTINELS.has(digits.padStart(2, '0'))) return null;
      const districtNo = Number(digits);
      return districtNo > 0 ? districtNo : null;
    };
    const bare = /^(\d{1,2})$/.exec(raw);
    if (bare) return parse(bare[1]!);
    const prefixed = /^([A-Z]{2})-(\d{1,2})$/.exec(raw);
    if (prefixed && prefixed[1] === state) return parse(prefixed[2]!);
    return null;
  }

  /**
   * Member-scoped FEC summary (Gap #1): for one directory member, surface the
   * financial relationship with the tenant's mapped clients — contributions whose
   * recipient candidate matches this member, from employers tied to a confirmed
   * fec_employer client mapping, grouped by client.
   *
   * IMPORTANT — this is an APPROXIMATE, name-matched view. FEC contributions link to
   * members only by candidate name (no shared ID), so the API returns matchQuality
   * and the disclaimer; the UI labels it accordingly. It is read-only context, not
   * an assertion, and never a contribution recommendation. Tenant-scoped via the
   * confirmed client mappings; fec_contribution is a global read-only table.
   */
  async getMemberFecSummary(ctx: TenantContext, contactId: string) {
    const normalizedContactId = normalizeContactId(contactId);
    const { contacts } = await this.getDirectoryData();
    const contact = contacts.find((c) => c.id === normalizedContactId);
    const empty = {
      contactId: normalizedContactId,
      memberName: contact?.memberName ?? null,
      matchQuality: 'name_approximate' as const,
      clients: [] as Array<{
        clientId: string;
        clientName: string;
        mappedEmployer: string;
        totalAmount: number;
        contributionCount: number;
        latestContributionDate: Date | null;
      }>,
      summary: { totalAmount: 0, contributionCount: 0, clientCount: 0 },
      disclaimer: FEC_DISCLAIMER,
    };
    if (!contact || !contact.memberName?.trim()) return empty;

    // Confirmed fec_employer mappings for this tenant's clients (the only employers
    // we attribute). Tenant-scoped read.
    const mappings = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { source: 'fec_employer', confirmed: true },
        select: { clientId: true, externalName: true },
      }),
    );
    if (mappings.length === 0) return empty;

    const employers = Array.from(
      new Set(mappings.map((m) => (m.externalName ?? '').trim().toLowerCase()).filter(Boolean)),
    );
    if (employers.length === 0) return empty;

    // Resolve client names (tenant-scoped) for display.
    const clientIds = Array.from(new Set(mappings.map((m) => m.clientId)));
    const clientRows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }),
    );
    const clientNameById = new Map(clientRows.map((c) => [c.id, c.name]));

    // Match contributions to this member by candidate name (approximate) for the
    // mapped employers. fec_contribution is a global, read-only table.
    const rows = await this.prisma.$queryRaw<
      Array<{
        contributor_employer: string;
        total_amount: number;
        contribution_count: number;
        latest_contribution_date: Date | null;
      }>
    >`
      SELECT
        LOWER(fc.contributor_employer) AS contributor_employer,
        COALESCE(SUM(fc.amount), 0)::float AS total_amount,
        COUNT(*)::int AS contribution_count,
        MAX(fc.contribution_date) AS latest_contribution_date
      FROM fec_contribution fc
      WHERE LOWER(fc.contributor_employer) = ANY(${employers}::text[])
        AND LOWER(fc.candidate_name) = LOWER(${contact.memberName.trim()})
      GROUP BY LOWER(fc.contributor_employer)
    `;

    const byEmployer = new Map(rows.map((r) => [r.contributor_employer, r]));
    const clients = mappings
      .map((m) => {
        const key = (m.externalName ?? '').trim().toLowerCase();
        const row = byEmployer.get(key);
        if (!row || row.total_amount <= 0) return null;
        return {
          clientId: m.clientId,
          clientName: clientNameById.get(m.clientId) ?? 'Unknown client',
          mappedEmployer: (m.externalName ?? '').trim(),
          totalAmount: row.total_amount,
          contributionCount: row.contribution_count,
          latestContributionDate: row.latest_contribution_date,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => b.totalAmount - a.totalAmount);

    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'directory.member_fec_summary.view',
          entityType: 'directory_contact',
          entityId: normalizedContactId,
          after: { memberName: contact.memberName, clientCount: clients.length },
        },
      });
    });

    return {
      contactId: normalizedContactId,
      memberName: contact.memberName,
      matchQuality: 'name_approximate' as const,
      clients,
      summary: {
        totalAmount: clients.reduce((s, c) => s + c.totalAmount, 0),
        contributionCount: clients.reduce((s, c) => s + c.contributionCount, 0),
        clientCount: clients.length,
      },
      disclaimer: FEC_DISCLAIMER,
    };
  }

  async createContactNote(
    ctx: TenantContext,
    contactId: string,
    input: CreateDirectoryContactNoteInput,
  ) {
    const normalizedContactId = normalizeContactId(contactId);
    const body = input.body.trim();
    if (!body) throw new BadRequestException('Note body is required');
    if (body.length > 4000)
      throw new BadRequestException('Note body must be 4000 characters or less');

    const directoryContactName = input.directoryContactName?.trim().slice(0, 240) || null;

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const note = await tx.directoryContactNote.create({
        data: {
          tenantId: ctx.tenantId,
          directoryContactId: normalizedContactId,
          directoryContactName,
          body,
          createdByUserId: ctx.userId,
        },
        select: {
          id: true,
          directoryContactId: true,
          directoryContactName: true,
          body: true,
          createdAt: true,
          createdBy: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'directory_contact_note.created',
          entityType: 'directory_contact_note',
          entityId: note.id,
          after: {
            directoryContactId: normalizedContactId,
            directoryContactName,
          },
        },
      });

      return note;
    });
  }

  /** Current user's favorited directory members (ids + names). */
  listFavorites(ctx: TenantContext) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.directoryContactFavorite.findMany({
        where: { tenantId: ctx.tenantId, userId: ctx.userId },
        select: { directoryContactId: true, directoryContactName: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async addFavorite(ctx: TenantContext, contactId: string, directoryContactName?: string) {
    const normalizedContactId = normalizeContactId(contactId);
    const name = directoryContactName?.trim().slice(0, 240) || null;
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.directoryContactFavorite.upsert({
        where: {
          tenantId_userId_directoryContactId: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            directoryContactId: normalizedContactId,
          },
        },
        create: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          directoryContactId: normalizedContactId,
          directoryContactName: name,
        },
        update: { directoryContactName: name },
      }),
    );
    return { ok: true, directoryContactId: normalizedContactId, favorited: true };
  }

  async removeFavorite(ctx: TenantContext, contactId: string) {
    const normalizedContactId = normalizeContactId(contactId);
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.directoryContactFavorite.deleteMany({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          directoryContactId: normalizedContactId,
        },
      }),
    );
    return { ok: true, directoryContactId: normalizedContactId, favorited: false };
  }

  // ── WS-D, LegiStorm gaps/enrichment plan: House-district detail + boundary ──
  // Reads legislative_district (WS-B's Postgres table, NOT an S3 overlay —
  // the original plan draft assumed an overlay before WS-B's storage design
  // was decided; this targets what WS-B actually built). currentMemberBioguides
  // on that table already gives the district->member mapping directly from
  // the vendor, so — unlike the plan draft's original assumption — NO reverse
  // index needs to be built in directory-indexes.ts; resolving each bioguide
  // against the existing snapshot's contacts is enough.

  /** House-district detail for `state`/`districtNo` (client_facilities-style
   * code: '00' for at-large, zero-padded 2-digit otherwise), 'C' (current) or
   * 'F' (future/enacted-not-yet-effective) — two DISTINCT rows, never merged. */
  async getDistrictDetail(
    state: string,
    facilityDistrictNo: string,
    status: 'C' | 'F' = 'C',
  ): Promise<DirectoryDistrictDetail> {
    const row = await this.resolveLegislativeDistrict(
      state.trim().toUpperCase(),
      facilityDistrictNo,
      status,
    );
    if (!row) throw new NotFoundException('District not found');

    const base = await this.getDirectoryData();
    const byBioguide = new Map(base.contacts.map((c) => [c.bioguideId, c] as const));
    const currentMembers: DirectoryDistrictMemberSummary[] = row.currentMemberBioguides
      .map((bioguideId) => byBioguide.get(bioguideId))
      .filter((c): c is DirectoryContact => c !== undefined)
      .map((c) => ({
        id: c.id,
        bioguideId: c.bioguideId,
        fullName: c.fullName,
        partyName: c.partyName ?? null,
        chamber: c.chamber,
        photoUrl: c.photoUrl || null,
        outgoingStatus: c.outgoingStatus,
      }));

    return {
      id: row.id,
      legistormDistrictId: row.legistormDistrictId,
      chamber: row.chamber as 'house' | 'senate',
      state: row.state,
      districtNo: facilityDistrictNo,
      name: row.name,
      // Not row.status: the query already filtered on this exact `status`
      // parameter, so it's guaranteed to match by construction — using the
      // input avoids trusting an unenforced assumption about row.status's
      // literal type (a plain String column, not a Prisma enum).
      status,
      effectiveDate: row.effectiveDate ? row.effectiveDate.toISOString().slice(0, 10) : null,
      enactedDate: row.enactedDate ? row.enactedDate.toISOString().slice(0, 10) : null,
      currentMembers,
      hasBoundary: row.kmlS3Key !== null,
      syncedAt: row.syncedAt.toISOString(),
    };
  }

  /**
   * Stream the district boundary from OUR OWN S3 (WS-B's kmlS3Key) — this is
   * NEVER a live proxy to LegiStorm. Two reasons: (1) WS-B already fetches
   * and re-hosts the boundary under our own key when run with --with-kml,
   * specifically so the raw vendor URL (which embeds our API key in its
   * path) never needs to be handled again after that point; (2)
   * LEGISTORM_API_KEY is deliberately withheld from the long-lived api/serve
   * task def (compute-stack.ts's apiSyncSecrets comment: "the long-lived
   * API/web tasks never receive LEGISTORM_API_KEY, only the ephemeral sync
   * task does") — this controller runs in that long-lived task, so it must
   * not need that secret at all.
   */
  async getDistrictKml(
    state: string,
    facilityDistrictNo: string,
    status: 'C' | 'F' = 'C',
  ): Promise<{ filename: string; buffer: Buffer }> {
    const row = await this.resolveLegislativeDistrict(
      state.trim().toUpperCase(),
      facilityDistrictNo,
      status,
    );
    if (!row) throw new NotFoundException('District not found');
    if (!row.kmlS3Key) {
      throw new NotFoundException('Boundary not yet available for this district');
    }

    const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: row.kmlS3Key }));
    if (!out.Body) throw new NotFoundException('Boundary object missing from storage');
    const bytes = await out.Body.transformToByteArray();
    return { filename: `${row.id}.kml`, buffer: Buffer.from(bytes) };
  }

  /**
   * WS-D — the boundary artifact manifest: how a client discovers which
   * content-hashed GeoJSON artifact is current. Read straight from S3 rather
   * than the database because the manifest is the artifact set's own source of
   * truth (the builder writes both together, and the per-district columns on
   * legislative_district are a denormalized convenience, not the index).
   */
  async getBoundaryManifest(status: 'C' | 'F'): Promise<BoundaryManifest> {
    const key = manifestKey(status);
    let raw: string;
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) throw new NotFoundException('Boundary manifest missing from storage');
      raw = await out.Body.transformToString();
    } catch (error) {
      // A missing manifest is the normal pre-build state, not a server fault —
      // and for status 'F' it stays missing until the --with-kml backfill runs.
      if (error instanceof NotFoundException) throw error;
      throw new NotFoundException(
        `No boundary artifact has been published for status ${status} yet`,
      );
    }
    try {
      return JSON.parse(raw) as BoundaryManifest;
    } catch {
      throw new ServiceUnavailableException('Boundary manifest is corrupt');
    }
  }

  /**
   * WS-D — stream the artifact the manifest points at, same-origin, so the
   * bucket stays private (signed URLs are the fallback, not the default).
   *
   * The body is stored gzipped, and is returned still gzipped with its hash:
   * the caller sets `Content-Encoding: gzip` and an `ETag`, so the ~5 MB
   * national artifact is never decompressed in this process just to be
   * recompressed on the wire.
   */
  async getBoundaryArtifact(
    status: 'C' | 'F',
  ): Promise<{ gzipped: Buffer; hash: string; districtCount: number }> {
    const manifest = await this.getBoundaryManifest(status);
    // Recomputed rather than read off the manifest: the key is content-addressed
    // from exactly these three values, so deriving it here keeps the bucket
    // layout out of a browser-facing document without adding a lookup.
    const key = artifactKey(status, manifest.vintage, manifest.hash);
    const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!out.Body) {
      // Manifest present but artifact gone: the pointer is dangling, which is a
      // storage inconsistency rather than a "not built yet".
      throw new ServiceUnavailableException('Boundary artifact missing for the published manifest');
    }
    const bytes = await out.Body.transformToByteArray();
    return {
      gzipped: Buffer.from(bytes),
      hash: manifest.hash,
      districtCount: manifest.districtCount,
    };
  }

  private async resolveLegislativeDistrict(
    state: string,
    facilityDistrictNo: string,
    status: 'C' | 'F',
  ) {
    // Senate seats are statewide (no district_no concept at all — matches
    // WS-C's own scoping); this endpoint's :districtNo path segment only
    // makes sense for House seats.
    const houseRows = await this.prisma.legislativeDistrict.findMany({
      where: { state, status, chamber: 'house' },
    });
    return matchFacilityDistrictCode(houseRows, facilityDistrictNo);
  }

  private async fetchGzipJson<T>(key: string): Promise<T> {
    const out = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );

    if (!out.Body) throw new Error(`No body for s3://${this.bucket}/${key}`);
    const bytes = await out.Body.transformToByteArray();
    const json = gunzipSync(Buffer.from(bytes)).toString('utf8');
    return JSON.parse(json) as T;
  }

  // Fetch a plain (non-gzipped) JSON object from S3. Returns null on any
  // failure so a missing/broken overlay can never take down the directory.
  private async fetchJsonSafe<T>(key: string): Promise<T | null> {
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) return null;
      const text = await out.Body.transformToString();
      return JSON.parse(text) as T;
    } catch (error) {
      this.logger.warn(
        `Optional directory JSON unavailable at s3://${this.bucket}/${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  // Member narrative-bio overlay, keyed by bioguide_id. Stored OUTSIDE the
  // vendor LegiStorm snapshot so snapshot rotation never clobbers it. Merged
  // into the structured LegiStorm bio at read-time; failure is non-fatal.
  private async loadBioOverlay(): Promise<Map<string, MemberBioOverlay>> {
    const overlay = await this.fetchJsonSafe<{
      members?: Record<string, MemberBioOverlay>;
    }>(this.bioOverlayKey);
    const map = new Map<string, MemberBioOverlay>();
    if (overlay?.members) {
      for (const [bioguideId, entry] of Object.entries(overlay.members)) {
        if (bioguideId && entry) map.set(bioguideId, entry);
      }
    }
    return map;
  }

  // Member press/RSS overlay (member-press-v1.json), keyed by bioguide_id. Same
  // out-of-band mechanism as the bio overlay — stored OUTSIDE the LegiStorm
  // snapshot so snapshot rotation never clobbers it. Failure is non-fatal.
  private async loadPressOverlay(): Promise<Map<string, MemberPressOverlay>> {
    const overlay = await this.fetchJsonSafe<{
      members?: Record<string, MemberPressOverlay>;
    }>(this.pressOverlayKey);
    const map = new Map<string, MemberPressOverlay>();
    if (overlay?.members) {
      for (const [bioguideId, entry] of Object.entries(overlay.members)) {
        if (bioguideId && entry) map.set(bioguideId, entry);
      }
    }
    return map;
  }

  // ---- Member news (pre-ingested press items; served from member_press_item) ----

  private async resolveContact(contactId: string): Promise<DirectoryContact> {
    const id = normalizeContactId(contactId);
    const contacts = await this.getAllContacts();
    const contact = contacts.find((c) => c.id === id);
    if (!contact) throw new NotFoundException('Directory member not found');
    return contact;
  }

  /**
   * The member's recent press items for the News tab. Served straight from
   * member_press_item (populated every ~3 days by scripts/sync-member-press.ts);
   * there is NO live feed fetch on profile view. newsPressUrl/rssFeedUrl come from
   * the press overlay merged onto the contact (header links + empty states).
   */
  async getMemberNews(contactId: string): Promise<MemberNewsPayload> {
    const contact = await this.resolveContact(contactId);
    const rssFeedUrl = contact.rssFeedUrl?.trim() || null;
    const newsPressUrl = contact.newsPressUrl?.trim() || null;

    const rows = await this.prisma.memberPressItem.findMany({
      where: { bioguideId: contact.bioguideId },
      orderBy: [{ publishedAt: 'desc' }, { syncedAt: 'desc' }],
      take: 50,
    });

    const items: MemberNewsItem[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      link: r.link,
      publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
      summary: r.summary ?? '',
    }));
    const lastSynced = rows.reduce<Date | null>(
      (max, r) => (!max || r.syncedAt > max ? r.syncedAt : max),
      null,
    );

    return {
      contactId: contact.id,
      memberName: contact.memberName,
      newsPressUrl,
      rssFeedUrl,
      rssSource: contact.rssSource?.trim() || null,
      items,
      lastSyncedAt: lastSynced ? lastSynced.toISOString() : null,
      // Only "no feed configured at all" remains a soft state; otherwise it's just
      // an empty list (nothing ingested yet / the feed had no items).
      feedError: !rssFeedUrl && items.length === 0 ? 'no_feed' : null,
    };
  }

  /**
   * Privately funded travel for a member OR staffer profile (WS-F, LegiStorm
   * gaps/enrichment plan). Works for either — legistorm_trip denormalizes
   * approver/traveler display names at ingest time, so this needs NO
   * directory round-trip at all, unlike getMemberFecSummary/getMemberNews
   * above. A member can appear as either role (they approved a staffer's
   * trip, or traveled themselves); a staffer only ever appears as a
   * traveler. Deliberately does NOT validate that contactId corresponds to
   * a real, existing contact — every caller reaches this from an
   * already-valid profile page, and legistorm_trip is a global (no-RLS)
   * table, so the extra existence check would only add cost, not safety.
   */
  async getContactTrips(contactId: string): Promise<DirectoryContactTripsPayload> {
    const normalizedContactId = normalizeContactId(contactId);
    const isStaff = normalizedContactId.startsWith('staff-');
    const numericId = Number(normalizedContactId.replace(/^(member|staff)-/, ''));
    if (!Number.isFinite(numericId)) {
      return { contactId: normalizedContactId, trips: [] };
    }

    const rows = await this.prisma.legistormTrip.findMany({
      where: isStaff
        ? { travelerStaffId: numericId }
        : { OR: [{ approverMemberId: numericId }, { travelerMemberId: numericId }] },
      orderBy: [{ startDate: 'desc' }, { filedDate: 'desc' }],
      take: 50,
    });

    const trips: DirectoryContactTripSummary[] = rows.map((t) => {
      // A member could theoretically be both approver and traveler on the
      // same trip (self-approved travel) — prefer the more specific
      // 'traveler' role in that case, never a false 'approver' label.
      const role: 'approver' | 'traveler' =
        !isStaff && t.approverMemberId === numericId && t.travelerMemberId !== numericId
          ? 'approver'
          : 'traveler';
      return {
        id: t.id,
        role,
        otherPartyName: role === 'approver' ? t.travelerName : t.approverName,
        companionName: t.companionName,
        startDate: t.startDate ? t.startDate.toISOString().slice(0, 10) : null,
        endDate: t.endDate ? t.endDate.toISOString().slice(0, 10) : null,
        durationDays: t.durationDays,
        purpose: t.purpose,
        totalCost: t.totalCost,
        destinations: Array.isArray(t.destinations)
          ? (t.destinations as Array<{ id: number; name: string | null; stateId: string | null }>)
          : [],
        sponsors: Array.isArray(t.sponsors)
          ? (t.sponsors as Array<{ id: number; name: string | null }>)
          : [],
        filedDate: t.filedDate ? t.filedDate.toISOString().slice(0, 10) : null,
      };
    });

    return { contactId: normalizedContactId, trips };
  }

}

function normalizeContactId(contactId: string): string {
  const normalized = contactId.trim();
  if (!normalized) throw new BadRequestException('Directory contact id is required');
  if (normalized.length > 120) throw new BadRequestException('Directory contact id is too long');
  return normalized;
}

function normalizeEmailAddress(value: string | null | undefined): string | null {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/^mailto:/, '');
  if (!normalized) return null;
  const match = normalized.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/);
  return match?.[0] ?? null;
}

/**
 * WS-D — bridge a client_facilities-style district code ('00' for at-large,
 * zero-padded 2-digit otherwise — the URL path convention) back to
 * LegiStorm's own raw districtNo storage, given the House rows already
 * fetched for a state+status.
 *
 * Implementation moved to `common/district-code.util.ts` (§7-A1) alongside the
 * other five district-code helpers; re-exported here to keep this path working
 * for existing importers and specs.
 */
export { matchFacilityDistrictCode };
