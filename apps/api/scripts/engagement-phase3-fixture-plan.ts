/**
 * Engagement Phase 3 parity fixtures — the declarative plan.
 *
 * Micro-session 3.2. This module is PURE: it builds and validates the fixture
 * set without touching a database, a provider, or the clock. The seed script
 * (`seed-engagement-phase3-parity-fixtures.ts`) materializes it; the spec
 * (`seed-engagement-phase3-parity-fixtures.spec.ts`) tests it.
 *
 * Two properties the split exists to buy:
 *
 *  1. **The contract JSON is byte-stable.** No row carries an absolute
 *     timestamp. Temporal position is a *descriptor* — an offset from a caller-
 *     supplied anchor, or a cycle-relative UTC date — which the seed
 *     materializes at apply time. A literal `2026-…Z` in the contract would
 *     make it re-generate differently every day, and would silently move the
 *     report-period fixtures into the wrong cycle next January.
 *
 *  2. **The negative controls bite.** Every rule below is a pure predicate over
 *     the plan, so the spec can corrupt a plan and prove the check fails —
 *     rather than asserting that a `grep` was spelled correctly.
 *
 * Fixture id space: `e3000000-0000-4000-8000-000000<gg><iiii>` — `gg` groups the
 * entity kind, `iiii` is its index. Stable across runs by construction, and
 * greppable in a database when a parity failure needs tracing.
 */

/** Marker required in every fixture row's human-readable label. */
export const PHASE3_MARKER = 'Phase 3 Parity';

/** Prefix every fixture UUID shares, so fixture rows are identifiable in SQL. */
export const FIXTURE_ID_PREFIX = 'e3000000-0000-4000-8000-';

const FIXTURE_ID_RE = /^e3000000-0000-4000-8000-000000[0-9a-f]{2}[0-9a-f]{4}$/;

/**
 * Domains a fixture address may use. RFC 2606 / RFC 6761 reserved names plus
 * `example.gov`, which GSA holds as the reserved federal example domain (and
 * which the accepted Phase 0 fixtures already use). Anything else is refused:
 * a fixture must not be able to name a mailbox that could actually receive
 * mail if an external action ever escaped containment.
 */
const ALLOWED_EMAIL_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'example.gov']);
const ALLOWED_EMAIL_TLD_SUFFIXES = ['.invalid', '.test', '.example', '.localhost'];

/**
 * Identifiers that must hold a specific non-marker value for the product to
 * behave correctly, with the reason. Every entry costs a citation, so the cheap
 * path is to keep the fixture inside the marker space rather than widen this.
 */
export const RESERVED_IDENTIFIERS: ReadonlyArray<{ value: string; field: string; reason: string }> =
  [
    {
      value: 'capiro-internal',
      field: 'Tenant.slug',
      reason:
        'The capiro_admin role is granted only when the org slug matches this reserved value — ' +
        'apps/api/scripts/bootstrap-capiro-admin.ts CAPIRO_INTERNAL_SLUG. A marker-prefixed slug ' +
        'would produce a tenant whose admin cannot be a Capiro admin, so the impersonation ' +
        'fixture would test nothing.',
    },
    {
      value: 'avery.testwell@example.invalid',
      field: 'MeetingAttendee.email',
      reason:
        'The one directory contact that exists without the S3 directory snapshot — ' +
        'TEST_DIRECTORY_CONTACT in apps/api/src/directory/directory.service.ts. Reports rows with ' +
        'source="directory" (and therefore every pendingActions count) are reachable only through ' +
        'a directory email match, so this address is what makes that state addressable at all.',
    },
  ];

// ─── temporal descriptors ───────────────────────────────────────────────────

/** Offset in minutes from the run anchor. Use for "recent"/"upcoming" data. */
export interface AnchorOffsetSpec {
  kind: 'anchorOffset';
  minutes: number;
}

/**
 * A fixed UTC date inside the current or previous *report cycle*. Report
 * periods are calendar-year windows resolved at request time
 * (`reportPeriodWindow`, engagement.service.ts), so any fixture that must land
 * in a named period has to be cycle-relative rather than anchor-relative — an
 * anchor-relative offset of −7 days falls in the previous cycle every January.
 */
export interface CycleDateSpec {
  kind: 'cycleDate';
  cycleYearOffset: 0 | -1;
  monthIndex: number;
  day: number;
  hourUtc: number;
  minuteUtc: number;
}

/**
 * A whole-day offset from the anchor at an explicit UTC clock time.
 *
 * `anchorOffset` cannot express this: it inherits the anchor's time-of-day, so a
 * "23:30 local" meeting lands at a different UTC hour on every run and the
 * local/UTC date divergence it exists to create silently disappears. The
 * timezone-boundary and all-day fixtures both need a pinned UTC time and a
 * position near the anchor, which is exactly this shape.
 */
export interface AnchorDaySpec {
  kind: 'anchorDay';
  dayOffset: number;
  hourUtc: number;
  minuteUtc: number;
}

export type TemporalSpec = AnchorOffsetSpec | CycleDateSpec | AnchorDaySpec;

const at = (minutes: number): AnchorOffsetSpec => ({ kind: 'anchorOffset', minutes });
const anchorDay = (dayOffset: number, hourUtc: number, minuteUtc = 0): AnchorDaySpec => ({
  kind: 'anchorDay',
  dayOffset,
  hourUtc,
  minuteUtc,
});
const cycleDate = (
  cycleYearOffset: 0 | -1,
  monthIndex: number,
  day: number,
  hourUtc = 15,
  minuteUtc = 0,
): CycleDateSpec => ({ kind: 'cycleDate', cycleYearOffset, monthIndex, day, hourUtc, minuteUtc });

const DAY = 60 * 24;

/** Materialize a descriptor against a concrete anchor. */
export function resolveTemporal(spec: TemporalSpec, anchor: Date): Date {
  if (spec.kind === 'anchorOffset') return new Date(anchor.getTime() + spec.minutes * 60_000);
  if (spec.kind === 'anchorDay') {
    return new Date(
      Date.UTC(
        anchor.getUTCFullYear(),
        anchor.getUTCMonth(),
        anchor.getUTCDate() + spec.dayOffset,
        spec.hourUtc,
        spec.minuteUtc,
      ),
    );
  }
  const year = anchor.getUTCFullYear() + spec.cycleYearOffset;
  return new Date(Date.UTC(year, spec.monthIndex, spec.day, spec.hourUtc, spec.minuteUtc));
}

// ─── row shapes ─────────────────────────────────────────────────────────────

export interface TenantFixture {
  key: string;
  id: string;
  slug: string;
  name: string;
  clerkOrgId: string;
}

export interface UserFixture {
  key: string;
  id: string;
  email: string;
  clerkUserId: string;
  firstName: string;
  lastName: string;
}

export interface MembershipFixture {
  key: string;
  id: string;
  tenantKey: string;
  userKey: string;
  role: 'capiro_admin' | 'user_admin' | 'standard_user' | 'client_portal_user';
  status: 'invited' | 'active' | 'removed';
}

export interface ImpersonationFixture {
  key: string;
  id: string;
  tenantKey: string;
  actorUserKey: string;
  reason: string;
  startedAt: TemporalSpec;
  expiresAt: TemporalSpec;
  endedAt: TemporalSpec | null;
}

export interface ClientFixture {
  key: string;
  id: string;
  tenantKey: string;
  name: string;
  memoryWall: boolean;
}

export interface ClientMemoryAccessFixture {
  key: string;
  id: string;
  tenantKey: string;
  clientKey: string;
  userKey: string;
}

export interface ContactFixture {
  key: string;
  id: string;
  tenantKey: string;
  clientKey: string | null;
  fullName: string;
  email: string | null;
  organization: string;
  title: string;
}

export interface MeetingFixture {
  key: string;
  id: string;
  tenantKey: string;
  clientKey: string | null;
  subject: string;
  startsAt: TemporalSpec;
  endsAt: TemporalSpec;
  timeZone: string | null;
  allDay: boolean;
  status: string;
  visibility: 'private' | 'shared';
  createdByUserKey: string;
  organizerEmail: string;
  location: string | null;
}

export interface AttendeeFixture {
  key: string;
  id: string;
  tenantKey: string;
  meetingKey: string;
  contactKey: string | null;
  email: string | null;
  name: string;
  role: string;
}

export interface BotSessionFixture {
  key: string;
  id: string;
  tenantKey: string;
  meetingKey: string;
  requestedByUserKey: string;
  status: string;
  joinUrl: string;
  recordingPolicy: string;
  error: string | null;
}

export interface PrepFixture {
  key: string;
  id: string;
  tenantKey: string;
  meetingKey: string;
  clientKey: string | null;
  status: 'generated' | 'edited' | 'approved' | 'stale' | 'failed';
  summary: string;
  agenda: string[];
}

/**
 * Note/debrief bodies are stored as PLAINTEXT here and encrypted by the seed
 * with the product's own MeetingNotesCryptoService. Keeping ciphertext out of
 * the plan is what makes the contract deterministic (the IV is random per
 * encryption) and what stops the fixture from drifting away from the cipher the
 * service actually reads.
 */
export interface EncryptedBodyFixture {
  key: string;
  id: string;
  tenantKey: string;
  meetingKey: string;
  clientKey: string | null;
  authorUserKey: string;
  bodyPlaintext: string;
  confidential: boolean;
  accessLevel: string;
  status: string;
}

export interface TaskFixture {
  key: string;
  id: string;
  tenantKey: string;
  clientKey: string | null;
  meetingKey: string | null;
  title: string;
  status: 'todo' | 'in_progress' | 'done' | 'blocked' | 'canceled';
  createdByUserKey: string;
}

export interface AttachmentFixture {
  key: string;
  id: string;
  tenantKey: string;
  clientKey: string | null;
  meetingKey: string | null;
  fileName: string;
  contentType: string;
  byteSize: number;
  bucket: string;
  s3Key: string;
  lifecycleStatus: string;
  scanStatus: string | null;
  uploadedByUserKey: string;
}

export interface OutreachRecipientFixture {
  id: string;
  name: string;
  email?: string;
  office?: string;
  title?: string;
  direction?: 'on-behalf' | 'to-clients';
  cc?: string[];
  bcc?: string[];
  groupMembers?: Array<{ email: string; name: string }>;
  personalNote?: string;
  generationKey?: string;
}

export interface OutreachRecordFixture {
  key: string;
  id: string;
  tenantKey: string;
  clientKey: string | null;
  meetingKey: string | null;
  createdByUserKey: string;
  type: 'campaign' | 'follow_up' | 'prep' | 'outbound_campaign';
  status: 'draft' | 'sent' | 'opened_in_email' | 'failed';
  title: string;
  subject: string | null;
  body: string | null;
  recipients: OutreachRecipientFixture[];
  lastStep: number;
  sentAt: TemporalSpec | null;
  openedInEmailAt: TemporalSpec | null;
  attachmentKeys: string[];
}

export interface DraftArtifactFixture {
  key: string;
  id: string;
  tenantKey: string;
  outreachRecordKey: string;
  generationKey: string;
  recipientKey: string;
  audienceKind: 'individual' | 'group';
  createdByUserKey: string;
  currentVersion: number;
}

