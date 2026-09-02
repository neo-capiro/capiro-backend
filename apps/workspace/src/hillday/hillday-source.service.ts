import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Read-side access to the source layers the Hill Day workflow draws from —
 * all of them apps/api-owned tables in the shared Aurora database (clients,
 * meetings + attendees, mail threads, strategies, users, tenants). The
 * workspace has no typed Prisma models for these, so every read is a
 * parameterized raw query run inside a transaction with the tenant GUC set,
 * exactly the way SourceResolverService reads `clients`. Row-level security
 * therefore still applies on the database side.
 *
 * Nothing here is cached and nothing is fabricated: a query that fails throws,
 * and the caller converts that into a named `unavailable` source block.
 */

export interface ClientRow {
  id: string;
  name: string;
  description: string | null;
  sectorTag: string | null;
  productDescription: string | null;
  hasLogo: boolean;
  officeCount: number;
  wallAllowed: boolean;
}

export interface RawEventRow {
  id: string;
  clientId: string | null;
  isInternal: boolean;
  connectionId: string | null;
  source: string;
  subject: string;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  organizerEmail: string | null;
  organizerName: string | null;
  timeZone: string | null;
  status: string;
  isVirtual: boolean;
  joinLink: string | null;
  attendees: Array<{ address: string | null; name: string | null; responseStatus: string | null }>;
}

export interface ConnectionRow {
  id: string;
  provider: string;
  status: string;
  lastSyncAt: Date | null;
  lastError: string | null;
  accountEmail: string | null;
}

export interface StrategyRow {
  id: string;
  title: string;
  type: string;
  goal: string | null;
}

export interface ThreadRow {
  id: string;
  subject: string;
  participants: Array<{ email?: string | null; name?: string | null; role?: string | null }>;
  lastMessageAt: Date | null;
  clientId: string | null;
  messageCount: number;
}

export interface MessageRow {
  threadId: string;
  fromEmail: string | null;
  fromName: string | null;
  sentAt: Date | null;
  subject: string | null;
  body: string | null;
}

export interface PriorMeetingRow {
  id: string;
  subject: string;
  startsAt: Date;
}

