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
import { PrismaService } from '../prisma/prisma.service.js';
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
  memberPhotoRecords,
  parsePhotoOverlay,
  resolveMemberPhoto,
  resolveStaffPhoto,
  type DirectoryPhotoOverlay,
} from './directory-photo.js';
import type {
  DirectoryCommitteeDetail,
  DirectoryDistrictDetail,
  DirectoryDistrictMemberSummary,
  DirectoryMemberDetail,
  DirectoryPeoplePayload,
  DirectoryPersonResult,
  DirectoryStaffDetail,
} from './directory-detail.types.js';

type Chamber = 'House' | 'Senate' | 'Governor';
type Party = 'D' | 'R' | 'I';
type Region = 'Northeast' | 'South' | 'Midwest' | 'West';

export type CommitteeChamber = 'House' | 'Senate' | 'Joint';
export type CommitteeKind = 'committee' | 'subcommittee';

// Federal congressional committee offices in the LegiStorm office-list, keyed by
// their `office_type`. The snapshot is dominated by ~2,300 STATE-legislature
// committees; this whitelist keeps only the federal House/Senate/Joint committees
// and subcommittees (~234 offices) so committee staff don't get polluted with
// state offices.
const FED_COMMITTEE_OFFICE_TYPES: Record<
  string,
  { chamber: CommitteeChamber; kind: CommitteeKind }
> = {
  'House Committee': { chamber: 'House', kind: 'committee' },
  'Senate Committee': { chamber: 'Senate', kind: 'committee' },
  'Joint Committee': { chamber: 'Joint', kind: 'committee' },
  'House Subcommittee': { chamber: 'House', kind: 'subcommittee' },
  'Senate Subcommittee': { chamber: 'Senate', kind: 'subcommittee' },
};

export interface DirectoryAddress {
  id: string;
  title: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  fax: string;
  isMain: boolean;
}

export interface DirectoryLink {
  label: string;
  url: string;
  type: string;
}

export interface DirectoryStaffMember {
  id: string;
  fullName: string;
  title: string;
  roles: string[];
  issueAreas: string[];
  email: string;
  phone: string;
  officeLocation: string;
}

export interface DirectoryContact {
  id: string;
  memberId: number;
  bioguideId: string;
  fullName: string;
  memberName: string;
  honorific: string;
  photoUrl: string;
  title: string;
  office: string;
  chamber: Chamber;
  state: string;
  district: string;
  party: Party;
  partyName: string;
  gender: 'F' | 'M' | 'Unknown';
  region: Region;
  isFreshman: boolean;
  servingSince: string;
  focusAreas: string[];
  committees: string[];
  committeeLeadership: string[];
  topIssues: Array<{ issue: string; stafferCount: number }>;
  leadershipPositions: string[];
  caucuses: string[];
  educationInstitutions: string[];
  senateClass: number | null;
  outgoingStatus: string | null;
  officeLocation: string;
  phone: string;
  fax: string;
  email: string;
  contactFormUrl: string;
  // Press/RSS overlay (member-press-v1.json, keyed by bioguide_id). Out-of-band
  // overlay merged at read-time — empty string when the member has no entry.
  newsPressUrl: string;
  rssFeedUrl: string;
  rssSource: string;
  officialLinks: DirectoryLink[];
  addresses: DirectoryAddress[];
  staff: DirectoryStaffMember[];
  /**
   * Populated ONLY by contacts search (`GET /contacts?q=…`) when the query
   * matched this office via one or more STAFFERS rather than the member's own
   * name/office — so the UI can explain why an office with a non-matching member
   * name was returned ("matched via staffer X"). Omitted on every other read.
   */
  matchedStaff?: Array<{ fullName: string; title: string }>;
  bio: {
    dob: string;
    hometown: string;
    birthplace: string;
    occupation: string;
    race: string;
    religion: string;
    pronunciation: string;
    narrative: string;
    education: string;
    military: string;
    relatives: string;
  };
  lastTouchpoint: string;
  owner: string;
  relationshipTier: 'Core' | 'Active' | 'Watch';
  notes: string;
  recentInteractions: Array<{
    date: string;
    channel: 'Call' | 'Email' | 'Meeting' | 'Dinner' | 'Briefing';
    summary: string;
  }>;
}

// Press/RSS overlay entry (member-press-v1.json), keyed by bioguide_id.
interface MemberPressOverlay {
  newsPressUrl?: string;
  rssFeedUrl?: string;
  rssSource?: string;
}

// One press item served from member_press_item (ingested by sync-member-press).
export interface MemberNewsItem {
  id: string;
  title: string;
  link: string;
  publishedAt: string | null; // ISO 8601, or null when the feed gave no date
  summary: string; // plain-text excerpt from the feed (NOT the full article)
}

// Payload for GET /directory/contacts/:id/news — the member's stored press items
// (latest first) + their press/RSS URLs. Pre-ingested; no live fetch on read.
export interface MemberNewsPayload {
  contactId: string;
  memberName: string;
  newsPressUrl: string | null;
  rssFeedUrl: string | null;
  rssSource: string | null;
  items: MemberNewsItem[];
  lastSyncedAt: string | null;
  feedError: 'no_feed' | null;
}

type DirectorySort = 'recent' | 'name-asc' | 'name-desc' | 'state-asc' | 'chamber' | 'party';

export interface DirectoryQuery {
  q?: string;
  freshman?: string;
  chamber?: string;
  party?: string | string[];
  gender?: string;
  leadership?: string | string[];
  caucus?: string | string[];
  committee?: string | string[];
  state?: string | string[];
  district?: string | string[];
  education?: string | string[];
  region?: string;
  sort?: string;
  page?: string | number;
  pageSize?: string | number;
}

export interface DirectoryTotals {
  all: number;
  house: number;
  senate: number;
  governors: number;
  staff: number;
}

export interface DirectoryStaffer {
  id: string;
  fullName: string;
  title: string;
  roles: string[];
  issueAreas: string[];
  email: string;
  phone: string;
  officeLocation: string;
  member: {
    id: string;
    fullName: string;
    memberName: string;
    chamber: Chamber;
    state: string;
    district: string;
    party: Party;
    partyName: string;
    photoUrl: string;
    title: string;
  };
}