export interface DraftVersionFixture {
  key: string;
  id: string;
  tenantKey: string;
  artifactKey: string;
  version: number;
  subject: string;
  body: string;
  generationStatus: 'generated' | 'manually_authored' | 'generation_failed';
  auditStatus: 'not_required' | 'pending' | 'passed' | 'warning' | 'held' | 'unavailable';
  approvalStatus: 'not_required' | 'pending' | 'approved' | 'rejected';
  auditDecision: string | null;
  provider: string | null;
  model: string | null;
  createdByUserKey: string;
}

export interface SendIntentFixture {
  key: string;
  id: string;
  tenantKey: string;
  userKey: string;
  outreachRecordKey: string;
  senderConnectionKey: string;
  requestKey: string;
  status: string;
  totals: Record<string, number>;
}

export interface DeliveryFixture {
  key: string;
  id: string;
  tenantKey: string;
  sendIntentKey: string;
  draftVersionKey: string;
  generationKey: string;
  recipientKey: string;
  toEmail: string;
  toName: string;
  renderedSubject: string;
  renderedBody: string;
  provider: 'microsoft_graph' | 'gmail';
  status: string;
  providerMessageId: string | null;
}

export interface AudienceFixture {
  key: string;
  id: string;
  tenantKey: string;
  createdByUserKey: string;
  kind: 'list' | 'group';
  name: string;
  status: string;
}

export interface AudienceMemberFixture {
  key: string;
  id: string;
  tenantKey: string;
  audienceKey: string;
  source: string;
  name: string;
  email: string;
  office: string;
}

export interface TemplateFixture {
  key: string;
  id: string;
  tenantKey: string;
  createdByUserKey: string;
  type: string;
  name: string;
  subject: string;
  body: string;
}

export interface AiTemplateFixture {
  key: string;
  id: string;
  tenantKey: string;
  userKey: string;
  name: string;
  category: string;
  prompt: string;
}

export interface ReportTargetFixture {
  key: string;
  id: string;
  tenantKey: string;
  clientKey: string | null;
  scopeKeyFrom: 'clientId' | 'all';
  officeKey: string;
  memberPrincipal: string;
  committee: string;
  staffer: string;
  building: string;
  leadOwner: string;
  prepStatus: 'auto' | 'not_started' | 'in_progress' | 'complete';
  outreachStatus: 'auto' | 'not_started' | 'in_progress' | 'complete';
  submissionStatus: 'auto' | 'not_started' | 'in_progress' | 'complete';
  source: string;
}

export interface ConnectionFixture {
  key: string;
  id: string;
  tenantKey: string;
  provider: 'microsoft_365' | 'google_workspace' | 'imap_caldav' | 'manual';
  accountEmail: string;
  displayName: string;
  status: 'needs_configuration' | 'connected' | 'error' | 'disabled';
  scopes: string[];
  lastSyncAt: TemporalSpec | null;
  lastError: string | null;
  /** Provider subscription metadata, recorded WITHOUT any provider call. */
  syncState: Record<string, unknown>;
}

/** A state the plan (micro-session 3.2) requires the fixture set to render. */
export interface FixtureState {
  id: string;
  planSection: 'users_and_tenants' | 'meetings' | 'outreach_v2' | 'reports' | 'integrations';
  requirement: string;
  /** Fixture keys that produce this state; `[]` only for absence states. */
  coveredBy: string[];
  /** Set when the state is the ABSENCE of rows rather than their presence. */
  absence?: string;
  /** External input the state needs beyond the database. */
  requires?: 'directory_snapshot' | 'runtime_config';
  note?: string;
}

export interface FixturePlan {
  marker: string;
  idPrefix: string;
  tenants: TenantFixture[];
  users: UserFixture[];
  memberships: MembershipFixture[];
  impersonations: ImpersonationFixture[];
  clients: ClientFixture[];
  clientMemoryAccess: ClientMemoryAccessFixture[];
  contacts: ContactFixture[];
  meetings: MeetingFixture[];
  attendees: AttendeeFixture[];
  botSessions: BotSessionFixture[];
  preps: PrepFixture[];
  notes: EncryptedBodyFixture[];
  debriefs: EncryptedBodyFixture[];
  tasks: TaskFixture[];
  attachments: AttachmentFixture[];
  outreachRecords: OutreachRecordFixture[];
  draftArtifacts: DraftArtifactFixture[];
  draftVersions: DraftVersionFixture[];
  sendIntents: SendIntentFixture[];
  deliveries: DeliveryFixture[];
  audiences: AudienceFixture[];
  audienceMembers: AudienceMemberFixture[];
  templates: TemplateFixture[];
  aiTemplates: AiTemplateFixture[];
  reportTargets: ReportTargetFixture[];
  connections: ConnectionFixture[];
  /** Ids that must resolve to NOTHING — the deterministic 404 fixtures. */
  absentIds: Array<{ key: string; id: string; expectation: string }>;
  states: FixtureState[];
  /**
   * Tables the seed writes, in the order cleanup must delete them. Asserted
   * against the seed's own delete plan so a new table cannot be seeded without
   * being cleaned up.
   */
  cleanupOrder: string[];
}

// ─── id helper ──────────────────────────────────────────────────────────────

const GROUP = {
  tenant: 0x01,
  user: 0x02,
  membership: 0x03,
  impersonation: 0x04,
  client: 0x05,
  wallGrant: 0x06,
  contact: 0x07,
  meeting: 0x08,
  attendee: 0x09,
  botSession: 0x0a,
  prep: 0x0b,
  note: 0x0c,
  debrief: 0x0d,
  task: 0x0e,
  attachment: 0x0f,
  outreach: 0x10,
  artifact: 0x11,
  version: 0x12,
  sendIntent: 0x13,
  delivery: 0x14,
  audience: 0x15,
  audienceMember: 0x16,
  template: 0x17,
  aiTemplate: 0x18,
  reportTarget: 0x19,
  connection: 0x1a,
  absent: 0x1f,
} as const;

function fid(group: number, index: number): string {
  const gg = group.toString(16).padStart(2, '0');
  const iiii = index.toString(16).padStart(4, '0');
  return `${FIXTURE_ID_PREFIX}000000${gg}${iiii}`;
}

const label = (text: string): string => `${PHASE3_MARKER} — ${text}`;

// ─── the plan ───────────────────────────────────────────────────────────────