export interface UserDisplay {
  clerkUserId: string;
  name: string;
  initials: string;
  email: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

@Injectable()
export class HillDaySourceService {
  private readonly logger = new Logger(HillDaySourceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Run `fn` with the tenant GUC set so RLS admits this tenant's rows.
   *
   * Prisma's interactive-transaction defaults (2s to acquire a connection, 5s
   * to finish) are too tight for this service's small pool: a slow read here
   * used to expire mid-flight AND starve the TenantGuard's own lookup, which
   * then failed closed with a 403 for the next request (seen live 2026-09-02).
   */
  private withTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        return fn(tx);
      },
      { maxWait: 8_000, timeout: 30_000 },
    );
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  async resolveUserId(clerkUserId: string): Promise<string | null> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id FROM users WHERE clerk_user_id = ${clerkUserId} LIMIT 1
      `,
    );
    return rows[0]?.id ?? null;
  }

  async userDisplays(clerkUserIds: string[]): Promise<Map<string, UserDisplay>> {
    const out = new Map<string, UserDisplay>();
    const ids = [...new Set(clerkUserIds.filter(Boolean))];
    if (!ids.length) return out;
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRaw<
        Array<{ clerkUserId: string; email: string | null; firstName: string | null; lastName: string | null }>
      >`
        SELECT clerk_user_id AS "clerkUserId", email::text AS email,
               first_name AS "firstName", last_name AS "lastName"
        FROM users WHERE clerk_user_id IN (${Prisma.join(ids)})
      `,
    );
    for (const row of rows) {
      const name =
        [row.firstName, row.lastName].filter(Boolean).join(' ').trim() ||
        row.email?.split('@')[0] ||
        'Unknown user';
      out.set(row.clerkUserId, {
        clerkUserId: row.clerkUserId,
        name,
        initials: initialsOf(name),
        email: row.email,
      });
    }
    return out;
  }

  async tenantName(tenantId: string): Promise<string | null> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM tenants WHERE id = ${tenantId}::uuid LIMIT 1
      `,
    );
    return rows[0]?.name ?? null;
  }

  /** Lower-cased emails of the tenant's own active members (the firm side). */
  async tenantMemberEmails(tenantId: string): Promise<Set<string>> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRaw<Array<{ email: string }>>`
        SELECT lower(u.email::text) AS email
        FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id
        WHERE tm.tenant_id = ${tenantId}::uuid AND tm.status::text = 'active'
      `,
    );
    return new Set(rows.map((r) => r.email).filter(Boolean));
  }

  // ── Clients ───────────────────────────────────────────────────────────────

  async listClients(
    tenantId: string,
    userId: string | null,
    q: string,
    cursor: { name: string; id: string } | null,
    limit: number,
  ): Promise<ClientRow[]> {
    const like = `%${q.trim()}%`;
    return this.withTenant(tenantId, (tx) =>
      tx.$queryRaw<ClientRow[]>`
        SELECT c.id::text AS id, c.name, c.description, c.sector_tag AS "sectorTag",
               c.product_description AS "productDescription",
               (c.logo_s3_key IS NOT NULL) AS "hasLogo",
               (SELECT count(*) FROM client_targets t WHERE t.client_id = c.id)::int AS "officeCount",
               (NOT c.memory_wall OR EXISTS (
                 SELECT 1 FROM client_memory_access a
                 WHERE a.client_id = c.id AND a.user_id = ${userId}::uuid
               )) AS "wallAllowed"
        FROM clients c
        WHERE c.tenant_id = ${tenantId}::uuid
          AND c.status = 'active'
          AND COALESCE(c.profile_status, 'ACTIVE') <> 'ARCHIVED'
          AND (${q.trim()} = '' OR c.name ILIKE ${like})
          AND (${cursor?.name ?? null}::text IS NULL
               OR (c.name, c.id::text) > (${cursor?.name ?? ''}, ${cursor?.id ?? ''}))
        ORDER BY c.name ASC, c.id ASC
        LIMIT ${limit + 1}
      `,
    );
  }

  async getClient(tenantId: string, userId: string | null, clientId: string): Promise<ClientRow | null> {
    if (!isUuid(clientId)) return null;
    const rows = await this.withTenant(tenantId, (tx) =>
      tx.$queryRaw<ClientRow[]>`
        SELECT c.id::text AS id, c.name, c.description, c.sector_tag AS "sectorTag",
               c.product_description AS "productDescription",
               (c.logo_s3_key IS NOT NULL) AS "hasLogo",
               (SELECT count(*) FROM client_targets t WHERE t.client_id = c.id)::int AS "officeCount",
               (NOT c.memory_wall OR EXISTS (
                 SELECT 1 FROM client_memory_access a
                 WHERE a.client_id = c.id AND a.user_id = ${userId}::uuid
               )) AS "wallAllowed"
        FROM clients c
        WHERE c.tenant_id = ${tenantId}::uuid AND c.id = ${clientId}::uuid
        LIMIT 1
      `,
    );
    return rows[0] ?? null;
  }

  /** Live strategy counts per client (Strategies layer). Throws when the layer is unreadable. */
  async objectiveCounts(tenantId: string, clientIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const ids = clientIds.filter(isUuid);
    if (!ids.length) return out;
    const rows = await this.withTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<{ clientId: string; n: number }>>`
        SELECT client_id::text AS "clientId", count(*)::int AS n
        FROM sp_strategy
        WHERE tenant_id = ${tenantId}::uuid AND archived_at IS NULL
          AND client_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
        GROUP BY client_id
      `,
    );
    for (const row of rows) out.set(row.clientId, row.n);
    return out;
  }

  async clientPeopleEmails(tenantId: string, clientId: string): Promise<Set<string>> {
    if (!isUuid(clientId)) return new Set();
    const rows = await this.withTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<{ email: string }>>`
        SELECT lower(email::text) AS email FROM client_people
        WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid AND email IS NOT NULL
      `,
    );
    return new Set(rows.map((r) => r.email).filter(Boolean));
  }

  async listStrategies(tenantId: string, clientId: string): Promise<StrategyRow[]> {
    if (!isUuid(clientId)) return [];
    return this.withTenant(tenantId, (tx) =>
      tx.$queryRaw<StrategyRow[]>`
        SELECT id::text AS id, title, type::text AS type, goal
        FROM sp_strategy
        WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid AND archived_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 25
      `,
    );
  }

  // ── Calendar ──────────────────────────────────────────────────────────────

  async listConnections(tenantId: string): Promise<ConnectionRow[]> {
    return this.withTenant(tenantId, (tx) =>
      tx.$queryRaw<ConnectionRow[]>`
        SELECT id::text AS id, provider::text AS provider, status::text AS status,
               last_sync_at AS "lastSyncAt", last_error AS "lastError", account_email::text AS "accountEmail"
        FROM engagement_connections
        WHERE tenant_id = ${tenantId}::uuid
        ORDER BY updated_at DESC
      `,
    );
  }

  /**
   * Calendar events in [from, to). Visibility mirrors apps/api's own rule:
   * shared events, plus the caller's private events (created by them or synced
   * from a connection they own). Soft-deleted events never surface.
   */
  async listEvents(
    tenantId: string,
    userId: string | null,
    from: Date,
    to: Date,
  ): Promise<RawEventRow[]> {
    return this.withTenant(tenantId, (tx) =>
      tx.$queryRaw<RawEventRow[]>`
        SELECT ${this.eventColumns()}
        FROM meetings m LEFT JOIN engagement_connections ec ON ec.id = m.connection_id
        WHERE m.tenant_id = ${tenantId}::uuid
          AND m.status <> 'deleted'
          AND m.starts_at >= ${from} AND m.starts_at < ${to}
          AND (m.visibility::text = 'shared'
               OR m.created_by_user_id = ${userId}::uuid
               OR ec.created_by_user_id = ${userId}::uuid)
        ORDER BY m.starts_at ASC
        LIMIT 400
      `,
    );
  }

  async eventsByIds(tenantId: string, userId: string | null, eventIds: string[]): Promise<RawEventRow[]> {
    const ids = eventIds.filter(isUuid);
    if (!ids.length) return [];
    return this.withTenant(tenantId, (tx) =>
      tx.$queryRaw<RawEventRow[]>`
        SELECT ${this.eventColumns()}
        FROM meetings m LEFT JOIN engagement_connections ec ON ec.id = m.connection_id
        WHERE m.tenant_id = ${tenantId}::uuid
          AND m.status <> 'deleted'
          AND m.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
          AND (m.visibility::text = 'shared'
               OR m.created_by_user_id = ${userId}::uuid
               OR ec.created_by_user_id = ${userId}::uuid)
        ORDER BY m.starts_at ASC
      `,
    );
  }

  private eventColumns(): Prisma.Sql {
    return Prisma.sql`
      m.id::text AS id, m.client_id::text AS "clientId", m.is_internal AS "isInternal",
      m.connection_id::text AS "connectionId", m.source::text AS source, m.subject, m.location,
      m.starts_at AS "startsAt", m.ends_at AS "endsAt",
      m.organizer_email::text AS "organizerEmail", m.organizer_name AS "organizerName",
      m.time_zone AS "timeZone", m.status, m.is_virtual AS "isVirtual", m.join_link AS "joinLink",
      COALESCE((
        SELECT json_agg(json_build_object('address', a.email, 'name', a.name, 'responseStatus', a.response_status)
                        ORDER BY a.created_at)
        FROM meeting_attendees a WHERE a.meeting_id = m.id
      ), '[]'::json) AS attendees`;
  }

  async upcomingEventAt(tenantId: string, clientId: string, after: Date): Promise<Date | null> {
    if (!isUuid(clientId)) return null;
    const rows = await this.withTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<{ startsAt: Date | null }>>`
        SELECT min(starts_at) AS "startsAt" FROM meetings
        WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
          AND status <> 'deleted' AND starts_at >= ${after}
      `,
    );
    return rows[0]?.startsAt ?? null;
  }

  /** Prior meetings with the same office (attendee overlap) for the sponsor, newest first. */
  async priorMeetings(
    tenantId: string,
    userId: string | null,
    clientId: string,
    addresses: string[],
    before: Date,
    excludeEventId: string,
  ): Promise<PriorMeetingRow[]> {
    const lower = [...new Set(addresses.map((a) => a.toLowerCase()))];
    if (!lower.length || !isUuid(clientId)) return [];
    const since = new Date(before.getTime() - 365 * 86_400_000);
    const exclude = isUuid(excludeEventId) ? excludeEventId : '00000000-0000-0000-0000-000000000000';
    // IN (...) via Prisma.join rather than `= ANY($1::text[])`: the join form is
    // the codebase's proven way to pass a list to $queryRaw.
    const addressList = Prisma.join(lower);
    return this.withTenant(tenantId, (tx) =>
      tx.$queryRaw<PriorMeetingRow[]>`
        SELECT m.id::text AS id, m.subject, m.starts_at AS "startsAt"
        FROM meetings m LEFT JOIN engagement_connections ec ON ec.id = m.connection_id
        WHERE m.tenant_id = ${tenantId}::uuid AND m.client_id = ${clientId}::uuid
          AND m.status <> 'deleted' AND m.id <> ${exclude}::uuid
          AND m.starts_at < ${before} AND m.starts_at >= ${since}
          AND (m.visibility::text = 'shared'
               OR m.created_by_user_id = ${userId}::uuid
               OR ec.created_by_user_id = ${userId}::uuid)
          AND EXISTS (
            SELECT 1 FROM meeting_attendees a
            WHERE a.meeting_id = m.id AND lower(a.email::text) IN (${addressList})
          )
        ORDER BY m.starts_at DESC
        LIMIT 10
      `,
    );
  }

  // ── Correspondence ────────────────────────────────────────────────────────

  /**
   * Threads inside the lookback window, scoped to the resolved attendees or
   * tagged to the client. Ownership mirrors apps/api's ownMailThreadWhere:
   * threads from a mailbox connection the caller owns, plus manual threads.
   * Anything older than `since` is excluded, not summarised.
   */
  async listThreads(
    tenantId: string,
    userId: string | null,
    clientId: string,
    addresses: string[],
    since: Date,
  ): Promise<ThreadRow[]> {
    const lower = [...new Set(addresses.map((a) => a.toLowerCase()))];
    const client = isUuid(clientId) ? clientId : null;
    if (!client && !lower.length) return [];
    // Attendee-address scope as an IN (...) list (Prisma.join), or FALSE when
    // there are no resolved addresses so only client-tagged threads qualify.
    const addressScope = lower.length
      ? Prisma.sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements(t.participants_jsonb) p
            WHERE lower(p->>'email') IN (${Prisma.join(lower)}))`
      : Prisma.sql`FALSE`;
    return this.withTenant(tenantId, (tx) =>
      tx.$queryRaw<ThreadRow[]>`
        SELECT t.id::text AS id, t.subject, t.participants_jsonb AS participants,
               t.last_message_at AS "lastMessageAt", t.client_id::text AS "clientId",
               (SELECT count(*) FROM mail_messages mm
                 WHERE mm.thread_id = t.id AND mm.removed_at IS NULL)::int AS "messageCount"
        FROM mail_threads t LEFT JOIN engagement_connections ec ON ec.id = t.connection_id
        WHERE t.tenant_id = ${tenantId}::uuid
          AND t.last_message_at >= ${since}
          AND (t.connection_id IS NULL OR ec.created_by_user_id = ${userId}::uuid)
          AND (t.client_id = ${client}::uuid OR ${addressScope})
        ORDER BY t.last_message_at DESC
        LIMIT 50
      `,
    );
  }

  async threadMessages(tenantId: string, threadIds: string[]): Promise<MessageRow[]> {
    const ids = threadIds.filter(isUuid);
    if (!ids.length) return [];
    return this.withTenant(tenantId, (tx) =>
      tx.$queryRaw<MessageRow[]>`
        SELECT thread_id::text AS "threadId", from_email::text AS "fromEmail", from_name AS "fromName",
               COALESCE(sent_at, received_at) AS "sentAt", subject, left(body_text, 1800) AS body
        FROM mail_messages
        WHERE tenant_id = ${tenantId}::uuid AND removed_at IS NULL
          AND thread_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
        ORDER BY COALESCE(sent_at, received_at) ASC
        LIMIT 60
      `,
    );
  }

  // ── Writes (explicit user actions only) ──────────────────────────────────

  /**
   * "Create the Directory record" for an address the congressional Directory
   * does not know. The LegiStorm snapshot is read-only, so the record the firm
   * can own is its tenant contact (engagement_contacts), linked to the sponsor.
   */
  async upsertEngagementContact(
    tenantId: string,
    clientId: string,
    input: { email: string; fullName: string; title: string | null; organization: string | null },
  ): Promise<string | null> {
    const client = isUuid(clientId) ? clientId : null;
    try {
      const rows = await this.withTenant(tenantId, (tx) =>
        tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO engagement_contacts
            (id, tenant_id, client_id, full_name, email, title, organization, source, metadata_jsonb, created_at, updated_at)
          VALUES
            (gen_random_uuid(), ${tenantId}::uuid, ${client}::uuid, ${input.fullName}, ${input.email},
             ${input.title}, ${input.organization}, 'hillday', '{}'::jsonb, now(), now())
          ON CONFLICT (tenant_id, email) DO UPDATE SET
            full_name = COALESCE(EXCLUDED.full_name, engagement_contacts.full_name),
            title = COALESCE(EXCLUDED.title, engagement_contacts.title),
            organization = COALESCE(EXCLUDED.organization, engagement_contacts.organization),
            client_id = COALESCE(engagement_contacts.client_id, EXCLUDED.client_id),
            updated_at = now()
          RETURNING id::text AS id
        `,
      );
      return rows[0]?.id ?? null;
    } catch (err) {
      this.logger.warn(`engagement contact upsert failed: ${(err as Error).message}`);
      return null;
    }
  }
}