export interface DirectoryStaffersPayload {
  staffers: DirectoryStaffer[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StaffersQuery {
  q?: string;
  chamber?: string;
  state?: string | string[];
  issue?: string | string[];
  page?: string | number;
  pageSize?: string | number;
}

export interface CommitteeMemberRef {
  id: string; // `member-${memberId}`
  name: string;
}

export interface DirectoryCommittee {
  id: string; // `committee-${officeId}`
  officeId: number;
  name: string;
  chamber: CommitteeChamber;
  kind: CommitteeKind;
  committeeCode: string | null;
  parentOfficeId: number | null; // subcommittee -> parent full committee
  staffCount: number; // distinct current staffers
  chair: CommitteeMemberRef | null;
  rankingMember: CommitteeMemberRef | null;
  viceChairs: string[];
  phone: string;
  officeLocation: string;
}

export interface DirectoryCommitteeStaffer {
  id: string; // `staff-${staffId}`
  fullName: string;
  title: string; // the committee position title
  email: string;
  phone: string;
  officeLocation: string;
  isCurrent: boolean;
  committee: {
    id: string;
    name: string;
    chamber: CommitteeChamber;
    kind: CommitteeKind;
  };
}

export interface CommitteesQuery {
  q?: string;
  chamber?: string;
  kind?: string;
  page?: string | number;
  pageSize?: string | number;
}

export interface DirectoryCommitteesPayload {
  committees: DirectoryCommittee[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CommitteeStaffQuery {
  q?: string;
  page?: string | number;
  pageSize?: string | number;
}

export interface DirectoryCommitteeStaffPayload {
  committee: DirectoryCommittee | null;
  staff: DirectoryCommitteeStaffer[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DirectoryAvailableFilters {
  chambers: Chamber[];
  parties: Array<{ value: Party; label: string }>;
  genders: Array<{ value: 'F' | 'M'; label: string }>;
  leadership: string[];
  committees: string[];
  issues: string[];
  caucuses: string[];
  states: string[];
  districts: string[];
  educationInstitutions: string[];
}

export interface DirectoryPayload {
  sourceId: string;
  contacts: DirectoryContact[];
  total: number;
  page: number;
  pageSize: number;
  totals: DirectoryTotals;
  availableStates: string[];
  availableFilters: DirectoryAvailableFilters;
}

export interface DirectoryEmailMatch {
  attendeeEmail: string;
  matchKind: 'member' | 'staff';
  directoryContactId: string;
  directoryContactName: string;
  member: {
    id: string;
    bioguideId: string;
    fullName: string;
    memberName: string;
    title: string;
    chamber: Chamber;
    state: string;
    district: string;
    partyName: string;
    officeLocation: string;
    phone: string;
    email: string;
    bio: DirectoryContact['bio'];
    committees: string[];
    leadershipPositions: string[];
    focusAreas: string[];
    addresses: DirectoryAddress[];
  };
  staff?: {
    id: string;
    fullName: string;
    title: string;
    email: string;
    phone: string;
    officeLocation: string;
    issueAreas: string[];
    roles: string[];
  };
}

export interface CreateDirectoryContactNoteInput {
  body: string;
  directoryContactName?: string;
}

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

interface StaffDetail {
  id: string;
  fullName: string;
  title: string;
  email: string;
  phone: string;
  officeLocation: string;
}

const TEST_DIRECTORY_CONTACT: DirectoryContact = {
  id: 'test-member-capiro-profile',
  memberId: -1001,
  bioguideId: 'TEST001',
  fullName: 'Rep. Avery Testwell',
  memberName: 'Avery Testwell',
  honorific: 'Rep.',
  photoUrl: '',
  title: 'Member of Congress - Test Profile',
  office: 'Avery Testwell office (TS-1)',
  chamber: 'House',
  state: 'TS',
  district: 'TS-1',
  party: 'I',
  partyName: 'Independent',
  gender: 'Unknown',
  region: 'South',
  isFreshman: false,
  servingSince: '2021-01-03',
  focusAreas: ['Defense Innovation', 'Federal Procurement', 'Small Business'],
  committees: ['House Committee on Armed Services', 'House Committee on Small Business'],
  committeeLeadership: ['Chair — House Committee on Small Business'],
  topIssues: [
    { issue: 'Defense Innovation', stafferCount: 2 },
    { issue: 'Federal Procurement', stafferCount: 1 },
  ],
  leadershipPositions: ['Testing Caucus Co-Chair'],
  caucuses: ['Congressional Test Data Caucus', 'Defense Innovation Caucus'],
  educationInstitutions: ['Example State University', 'National Policy Institute'],
  senateClass: null,
  outgoingStatus: null,
  officeLocation: '123 Test House Office Building, Washington, DC 20515',
  phone: '202-555-0147',
  fax: '202-555-0199',
  email: 'avery.testwell@example.invalid',
  contactFormUrl: 'https://example.invalid/contact/avery-testwell',
  newsPressUrl: 'https://example.invalid/avery-testwell/press-releases',
  rssFeedUrl: '',
  rssSource: '',
  officialLinks: [
    {
      label: 'Website, official',
      url: 'https://example.invalid/avery-testwell',
      type: 'Website',
    },
    {
      label: 'Contact form',
      url: 'https://example.invalid/contact/avery-testwell',
      type: 'Email Form',
    },
    {
      label: 'Email, test',
      url: 'mailto:avery.testwell@example.invalid',
      type: 'Email',
    },
  ],
  addresses: [
    {
      id: 'test-main-office',
      title: 'Main Office',
      address1: '123 Test House Office Building',
      address2: '',
      city: 'Washington',
      state: 'DC',
      zip: '20515',
      phone: '202-555-0147',
      fax: '202-555-0199',
      isMain: true,
    },
    {
      id: 'test-district-office',
      title: 'District Office',
      address1: '456 Constituent Avenue',
      address2: 'Suite 200',
      city: 'Testville',
      state: 'TS',
      zip: '00001',
      phone: '202-555-0188',
      fax: '',
      isMain: false,
    },
  ],
  staff: [
    {
      id: 'test-staff-chief',
      fullName: 'Jordan Sample',
      title: 'Chief of Staff',
      roles: ['Chief of Staff', 'Leadership'],
      issueAreas: ['Defense Innovation', 'Appropriations'],
      email: 'jordan.sample@example.invalid',
      phone: '202-555-0151',
      officeLocation: '123 Test House Office Building',
    },
    {
      id: 'test-staff-leg',
      fullName: 'Morgan Example',
      title: 'Legislative Assistant',
      roles: ['Legislative Assistant'],
      issueAreas: ['Federal Procurement', 'Small Business', 'Technology'],
      email: 'morgan.example@example.invalid',
      phone: '202-555-0152',
      officeLocation: '123 Test House Office Building',
    },
  ],
  bio: {
    dob: '1979-05-15',
    hometown: 'Testville, TS',
    birthplace: 'Example City, TS',
    occupation: 'Attorney; former technology policy advisor',
    race: 'Not specified',
    religion: 'Not specified',
    pronunciation: 'AY-vuh-ree TEST-well',
    narrative:
      'Avery Testwell — Independent Representative, TS-1. Synthetic QA profile used to validate the directory member detail view.',
    education: 'Example State University (BA); Test School of Law (JD)',
    military: '',
    relatives: '',
  },
  lastTouchpoint: '2026-05-04',
  owner: 'Capiro Test Data',
  relationshipTier: 'Watch',
  notes: 'Synthetic directory profile for QA only.',
  recentInteractions: [
    {
      date: '2026-04-29',
      channel: 'Email',
      summary: 'Synthetic outreach record for interface testing.',
    },
  ],
};

interface MemberBioOverlay {
  narrative?: string;
  education?: string;
  military?: string;
  relatives?: string;
  first_elected?: string | number;
  years_in_congress?: string | number;
  total_terms?: string | number;
  party_leadership?: string[];
  wikipedia?: string;
}

/** Minimal read-side view of LATEST.json (the publisher writes the full 2.0.0 schema). */
interface DirectorySnapshotPointer {
  snapshot_prefix?: unknown;
  previous_snapshot_prefix?: unknown;
}

/** A single office normalized from either the live-array or legacy-object shape. */
interface NormalizedOfficeRow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  office: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  office_member_addresses: any[];
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
    const page = this.toPositiveInt(query.page, 1);
    const pageSize = this.toPositiveInt(
      query.pageSize,
      DirectoryService.DEFAULT_PAGE_SIZE,
      DirectoryService.MAX_PAGE_SIZE,
    );
    const base = await this.getDirectoryData();
    return this.toPagedPayload(base, query, page, pageSize);
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

  // Search across the flattened staffer index (built once at cache time).
  // In-memory filter over the cached dataset — fast even at ~20k staffers.
  async getStaffers(query: StaffersQuery = {}): Promise<DirectoryStaffersPayload> {
    const page = this.toPositiveInt(query.page, 1);
    const pageSize = this.toPositiveInt(
      query.pageSize,
      DirectoryService.DEFAULT_PAGE_SIZE,
      DirectoryService.MAX_PAGE_SIZE,
    );
    const base = await this.getDirectoryData();
    const q = String(query.q ?? '')
      .trim()
      .toLowerCase();
    const chamber = this.normalizeFilter(query.chamber);
    const states = this.normalizeMultiFilter(query.state);
    const issues = this.normalizeMultiFilter(query.issue);

    const filtered = base.staffers.filter((staffer) => {
      const blob = [
        staffer.fullName,
        staffer.title,
        staffer.email,
        staffer.phone,
        staffer.roles.join(' '),
        staffer.issueAreas.join(' '),
        staffer.member.memberName,
        staffer.member.fullName,
        staffer.member.state,
      ]
        .join(' ')
        .toLowerCase();
      const matchesQuery = q.length === 0 || blob.includes(q);
      const matchesChamber = chamber === null || staffer.member.chamber === chamber;
      const matchesState = states.length === 0 || states.includes(staffer.member.state);
      const matchesIssue =
        issues.length === 0 || staffer.issueAreas.some((area) => issues.includes(area));
      return matchesQuery && matchesChamber && matchesState && matchesIssue;
    });

    const total = filtered.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pageCount);
    const start = (safePage - 1) * pageSize;
    return { staffers: filtered.slice(start, start + pageSize), total, page: safePage, pageSize };
  }

  // Committee directory: federal House/Senate/Joint committees and subcommittees,
  // sorted by current staff headcount (then name). Filterable by chamber/kind/text.
  async getCommittees(query: CommitteesQuery = {}): Promise<DirectoryCommitteesPayload> {
    const page = this.toPositiveInt(query.page, 1);
    const pageSize = this.toPositiveInt(
      query.pageSize,
      DirectoryService.DEFAULT_PAGE_SIZE,
      DirectoryService.MAX_PAGE_SIZE,
    );
    const base = await this.getDirectoryData();
    const q = String(query.q ?? '')
      .trim()
      .toLowerCase();
    const chamber = this.normalizeFilter(query.chamber);
    const kind = this.normalizeFilter(query.kind);

    const filtered = base.committees.filter((committee) => {
      const matchesQuery =
        q.length === 0 ||
        committee.name.toLowerCase().includes(q) ||
        (committee.committeeCode ?? '').toLowerCase().includes(q);
      const matchesChamber = chamber === null || committee.chamber === chamber;
      const matchesKind = kind === null || committee.kind === kind;
      return matchesQuery && matchesChamber && matchesKind;
    });

    const total = filtered.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pageCount);
    const start = (safePage - 1) * pageSize;
    return { committees: filtered.slice(start, start + pageSize), total, page: safePage, pageSize };
  }

  // Roster for a single committee. Current staffers first, then alphabetical.
  async getCommitteeStaff(
    committeeId: string,
    query: CommitteeStaffQuery = {},
  ): Promise<DirectoryCommitteeStaffPayload> {
    const page = this.toPositiveInt(query.page, 1);
    const pageSize = this.toPositiveInt(
      query.pageSize,
      DirectoryService.DEFAULT_PAGE_SIZE,
      DirectoryService.MAX_PAGE_SIZE,
    );
    const base = await this.getDirectoryData();
    const committee = base.committees.find((entry) => entry.id === committeeId) ?? null;
    if (!committee) {
      return { committee: null, staff: [], total: 0, page: 1, pageSize };
    }

    const q = String(query.q ?? '')
      .trim()
      .toLowerCase();
    const roster = base.committeeStaff.get(committeeId) ?? [];
    const filtered = roster.filter((staffer) => {
      if (q.length === 0) return true;
      return staffer.fullName.toLowerCase().includes(q) || staffer.title.toLowerCase().includes(q);
    });

    const total = filtered.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pageCount);
    const start = (safePage - 1) * pageSize;
    return {
      committee,
      staff: filtered.slice(start, start + pageSize),
      total,
      page: safePage,
      pageSize,
    };
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
    const page = this.toPositiveInt(query.page, 1);
    const pageSize = this.toPositiveInt(query.pageSize, DirectoryService.DEFAULT_PAGE_SIZE, 200);

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
    const numericId = Number(String(memberId).replace(/^member-/, ''));
    const row = base.indexes.membersById.get(numericId);
    if (!row) throw new NotFoundException('Directory member not found');
    const member = (row.member ?? {}) as Record<string, any>;
    const profile = (member.profile ?? {}) as Record<string, any>;
    const bio = (profile.bio_details ?? {}) as Record<string, any>;
    const personId = `member-${numericId}`;
    const overlay = base.photoOverlay.people[personId] ?? null;
    const selected = resolveMemberPhoto(row.photos, overlay);
    const contact = base.contacts.find((c) => c.id === personId);
    return {
      kind: 'member',
      id: personId,
      source: {
        snapshotId: base.sourceId,
        memberId: numericId,
        lastUpdatedAt: this.latestUpdatedAt([row.member_offices, row.committees, row.leaderships]),
      },
      identity: {
        memberId: numericId,
        bioguideId: String(member.bioguide_id ?? ''),
        icpsrId: Number.isFinite(Number(member.icpsr_id)) ? Number(member.icpsr_id) : null,
        lisMemberId: member.lis_member_id == null ? null : String(member.lis_member_id),
        firstName: String(profile.first_name ?? ''),
        lastName: String(profile.last_name ?? ''),
        preferredFirstName: profile.preferred_first_name ?? null,
        preferredLastName: profile.preferred_last_name ?? null,
        suffix: profile.suffix ?? null,
        gender: profile.gender ?? null,
      },
      bioDetails: {
        dob: bio.dob ?? null,
        dateOfDeath: bio.date_of_death ?? null,
        placeOfBirth: bio.pob ?? null,
        hometown: bio.hometown ?? null,
        nativeOf: bio.native_of ?? null,
        majMin: bio.maj_min ?? null,
        partyName: bio.party_name ?? null,
        occupation: bio.occupation ?? null,
        pronunciation: bio.pronunciation ?? null,
        raceName: bio.race_name ?? null,
        religionName: bio.religion_name ?? null,
      },
      photos: memberPhotoRecords(row.photos),
      selectedPhotoUrl: selected.url,
      photoSource: selected.source,
      offices: this.mapMemberOffices(row.member_offices),
      officeAddresses: this.mapStaffOfficeAddresses(row.office_member_addresses),
      committees: this.membershipsForPerson(base.indexes, personId),
      leaderships: this.mapLeaderships(row.leaderships),
      socialContacts: this.mapContactMethods(row.social_media),
      staffRoles: this.mapStaffRoles(row.staffer_roles),
      staffIssues: this.mapStaffIssues(row.staffer_issues),
      enrichments: {
        bioOverlay: Boolean(contact?.bio?.narrative),
        pressOverlay: Boolean(contact?.rssFeedUrl || contact?.newsPressUrl),
      },
    };
  }

  async getStaffDetail(staffId: string): Promise<DirectoryStaffDetail> {
    const base = await this.getDirectoryData();
    const numericId = Number(String(staffId).replace(/^staff-/, ''));
    const row = base.indexes.staffById.get(numericId);
    // A staffer can appear in the directory via a member's roster
    // (staffer_roles/staffer_issues) without having a /staff/list row. Rather than
    // 404 that profile, render a minimal one from the member-side data we do have.
    if (!row) return this.buildRosterOnlyStaffDetail(base, numericId);
    const staff = (row.staff ?? {}) as Record<string, any>;
    const bio = (staff.bio_details ?? {}) as Record<string, any>;
    const personId = `staff-${numericId}`;
    const overlay = base.photoOverlay.people[personId] ?? null;
    const photo = resolveStaffPhoto(null, overlay); // entitlement returns no staff photo today
    const positions = Array.isArray(row.positions) ? row.positions : [];
    const memberAssociations = [
      ...new Map(
        positions
          .map((p: any) => Number(p?.member?.member_id))
          .filter((id: number) => Number.isFinite(id))
          .map((id: number) => {
            const ref = this.resolveMemberRef(base.indexes, id);
            return [
              id,
              {
                id: `member-${id}`,
                memberId: id,
                fullName: ref.fullName,
                party: ref.party,
                state: ref.state,
                district: ref.district,
              },
            ];
          }),
      ).values(),
    ];
    const issues = (base.indexes.staffIssuesByStaffId.get(numericId) ?? []).map((link) => ({
      issueName: link.issueName,
      memberId: link.memberId,
      memberName:
        link.memberId != null ? this.resolveMemberRef(base.indexes, link.memberId).fullName || null : null,
      updatedAt: link.updatedAt,
    }));
    const roles = (base.indexes.staffRolesByStaffId.get(numericId) ?? []).map((link) => ({
      roleName: link.roleName,
      memberId: link.memberId,
      memberName:
        link.memberId != null ? this.resolveMemberRef(base.indexes, link.memberId).fullName || null : null,
      updatedAt: link.updatedAt,
    }));
    return {
      kind: 'staff',
      id: personId,
      source: {
        snapshotId: base.sourceId,
        staffId: numericId,
        lastUpdatedAt: this.latestUpdatedAt([row.positions]),
      },
      identity: {
        staffId: numericId,
        firstName: String(staff.first_name ?? ''),
        lastName: String(staff.last_name ?? ''),
        preferredFirstName: staff.preferred_first_name ?? null,
        preferredLastName: staff.preferred_last_name ?? null,
        suffix: staff.suffix ?? null,
        gender: staff.gender ?? null,
      },
      bioDetails: {
        dob: bio.dob ?? null,
        dateOfDeath: bio.date_of_death ?? null,
        hometown: bio.hometown ?? null,
        placeOfBirth: bio.pob ?? null,
        nativeOf: bio.native_of ?? null,
        majMin: bio.maj_min ?? null,
        partyName: bio.party_name ?? null,
        occupation: bio.occupation ?? null,
        pronunciation: bio.pronunciation ?? null,
        raceName: bio.race_name ?? null,
        religionName: bio.religion_name ?? null,
      },
      photoUrl: photo.url,
      photoSource: photo.source,
      emails: this.mapContactMethods(row.staff_emails),
      socialContacts: this.mapContactMethods(row.social_media),
      officeAddresses: this.mapStaffOfficeAddresses(row.office_member_addresses),
      positions: this.mapStaffPositions(row.positions),
      memberAssociations,
      committeeAssociations: this.membershipsForPerson(base.indexes, personId),
      issues,
      roles,
      availability: {
        photo: photo.url ? 'available' : 'not_provided',
        socialContacts: this.mapContactMethods(row.social_media).length ? 'available' : 'not_provided',
      },
    };
  }

  /**
   * Minimal staff detail for a staffer who appears via a member's roster but has no
   * /staff/list row (name + issues + roles + member associations; everything else
   * "not provided"). Prevents a 404 when such a staffer's profile is opened.
   */
  private buildRosterOnlyStaffDetail(
    base: CachedContacts['data'],
    numericId: number,
  ): DirectoryStaffDetail {
    const name = base.indexes.staffNamesByStaffId.get(numericId);
    if (!name) throw new NotFoundException('Directory staffer not found');
    const personId = `staff-${numericId}`;
    const parts = name.split(' ').filter(Boolean);
    const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : name;
    const lastName = parts.length > 1 ? parts[parts.length - 1]! : '';
    const overlay = base.photoOverlay.people[personId] ?? null;
    const photo = resolveStaffPhoto(null, overlay);
    const memberName = (memberId: number | null): string | null =>
      memberId != null ? this.resolveMemberRef(base.indexes, memberId).fullName || null : null;
    const issues = (base.indexes.staffIssuesByStaffId.get(numericId) ?? []).map((link) => ({
      issueName: link.issueName,
      memberId: link.memberId,
      memberName: memberName(link.memberId),
      updatedAt: link.updatedAt,
    }));
    const roles = (base.indexes.staffRolesByStaffId.get(numericId) ?? []).map((link) => ({
      roleName: link.roleName,
      memberId: link.memberId,
      memberName: memberName(link.memberId),
      updatedAt: link.updatedAt,
    }));
    const memberIds = [
      ...new Set(
        [...issues, ...roles]
          .map((x) => x.memberId)
          .filter((id): id is number => id != null),
      ),
    ];
    const memberAssociations = memberIds.map((id) => {
      const ref = this.resolveMemberRef(base.indexes, id);
      return {
        id: `member-${id}`,
        memberId: id,
        fullName: ref.fullName,
        party: ref.party,
        state: ref.state,
        district: ref.district,
      };
    });
    return {
      kind: 'staff',
      id: personId,
      source: { snapshotId: base.sourceId, staffId: numericId, lastUpdatedAt: null },
      identity: {
        staffId: numericId,
        firstName,
        lastName,
        preferredFirstName: null,
        preferredLastName: null,
        suffix: null,
        gender: null,
      },
      bioDetails: {
        dob: null,
        dateOfDeath: null,
        hometown: null,
        placeOfBirth: null,
        nativeOf: null,
        majMin: null,
        partyName: null,
        occupation: null,
        pronunciation: null,
        raceName: null,
        religionName: null,
      },
      photoUrl: photo.url,
      photoSource: photo.source,
      emails: [],
      socialContacts: [],
      officeAddresses: [],
      positions: [],
      memberAssociations,
      committeeAssociations: this.membershipsForPerson(base.indexes, personId),
      issues,
      roles,
      availability: {
        photo: photo.url ? 'available' : 'not_provided',
        socialContacts: 'not_provided',
      },
    };
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
    const page = this.toPositiveInt(query.page, 1);
    const pageSize = this.toPositiveInt(query.pageSize, DirectoryService.DEFAULT_PAGE_SIZE, 500);
    const total = filtered.length;
    const start = (Math.min(page, Math.max(1, Math.ceil(total / pageSize))) - 1) * pageSize;
    return { committee, contacts: filtered.slice(start, start + pageSize), total, page, pageSize };
  }

  private normalizePersonTypeFilter(raw: unknown): 'all' | 'member' | 'staff' {
    return raw === 'member' || raw === 'staff' ? raw : 'all';
  }

  private membershipsForPerson(idx: DirectoryIndexes, personId: string): DirectoryCommitteeMembership[] {
    const committeeIds = idx.committeesByPersonId.get(personId) ?? [];
    return committeeIds.flatMap((cid) =>
      (idx.membershipsByCommitteeId.get(cid) ?? []).filter((m) => m.person.id === personId),
    );
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

  private mapMemberOffices(raw: unknown): DirectoryMemberDetail['offices'] {
    return (Array.isArray(raw) ? raw : []).filter((o) => o && typeof o === 'object').map((o: any) => ({
      officeId: Number.isFinite(Number(o.office?.office_id)) ? Number(o.office.office_id) : null,
      name: o.office?.name ?? null,
      officeTypeId: o.office_type_id ?? null,
      state: o.state_id ?? null,
      district: o.district_no == null ? null : String(o.district_no),
      party: o.party ?? null,
      senateClass: o.senate_class == null ? null : String(o.senate_class),
      outgoingStatus: o.outgoing_status ?? null,
      status: o.status ?? null,
      startDate: o.start_date ?? null,
      endDate: o.end_date ?? null,
      updatedAt: o.updated_at ?? null,
    }));
  }

  private mapLeaderships(raw: unknown): DirectoryMemberDetail['leaderships'] {
    return (Array.isArray(raw) ? raw : []).filter((l) => l && typeof l === 'object').map((l: any) => ({
      position: l.position ?? null,
      startDate: l.start_date ?? null,
      endDate: l.end_date ?? null,
      updatedAt: l.updated_at ?? null,
    }));
  }

  private mapContactMethods(raw: unknown): DirectoryMemberDetail['socialContacts'] {
    return (Array.isArray(raw) ? raw : [])
      .filter((c) => c && typeof c === 'object' && typeof (c as any).contact_string === 'string')
      .map((c: any) => ({
        type: c.contact_type ?? null,
        value: String(c.contact_string),
        updatedAt: c.updated_at ?? null,
      }));
  }

  private mapStaffRoles(raw: unknown): DirectoryMemberDetail['staffRoles'] {
    return (Array.isArray(raw) ? raw : []).filter((r) => r && typeof r === 'object').map((r: any) => ({
      memberId: Number.isFinite(Number(r.staffer?.member_id ?? r.member_id)) ? Number(r.staffer?.member_id ?? r.member_id) : null,
      roleName: r.role_name ?? null,
      updatedAt: r.updated_at ?? null,
    }));
  }

  private mapStaffIssues(raw: unknown): DirectoryMemberDetail['staffIssues'] {
    return (Array.isArray(raw) ? raw : []).filter((r) => r && typeof r === 'object').map((r: any) => ({
      memberId: Number.isFinite(Number(r.member_id)) ? Number(r.member_id) : null,
      issueName: r.issue_name ?? null,
      updatedAt: r.updated_at ?? null,
    }));
  }

  private mapStaffPositions(raw: unknown): DirectoryStaffDetail['positions'] {
    return (Array.isArray(raw) ? raw : []).filter((p) => p && typeof p === 'object').map((p: any) => {
      const m = p.member && typeof p.member === 'object' ? p.member : null;
      const profile = m?.profile && typeof m.profile === 'object' ? m.profile : null;
      const memberFullName = profile
        ? [profile.preferred_first_name ?? profile.first_name, profile.preferred_last_name ?? profile.last_name]
            .filter(Boolean)
            .join(' ')
            .trim()
        : '';
      return {
        officeId: Number.isFinite(Number(p.office?.office_id)) ? Number(p.office.office_id) : null,
        officeName: p.office?.name ?? null,
        memberId: Number.isFinite(Number(m?.member_id)) ? Number(m.member_id) : null,
        title: p.position_title ?? null,
        positionType: p.position_type ?? null,
        isCurrent: p.is_current === true,
        isOnLeave: p.is_on_leave === true,
        startDate: p.start_date ?? null,
        endDate: p.end_date ?? null,
        updatedAt: p.updated_at ?? null,
        member: m
          ? {
              memberId: Number.isFinite(Number(m.member_id)) ? Number(m.member_id) : null,
              fullName: memberFullName || null,
              party: typeof m.party === 'string' ? m.party : null,
              state: typeof m.state_id === 'string' ? m.state_id : null,
              district: m.district_no === undefined || m.district_no === null ? null : String(m.district_no),
              officeTypeId:
                m.office_type_id === undefined || m.office_type_id === null
                  ? null
                  : String(m.office_type_id),
            }
          : null,
      };
    });
  }

  private mapStaffOfficeAddresses(raw: unknown): DirectoryStaffDetail['officeAddresses'] {
    return (Array.isArray(raw) ? raw : [])
      .filter((a) => a && typeof a === 'object')
      .map((a: any) => ({
        addressId: Number.isFinite(Number(a.id)) ? Number(a.id) : null,
        officeId: Number.isFinite(Number(a.office?.office_id)) ? Number(a.office.office_id) : null,
        officeName: a.office?.name ?? null,
        label: a.title ?? null,
        address1: a.address1 ?? null,
        address2: a.address2 ?? null,
        city: a.city ?? null,
        state: a.state_id ?? null,
        zip: a.zip ?? null,
        zipExt: a.zip_ext ?? null,
        phone: a.phone ?? null,
        fax: a.fax ?? null,
        isMain: a.is_main === true,
        publicNotes: a.public_notes ?? null,
        updatedAt: a.updated_at ?? null,
      }));
  }

  /** Resolve a member's canonical display fields from the indexed member row. */
  private resolveMemberRef(
    indexes: DirectoryIndexes,
    memberId: number,
  ): { fullName: string; party: string | null; state: string | null; district: string | null } {
    const row = indexes.membersById.get(memberId) as Record<string, any> | undefined;
    const member = (row?.member ?? {}) as Record<string, any>;
    const profile = (member.profile ?? {}) as Record<string, any>;
    const fullName = [
      profile.preferred_first_name ?? profile.first_name,
      profile.preferred_last_name ?? profile.last_name,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    // Use the authoritative current-office selector (in-office > open end_date >
    // last term), NOT the first array element: member_offices is stored
    // oldest-first, so .find(first) would surface a stale/former term's
    // party/state/district for any multi-term member.
    const office = this.currentMemberOffice(row?.member_offices);
    return {
      fullName,
      party: typeof office?.party === 'string' ? office.party : null,
      state: typeof office?.state_id === 'string' ? office.state_id : null,
      district:
        office?.district_no === undefined || office?.district_no === null
          ? null
          : String(office.district_no),
    };
  }

  private latestUpdatedAt(sources: unknown[]): string | null {
    let latest: string | null = null;
    for (const source of sources) {
      for (const entry of Array.isArray(source) ? source : []) {
        const updatedAt = (entry as any)?.updated_at;
        if (typeof updatedAt === 'string' && (latest === null || updatedAt > latest)) latest = updatedAt;
      }
    }
    return latest;
  }

  // Builds the committee catalog (from office-list) and the per-committee staff
  // roster (from staff-list `positions[].office`). A staffer can appear under
  // multiple committees; within one committee we keep a single entry per person,
  // preferring their current position and a titled role.
  private buildCommitteeIndex(officeRaw: unknown, staffRaw: unknown[], membersRaw: unknown[]) {
    // Normalize BOTH the live array shape ([{ office, office_member_addresses, ... }])
    // and the legacy object shape ({ office: [...], office_member_addresses: [...] }).
    // The live combined file is an array; the old code assumed the object shape and
    // silently produced an empty committee catalog against real data.
    const rows = this.normalizeOfficeRows(officeRaw);
    const offices = rows.map((row) => row.office);
    const committeesByOfficeId = new Map<number, DirectoryCommittee>();

    // Committee leadership (Chair / Ranking Member / Vice Chair) lives on the
    // MEMBER side as committees[].position; invert it into an officeId -> roles map.
    const leadershipByOffice = this.buildCommitteeLeadershipMap(membersRaw);

    // Committee office phone/address comes from each office's office_member_addresses.
    const contactByOffice = this.buildOfficeContactMap(rows);

    for (const office of offices as any[]) {
      const meta = FED_COMMITTEE_OFFICE_TYPES[String(office?.office_type ?? '')];
      const officeId = Number(office?.office_id);
      if (!meta || !Number.isFinite(officeId)) continue;
      const name = String(office?.name ?? '').trim();
      if (!name) continue;
      const leadership = leadershipByOffice.get(officeId);
      const contact = contactByOffice.get(officeId);
      committeesByOfficeId.set(officeId, {
        id: `committee-${officeId}`,
        officeId,
        name,
        chamber: meta.chamber,
        kind: meta.kind,
        committeeCode: office?.congress_committee_code
          ? String(office.congress_committee_code)
          : null,
        parentOfficeId: Number(office?.parent_office?.office_id) || null,
        staffCount: 0,
        chair: leadership?.chair ?? null,
        rankingMember: leadership?.rankingMember ?? null,
        viceChairs: leadership?.viceChairs ?? [],
        phone: contact?.phone ?? '',
        officeLocation: contact?.officeLocation ?? '',
      });
    }

    // committee id -> (staffId -> staffer), deduped per person per committee.
    const rosterById = new Map<string, Map<number, DirectoryCommitteeStaffer>>();
    const staffList = Array.isArray(staffRaw) ? staffRaw : [];

    for (const row of staffList as any[]) {
      const staff = row?.staff;
      const staffId = Number(staff?.id);
      if (!Number.isFinite(staffId)) continue;
      const fullName = [
        staff?.preferred_first_name ?? staff?.first_name,
        staff?.preferred_last_name ?? staff?.last_name,
      ]
        .filter(Boolean)
        .join(' ')
        .trim();
      if (!fullName) continue;

      const emails = Array.isArray(row?.staff_emails) ? row.staff_emails : [];
      const email = String(
        emails.find(
          (entry: any) =>
            typeof entry?.contact_string === 'string' && entry.contact_string.includes('@'),
        )?.contact_string ?? '',
      );
      const addresses = Array.isArray(row?.office_member_addresses)
        ? row.office_member_addresses
        : [];
      const address = addresses.find((entry: any) => entry?.is_main) ?? addresses[0];
      const phone = String(address?.phone ?? '');
      const officeLocation = [address?.address1, address?.city, address?.state_id]
        .filter(Boolean)
        .join(', ');

      const positions = Array.isArray(row?.positions) ? row.positions : [];
      for (const position of positions) {
        const officeId = Number(position?.office?.office_id);
        const committee = committeesByOfficeId.get(officeId);
        if (!committee) continue;

        const byStaffId =
          rosterById.get(committee.id) ?? new Map<number, DirectoryCommitteeStaffer>();
        const isCurrent = Boolean(position?.is_current);
        const title = String(position?.position_title ?? position?.position_type ?? 'Staff');
        const existing = byStaffId.get(staffId);
        // Prefer a current position; otherwise keep the first seen.
        if (!existing || (isCurrent && !existing.isCurrent)) {
          byStaffId.set(staffId, {
            id: `staff-${staffId}`,
            fullName,
            title,
            email,
            phone,
            officeLocation,
            isCurrent,
            committee: {
              id: committee.id,
              name: committee.name,
              chamber: committee.chamber,
              kind: committee.kind,
            },
          });
        }
        rosterById.set(committee.id, byStaffId);
      }
    }

    const committeeStaff = new Map<string, DirectoryCommitteeStaffer[]>();
    for (const committee of committeesByOfficeId.values()) {
      const roster = [...(rosterById.get(committee.id)?.values() ?? [])].sort((left, right) => {
        if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
        return left.fullName.localeCompare(right.fullName);
      });
      committee.staffCount = roster.filter((staffer) => staffer.isCurrent).length;
      committeeStaff.set(committee.id, roster);
    }

    const committees = [...committeesByOfficeId.values()].sort((left, right) => {
      if (right.staffCount !== left.staffCount) return right.staffCount - left.staffCount;
      return left.name.localeCompare(right.name);
    });

    return { committees, committeeStaff };
  }

  // officeId -> { chair, rankingMember, viceChairs[] } from members' committees[].position.
  private buildCommitteeLeadershipMap(
    membersRaw: unknown[],
  ): Map<
    number,
    { chair?: CommitteeMemberRef; rankingMember?: CommitteeMemberRef; viceChairs: string[] }
  > {
    const map = new Map<
      number,
      { chair?: CommitteeMemberRef; rankingMember?: CommitteeMemberRef; viceChairs: string[] }
    >();
    const members = Array.isArray(membersRaw) ? membersRaw : [];
    for (const row of members as any[]) {
      const memberId = Number(row?.member?.member_id);
      if (!Number.isFinite(memberId)) continue;
      const profile = row?.member?.profile;
      const name = [
        profile?.preferred_first_name ?? profile?.first_name,
        profile?.preferred_last_name ?? profile?.last_name,
      ]
        .filter(Boolean)
        .join(' ')
        .trim();
      if (!name) continue;
      const ref: CommitteeMemberRef = { id: `member-${memberId}`, name };
      const committees = Array.isArray(row?.committees) ? row.committees : [];
      for (const committee of committees) {
        const officeId = Number(committee?.committee_office?.office_id);
        const position = String(committee?.position ?? '').trim();
        if (!Number.isFinite(officeId) || !position) continue;
        const entry = map.get(officeId) ?? { viceChairs: [] };
        if (position === 'Chair' && !entry.chair) entry.chair = ref;
        else if (position === 'Ranking Member' && !entry.rankingMember) entry.rankingMember = ref;
        else if (position === 'Vice Chair') entry.viceChairs.push(name);
        map.set(officeId, entry);
      }
    }
    return map;
  }

  /**
   * Normalize the office combined file into `{ office, office_member_addresses }`
   * rows, tolerating BOTH shapes:
   *   - LIVE array: [{ office: {...}, office_member_addresses: [...], ... }, ...]
   *   - LEGACY object: { office: [...offices], office_member_addresses: [...flat] }
   * For the legacy shape the flat addresses are grouped back onto their office by
   * office_id so downstream code can treat every row uniformly. Pure/defensive:
   * any other shape yields an empty list.
   */
  private normalizeOfficeRows(officeRaw: unknown): NormalizedOfficeRow[] {
    if (Array.isArray(officeRaw)) {
      return (officeRaw as any[]).map((row) => ({
        office: row?.office ?? null,
        office_member_addresses: Array.isArray(row?.office_member_addresses)
          ? row.office_member_addresses
          : [],
      }));
    }
    const legacy = officeRaw as any;
    if (legacy && Array.isArray(legacy.office)) {
      const flat = Array.isArray(legacy.office_member_addresses)
        ? legacy.office_member_addresses
        : [];
      const addressesByOfficeId = new Map<number, any[]>();
      for (const entry of flat as any[]) {
        const officeId = Number(entry?.office?.office_id);
        if (!Number.isFinite(officeId)) continue;
        const list = addressesByOfficeId.get(officeId) ?? [];
        list.push(entry);
        addressesByOfficeId.set(officeId, list);
      }
      return (legacy.office as any[]).map((office) => ({
        office,
        office_member_addresses: addressesByOfficeId.get(Number(office?.office_id)) ?? [],
      }));
    }
    return [];
  }

  // officeId -> { phone, officeLocation } from each office's office_member_addresses.
  private buildOfficeContactMap(
    rows: NormalizedOfficeRow[],
  ): Map<number, { phone: string; officeLocation: string }> {
    const map = new Map<number, { phone: string; officeLocation: string }>();
    for (const row of rows) {
      const officeId = Number(row.office?.office_id);
      if (!Number.isFinite(officeId)) continue;
      const addresses = row.office_member_addresses ?? [];
      if (addresses.length === 0) continue;
      // Prefer the main office address.
      const entry = addresses.find((address: any) => address?.is_main) ?? addresses[0];
      map.set(officeId, {
        phone: String(entry?.phone ?? ''),
        officeLocation: [entry?.address1, entry?.city, entry?.state_id, entry?.zip]
          .filter(Boolean)
          .join(', '),
      });
    }
    return map;
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
    const contacts = this.buildContacts(members, staff, bioOverlay, pressOverlay);
    const staffers = this.buildStafferIndex(contacts);
    const { committees, committeeStaff } = this.buildCommitteeIndex(offices, staff, members);
    // Full person/committee indexes (raw rows + every membership + reverse lookups)
    // layered on the identified committees — powers the detail/dictionary endpoints.
    const indexes = buildDirectoryIndexes({ members, staff, committees });
    const availableStates = uniqueSorted(contacts.map((contact) => contact.state));
    const availableFilters = this.buildAvailableFilters(contacts);
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
    const districtNo = Number(contact.district);
    const clients = await this.representation.clientsRepresentedByMember(ctx.tenantId, {
      bioguideId: contact.bioguideId,
      chamber: contact.chamber === 'Senate' ? 'senate' : 'house',
      state: contact.state,
      district: Number.isFinite(districtNo) && districtNo > 0 ? districtNo : null,
    });
    return { clients };
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

  private toPagedPayload(
    base: CachedContacts['data'],
    query: DirectoryQuery,
    page: number,
    pageSize: number,
  ): DirectoryPayload {
    const chamber = this.normalizeFilter(query.chamber);
    const freshman = this.normalizeFilter(query.freshman);
    const gender = this.normalizeFilter(query.gender);
    const region = this.normalizeFilter(query.region);
    const parties = this.normalizeMultiFilter(query.party);
    const leadership = this.normalizeMultiFilter(query.leadership);
    const committees = this.normalizeMultiFilter(query.committee);
    const caucuses = this.normalizeMultiFilter(query.caucus);
    const states = this.normalizeMultiFilter(query.state);
    const districts = this.normalizeMultiFilter(query.district);
    const education = this.normalizeMultiFilter(query.education);
    const normalizedQuery = String(query.q ?? '')
      .trim()
      .toLowerCase();
    // Tokenize so multi-word queries match in any order ("cruz ted" == "ted cruz")
    // and tolerate extra whitespace. A single token behaves exactly as before.
    const queryTokens = normalizedQuery.split(/\s+/).filter((t) => t.length > 0);
    const sort = this.normalizeSort(query.sort);

    // A blob matches if it contains the full query as a contiguous substring
    // (back-compat) OR — for multi-word queries — contains every token. Single-
    // token queries reduce to the old `includes` behavior.
    const blobMatches = (blob: string): boolean => {
      if (queryTokens.length === 0) return true;
      if (blob.includes(normalizedQuery)) return true;
      return queryTokens.length > 1 && queryTokens.every((token) => blob.includes(token));
    };

    // Why a contact matched the query: by the member's own fields, and/or via
    // specific staffers. `matchedStaff` lets the UI explain a result whose member
    // name doesn't contain the query (e.g. searching a staffer's first name).
    const matchInfo = new Map<
      string,
      { memberMatched: boolean; matchedStaff: Array<{ fullName: string; title: string }> }
    >();

    const filtered = base.contacts.filter((contact) => {
      const matchesFreshman =
        freshman === null ||
        (freshman === 'Freshman' && contact.isFreshman) ||
        (freshman === 'Non-Freshman' && !contact.isFreshman);
      const matchesChamber = chamber === null || contact.chamber === chamber;
      const matchesRegion = region === null || contact.region === region;
      const matchesGender = gender === null || contact.gender === gender;
      const matchesParty = parties.length === 0 || parties.includes(contact.party);
      const matchesState = states.length === 0 || states.includes(contact.state);
      const matchesDistrict = districts.length === 0 || districts.includes(contact.district);
      const matchesLeadership =
        leadership.length === 0 ||
        contact.leadershipPositions.some((position) => leadership.includes(position));
      const matchesCommittee =
        committees.length === 0 ||
        contact.committees.some((committee) => committees.includes(committee));
      const matchesCaucus =
        caucuses.length === 0 || contact.caucuses.some((caucus) => caucuses.includes(caucus));
      const matchesEducation =
        education.length === 0 ||
        contact.educationInstitutions.some((institution) => education.includes(institution));

      // Cheap structured filters first; only build search blobs if those pass.
      if (
        !(
          matchesFreshman &&
          matchesChamber &&
          matchesRegion &&
          matchesGender &&
          matchesParty &&
          matchesState &&
          matchesDistrict &&
          matchesLeadership &&
          matchesCommittee &&
          matchesCaucus &&
          matchesEducation
        )
      ) {
        return false;
      }

      // No free-text query → structured filters alone decide; no match metadata.
      if (queryTokens.length === 0) return true;

      const memberBlob = [
        contact.fullName,
        contact.memberName,
        contact.title,
        contact.office,
        contact.state,
        contact.district,
        contact.partyName,
        contact.phone,
        contact.email,
        contact.contactFormUrl,
        contact.focusAreas.join(' '),
        contact.committees.join(' '),
        contact.leadershipPositions.join(' '),
      ]
        .join(' ')
        .toLowerCase();

      const staffBlobs = contact.staff.map((staff) => ({
        staff,
        blob: (
          `${staff.fullName} ${staff.title} ${staff.email} ${staff.phone} ` +
          `${staff.roles.join(' ')} ${staff.issueAreas.join(' ')}`
        ).toLowerCase(),
      }));

      // Reproduces the legacy combined-blob `includes` match for member fields and
      // within a single staffer's fields, and adds order-independent tokens plus
      // staffer roles/issue-areas to the searchable text. (The one legacy match it
      // does not reproduce is a contiguous substring that spanned two adjacent
      // staffers — not a realistic free-text query.)
      const combinedBlob = `${memberBlob} ${staffBlobs.map((s) => s.blob).join(' ')}`;
      if (!blobMatches(combinedBlob)) return false;

      const memberMatched = blobMatches(memberBlob);
      const matchedStaff = staffBlobs
        .filter((s) => blobMatches(s.blob))
        .slice(0, 5)
        .map((s) => ({ fullName: s.staff.fullName, title: s.staff.title }));
      matchInfo.set(contact.id, { memberMatched, matchedStaff });
      return true;
    });

    let sorted = this.sortContacts(filtered, sort);
    // When searching, hoist offices whose own name/fields matched above offices
    // that matched only via a staffer — the member you typed should come first.
    // Array.prototype.sort is stable in V8, so the requested sort is preserved
    // within each group.
    if (queryTokens.length > 0) {
      sorted = sorted
        .slice()
        .sort(
          (a, b) =>
            Number(matchInfo.get(b.id)?.memberMatched ?? false) -
            Number(matchInfo.get(a.id)?.memberMatched ?? false),
        );
    }
    const total = sorted.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pageCount);
    const start = (safePage - 1) * pageSize;
    // Attach the staffer match reason to the page slice only (shallow copy — the
    // cached contact objects are shared and must not be mutated).
    const contacts = sorted.slice(start, start + pageSize).map((contact) => {
      const info = matchInfo.get(contact.id);
      if (info && !info.memberMatched && info.matchedStaff.length > 0) {
        return { ...contact, matchedStaff: info.matchedStaff };
      }
      return contact;
    });

    return {
      sourceId: base.sourceId,
      contacts,
      total,
      page: safePage,
      pageSize,
      totals: base.totals,
      availableStates: base.availableStates,
      availableFilters: base.availableFilters,
    };
  }

  private sortContacts(entries: DirectoryContact[], sort: DirectorySort): DirectoryContact[] {
    const next = [...entries];

    if (sort === 'name-asc') {
      return next.sort((left, right) => this.compareLastName(left, right));
    }

    if (sort === 'name-desc') {
      return next.sort((left, right) => this.compareLastName(right, left));
    }

    if (sort === 'state-asc') {
      return next.sort((left, right) => {
        const stateCompare = left.state.localeCompare(right.state);
        return stateCompare !== 0 ? stateCompare : this.compareLastName(left, right);
      });
    }

    if (sort === 'chamber') {
      return next.sort((left, right) => {
        const chamberCompare = left.chamber.localeCompare(right.chamber);
        return chamberCompare !== 0 ? chamberCompare : this.compareLastName(left, right);
      });
    }

    if (sort === 'party') {
      return next.sort((left, right) => {
        const partyCompare = left.partyName.localeCompare(right.partyName);
        return partyCompare !== 0 ? partyCompare : this.compareLastName(left, right);
      });
    }

    return next.sort((left, right) => right.lastTouchpoint.localeCompare(left.lastTouchpoint));
  }

  private compareLastName(left: DirectoryContact, right: DirectoryContact): number {
    return this.lastNameSortKey(left.memberName).localeCompare(
      this.lastNameSortKey(right.memberName),
    );
  }

  private lastNameSortKey(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    const last = parts.at(-1) ?? name;
    const first = parts.slice(0, -1).join(' ');
    return `${last} ${first}`.toLowerCase();
  }

  private buildAvailableFilters(contacts: DirectoryContact[]): DirectoryAvailableFilters {
    return {
      chambers: uniqueSorted(contacts.map((contact) => contact.chamber)) as Chamber[],
      parties: (
        [
          { value: 'D', label: 'Democrat' },
          { value: 'R', label: 'Republican' },
          { value: 'I', label: 'Independent' },
        ] satisfies Array<{ value: Party; label: string }>
      ).filter((party) => contacts.some((contact) => contact.party === party.value)),
      genders: [
        { value: 'F' as const, label: 'Female' },
        { value: 'M' as const, label: 'Male' },
      ].filter((gender) => contacts.some((contact) => contact.gender === gender.value)),
      leadership: uniqueSorted(contacts.flatMap((contact) => contact.leadershipPositions)),
      committees: uniqueSorted(contacts.flatMap((contact) => contact.committees)),
      // CRS issue taxonomy, derived from staffer issue tags across all members.
      issues: uniqueSorted(
        contacts.flatMap((contact) => contact.staff.flatMap((staffer) => staffer.issueAreas)),
      ),
      // Caucus & Education have no backing data in the current snapshot (the
      // LegiStorm pull omits those endpoints). Emit empty arrays so the response
      // shape stays stable for consumers; the UI no longer renders these filters.
      caucuses: [],
      states: uniqueSorted(contacts.map((contact) => contact.state)),
      districts: uniqueSorted(
        contacts.map((contact) => contact.district),
        compareDistricts,
      ),
      educationInstitutions: [],
    };
  }

  private normalizeSort(raw: unknown): DirectorySort {
    const value = String(raw ?? 'recent');
    if (
      value === 'name-asc' ||
      value === 'name-desc' ||
      value === 'state-asc' ||
      value === 'chamber' ||
      value === 'party'
    )
      return value;
    return 'recent';
  }

  private normalizeFilter(raw: unknown): string | null {
    const value = String(raw ?? '').trim();
    if (!value || value.toLowerCase() === 'all') return null;
    return value;
  }

  private normalizeMultiFilter(raw: unknown): string[] {
    const values = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
    return uniqueSorted(
      values
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0 && value.toLowerCase() !== 'all'),
    );
  }

  private toPositiveInt(raw: unknown, fallback: number, max?: number): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    const intValue = Math.floor(parsed);
    if (max && intValue > max) return max;
    return intValue;
  }

  private buildContacts(
    membersRaw: unknown[],
    staffRaw: unknown[],
    bioOverlay: Map<string, MemberBioOverlay> = new Map(),
    pressOverlay: Map<string, MemberPressOverlay> = new Map(),
  ): DirectoryContact[] {
    const members = Array.isArray(membersRaw) ? membersRaw : [];
    const staffById = this.buildStaffDetailsById(staffRaw);
    const staffIdsByMember = this.buildStaffIdsByMember(staffRaw);
    const contacts: DirectoryContact[] = [];

    for (const row of members as any[]) {
      const member = row?.member;
      const memberId = Number(member?.member_id);
      if (!Number.isFinite(memberId)) continue;

      const profile = member?.profile;
      const memberName = [
        profile?.preferred_first_name ?? profile?.first_name,
        profile?.preferred_last_name ?? profile?.last_name,
      ]
        .filter(Boolean)
        .join(' ')
        .trim();
      if (!memberName) continue;

      const currentOffice = this.currentMemberOffice(row?.member_offices);
      if (!currentOffice) continue;

      const state = String(currentOffice.state_id ?? '').toUpperCase();
      const chamber = this.mapChamber(String(currentOffice.office_type_id ?? '').toUpperCase());
      const district = this.formatDistrict(chamber, state, currentOffice.district_no);
      const partyName = String(currentOffice.party ?? profile?.bio_details?.party_name ?? '');
      const party = this.mapParty(partyName);
      const honorific = this.honorific(chamber);
      const fullName = `${honorific} ${memberName}`;
      const title = this.primaryTitle(chamber, row?.leaderships);

      const addresses = this.buildAddresses(row?.office_member_addresses);
      const mainAddress = addresses.find((address) => address.isMain) ?? addresses[0];
      const officialLinks = this.buildLinks(row?.social_media);
      const email =
        officialLinks.find(
          (link) => link.type.toLowerCase().includes('email') && link.url.includes('@'),
        )?.url ?? '';
      const contactFormUrl =
        officialLinks.find(
          (link) =>
            link.type.toLowerCase().includes('email') &&
            !link.url.includes('@') &&
            link.url.startsWith('http'),
        )?.url ?? '';
      const committees = this.buildCommittees(row?.committees);
      const committeeLeadership = this.buildCommitteeLeadershipLabels(row?.committees);
      const leadershipPositions = this.buildLeadership(row?.leaderships);
      const staff = this.buildMemberStaff(row, staffById, staffIdsByMember.get(memberId) ?? []);
      const focusAreas = uniqueSorted(staff.flatMap((staffer) => staffer.issueAreas)).slice(0, 12);
      const topIssues = this.buildTopIssues(staff);
      const servingSince = this.servingSince(row?.member_offices);
      const photoUrl = this.primaryPhoto(row?.photos);
      const senateClass = this.parseSenateClass(currentOffice.senate_class);
      const outgoingStatus = currentOffice.outgoing_status
        ? String(currentOffice.outgoing_status)
        : null;
      const press = pressOverlay.get(String(member?.bioguide_id ?? ''));

      contacts.push({
        id: `member-${memberId}`,
        memberId,
        bioguideId: String(member?.bioguide_id ?? ''),
        fullName,
        memberName,
        honorific,
        photoUrl,
        title,
        office: this.formatOfficeLabel(chamber, memberName, state, currentOffice.district_no),
        chamber,
        state: state || 'DC',
        district,
        party,
        partyName: partyName || this.partyLabel(party),
        gender: this.mapGender(profile?.gender),
        region: this.mapRegion(state),
        isFreshman: this.isFreshman(servingSince),
        servingSince,
        focusAreas,
        committees,
        committeeLeadership,
        topIssues,
        leadershipPositions,
        caucuses: this.buildNamedList(row?.caucuses),
        educationInstitutions: this.buildEducation(row),
        senateClass,
        outgoingStatus,
        officeLocation: mainAddress ? this.formatAddress(mainAddress) : '',
        phone: mainAddress?.phone ?? '',
        fax: mainAddress?.fax ?? '',
        email,
        contactFormUrl,
        newsPressUrl: press?.newsPressUrl ?? '',
        rssFeedUrl: press?.rssFeedUrl ?? '',
        rssSource: press?.rssSource ?? '',
        officialLinks,
        addresses,
        staff,
        bio: {
          dob: String(profile?.bio_details?.dob ?? ''),
          hometown: String(profile?.bio_details?.hometown ?? ''),
          birthplace: String(profile?.bio_details?.pob ?? ''),
          occupation: String(profile?.bio_details?.occupation ?? ''),
          race: String(profile?.bio_details?.race_name ?? ''),
          religion: String(profile?.bio_details?.religion_name ?? ''),
          pronunciation: String(profile?.bio_details?.pronunciation ?? ''),
          narrative: String(bioOverlay.get(String(member?.bioguide_id ?? ''))?.narrative ?? ''),
          education: String(bioOverlay.get(String(member?.bioguide_id ?? ''))?.education ?? ''),
          military: String(bioOverlay.get(String(member?.bioguide_id ?? ''))?.military ?? ''),
          relatives: String(bioOverlay.get(String(member?.bioguide_id ?? ''))?.relatives ?? ''),
        },
        lastTouchpoint: this.latestDate([
          currentOffice.updated_at,
          mainAddress?.id
            ? row?.office_member_addresses?.find?.((a: any) => String(a?.id) === mainAddress.id)
                ?.updated_at
            : undefined,
          ...(Array.isArray(row?.social_media)
            ? row.social_media.map((link: any) => link?.updated_at)
            : []),
          ...(Array.isArray(row?.committees)
            ? row.committees.map((committee: any) => committee?.updated_at)
            : []),
          ...(Array.isArray(row?.leaderships)
            ? row.leaderships.map((leadership: any) => leadership?.updated_at)
            : []),
        ]),
        owner: 'Unassigned',
        relationshipTier:
          leadershipPositions.length > 0 ? 'Core' : committees.length > 0 ? 'Active' : 'Watch',
        notes: '',
        recentInteractions: [],
      });
    }

    contacts.push(TEST_DIRECTORY_CONTACT);

    return contacts.sort((a, b) => a.memberName.localeCompare(b.memberName));
  }

  private buildStaffDetailsById(staffRaw: unknown[]): Map<number, StaffDetail> {
    const staffById = new Map<number, StaffDetail>();
    const staffList = Array.isArray(staffRaw) ? staffRaw : [];

    for (const row of staffList as any[]) {
      const staff = row?.staff;
      const staffId = Number(staff?.id);
      if (!Number.isFinite(staffId)) continue;

      const fullName = [
        staff?.preferred_first_name ?? staff?.first_name,
        staff?.preferred_last_name ?? staff?.last_name,
      ]
        .filter(Boolean)
        .join(' ')
        .trim();
      if (!fullName) continue;

      const positions = Array.isArray(row?.positions) ? row.positions : [];
      const currentPosition =
        positions.find((position: any) => position?.is_current && position?.position_title) ??
        positions.find((position: any) => position?.position_title) ??
        positions[0];
      const emails = Array.isArray(row?.staff_emails) ? row.staff_emails : [];
      const emailRecord = emails.find(
        (email: any) =>
          typeof email?.contact_string === 'string' && email.contact_string.includes('@'),
      );
      const addresses = Array.isArray(row?.office_member_addresses)
        ? row.office_member_addresses
        : [];
      const address = addresses.find((entry: any) => entry?.is_main) ?? addresses[0];

      staffById.set(staffId, {
        id: `staff-${staffId}`,
        fullName,
        title: String(currentPosition?.position_title ?? currentPosition?.position_type ?? 'Staff'),
        email: String(emailRecord?.contact_string ?? ''),
        phone: String(address?.phone ?? ''),
        officeLocation: [address?.address1, address?.city, address?.state_id]
          .filter(Boolean)
          .join(', '),
      });
    }

    return staffById;
  }

  // member_id -> staffIds with a CURRENT position in that member's office, from
  // staff-list `positions[].member`. Committee positions have member=null, so
  // they're naturally excluded. Powers the staffer-coverage merge.
  private buildStaffIdsByMember(staffRaw: unknown[]): Map<number, number[]> {
    const byMember = new Map<number, Set<number>>();
    const staffList = Array.isArray(staffRaw) ? staffRaw : [];
    for (const row of staffList as any[]) {
      const staffId = Number(row?.staff?.id);
      if (!Number.isFinite(staffId)) continue;
      const positions = Array.isArray(row?.positions) ? row.positions : [];
      for (const position of positions) {
        if (!position?.is_current) continue;
        const memberId = Number(position?.member?.member_id);
        if (!Number.isFinite(memberId)) continue;
        const set = byMember.get(memberId) ?? new Set<number>();
        set.add(staffId);
        byMember.set(memberId, set);
      }
    }
    const out = new Map<number, number[]>();
    for (const [memberId, set] of byMember) out.set(memberId, [...set]);
    return out;
  }

  private buildMemberStaff(
    row: any,
    staffById: Map<number, StaffDetail>,
    extraStaffIds: number[] = [],
  ): DirectoryStaffMember[] {
    const byStaffId = new Map<number, DirectoryStaffMember>();
    const roles = Array.isArray(row?.staffer_roles) ? row.staffer_roles : [];
    const issues = Array.isArray(row?.staffer_issues) ? row.staffer_issues : [];

    const ensureStaffer = (staffer: any): DirectoryStaffMember | null => {
      const staffId = Number(staffer?.id);
      if (!Number.isFinite(staffId)) return null;
      const detail = staffById.get(staffId);
      const fullName =
        detail?.fullName ??
        [
          staffer?.preferred_first_name ?? staffer?.first_name,
          staffer?.preferred_last_name ?? staffer?.last_name,
        ]
          .filter(Boolean)
          .join(' ')
          .trim();
      if (!fullName) return null;
      const existing = byStaffId.get(staffId);
      if (existing) return existing;
      const created: DirectoryStaffMember = {
        id: `staff-${staffId}`,
        fullName,
        title: detail?.title ?? 'Staff',
        roles: [],
        issueAreas: [],
        email: detail?.email ?? '',
        phone: detail?.phone ?? '',
        officeLocation: detail?.officeLocation ?? '',
      };
      byStaffId.set(staffId, created);
      return created;
    };

    for (const role of roles) {
      const staffer = ensureStaffer(role?.staffer);
      if (!staffer || !role?.role_name) continue;
      staffer.roles.push(String(role.role_name));
      if (staffer.title === 'Staff') staffer.title = String(role.role_name);
    }

    for (const issue of issues) {
      const staffer = ensureStaffer(issue?.staffer);
      if (!staffer || !issue?.issue_name) continue;
      staffer.issueAreas.push(String(issue.issue_name));
    }

    // Coverage merge: staffers linked to this member via staff-list
    // `positions[].member` but absent from staffer_roles/issues. They get their
    // title/contact from staffById; roles/issueAreas stay empty (not tagged).
    for (const staffId of extraStaffIds) {
      if (byStaffId.has(staffId)) continue;
      const detail = staffById.get(staffId);
      if (!detail?.fullName) continue;
      byStaffId.set(staffId, {
        id: `staff-${staffId}`,
        fullName: detail.fullName,
        title: detail.title || 'Staff',
        roles: [],
        issueAreas: [],
        email: detail.email ?? '',
        phone: detail.phone ?? '',
        officeLocation: detail.officeLocation ?? '',
      });
    }

    return [...byStaffId.values()]
      .map((staffer) => ({
        ...staffer,
        roles: uniqueSorted(staffer.roles),
        issueAreas: uniqueSorted(staffer.issueAreas),
      }))
      .sort((left, right) => left.fullName.localeCompare(right.fullName));
  }

  private currentMemberOffice(rawOffices: unknown): any | null {
    // Single source of truth (see selectCurrentMemberOffice): in-office > newest
    // non-expired > last term. Never the first (oldest) array element.
    return selectCurrentMemberOffice(rawOffices);
  }

  private buildAddresses(rawAddresses: unknown): DirectoryAddress[] {
    const addresses = Array.isArray(rawAddresses) ? rawAddresses : [];
    return addresses.map((address: any) => ({
      id: String(address?.id ?? ''),
      title: String(address?.title ?? ''),
      address1: String(address?.address1 ?? ''),
      address2: String(address?.address2 ?? ''),
      city: String(address?.city ?? ''),
      state: String(address?.state_id ?? ''),
      zip: [address?.zip, address?.zip_ext].filter(Boolean).join('-'),
      phone: String(address?.phone ?? ''),
      fax: String(address?.fax ?? ''),
      isMain: Boolean(address?.is_main),
    }));
  }

  private buildLinks(rawLinks: unknown): DirectoryLink[] {
    const links = Array.isArray(rawLinks) ? rawLinks : [];
    return links
      .map((link: any) => ({
        label: this.linkLabel(String(link?.contact_type ?? 'Link')),
        type: String(link?.contact_type ?? ''),
        url: String(link?.contact_string ?? ''),
      }))
      .filter((link) => link.url);
  }

  private linkLabel(type: string): string {
    const lower = type.toLowerCase();
    if (lower.includes('website'))
      return type.includes('campaign') ? 'Website, campaign' : 'Website, official';
    if (lower.includes('twitter') || lower.includes('x ('))
      return type.includes('campaign') ? 'X, campaign' : 'X, official';
    if (lower.includes('facebook'))
      return type.includes('campaign') ? 'Facebook, campaign' : 'Facebook, official';
    if (lower.includes('instagram'))
      return type.includes('campaign') ? 'Instagram, campaign' : 'Instagram, official';
    if (lower.includes('youtube'))
      return type.includes('campaign') ? 'YouTube, campaign' : 'YouTube, official';
    if (lower.includes('email')) return type.includes('form') ? 'Contact form' : type;
    return type || 'Link';
  }

  private buildCommittees(rawCommittees: unknown): string[] {
    const committees = Array.isArray(rawCommittees) ? rawCommittees : [];
    return uniqueSorted(
      committees
        .map((committee: any) => committee?.committee_office?.name)
        .filter(Boolean)
        .map(String),
    );
  }

  // Leadership roles this member holds on committees, e.g. "Chair — House Armed
  // Services Committee". Only the ranking roles (not plain membership).
  private buildCommitteeLeadershipLabels(rawCommittees: unknown): string[] {
    const committees = Array.isArray(rawCommittees) ? rawCommittees : [];
    const ranked = new Set([
      'Chair',
      'Ranking Member',
      'Vice Chair',
      'Vice Ranking Member',
      'Co-Chair',
      'Chair Emeritus',
    ]);
    return uniqueSorted(
      committees
        .filter((committee: any) => ranked.has(String(committee?.position ?? '').trim()))
        .map((committee: any) => {
          const name = committee?.committee_office?.name;
          const position = String(committee?.position ?? '').trim();
          return name ? `${position} — ${name}` : '';
        })
        .filter(Boolean),
    );
  }

  // Per-member issue intensity: distinct staffers tagged with each issue, ranked
  // by headcount. This is the honest signal (issue *presence* is near-universal).
  private buildTopIssues(
    staff: DirectoryStaffMember[],
  ): Array<{ issue: string; stafferCount: number }> {
    const counts = new Map<string, number>();
    for (const staffer of staff) {
      for (const issue of new Set(staffer.issueAreas)) {
        counts.set(issue, (counts.get(issue) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([issue, stafferCount]) => ({ issue, stafferCount }))
      .sort((left, right) => {
        if (right.stafferCount !== left.stafferCount) return right.stafferCount - left.stafferCount;
        return left.issue.localeCompare(right.issue);
      })
      .slice(0, 12);
  }

  private parseSenateClass(raw: unknown): number | null {
    const value = Number(raw);
    return value === 1 || value === 2 || value === 3 ? value : null;
  }

  private buildLeadership(rawLeaderships: unknown): string[] {
    const leaderships = Array.isArray(rawLeaderships) ? rawLeaderships : [];
    return uniqueSorted(
      leaderships
        .filter(
          (leadership: any) => !leadership?.end_date || String(leadership.end_date) >= '2026-01-01',
        )
        .map((leadership: any) => leadership?.position)
        .filter(Boolean)
        .map(String),
    );
  }

  private buildNamedList(rawList: unknown): string[] {
    const list = Array.isArray(rawList) ? rawList : [];
    return uniqueSorted(
      list
        .map((entry: any) => entry?.name ?? entry?.caucus_name ?? entry?.title)
        .filter(Boolean)
        .map(String),
    );
  }

  private buildEducation(row: any): string[] {
    const list = Array.isArray(row?.education)
      ? row.education
      : Array.isArray(row?.educations)
        ? row.educations
        : [];
    return uniqueSorted(
      list
        .map((entry: any) => entry?.school ?? entry?.institution ?? entry?.name)
        .filter(Boolean)
        .map(String),
    );
  }

  private servingSince(rawOffices: unknown): string {
    const offices = Array.isArray(rawOffices) ? rawOffices : [];
    const starts = offices
      .map((office: any) => String(office?.start_date ?? ''))
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
      .sort();
    return starts[0] ?? '';
  }

  private isFreshman(servingSince: string): boolean {
    return Boolean(servingSince) && servingSince >= '2025-01-03';
  }

  private primaryPhoto(rawPhotos: unknown): string {
    const photos = Array.isArray(rawPhotos) ? rawPhotos : [];
    return String(
      photos.find((photo: any) => photo?.status === 'public' && photo?.is_directory)?.url ??
        photos.find((photo: any) => photo?.status === 'public' && photo?.is_primary)?.url ??
        photos.find((photo: any) => photo?.status === 'public')?.url ??
        '',
    );
  }

  private primaryTitle(chamber: Chamber, rawLeaderships: unknown): string {
    const leadership = this.buildLeadership(rawLeaderships)[0];
    if (leadership) return leadership;
    if (chamber === 'Senate') return 'United States Senator';
    if (chamber === 'Governor') return 'Governor';
    return 'Member of Congress';
  }

  private mapChamber(officeType: string): Chamber {
    if (officeType === 'SM') return 'Senate';
    if (officeType === 'GV') return 'Governor';
    return 'House';
  }

  private mapParty(rawParty: unknown): Party {
    const value = String(rawParty ?? '').toLowerCase();
    if (value.startsWith('r')) return 'R';
    if (value.startsWith('i')) return 'I';
    return 'D';
  }

  private partyLabel(party: Party): string {
    if (party === 'R') return 'Republican';
    if (party === 'I') return 'Independent';
    return 'Democrat';
  }

  private mapGender(rawGender: unknown): DirectoryContact['gender'] {
    const value = String(rawGender ?? '').toUpperCase();
    if (value === 'F' || value === 'M') return value;
    return 'Unknown';
  }

  private mapRegion(stateCode: string): Region {
    const state = stateCode.toUpperCase();
    const northeast = new Set(['ME', 'NH', 'VT', 'MA', 'RI', 'CT', 'NY', 'NJ', 'PA']);
    const south = new Set([
      'DE',
      'MD',
      'DC',
      'VA',
      'WV',
      'NC',
      'SC',
      'GA',
      'FL',
      'KY',
      'TN',
      'MS',
      'AL',
      'OK',
      'TX',
      'AR',
      'LA',
    ]);
    const midwest = new Set([
      'OH',
      'MI',
      'IN',
      'IL',
      'WI',
      'MN',
      'IA',
      'MO',
      'ND',
      'SD',
      'NE',
      'KS',
    ]);
    if (northeast.has(state)) return 'Northeast';
    if (south.has(state)) return 'South';
    if (midwest.has(state)) return 'Midwest';
    return 'West';
  }

  private honorific(chamber: Chamber): string {
    if (chamber === 'Senate') return 'Sen.';
    if (chamber === 'Governor') return 'Gov.';
    return 'Rep.';
  }

  private formatOfficeLabel(
    chamber: Chamber,
    memberName: string,
    state: string,
    district: unknown,
  ): string {
    if (chamber === 'Senate') return `Senate office, ${state}`;
    if (chamber === 'Governor') return `Governor office, ${state}`;
    const districtNo = Number(district);
    if (Number.isFinite(districtNo) && districtNo > 0) {
      return `${memberName} office (${state}-${districtNo})`;
    }
    return `${memberName} office (${state})`;
  }

  private formatDistrict(chamber: Chamber, state: string, district: unknown): string {
    if (chamber !== 'House') return state;
    const districtNo = Number(district);
    return Number.isFinite(districtNo) && districtNo > 0 ? `${state}-${districtNo}` : state;
  }

  private formatAddress(address: DirectoryAddress): string {
    return [address.address1, address.address2, address.city, address.state, address.zip]
      .filter(Boolean)
      .join(', ');
  }

  private latestDate(values: unknown[]): string {
    const dates = values
      .map((value) => this.toIsoDate(value))
      .filter((value) => value !== '1970-01-01');
    return dates.sort().at(-1) ?? '1970-01-01';
  }

  private toIsoDate(raw: unknown): string {
    if (!raw) return '1970-01-01';
    const parsed = new Date(String(raw).replace(' ', 'T'));
    if (Number.isNaN(parsed.getTime())) return '1970-01-01';
    return parsed.toISOString().slice(0, 10);
  }
}

function uniqueSorted<T extends string>(
  values: T[],
  compareFn?: (left: T, right: T) => number,
): T[] {
  return Array.from(new Set(values.filter(Boolean))).sort(
    compareFn ?? ((left, right) => left.localeCompare(right)),
  );
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

function compareDistricts(left: string, right: string): number {
  const [leftState = '', leftDistrictRaw = '0'] = left.split('-');
  const [rightState = '', rightDistrictRaw = '0'] = right.split('-');
  const stateCompare = leftState.localeCompare(rightState);
  if (stateCompare !== 0) return stateCompare;
  return Number(leftDistrictRaw) - Number(rightDistrictRaw);
}

/**
 * WS-D — bridge a client_facilities-style district code ('00' for at-large,
 * zero-padded 2-digit otherwise — the URL path convention) back to
 * LegiStorm's own raw districtNo storage, given the House rows already
 * fetched for a state+status. Exported (unlike this file's other module-
 * level helpers) so its at-large logic is unit-testable without a database.
 *
 * '00' matches ONLY when exactly one House row exists for this state+status
 * — never a hardcoded list of "the 6 at-large states" (WY, VT, DE, ND, SD,
 * AK today; apportionment can change after a future census), and never by
 * trusting LegiStorm's own districtNo value, which reports "1" (not a "0"
 * or null sentinel) even for a jurisdiction's sole House seat — verified
 * live 2026-07-24 via DC's non-voting delegate.
 */
export function matchFacilityDistrictCode<T extends { districtNo: string | null }>(
  houseRows: T[],
  facilityDistrictNo: string,
): T | null {
  if (facilityDistrictNo === '00') {
    // Defense in depth: don't rely solely on the caller's chamber='house'
    // filter to keep a null-districtNo (Senate-shaped) row out of this
    // array — require the sole row to actually carry a districtNo before
    // calling it an at-large match.
    const single = houseRows.length === 1 ? houseRows[0]! : null;
    return single && single.districtNo !== null ? single : null;
  }
  const bare = facilityDistrictNo.replace(/^0+(?=\d)/, '');
  return houseRows.find((r) => r.districtNo === bare) ?? null;
}