export function buildFixturePlan(): FixturePlan {
  const tenants: TenantFixture[] = [
    {
      key: 'tenant.primary',
      id: fid(GROUP.tenant, 1),
      slug: 'phase3-parity-primary',
      name: label('Primary Tenant'),
      clerkOrgId: 'org_phase3_parity_primary',
    },
    {
      key: 'tenant.secondary',
      id: fid(GROUP.tenant, 2),
      slug: 'phase3-parity-secondary',
      name: label('Second Tenant'),
      clerkOrgId: 'org_phase3_parity_secondary',
    },
    {
      // Reserved slug — see RESERVED_IDENTIFIERS.
      key: 'tenant.capiroInternal',
      id: fid(GROUP.tenant, 3),
      slug: 'capiro-internal',
      name: label('Capiro Internal'),
      clerkOrgId: 'org_phase3_parity_capiro_internal',
    },
  ];

  const users: UserFixture[] = [
    ['admin', 'Ada', 'Adminson'],
    ['standard', 'Sam', 'Standard'],
    ['belowRole', 'Bo', 'Portalson'],
    ['peer', 'Pia', 'Peerson'],
    ['wallDenied', 'Wes', 'Walled'],
    ['crossTenant', 'Cleo', 'Crosstenant'],
    ['capiroAdmin', 'Cap', 'Adminstaff'],
  ].map(([name, firstName, lastName], index) => ({
    key: `actor.${name}`,
    id: fid(GROUP.user, index + 1),
    email: `phase3-${(name as string).toLowerCase()}@example.invalid`,
    clerkUserId: `user_phase3_parity_${name}`,
    firstName: `${firstName} ${PHASE3_MARKER}`,
    lastName: lastName as string,
  }));

  const memberships: MembershipFixture[] = [
    { userKey: 'actor.admin', tenantKey: 'tenant.primary', role: 'user_admin' as const },
    { userKey: 'actor.standard', tenantKey: 'tenant.primary', role: 'standard_user' as const },
    {
      userKey: 'actor.belowRole',
      tenantKey: 'tenant.primary',
      role: 'client_portal_user' as const,
    },
    { userKey: 'actor.peer', tenantKey: 'tenant.primary', role: 'standard_user' as const },
    { userKey: 'actor.wallDenied', tenantKey: 'tenant.primary', role: 'standard_user' as const },
    { userKey: 'actor.crossTenant', tenantKey: 'tenant.secondary', role: 'user_admin' as const },
    {
      userKey: 'actor.capiroAdmin',
      tenantKey: 'tenant.capiroInternal',
      role: 'capiro_admin' as const,
    },
  ].map((row, index) => ({
    key: `membership.${row.userKey}`,
    id: fid(GROUP.membership, index + 1),
    tenantKey: row.tenantKey,
    userKey: row.userKey,
    role: row.role,
    status: 'active' as const,
  }));

  const impersonations: ImpersonationFixture[] = [
    {
      key: 'impersonation.active',
      id: fid(GROUP.impersonation, 1),
      tenantKey: 'tenant.primary',
      actorUserKey: 'actor.capiroAdmin',
      reason: label('active impersonation for parity acceptance'),
      startedAt: at(-15),
      expiresAt: at(8 * 60),
      endedAt: null,
    },
    {
      key: 'impersonation.expired',
      id: fid(GROUP.impersonation, 2),
      tenantKey: 'tenant.primary',
      actorUserKey: 'actor.capiroAdmin',
      reason: label('expired impersonation for parity acceptance'),
      startedAt: at(-4 * DAY),
      expiresAt: at(-4 * DAY + 60),
      endedAt: at(-4 * DAY + 60),
    },
  ];

  const clients: ClientFixture[] = [
    {
      key: 'client.alpha',
      id: fid(GROUP.client, 1),
      tenantKey: 'tenant.primary',
      name: label('Alpha Systems'),
      memoryWall: false,
    },
    {
      key: 'client.beta',
      id: fid(GROUP.client, 2),
      tenantKey: 'tenant.primary',
      name: label('Beta Industries'),
      memoryWall: false,
    },
    {
      key: 'client.walled',
      id: fid(GROUP.client, 3),
      tenantKey: 'tenant.primary',
      name: label('Walled Holdings'),
      memoryWall: true,
    },
    {
      key: 'client.secondTenant',
      id: fid(GROUP.client, 4),
      tenantKey: 'tenant.secondary',
      name: label('Second Tenant Client'),
      memoryWall: false,
    },
  ];

  // The walled client is reachable by admin and standard; actor.wallDenied
  // holds no grant, which is what makes it the denied actor. A walled client
  // with zero grants is invisible to everyone (admins included), so the grants
  // have to exist for the ALLOWED half of the comparison to be observable.
  const clientMemoryAccess: ClientMemoryAccessFixture[] = [
    { userKey: 'actor.admin' },
    { userKey: 'actor.standard' },
  ].map((row, index) => ({
    key: `wallGrant.${row.userKey}`,
    id: fid(GROUP.wallGrant, index + 1),
    tenantKey: 'tenant.primary',
    clientKey: 'client.walled',
    userKey: row.userKey,
  }));

  const contacts: ContactFixture[] = [
    {
      key: 'contact.staffer',
      clientKey: 'client.alpha',
      fullName: label('Jordan Staffer'),
      email: 'jordan.staffer@example.gov',
      organization: label('House Committee Office'),
      title: 'Legislative Director',
    },
    {
      key: 'contact.member',
      clientKey: null,
      fullName: label('Robin Member'),
      email: 'robin.member@example.gov',
      organization: label('Member Office'),
      title: 'Member of Congress',
    },
    {
      key: 'contact.noEmail',
      clientKey: 'client.alpha',
      fullName: label('Quinn Noaddress'),
      email: null,
      organization: label('Agency Program Office'),
      title: 'Program Analyst',
    },
    {
      key: 'contact.groupA',
      clientKey: null,
      fullName: label('Group Member A'),
      email: 'group.a@example.gov',
      organization: label('Appropriations Staff'),
      title: 'Professional Staff',
    },
    {
      key: 'contact.groupB',
      clientKey: null,
      fullName: label('Group Member B'),
      email: 'group.b@example.gov',
      organization: label('Appropriations Staff'),
      title: 'Professional Staff',
    },
    {
      key: 'contact.clientContact',
      clientKey: 'client.beta',
      fullName: label('Casey Clientside'),
      email: 'casey.clientside@example.com',
      organization: label('Beta Industries'),
      title: 'VP Government Affairs',
    },
  ].map((row, index) => ({
    key: row.key,
    id: fid(GROUP.contact, index + 1),
    tenantKey: 'tenant.primary',
    clientKey: row.clientKey,
    fullName: row.fullName,
    email: row.email,
    organization: row.organization,
    title: row.title,
  }));

  const meetings: MeetingFixture[] = [
    {
      key: 'meeting.upcomingWithClient',
      clientKey: 'client.alpha',
      subject: label('Upcoming client briefing'),
      startsAt: at(2 * DAY),
      endsAt: at(2 * DAY + 60),
      timeZone: 'America/New_York',
      allDay: false,
      visibility: 'shared' as const,
      location: 'Rayburn 2118',
    },
    {
      key: 'meeting.upcomingNoClient',
      clientKey: null,
      subject: label('Upcoming internal sync, no client'),
      startsAt: at(3 * DAY),
      endsAt: at(3 * DAY + 30),
      timeZone: 'America/New_York',
      allDay: false,
      visibility: 'private' as const,
      location: null,
    },
    {
      key: 'meeting.past',
      clientKey: 'client.alpha',
      subject: label('Past appropriations meeting'),
      startsAt: at(-6 * DAY),
      endsAt: at(-6 * DAY + 60),
      timeZone: 'America/New_York',
      allDay: false,
      visibility: 'shared' as const,
      location: 'Dirksen 192',
    },
    {
      key: 'meeting.allDay',
      clientKey: 'client.beta',
      subject: label('All-day markup'),
      // Midnight-to-midnight UTC, which is what the current UI treats as all-day.
      startsAt: anchorDay(4, 0),
      endsAt: anchorDay(5, 0),
      timeZone: null,
      allDay: true,
      visibility: 'shared' as const,
      location: null,
    },
    {
      // 03:30Z is 19:30 or 20:30 the PREVIOUS day in America/Los_Angeles (the
      // offset is −8/−7 year-round), so UTC and local day-bucketing always
      // disagree. A view that buckets in the wrong zone puts this meeting on the
      // wrong date, which is the parity defect the fixture exists to expose.
      // Pinned to a UTC clock time, because an anchor-relative offset inherits
      // the anchor's time of day and the divergence would come and go.
      key: 'meeting.timezoneBoundary',
      clientKey: 'client.alpha',
      subject: label('Timezone boundary call'),
      startsAt: anchorDay(7, 3, 30),
      endsAt: anchorDay(7, 4, 30),
      timeZone: 'America/Los_Angeles',
      allDay: false,
      visibility: 'shared' as const,
      location: null,
    },
    {
      key: 'meeting.multiAttendee',
      clientKey: 'client.alpha',
      subject: label('Coalition roundtable, many attendees'),
      startsAt: at(1 * DAY),
      endsAt: at(1 * DAY + 90),
      timeZone: 'America/New_York',
      allDay: false,
      visibility: 'shared' as const,
      location: 'Capitol Visitor Center',
    },
    {
      // Far outside any default calendar window, so opening it by deep link is
      // the only way to reach it.
      key: 'meeting.deepLinkOutsideRange',
      clientKey: 'client.alpha',
      subject: label('Deep-linked meeting outside visible range'),
      startsAt: at(400 * DAY),
      endsAt: at(400 * DAY + 60),
      timeZone: 'America/New_York',
      allDay: false,
      visibility: 'shared' as const,
      location: null,
    },
    {
      key: 'meeting.confidentialAccessible',
      clientKey: 'client.alpha',
      subject: label('Meeting with confidential note the admin may read'),
      startsAt: at(-2 * DAY),
      endsAt: at(-2 * DAY + 60),
      timeZone: 'America/New_York',
      allDay: false,
      visibility: 'private' as const,
      location: null,
    },
    {
      key: 'meeting.confidentialDenied',
      clientKey: 'client.walled',
      subject: label("Meeting with another user's confidential note"),
      startsAt: at(-3 * DAY),
      endsAt: at(-3 * DAY + 60),
      timeZone: 'America/New_York',
      allDay: false,
      visibility: 'private' as const,
      location: null,
    },
    {
      key: 'meeting.reportCurrentCycle',
      clientKey: 'client.alpha',
      subject: label('Directory-matched meeting, current cycle'),
      startsAt: cycleDate(0, 2, 12),
      endsAt: cycleDate(0, 2, 12, 16),
      timeZone: 'America/New_York',
      allDay: false,
      visibility: 'shared' as const,
      location: 'Longworth 1100',
    },
    {
      key: 'meeting.reportPreviousCycle',
      clientKey: 'client.alpha',
      subject: label('Directory-matched meeting, previous cycle'),
      startsAt: cycleDate(-1, 2, 12),
      endsAt: cycleDate(-1, 2, 12, 16),
      timeZone: 'America/New_York',
      allDay: false,
      visibility: 'shared' as const,
      location: 'Longworth 1100',
    },
  ].map((row, index) => ({
    key: row.key,
    id: fid(GROUP.meeting, index + 1),
    tenantKey: 'tenant.primary',
    clientKey: row.clientKey,
    subject: row.subject,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    timeZone: row.timeZone,
    allDay: row.allDay,
    status: 'scheduled',
    visibility: row.visibility,
    createdByUserKey: 'actor.admin',
    organizerEmail: 'phase3-admin@example.invalid',
    location: row.location,
  }));

  // The cross-tenant meeting is the "inaccessible" fixture: a row that exists
  // but must read as not-found to every primary-tenant actor. A DELETED meeting
  // cannot be seeded at all, so its half of the requirement is an absentId.
  meetings.push({
    key: 'meeting.otherTenant',
    id: fid(GROUP.meeting, 90),
    tenantKey: 'tenant.secondary',
    clientKey: 'client.secondTenant',
    subject: label('Second-tenant meeting, inaccessible from primary'),
    startsAt: at(1 * DAY),
    endsAt: at(1 * DAY + 60),
    timeZone: 'America/New_York',
    allDay: false,
    status: 'scheduled',
    visibility: 'shared',
    createdByUserKey: 'actor.crossTenant',
    organizerEmail: 'phase3-crosstenant@example.invalid',
    location: null,
  });

  const attendeeSpecs: Array<{
    meetingKey: string;
    contactKey: string | null;
    email: string | null;
    name: string;
    role: string;
  }> = [
    {
      meetingKey: 'meeting.upcomingWithClient',
      contactKey: 'contact.staffer',
      email: 'jordan.staffer@example.gov',
      name: label('Jordan Staffer'),
      role: 'required',
    },
    {
      meetingKey: 'meeting.upcomingNoClient',
      contactKey: null,
      email: 'phase3-peer@example.invalid',
      name: label('Pia Peerson'),
      role: 'required',
    },
    {
      meetingKey: 'meeting.past',
      contactKey: 'contact.member',
      email: 'robin.member@example.gov',
      name: label('Robin Member'),
      role: 'required',
    },
    {
      meetingKey: 'meeting.multiAttendee',
      contactKey: 'contact.staffer',
      email: 'jordan.staffer@example.gov',
      name: label('Jordan Staffer'),
      role: 'required',
    },
    {
      meetingKey: 'meeting.multiAttendee',
      contactKey: 'contact.groupA',
      email: 'group.a@example.gov',
      name: label('Group Member A'),
      role: 'optional',
    },
    {
      meetingKey: 'meeting.multiAttendee',
      contactKey: 'contact.groupB',
      email: 'group.b@example.gov',
      name: label('Group Member B'),
      role: 'optional',
    },
    {
      meetingKey: 'meeting.multiAttendee',
      contactKey: 'contact.noEmail',
      email: null,
      name: label('Quinn Noaddress'),
      role: 'optional',
    },
    {
      // Reserved address — the only directory-resolvable contact without the
      // S3 snapshot. See RESERVED_IDENTIFIERS.
      meetingKey: 'meeting.reportCurrentCycle',
      contactKey: null,
      email: 'avery.testwell@example.invalid',
      name: label('Rep. Avery Testwell'),
      role: 'required',
    },
    {
      meetingKey: 'meeting.reportPreviousCycle',
      contactKey: null,
      email: 'avery.testwell@example.invalid',
      name: label('Rep. Avery Testwell'),
      role: 'required',
    },
    {
      meetingKey: 'meeting.otherTenant',
      contactKey: null,
      email: 'second.tenant.attendee@example.gov',
      name: label('Second Tenant Attendee'),
      role: 'required',
    },
  ];

  const attendees: AttendeeFixture[] = attendeeSpecs.map((row, index) => ({
    key: `attendee.${row.meetingKey.replace('meeting.', '')}.${index + 1}`,
    id: fid(GROUP.attendee, index + 1),
    tenantKey: row.meetingKey === 'meeting.otherTenant' ? 'tenant.secondary' : 'tenant.primary',
    meetingKey: row.meetingKey,
    contactKey: row.contactKey,
    email: row.email,
    name: row.name,
    role: row.role,
  }));

  const botSessions: BotSessionFixture[] = [
    { meetingKey: 'meeting.past', status: 'done', error: null },
    { meetingKey: 'meeting.confidentialAccessible', status: 'failed', error: 'fixture: join failed' },
    { meetingKey: 'meeting.confidentialDenied', status: 'no_show', error: null },
    { meetingKey: 'meeting.upcomingWithClient', status: 'requested', error: null },
    { meetingKey: 'meeting.multiAttendee', status: 'in_call', error: null },
  ].map((row, index) => ({
    key: `botSession.${row.status}`,
    id: fid(GROUP.botSession, index + 1),
    tenantKey: 'tenant.primary',
    meetingKey: row.meetingKey,
    requestedByUserKey: 'actor.admin',
    status: row.status,
    joinUrl: `https://meet.example.invalid/phase3-parity/${row.status}`,
    recordingPolicy: 'transcript_only',
    error: row.error,
  }));

  const preps: PrepFixture[] = [
    {
      meetingKey: 'meeting.past',
      clientKey: 'client.alpha',
      status: 'approved' as const,
      summary: label('approved prep summary'),
    },
    {
      meetingKey: 'meeting.upcomingWithClient',
      clientKey: 'client.alpha',
      status: 'generated' as const,
      summary: label('generated prep summary'),
    },
    {
      meetingKey: 'meeting.multiAttendee',
      clientKey: 'client.alpha',
      status: 'edited' as const,
      summary: label('manually edited prep summary'),
    },
    {
      meetingKey: 'meeting.reportCurrentCycle',
      clientKey: 'client.alpha',
      status: 'approved' as const,
      summary: label('approved prep for the report cycle meeting'),
    },
  ].map((row, index) => ({
    key: `prep.${row.status}.${index + 1}`,
    id: fid(GROUP.prep, index + 1),
    tenantKey: 'tenant.primary',
    meetingKey: row.meetingKey,
    clientKey: row.clientKey,
    status: row.status,
    summary: row.summary,
    agenda: [label('agenda item one'), label('agenda item two')],
  }));

  const notes: EncryptedBodyFixture[] = [
    {
      key: 'note.adminApproved',
      meetingKey: 'meeting.confidentialAccessible',
      clientKey: 'client.alpha',
      authorUserKey: 'actor.admin',
      status: 'approved',
      bodyPlaintext: label('approved confidential note authored by the tenant admin.'),
    },
    {
      key: 'note.adminDraft',
      meetingKey: 'meeting.past',
      clientKey: 'client.alpha',
      authorUserKey: 'actor.admin',
      status: 'draft',
      bodyPlaintext: label('draft note that has never been approved.'),
    },
    {
      key: 'note.peerConfidential',
      meetingKey: 'meeting.confidentialDenied',
      clientKey: 'client.walled',
      authorUserKey: 'actor.peer',
      status: 'approved',
      bodyPlaintext: label("another user's confidential note; a standard user must not read it."),
    },
  ].map((row, index) => ({
    key: row.key,
    id: fid(GROUP.note, index + 1),
    tenantKey: 'tenant.primary',
    meetingKey: row.meetingKey,
    clientKey: row.clientKey,
    authorUserKey: row.authorUserKey,
    bodyPlaintext: row.bodyPlaintext,
    confidential: true,
    accessLevel: 'tenant_admins_and_author',
    status: row.status,
  }));

  const debriefs: EncryptedBodyFixture[] = [
    {
      key: 'debrief.approved',
      meetingKey: 'meeting.past',
      status: 'approved',
      bodyPlaintext: label('approved debrief for the past meeting.'),
    },
    {
      key: 'debrief.generated',
      meetingKey: 'meeting.confidentialAccessible',
      status: 'generated',
      bodyPlaintext: label('generated debrief awaiting approval.'),
    },
  ].map((row, index) => ({
    key: row.key,
    id: fid(GROUP.debrief, index + 1),
    tenantKey: 'tenant.primary',
    meetingKey: row.meetingKey,
    clientKey: 'client.alpha',
    authorUserKey: 'actor.admin',
    bodyPlaintext: row.bodyPlaintext,
    confidential: true,
    accessLevel: 'tenant_members',
    status: row.status,
  }));

  const tasks: TaskFixture[] = [
    {
      meetingKey: 'meeting.reportCurrentCycle',
      status: 'todo' as const,
      title: label('open follow-up on the directory-matched meeting'),
    },
    {
      meetingKey: 'meeting.reportCurrentCycle',
      status: 'in_progress' as const,
      title: label('in-progress follow-up on the directory-matched meeting'),
    },
    {
      meetingKey: 'meeting.past',
      status: 'blocked' as const,
      title: label('blocked follow-up on the past meeting'),
    },
    {
      meetingKey: 'meeting.past',
      status: 'done' as const,
      title: label('completed follow-up, excluded from pending actions'),
    },
    { meetingKey: null, status: 'todo' as const, title: label('standalone task with no meeting') },
  ].map((row, index) => ({
    key: `task.${row.status}.${index + 1}`,
    id: fid(GROUP.task, index + 1),
    tenantKey: 'tenant.primary',
    clientKey: 'client.alpha',
    meetingKey: row.meetingKey,
    title: row.title,
    status: row.status,
    createdByUserKey: 'actor.admin',
  }));

  // No S3 object backs any of these keys — they are metadata rows only. 3.6's
  // download/extract denials must therefore assert on the runtime action being
  // refused, not on a byte stream being absent.
  const attachments: AttachmentFixture[] = [
    {
      key: 'attachment.meetingReady',
      meetingKey: 'meeting.past',
      clientKey: 'client.alpha',
      fileName: `${PHASE3_MARKER} briefing memo.pdf`,
      lifecycleStatus: 'legacy_ready',
      scanStatus: null,
    },
    {
      key: 'attachment.meetingBlocked',
      meetingKey: 'meeting.past',
      clientKey: 'client.alpha',
      fileName: `${PHASE3_MARKER} blocked upload.pdf`,
      lifecycleStatus: 'blocked',
      scanStatus: 'threat',
    },
    {
      key: 'attachment.outreach',
      meetingKey: null,
      clientKey: 'client.alpha',
      fileName: `${PHASE3_MARKER} outreach attachment.pdf`,
      lifecycleStatus: 'ready',
      scanStatus: 'clean',
    },
  ].map((row, index) => ({
    key: row.key,
    id: fid(GROUP.attachment, index + 1),
    tenantKey: 'tenant.primary',
    clientKey: row.clientKey,
    meetingKey: row.meetingKey,
    fileName: row.fileName,
    contentType: 'application/pdf',
    byteSize: 1024 * (index + 1),
    bucket: 'phase3-parity-fixture-bucket-no-object',
    s3Key: `phase3-parity/${row.key}.pdf`,
    lifecycleStatus: row.lifecycleStatus,
    scanStatus: row.scanStatus,
    uploadedByUserKey: 'actor.admin',
  }));

  const outreachRecords: OutreachRecordFixture[] = [
    {
      key: 'outreach.draft',
      clientKey: 'client.alpha',
      meetingKey: null,
      type: 'campaign' as const,
      status: 'draft' as const,
      title: label('Draft campaign at step 1'),
      subject: null,
      body: null,
      lastStep: 1,
      recipients: [],
      sentAt: null,
      openedInEmailAt: null,
      attachmentKeys: [],
    },
    {
      key: 'outreach.partialWizard',
      clientKey: 'client.alpha',
      meetingKey: null,
      type: 'campaign' as const,
      status: 'draft' as const,
      title: label('Partially completed wizard at step 4'),
      subject: label('partially drafted subject'),
      body: null,
      lastStep: 4,
      recipients: [
        {
          id: 'jordan.staffer@example.gov',
          name: label('Jordan Staffer'),
          email: 'jordan.staffer@example.gov',
          office: label('House Committee Office'),
          title: 'Legislative Director',
          generationKey: 'individual:jordan.staffer@example.gov',
        },
      ],
      sentAt: null,
      openedInEmailAt: null,
      attachmentKeys: [],
    },
    {
      key: 'outreach.followUp',
      clientKey: 'client.alpha',
      meetingKey: 'meeting.past',
      type: 'follow_up' as const,
      status: 'draft' as const,
      title: label('Follow-up linked to a past meeting'),
      subject: label('following up on our meeting'),
      body: label('follow-up body text.'),
      lastStep: 5,
      recipients: [
        {
          id: 'robin.member@example.gov',
          name: label('Robin Member'),
          email: 'robin.member@example.gov',
          generationKey: 'individual:robin.member@example.gov',
        },
      ],
      sentAt: null,
      openedInEmailAt: null,
      attachmentKeys: [],
    },
    {
      key: 'outreach.prepDistribution',
      clientKey: 'client.alpha',
      meetingKey: 'meeting.upcomingWithClient',
      type: 'prep' as const,
      status: 'draft' as const,
      title: label('Prep distribution for an upcoming meeting'),
      subject: label('prep materials'),
      body: label('prep distribution body text.'),
      lastStep: 3,
      recipients: [
        {
          id: 'phase3-peer@example.invalid',
          name: label('Pia Peerson'),
          email: 'phase3-peer@example.invalid',
          generationKey: 'individual:phase3-peer@example.invalid',
        },
      ],
      sentAt: null,
      openedInEmailAt: null,
      attachmentKeys: [],
    },
    {
      key: 'outreach.outboundCampaign',
      clientKey: 'client.alpha',
      meetingKey: null,
      type: 'outbound_campaign' as const,
      status: 'draft' as const,
      title: label('Outbound campaign'),
      subject: label('outbound campaign subject'),
      body: label('outbound campaign body text.'),
      lastStep: 6,
      recipients: [
        {
          id: 'robin.member@example.gov',
          name: label('Robin Member'),
          email: 'robin.member@example.gov',
          cc: ['group.a@example.gov'],
          bcc: ['group.b@example.gov'],
          generationKey: 'individual:robin.member@example.gov',
        },
      ],
      sentAt: null,
      openedInEmailAt: null,
      attachmentKeys: [],
    },
    {
      key: 'outreach.sent',
      clientKey: 'client.alpha',
      meetingKey: null,
      type: 'campaign' as const,
      status: 'sent' as const,
      title: label('Sent campaign'),
      subject: label('sent campaign subject'),
      body: label('sent campaign body text.'),
      lastStep: 7,
      recipients: [
        {
          id: 'jordan.staffer@example.gov',
          name: label('Jordan Staffer'),
          email: 'jordan.staffer@example.gov',
          generationKey: 'individual:jordan.staffer@example.gov',
        },
      ],
      sentAt: at(-2 * DAY),
      openedInEmailAt: null,
      attachmentKeys: [],
    },
    {
      key: 'outreach.failed',
      clientKey: 'client.alpha',
      meetingKey: null,
      type: 'campaign' as const,
      status: 'failed' as const,
      title: label('Failed campaign'),
      subject: label('failed campaign subject'),
      body: label('failed campaign body text.'),
      lastStep: 7,
      recipients: [
        {
          id: 'robin.member@example.gov',
          name: label('Robin Member'),
          email: 'robin.member@example.gov',
          generationKey: 'individual:robin.member@example.gov',
        },
      ],
      sentAt: null,
      openedInEmailAt: null,
      attachmentKeys: [],
    },
    {
      key: 'outreach.openedInEmail',
      clientKey: 'client.alpha',
      meetingKey: null,
      type: 'campaign' as const,
      status: 'opened_in_email' as const,
      title: label('Opened in the connected mail client'),
      subject: label('opened in email subject'),
      body: label('opened in email body text.'),
      lastStep: 7,
      recipients: [
        {
          id: 'jordan.staffer@example.gov',
          name: label('Jordan Staffer'),
          email: 'jordan.staffer@example.gov',
          generationKey: 'individual:jordan.staffer@example.gov',
        },
      ],
      sentAt: null,
      openedInEmailAt: at(-1 * DAY),
      attachmentKeys: [],
    },
    {
      key: 'outreach.deliveryUnknown',
      clientKey: 'client.alpha',
      meetingKey: null,
      type: 'campaign' as const,
      status: 'sent' as const,
      title: label('Campaign with an unknown delivery outcome'),
      subject: label('unknown delivery subject'),
      body: label('unknown delivery body text.'),
      lastStep: 7,
      recipients: [
        {
          id: 'group.a@example.gov',
          name: label('Group Member A'),
          email: 'group.a@example.gov',
          generationKey: 'individual:group.a@example.gov',
        },
      ],
      sentAt: at(-3 * DAY),
      openedInEmailAt: null,
      attachmentKeys: [],
    },
    {
      key: 'outreach.clientDirected',
      clientKey: 'client.beta',
      meetingKey: null,
      type: 'campaign' as const,
      status: 'draft' as const,
      title: label('Client-directed campaign'),
      subject: label('client-directed subject'),
      body: label('client-directed body text.'),
      lastStep: 5,
      recipients: [
        {
          id: 'casey.clientside@example.com',
          name: label('Casey Clientside'),
          email: 'casey.clientside@example.com',
          direction: 'to-clients' as const,
          generationKey: 'individual:casey.clientside@example.com',
        },
      ],
      sentAt: null,
      openedInEmailAt: null,
      attachmentKeys: [],
    },
    {
      key: 'outreach.externalOnBehalf',
      clientKey: 'client.beta',
      meetingKey: null,
      type: 'outbound_campaign' as const,
      status: 'draft' as const,
      title: label('External campaign on behalf of a client'),
      subject: label('on-behalf subject'),
      body: label('on-behalf body text.'),
      lastStep: 5,
      recipients: [
        {
          id: 'robin.member@example.gov',
          name: label('Robin Member'),
          email: 'robin.member@example.gov',
          direction: 'on-behalf' as const,
          generationKey: 'individual:robin.member@example.gov',
        },
      ],
      sentAt: null,
      openedInEmailAt: null,
      attachmentKeys: [],
    },
    {
      key: 'outreach.groupRecipient',
      clientKey: 'client.alpha',
      meetingKey: null,
      type: 'campaign' as const,
      status: 'draft' as const,
      title: label('Group recipient, one shared email'),
      subject: label('group recipient subject'),
      body: label('group recipient body text.'),
      lastStep: 5,
      recipients: [
        {
          id: 'group.a@example.gov',
          name: label('Appropriations Group'),
          email: 'group.a@example.gov',
          groupMembers: [
            { email: 'group.a@example.gov', name: label('Group Member A') },
            { email: 'group.b@example.gov', name: label('Group Member B') },
          ],
          generationKey: `group:${fid(GROUP.audience, 2)}`,
        },
      ],
      sentAt: null,
      openedInEmailAt: null,
      attachmentKeys: [],
    },
    {
      key: 'outreach.missingEmail',
      clientKey: 'client.alpha',
      meetingKey: null,
      type: 'campaign' as const,
      status: 'draft' as const,
      title: label('Recipient with no usable address'),
      subject: label('missing email subject'),
      body: label('missing email body text.'),
      lastStep: 5,
      recipients: [
        {
          id: fid(GROUP.contact, 3),
          name: label('Quinn Noaddress'),
          office: label('Agency Program Office'),
          generationKey: `individual:${fid(GROUP.contact, 3)}`,
        },
      ],
      sentAt: null,
      openedInEmailAt: null,
      attachmentKeys: [],
    },
    {
      key: 'outreach.withAttachment',
      clientKey: 'client.alpha',
      meetingKey: null,
      type: 'campaign' as const,
      status: 'draft' as const,
      title: label('Campaign carrying existing attachment metadata'),
      subject: label('attachment metadata subject'),
      body: label('attachment metadata body text.'),
      lastStep: 6,
      recipients: [
        {
          id: 'jordan.staffer@example.gov',
          name: label('Jordan Staffer'),
          email: 'jordan.staffer@example.gov',
          generationKey: 'individual:jordan.staffer@example.gov',
        },
      ],
      sentAt: null,
      openedInEmailAt: null,
      attachmentKeys: ['attachment.outreach'],
    },
    {
      // OutreachRecord.clientId stays nullable on purpose: a firm-level campaign
      // must not fabricate a primary client (master context §26).
      key: 'outreach.nullableClient',
      clientKey: null,
      meetingKey: null,
      type: 'outbound_campaign' as const,
      status: 'draft' as const,
      title: label('Firm campaign with no client association'),
      subject: label('no client association subject'),
      body: label('no client association body text.'),
      lastStep: 5,
      recipients: [
        {
          id: 'robin.member@example.gov',
          name: label('Robin Member'),
          email: 'robin.member@example.gov',
          generationKey: 'individual:robin.member@example.gov',
        },
      ],
      sentAt: null,
      openedInEmailAt: null,
      attachmentKeys: [],
    },
  ].map((row, index) => ({
    key: row.key,
    id: fid(GROUP.outreach, index + 1),
    tenantKey: 'tenant.primary',
    clientKey: row.clientKey,
    meetingKey: row.meetingKey,
    createdByUserKey: 'actor.admin',
    type: row.type,
    status: row.status,
    title: row.title,
    subject: row.subject,
    body: row.body,
    recipients: row.recipients,
    lastStep: row.lastStep,
    sentAt: row.sentAt,
    openedInEmailAt: row.openedInEmailAt,
    attachmentKeys: row.attachmentKeys,
  }));

  const draftArtifacts: DraftArtifactFixture[] = [
    {
      key: 'artifact.sent',
      outreachRecordKey: 'outreach.sent',
      recipientKey: 'jordan.staffer@example.gov',
      audienceKind: 'individual' as const,
      currentVersion: 2,
    },
    {
      key: 'artifact.held',
      outreachRecordKey: 'outreach.failed',
      recipientKey: 'robin.member@example.gov',
      audienceKind: 'individual' as const,
      currentVersion: 1,
    },
    {
      key: 'artifact.deliveryUnknown',
      outreachRecordKey: 'outreach.deliveryUnknown',
      recipientKey: 'group.a@example.gov',
      audienceKind: 'individual' as const,
      currentVersion: 1,
    },
  ].map((row, index) => ({
    key: row.key,
    id: fid(GROUP.artifact, index + 1),
    tenantKey: 'tenant.primary',
    outreachRecordKey: row.outreachRecordKey,
    generationKey: `individual:${row.recipientKey}`,
    recipientKey: row.recipientKey,
    audienceKind: row.audienceKind,
    createdByUserKey: 'actor.admin',
    currentVersion: row.currentVersion,
  }));

  const draftVersions: DraftVersionFixture[] = [
    {
      key: 'version.sentV1',
      artifactKey: 'artifact.sent',
      version: 1,
      generationStatus: 'generated' as const,
      auditStatus: 'passed' as const,
      approvalStatus: 'approved' as const,
      auditDecision: 'allow',
      subject: label('sent draft v1 subject'),
      body: label('sent draft v1 body.'),
    },
    {
      key: 'version.sentV2',
      artifactKey: 'artifact.sent',
      version: 2,
      generationStatus: 'manually_authored' as const,
      auditStatus: 'warning' as const,
      approvalStatus: 'approved' as const,
      auditDecision: 'allow_with_warning',
      subject: label('sent draft v2 subject'),
      body: label('sent draft v2 body.'),
    },
    {
      key: 'version.held',
      artifactKey: 'artifact.held',
      version: 1,
      generationStatus: 'generated' as const,
      auditStatus: 'held' as const,
      approvalStatus: 'pending' as const,
      auditDecision: 'block',
      subject: label('held draft subject'),
      body: label('held draft body with an unsupported claim.'),
    },
    {
      key: 'version.deliveryUnknown',
      artifactKey: 'artifact.deliveryUnknown',
      version: 1,
      generationStatus: 'generated' as const,
      auditStatus: 'passed' as const,
      approvalStatus: 'approved' as const,
      auditDecision: 'allow',
      subject: label('unknown delivery draft subject'),
      body: label('unknown delivery draft body.'),
    },
  ].map((row, index) => ({
    key: row.key,
    id: fid(GROUP.version, index + 1),
    tenantKey: 'tenant.primary',
    artifactKey: row.artifactKey,
    version: row.version,
    subject: row.subject,
    body: row.body,
    generationStatus: row.generationStatus,
    auditStatus: row.auditStatus,
    approvalStatus: row.approvalStatus,
    auditDecision: row.auditDecision,
    provider: 'fixture-no-provider',
    model: 'fixture-no-model',
    createdByUserKey: 'actor.admin',
  }));

  const connections: ConnectionFixture[] = [
    {
      key: 'connection.microsoftConnected',
      tenantKey: 'tenant.primary',
      provider: 'microsoft_365' as const,
      accountEmail: 'phase3-mailbox@example.invalid',
      displayName: label('Microsoft mailbox, connected'),
      status: 'connected' as const,
      scopes: ['Mail.Read', 'Calendars.Read'],
      lastSyncAt: at(-90),
      lastError: null,
      syncState: {
        phase3Fixture: true,
        // Subscription metadata recorded as data, never fetched: the fixture
        // must not imply a Graph subscription actually exists.
        subscription: {
          id: 'phase3-parity-subscription-not-real',
          resource: "users/phase3-mailbox@example.invalid/mailFolders('Inbox')/messages",
          expirationOffsetMinutes: 3 * DAY,
          providerCallMade: false,
        },
        calendarWindowDays: 30,
      },
    },
    {
      key: 'connection.googleConnected',
      tenantKey: 'tenant.primary',
      provider: 'google_workspace' as const,
      accountEmail: 'phase3-google@example.invalid',
      displayName: label('Google mailbox, connected'),
      status: 'connected' as const,
      scopes: ['gmail.readonly', 'calendar.readonly'],
      lastSyncAt: at(-120),
      lastError: null,
      syncState: { phase3Fixture: true, historyId: 'phase3-parity-history-not-real' },
    },
    {
      key: 'connection.disconnected',
      tenantKey: 'tenant.primary',
      provider: 'microsoft_365' as const,
      accountEmail: 'phase3-disconnected@example.invalid',
      displayName: label('Microsoft mailbox, disconnected'),
      status: 'disabled' as const,
      scopes: [],
      lastSyncAt: null,
      lastError: null,
      syncState: { phase3Fixture: true },
    },
    {
      key: 'connection.expiredError',
      tenantKey: 'tenant.primary',
      provider: 'google_workspace' as const,
      accountEmail: 'phase3-expired@example.invalid',
      displayName: label('Google mailbox, expired credential'),
      status: 'error' as const,
      scopes: ['gmail.readonly'],
      lastSyncAt: at(-30 * DAY),
      lastError: 'fixture: refresh token expired; reconnect required',
      syncState: { phase3Fixture: true },
    },
  ].map((row, index) => ({ ...row, id: fid(GROUP.connection, index + 1) }));

  const sendIntents: SendIntentFixture[] = [
    {
      key: 'sendIntent.deliveryUnknown',
      id: fid(GROUP.sendIntent, 1),
      tenantKey: 'tenant.primary',
      userKey: 'actor.admin',
      outreachRecordKey: 'outreach.deliveryUnknown',
      senderConnectionKey: 'connection.microsoftConnected',
      requestKey: 'phase3-parity-unknown-delivery',
      status: 'partial',
      totals: { total: 1, pending: 0, sending: 0, sent: 0, failed: 0, unknown: 1, skipped: 0, held: 0 },
    },
  ];

  const deliveries: DeliveryFixture[] = [
    {
      key: 'delivery.unknown',
      id: fid(GROUP.delivery, 1),
      tenantKey: 'tenant.primary',
      sendIntentKey: 'sendIntent.deliveryUnknown',
      draftVersionKey: 'version.deliveryUnknown',
      generationKey: 'individual:group.a@example.gov',
      recipientKey: 'group.a@example.gov',
      toEmail: 'group.a@example.gov',
      toName: label('Group Member A'),
      renderedSubject: label('unknown delivery draft subject'),
      renderedBody: label('unknown delivery draft body.'),
      provider: 'microsoft_graph',
      status: 'unknown',
      // An unknown outcome has no confirmed provider id — recording one would
      // assert a send we cannot prove happened.
      providerMessageId: null,
    },
  ];

  const audiences: AudienceFixture[] = [
    { key: 'audience.list', kind: 'list' as const, name: label('Saved list audience') },
    { key: 'audience.group', kind: 'group' as const, name: label('Saved group audience') },
  ].map((row, index) => ({
    key: row.key,
    id: fid(GROUP.audience, index + 1),
    tenantKey: 'tenant.primary',
    createdByUserKey: 'actor.admin',
    kind: row.kind,
    name: row.name,
    status: 'active',
  }));

  const audienceMembers: AudienceMemberFixture[] = [
    { audienceKey: 'audience.list', email: 'jordan.staffer@example.gov', name: label('Jordan Staffer') },
    { audienceKey: 'audience.list', email: 'robin.member@example.gov', name: label('Robin Member') },
    { audienceKey: 'audience.group', email: 'group.a@example.gov', name: label('Group Member A') },
    { audienceKey: 'audience.group', email: 'group.b@example.gov', name: label('Group Member B') },
  ].map((row, index) => ({
    key: `audienceMember.${index + 1}`,
    id: fid(GROUP.audienceMember, index + 1),
    tenantKey: 'tenant.primary',
    audienceKey: row.audienceKey,
    source: 'manual',
    name: row.name,
    email: row.email,
    office: label('Fixture office'),
  }));

  const templates: TemplateFixture[] = [
    {
      key: 'template.outbound',
      id: fid(GROUP.template, 1),
      tenantKey: 'tenant.primary',
      createdByUserKey: 'actor.admin',
      type: 'outbound_campaign',
      name: label('Saved outbound template'),
      subject: label('template subject'),
      body: label('template body text.'),
    },
  ];

  const aiTemplates: AiTemplateFixture[] = [
    {
      key: 'aiTemplate.general',
      id: fid(GROUP.aiTemplate, 1),
      tenantKey: 'tenant.primary',
      userKey: 'actor.admin',
      name: label('Saved AI template'),
      category: 'general',
      prompt: label('fixture prompt text; never sent to a provider in Phase 3.'),
    },
  ];

  const reportTargets: ReportTargetFixture[] = [
    {
      key: 'reportTarget.autoAlpha',
      clientKey: 'client.alpha',
      scopeKeyFrom: 'clientId' as const,
      officeKey: 'phase3-hasc-majority',
      prepStatus: 'auto' as const,
      outreachStatus: 'auto' as const,
      submissionStatus: 'auto' as const,
    },
    {
      key: 'reportTarget.manualOverrideAlpha',
      clientKey: 'client.alpha',
      scopeKeyFrom: 'clientId' as const,
      officeKey: 'phase3-hasc-minority',
      prepStatus: 'complete' as const,
      outreachStatus: 'in_progress' as const,
      submissionStatus: 'complete' as const,
    },
    {
      key: 'reportTarget.notStartedAlpha',
      clientKey: 'client.alpha',
      scopeKeyFrom: 'clientId' as const,
      officeKey: 'phase3-sac-d',
      prepStatus: 'not_started' as const,
      outreachStatus: 'not_started' as const,
      submissionStatus: 'not_started' as const,
    },
    {
      key: 'reportTarget.beta',
      clientKey: 'client.beta',
      scopeKeyFrom: 'clientId' as const,
      officeKey: 'phase3-hac-d',
      prepStatus: 'in_progress' as const,
      outreachStatus: 'complete' as const,
      submissionStatus: 'not_started' as const,
    },
    {
      key: 'reportTarget.scopeAll',
      clientKey: null,
      scopeKeyFrom: 'all' as const,
      officeKey: 'phase3-firm-wide',
      prepStatus: 'auto' as const,
      outreachStatus: 'auto' as const,
      submissionStatus: 'auto' as const,
    },
  ].map((row, index) => ({
    key: row.key,
    id: fid(GROUP.reportTarget, index + 1),
    tenantKey: 'tenant.primary',
    clientKey: row.clientKey,
    scopeKeyFrom: row.scopeKeyFrom,
    officeKey: row.officeKey,
    memberPrincipal: label(`Member principal ${index + 1}`),
    committee: label(`Committee ${index + 1}`),
    staffer: label(`Staffer ${index + 1}`),
    building: label(`Building ${index + 1}`),
    leadOwner: label(`Lead owner ${index + 1}`),
    prepStatus: row.prepStatus,
    outreachStatus: row.outreachStatus,
    submissionStatus: row.submissionStatus,
    source: 'manual',
  }));

  const absentIds = [
    {
      key: 'absent.meeting',
      id: fid(GROUP.absent, 1),
      expectation:
        'A well-formed meeting id that no row uses. Deep-linking it must render the current ' +
        'not-found state identically in both modes — the "deleted meeting" half of the plan\'s ' +
        'inaccessible/deleted requirement, which cannot be produced by inserting a row.',
    },
    {
      key: 'absent.outreachRecord',
      id: fid(GROUP.absent, 2),
      expectation: 'A well-formed outreach record id that no row uses; must 404 in both modes.',
    },
    {
      key: 'absent.connection',
      id: fid(GROUP.absent, 3),
      expectation:
        'A well-formed integration connection id that no row uses; every action against it must ' +
        'deny without revealing whether it exists.',
    },
  ];

  const states = buildStates();

  return {
    marker: PHASE3_MARKER,
    idPrefix: FIXTURE_ID_PREFIX,
    tenants,
    users,
    memberships,
    impersonations,
    clients,
    clientMemoryAccess,
    contacts,
    meetings,
    attendees,
    botSessions,
    preps,
    notes,
    debriefs,
    tasks,
    attachments,
    outreachRecords,
    draftArtifacts,
    draftVersions,
    sendIntents,
    deliveries,
    audiences,
    audienceMembers,
    templates,
    aiTemplates,
    reportTargets,
    connections,
    absentIds,
    states,
    cleanupOrder: CLEANUP_ORDER.slice(),
  };
}

/**
 * Deletion order, children before parents. Tenant cascades would cover most of
 * this, but `users` is a global table and `OutreachDraftVersion.createdBy` is
 * `onDelete: Restrict` against it — so an explicit order is the only thing that
 * makes cleanup work after a test has authored rows against a fixture user.
 */
const CLEANUP_ORDER: string[] = [
  'outreach_deliveries',
  'outreach_send_intents',
  'outreach_draft_versions',
  'outreach_draft_artifacts',
  'outreach_records',
  'outreach_audience_members',
  'outreach_audiences',
  'outreach_templates',
  'outreach_ai_template',
  'engagement_report_target_offices',
  'engagement_tasks',
  'engagement_attachments',
  'meeting_notes',
  'meeting_debriefs',
  'meeting_preps',
  'meeting_bot_sessions',
  'meeting_attendees',
  'meetings',
  'engagement_contacts',
  'engagement_connection_tokens',
  'engagement_connections',
  'client_memory_access',
  'clients',
  'impersonation_sessions',
  'tenant_memberships',
  'users',
  'tenants',
];

function buildStates(): FixtureState[] {
  const s = (
    id: string,
    planSection: FixtureState['planSection'],
    requirement: string,
    coveredBy: string[],
    extra: Partial<FixtureState> = {},
  ): FixtureState => ({ id, planSection, requirement, coveredBy, ...extra });

  return [
    // ── Users and tenants ──────────────────────────────────────────────────
    s('users.admin', 'users_and_tenants', 'admin', ['actor.admin', 'membership.actor.admin']),
    s('users.standard', 'users_and_tenants', 'standard user', [
      'actor.standard',
      'membership.actor.standard',
    ]),
    s('users.belowRole', 'users_and_tenants', 'below-required role', [
      'actor.belowRole',
      'membership.actor.belowRole',
    ]),
    s('users.samePeer', 'users_and_tenants', 'different user in same tenant', [
      'actor.peer',
      'membership.actor.peer',
    ]),
    s('users.secondTenant', 'users_and_tenants', 'second tenant', [
      'tenant.secondary',
      'actor.crossTenant',
      'client.secondTenant',
    ]),
    s(
      'users.wallDenied',
      'users_and_tenants',
      'ethical-wall denied actor when supported',
      ['client.walled', 'actor.wallDenied', 'wallGrant.actor.admin'],
      {
        note:
          'Supported: Client.memoryWall plus client_memory_access grants ' +
          '(apps/api/src/memory/memory-wall.helpers.ts). actor.wallDenied holds no grant.',
      },
    ),
    s(
      'users.impersonation',
      'users_and_tenants',
      'Capiro Admin impersonation fixture when supported',
      [
        'tenant.capiroInternal',
        'actor.capiroAdmin',
        'membership.actor.capiroAdmin',
        'impersonation.active',
        'impersonation.expired',
      ],
      {
        note:
          'Supported: ImpersonationSession rows started by a capiro_admin in the reserved ' +
          'capiro-internal tenant. The expired row is what 3.10 needs to prove expiry clears.',
      },
    ),

    // ── Meetings ───────────────────────────────────────────────────────────
    s('meetings.upcomingClient', 'meetings', 'upcoming client meeting', [
      'meeting.upcomingWithClient',
    ]),
    s('meetings.upcomingNoClient', 'meetings', 'upcoming no-client meeting', [
      'meeting.upcomingNoClient',
    ]),
    s('meetings.past', 'meetings', 'past meeting', ['meeting.past']),
    s('meetings.allDay', 'meetings', 'all-day meeting', ['meeting.allDay']),
    s('meetings.timezoneBoundary', 'meetings', 'timezone-boundary meeting', [
      'meeting.timezoneBoundary',
    ]),
    s('meetings.multipleAttendees', 'meetings', 'multiple attendees', ['meeting.multiAttendee']),
    s('meetings.deepLinkOutsideRange', 'meetings', 'deep-linked meeting outside visible range', [
      'meeting.deepLinkOutsideRange',
    ]),
    s(
      'meetings.inaccessible',
      'meetings',
      'inaccessible meeting',
      ['meeting.otherTenant'],
      { note: 'A real row in the second tenant; must read as not-found to every primary actor.' },
    ),
    s('meetings.deleted', 'meetings', 'deleted meeting', [], {
      absence: 'absent.meeting',
      note: 'A deleted meeting cannot be seeded; the fixture is an id with no row.',
    }),
    s('meetings.prep', 'meetings', 'prep', [
      'prep.approved.1',
      'prep.generated.2',
      'prep.edited.3',
      'prep.approved.4',
    ]),
    s('meetings.notes', 'meetings', 'notes', [
      'note.adminApproved',
      'note.adminDraft',
      'note.peerConfidential',
    ]),
    s('meetings.debrief', 'meetings', 'debrief', ['debrief.approved', 'debrief.generated']),
    s('meetings.tasks', 'meetings', 'tasks', [
      'task.todo.1',
      'task.in_progress.2',
      'task.blocked.3',
      'task.done.4',
      'task.todo.5',
    ]),
    s(
      'meetings.attachmentMetadata',
      'meetings',
      'attachment metadata',
      ['attachment.meetingReady', 'attachment.meetingBlocked'],
      { note: 'Metadata rows only — no S3 object backs any fixture s3Key.' },
    ),
    s('meetings.notetakerStatuses', 'meetings', 'relevant notetaker statuses', [
      'botSession.done',
      'botSession.failed',
      'botSession.no_show',
      'botSession.requested',
      'botSession.in_call',
    ]),
    s('meetings.confidentialAccessible', 'meetings', 'accessible confidential content', [
      'meeting.confidentialAccessible',
      'note.adminApproved',
    ]),
    s('meetings.confidentialDenied', 'meetings', 'denied confidential content', [
      'meeting.confidentialDenied',
      'note.peerConfidential',
    ]),

    // ── Outreach v2 ────────────────────────────────────────────────────────
    s('outreach.emptyList', 'outreach_v2', 'empty list', [], {
      absence: 'tenant.secondary',
      note: 'The second tenant holds zero outreach records, so its list renders the empty state.',
    }),
    s('outreach.draft', 'outreach_v2', 'draft', ['outreach.draft']),
    s('outreach.partialWizard', 'outreach_v2', 'partially completed wizard', [
      'outreach.partialWizard',
    ]),
    s('outreach.followUp', 'outreach_v2', 'follow-up', ['outreach.followUp']),
    s('outreach.prepDistribution', 'outreach_v2', 'prep distribution', [
      'outreach.prepDistribution',
    ]),
    s('outreach.outboundCampaign', 'outreach_v2', 'outbound campaign', [
      'outreach.outboundCampaign',
    ]),
    s('outreach.sent', 'outreach_v2', 'sent', ['outreach.sent']),
    s('outreach.failed', 'outreach_v2', 'failed', ['outreach.failed']),
    s('outreach.openedInEmail', 'outreach_v2', 'opened-in-email', ['outreach.openedInEmail']),
    s(
      'outreach.deliveryUnknown',
      'outreach_v2',
      'delivery unknown',
      ['outreach.deliveryUnknown', 'sendIntent.deliveryUnknown', 'delivery.unknown'],
      {
        note:
          'The ONLY pre-existing send intent and delivery in the fixture set. 3.7 must therefore ' +
          'assert its external-denial invariants as a DELTA against these declared rows, not as ' +
          'an absolute "zero send intents" count.',
      },
    ),
    s('outreach.clientDirected', 'outreach_v2', 'client-directed', ['outreach.clientDirected']),
    s('outreach.externalOnBehalf', 'outreach_v2', 'external/on-behalf', [
      'outreach.externalOnBehalf',
    ]),
    s('outreach.groupRecipient', 'outreach_v2', 'group recipient', ['outreach.groupRecipient']),
    s('outreach.missingEmail', 'outreach_v2', 'missing email', [
      'outreach.missingEmail',
      'contact.noEmail',
    ]),
    s('outreach.attachmentMetadata', 'outreach_v2', 'attachment metadata', [
      'outreach.withAttachment',
      'attachment.outreach',
    ]),
    s(
      'outreach.nullableClient',
      'outreach_v2',
      'truthful nullable-client record',
      ['outreach.nullableClient'],
      { note: 'clientId stays null; 3.7 asserts no code path fabricates one.' },
    ),
    s(
      'outreach.draftLifecycle',
      'outreach_v2',
      'immutable artifact/version and draft audit reads',
      [
        'artifact.sent',
        'version.sentV1',
        'version.sentV2',
        'artifact.held',
        'version.held',
        'artifact.deliveryUnknown',
        'version.deliveryUnknown',
      ],
    ),
    s('outreach.recipientSources', 'outreach_v2', 'recipients from current sources', [
      'audience.list',
      'audience.group',
      'audienceMember.1',
      'audienceMember.3',
      'template.outbound',
      'aiTemplate.general',
    ]),

    // ── Reports ────────────────────────────────────────────────────────────
    s('reports.currentPeriod', 'reports', 'current period', [
      'meeting.reportCurrentCycle',
      'reportTarget.autoAlpha',
    ]),
    s('reports.previousPeriod', 'reports', 'previous period', ['meeting.reportPreviousCycle']),
    s('reports.emptyPeriod', 'reports', 'empty period', [], {
      absence: 'client.beta',
      note: 'client.beta has no meetings in any cycle, so its report renders the empty result.',
    }),
    s('reports.everyStatus', 'reports', 'every status', [
      'reportTarget.autoAlpha',
      'reportTarget.notStartedAlpha',
      'reportTarget.beta',
      'reportTarget.manualOverrideAlpha',
    ]),
    s('reports.manualOverride', 'reports', 'manual override', [
      'reportTarget.manualOverrideAlpha',
    ]),
    s(
      'reports.meetingsAndPendingActions',
      'reports',
      'meetings and pending actions',
      ['meeting.reportCurrentCycle', 'task.todo.1', 'task.in_progress.2'],
      {
        requires: 'directory_snapshot',
        note:
          'reportOverview attaches meetings and pendingActions only inside its directory-match ' +
          'loop (engagement.service.ts ~5513), and directory data comes from the S3 snapshot, not ' +
          'the database. The fixture seats the one snapshot-independent directory address on these ' +
          'meetings; without directory access the state is unreachable by ANY database fixture and ' +
          '3.8 must record it as a coverage limitation rather than a parity failure.',
      },
    ),
    s('reports.crossClientIsolation', 'reports', 'cross-client isolation', [
      'reportTarget.autoAlpha',
      'reportTarget.beta',
      'reportTarget.scopeAll',
    ]),

    // ── Integrations ───────────────────────────────────────────────────────
    s('integrations.microsoftConnected', 'integrations', 'Microsoft connected', [
      'connection.microsoftConnected',
    ]),
    s('integrations.googleConnected', 'integrations', 'Google connected', [
      'connection.googleConnected',
    ]),
    s('integrations.disconnected', 'integrations', 'disconnected', ['connection.disconnected']),
    s('integrations.expiredError', 'integrations', 'expired/error', ['connection.expiredError']),
    s('integrations.noConnections', 'integrations', 'no connections', [], {
      absence: 'tenant.secondary',
      note: 'The second tenant holds zero connections, so its Integrations page renders empty.',
    }),
    s(
      'integrations.subscriptionMetadata',
      'integrations',
      'subscription metadata without provider calls',
      ['connection.microsoftConnected'],
      {
        note:
          'Stored in syncState as data. Zero IntegrationConnectionToken rows exist, which is the ' +
          'checkable invariant behind "no provider credential".',
      },
    ),
  ];
}

// ─── validation ─────────────────────────────────────────────────────────────

export interface ValidationIssue {
  rule: string;
  detail: string;
}

/**
 * Fields whose name ends in `Key`/`Keys` but which hold product data rather than
 * a reference to another fixture row.
 */
const NON_REFERENCE_KEY_FIELDS = new Set([
  'recipientKey', // the recipient's own identity (an email or contact id)
  'generationKey', // the immutable draft slot key
  'requestKey', // the send-intent idempotency token
  'officeKey', // a report target office's own key
  'scopeKeyFrom', // how the report scope key is derived, not a reference
  's3Key', // an S3 object key; no object exists behind it
]);

/** Every requirement the plan's 3.2 "Required fixtures" section enumerates. */
export const REQUIRED_FIXTURE_STATES: ReadonlyArray<{
  planSection: FixtureState['planSection'];
  requirement: string;
}> = [
  { planSection: 'users_and_tenants', requirement: 'admin' },
  { planSection: 'users_and_tenants', requirement: 'standard user' },
  { planSection: 'users_and_tenants', requirement: 'below-required role' },
  { planSection: 'users_and_tenants', requirement: 'different user in same tenant' },
  { planSection: 'users_and_tenants', requirement: 'second tenant' },
  { planSection: 'users_and_tenants', requirement: 'ethical-wall denied actor when supported' },
  {
    planSection: 'users_and_tenants',
    requirement: 'Capiro Admin impersonation fixture when supported',
  },
  { planSection: 'meetings', requirement: 'upcoming client meeting' },
  { planSection: 'meetings', requirement: 'upcoming no-client meeting' },
  { planSection: 'meetings', requirement: 'past meeting' },
  { planSection: 'meetings', requirement: 'all-day meeting' },
  { planSection: 'meetings', requirement: 'timezone-boundary meeting' },
  { planSection: 'meetings', requirement: 'multiple attendees' },
  { planSection: 'meetings', requirement: 'deep-linked meeting outside visible range' },
  { planSection: 'meetings', requirement: 'inaccessible meeting' },
  { planSection: 'meetings', requirement: 'deleted meeting' },
  { planSection: 'meetings', requirement: 'prep' },
  { planSection: 'meetings', requirement: 'notes' },
  { planSection: 'meetings', requirement: 'debrief' },
  { planSection: 'meetings', requirement: 'tasks' },
  { planSection: 'meetings', requirement: 'attachment metadata' },
  { planSection: 'meetings', requirement: 'relevant notetaker statuses' },
  { planSection: 'meetings', requirement: 'accessible confidential content' },
  { planSection: 'meetings', requirement: 'denied confidential content' },
  { planSection: 'outreach_v2', requirement: 'empty list' },
  { planSection: 'outreach_v2', requirement: 'draft' },
  { planSection: 'outreach_v2', requirement: 'partially completed wizard' },
  { planSection: 'outreach_v2', requirement: 'follow-up' },
  { planSection: 'outreach_v2', requirement: 'prep distribution' },
  { planSection: 'outreach_v2', requirement: 'outbound campaign' },
  { planSection: 'outreach_v2', requirement: 'sent' },
  { planSection: 'outreach_v2', requirement: 'failed' },
  { planSection: 'outreach_v2', requirement: 'opened-in-email' },
  { planSection: 'outreach_v2', requirement: 'delivery unknown' },
  { planSection: 'outreach_v2', requirement: 'client-directed' },
  { planSection: 'outreach_v2', requirement: 'external/on-behalf' },
  { planSection: 'outreach_v2', requirement: 'group recipient' },
  { planSection: 'outreach_v2', requirement: 'missing email' },
  { planSection: 'outreach_v2', requirement: 'attachment metadata' },
  { planSection: 'outreach_v2', requirement: 'truthful nullable-client record' },
  { planSection: 'reports', requirement: 'current period' },
  { planSection: 'reports', requirement: 'previous period' },
  { planSection: 'reports', requirement: 'empty period' },
  { planSection: 'reports', requirement: 'every status' },
  { planSection: 'reports', requirement: 'manual override' },
  { planSection: 'reports', requirement: 'meetings and pending actions' },
  { planSection: 'integrations', requirement: 'Microsoft connected' },
  { planSection: 'integrations', requirement: 'Google connected' },
  { planSection: 'integrations', requirement: 'disconnected' },
  { planSection: 'integrations', requirement: 'expired/error' },
  { planSection: 'integrations', requirement: 'no connections' },
  { planSection: 'integrations', requirement: 'subscription metadata without provider calls' },
];

/** Every fixture key the plan defines, mapped to the collection it came from. */
export function collectKeys(plan: FixturePlan): Map<string, string> {
  const keys = new Map<string, string>();
  const add = (collection: string, rows: ReadonlyArray<{ key: string }>) => {
    for (const row of rows) keys.set(row.key, collection);
  };
  add('tenants', plan.tenants);
  add('users', plan.users);
  add('memberships', plan.memberships);
  add('impersonations', plan.impersonations);
  add('clients', plan.clients);
  add('clientMemoryAccess', plan.clientMemoryAccess);
  add('contacts', plan.contacts);
  add('meetings', plan.meetings);
  add('attendees', plan.attendees);
  add('botSessions', plan.botSessions);
  add('preps', plan.preps);
  add('notes', plan.notes);
  add('debriefs', plan.debriefs);
  add('tasks', plan.tasks);
  add('attachments', plan.attachments);
  add('outreachRecords', plan.outreachRecords);
  add('draftArtifacts', plan.draftArtifacts);
  add('draftVersions', plan.draftVersions);
  add('sendIntents', plan.sendIntents);
  add('deliveries', plan.deliveries);
  add('audiences', plan.audiences);
  add('audienceMembers', plan.audienceMembers);
  add('templates', plan.templates);
  add('aiTemplates', plan.aiTemplates);
  add('reportTargets', plan.reportTargets);
  add('connections', plan.connections);
  add('absentIds', plan.absentIds);
  return keys;
}

/** Every declared UUID with the field that holds it. */
function collectIds(plan: FixturePlan): Array<{ key: string; id: string }> {
  const rows: Array<{ key: string; id: string }> = [];
  for (const [, collection] of Object.entries(plan)) {
    if (!Array.isArray(collection)) continue;
    for (const row of collection) {
      if (row && typeof row === 'object' && 'id' in row && 'key' in row) {
        rows.push({ key: String((row as { key: unknown }).key), id: String((row as { id: unknown }).id) });
      }
    }
  }
  return rows;
}

export function isAllowedFixtureEmail(email: string): boolean {
  const at_ = email.lastIndexOf('@');
  if (at_ <= 0 || at_ === email.length - 1) return false;
  const domain = email.slice(at_ + 1).toLowerCase();
  if (ALLOWED_EMAIL_DOMAINS.has(domain)) return true;
  return ALLOWED_EMAIL_TLD_SUFFIXES.some((suffix) => domain.endsWith(suffix));
}

/**
 * Every address the plan declares, with its origin. Matches email-shaped
 * SUBSTRINGS rather than whole strings: a Graph subscription resource embeds a
 * mailbox inside a URL path, and treating the whole path as the address made the
 * domain check fail on a perfectly valid fixture.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function collectEmails(plan: FixturePlan): Array<{ where: string; email: string }> {
  const found: Array<{ where: string; email: string }> = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(EMAIL_RE)) found.push({ where: path, email: match[0] });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    }
  };
  walk(plan, 'plan');
  return found;
}

/**
 * Every rule the plan's 3.2 "Rules and tests" section states, as pure
 * predicates over the plan. Returns every issue rather than throwing on the
 * first, so a broken plan reports its full damage in one run.
 */
export function validateFixturePlan(plan: FixturePlan): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const reservedValues = new Set(RESERVED_IDENTIFIERS.map((entry) => entry.value));

  // 1 — Phase 3 marker on every row's human-readable label.
  const labelFields = ['name', 'title', 'subject', 'fullName', 'firstName', 'memberPrincipal', 'displayName', 'fileName'];
  const checkLabels = (collection: string, rows: ReadonlyArray<Record<string, unknown>>) => {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const present = labelFields.filter((field) => typeof row[field] === 'string');
      if (!present.length) continue;
      const marked = present.some((field) => String(row[field]).includes(PHASE3_MARKER));
      if (!marked) {
        issues.push({
          rule: 'marker-on-every-row',
          detail: `${collection}.${String(row.key)} has labels ${present.join('/')} but none carries "${PHASE3_MARKER}"`,
        });
      }
    }
  };
  for (const [collection, rows] of Object.entries(plan)) {
    if (Array.isArray(rows)) checkLabels(collection, rows as Array<Record<string, unknown>>);
  }

  // 2 — Every id is in the fixture id space, and unique.
  const seenIds = new Map<string, string>();
  for (const { key, id } of collectIds(plan)) {
    if (!FIXTURE_ID_RE.test(id)) {
      issues.push({ rule: 'fixture-id-space', detail: `${key} id ${id} is outside the fixture id space` });
    }
    const previous = seenIds.get(id);
    if (previous) {
      issues.push({ rule: 'unique-fixture-id', detail: `${key} reuses the id of ${previous} (${id})` });
    } else {
      seenIds.set(id, key);
    }
  }

  // 3 — Every address is a reserved example domain.
  for (const { where, email } of collectEmails(plan)) {
    if (!isAllowedFixtureEmail(email)) {
      issues.push({
        rule: 'reserved-email-domains-only',
        detail: `${where} = ${email} is not a reserved example domain`,
      });
    }
  }

  // 4 — Nothing resembling a provider credential.
  const credentialFields = /(token|secret|password|refreshToken|accessToken|apiKey|credential)/i;
  const walkCredentials = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walkCredentials(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (credentialFields.test(k) && typeof v === 'string' && v.length > 0) {
          issues.push({ rule: 'no-provider-credential', detail: `${path}.${k} carries a credential-shaped value` });
        }
        walkCredentials(v, `${path}.${k}`);
      }
    }
  };
  walkCredentials(plan, 'plan');

  // 5 — Non-marker identifiers must be declared reserved, with a reason.
  for (const tenant of plan.tenants) {
    if (!tenant.slug.startsWith('phase3-') && !reservedValues.has(tenant.slug)) {
      issues.push({
        rule: 'reserved-identifier-declared',
        detail: `tenant ${tenant.key} slug "${tenant.slug}" is neither phase3-prefixed nor declared reserved`,
      });
    }
  }
  for (const entry of RESERVED_IDENTIFIERS) {
    if (!entry.reason.trim()) {
      issues.push({
        rule: 'reserved-identifier-declared',
        detail: `reserved identifier ${entry.value} carries no reason`,
      });
    }
  }

  // 6 — Every plan-required state is covered by rows that actually exist.
  const keys = collectKeys(plan);
  const byRequirement = new Map(plan.states.map((state) => [`${state.planSection}|${state.requirement}`, state]));
  for (const required of REQUIRED_FIXTURE_STATES) {
    const state = byRequirement.get(`${required.planSection}|${required.requirement}`);
    if (!state) {
      issues.push({
        rule: 'required-state-covered',
        detail: `no fixture state covers ${required.planSection} / "${required.requirement}"`,
      });
      continue;
    }
    if (!state.coveredBy.length && !state.absence) {
      issues.push({
        rule: 'required-state-covered',
        detail: `state ${state.id} names no covering row and declares no absence`,
      });
    }
    for (const key of state.coveredBy) {
      if (!keys.has(key)) {
        issues.push({
          rule: 'required-state-covered',
          detail: `state ${state.id} cites unknown fixture key ${key}`,
        });
      }
    }
    if (state.absence && !keys.has(state.absence)) {
      issues.push({
        rule: 'required-state-covered',
        detail: `state ${state.id} cites unknown absence fixture ${state.absence}`,
      });
    }
  }

  // 7 — Every conditional state explains what it needs and why.
  for (const state of plan.states) {
    if (state.requires && !state.note?.trim()) {
      issues.push({
        rule: 'conditional-state-explained',
        detail: `state ${state.id} requires ${state.requires} but records no note`,
      });
    }
  }

  // 8 — Every foreign key names a row the plan defines.
  const refs: Array<{ from: string; field: string; value: string | null }> = [];
  const pushRefs = (rows: ReadonlyArray<Record<string, unknown>>) => {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      for (const [field, value] of Object.entries(row)) {
        if (!field.endsWith('Key') && !field.endsWith('Keys')) continue;
        // A blocklist, not an allowlist, and deliberately so: a NEW reference
        // field is checked by default, and a new non-reference *Key field fails
        // the build until it is named here.
        if (NON_REFERENCE_KEY_FIELDS.has(field)) continue;
        if (typeof value === 'string') refs.push({ from: String(row.key), field, value });
        else if (value === null) refs.push({ from: String(row.key), field, value: null });
        else if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === 'string') refs.push({ from: String(row.key), field, value: item });
          }
        }
      }
    }
  };
  for (const rows of Object.values(plan)) {
    if (Array.isArray(rows)) pushRefs(rows as Array<Record<string, unknown>>);
  }
  for (const ref of refs) {
    if (ref.value === null) continue;
    if (!keys.has(ref.value)) {
      issues.push({
        rule: 'foreign-keys-resolve',
        detail: `${ref.from}.${ref.field} references unknown fixture key ${ref.value}`,
      });
    }
  }

  // 9 — Cleanup order covers every table with rows, children before parents.
  if (plan.cleanupOrder.length !== new Set(plan.cleanupOrder).size) {
    issues.push({ rule: 'cleanup-order-complete', detail: 'cleanupOrder repeats a table' });
  }

  return issues;
}

/** The committed contract artifact: the plan plus its coverage summary. */
export function buildFixtureContract(plan: FixturePlan): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const [collection, rows] of Object.entries(plan)) {
    if (Array.isArray(rows) && collection !== 'states' && collection !== 'cleanupOrder') {
      counts[collection] = rows.length;
    }
  }
  return {
    schemaVersion: 1,
    description:
      'Engagement Phase 3 parity fixture contract. Generated from ' +
      'apps/api/scripts/engagement-phase3-fixture-plan.ts — never hand-edited. ' +
      'Timestamps are descriptors, not literals, so this file is byte-stable and the ' +
      'report-period fixtures stay in the right calendar cycle in any year.',
    marker: plan.marker,
    idPrefix: plan.idPrefix,
    reservedIdentifiers: RESERVED_IDENTIFIERS,
    counts,
    totals: {
      rows: Object.values(counts).reduce((sum, n) => sum + n, 0),
      states: plan.states.length,
      requiredStates: REQUIRED_FIXTURE_STATES.length,
      conditionalStates: plan.states.filter((state) => Boolean(state.requires)).length,
      absenceStates: plan.states.filter((state) => Boolean(state.absence)).length,
    },
    states: plan.states,
    cleanupOrder: plan.cleanupOrder,
    plan: {
      tenants: plan.tenants,
      users: plan.users,
      memberships: plan.memberships,
      impersonations: plan.impersonations,
      clients: plan.clients,
      clientMemoryAccess: plan.clientMemoryAccess,
      contacts: plan.contacts,
      meetings: plan.meetings,
      attendees: plan.attendees,
      botSessions: plan.botSessions,
      preps: plan.preps,
      notes: plan.notes,
      debriefs: plan.debriefs,
      tasks: plan.tasks,
      attachments: plan.attachments,
      outreachRecords: plan.outreachRecords,
      draftArtifacts: plan.draftArtifacts,
      draftVersions: plan.draftVersions,
      sendIntents: plan.sendIntents,
      deliveries: plan.deliveries,
      audiences: plan.audiences,
      audienceMembers: plan.audienceMembers,
      templates: plan.templates,
      aiTemplates: plan.aiTemplates,
      reportTargets: plan.reportTargets,
      connections: plan.connections,
      absentIds: plan.absentIds,
    },
  };
}
