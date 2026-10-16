import type {
  ObjectiveOperationalActor,
  ObjectiveOperationalBinding,
  ObjectiveOperationalResource,
  ObjectiveOperationalSelection,
  ObjectiveOperationalSourceRead,
  ObjectiveOperationalTx,
} from '@capiro/shared';
import { parseOutreachV3StateEnabled } from '../../../outreach-v3/api/outreach-v3-state.guard.js';
import {
  hashCampaignSpecV1,
  parseCampaignSpecV1,
} from '../../../outreach-v3/state/outreach-campaign-spec.v1.js';
import { assertOutreachContextSponsorIsolation } from '../../../outreach-v3/context/outreach-context-sponsor-policy.js';
import type { OperationalCycle } from './objective-operational.types.js';

const INTERNAL_TENANT_SLUG = 'capiro-internal';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ECMAScript String.trim whitespace, matching clientAssociatedMeetingWhere.
// PostgreSQL's one-argument btrim only removes ASCII spaces.
const CONTACT_TRIM_CHARACTERS =
  '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

function outreachEnabled(): boolean {
  // The controller's feature guard does not run for an internal reader. Preserve
  // its parser here, before even the owner-lock query, and fail closed on bad config.
  try {
    return parseOutreachV3StateEnabled(process.env.OUTREACH_V3_STATE_ENABLED);
  } catch {
    return false;
  }
}

async function canReadInternalCycle(
  tx: ObjectiveOperationalTx,
  actor: ObjectiveOperationalActor,
): Promise<boolean> {
  // Match DefenseBudgetLifecycleInternalGuard: configured identity is the fast
  // path; the current database slug is the fallback. Context slug is no grant.
  const configured = process.env.CAPIRO_INTERNAL_TENANT_ID?.trim() || undefined;
  if (configured && actor.tenantId === configured) return true;
  try {
    const rows = await tx.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok WHERE EXISTS (
        SELECT 1 FROM tenants WHERE id::text = ${actor.tenantId} AND slug = ${INTERNAL_TENANT_SLUG}
      ) LIMIT 1
    `;
    return rows.some((row) => row.ok === 1);
  } catch {
    return false;
  }
}

export interface ObjectiveLocalResourceGate {
  kind: 'meeting';
  tenantId: string;
  userId: string;
  meetingId: string;
  clientId: string;
  lockedPersonIds: string[];
  lockedAttendeeIds: string[];
}

function gateUnavailable(): never {
  throw new Error('Objective local resource gate unavailable');
}

function lockedIds(rows: Array<{ id: string }>): string[] {
  if (rows.some((row) => !UUID.test(row.id))) gateUnavailable();
  return [...new Set(rows.map((row) => row.id.toLowerCase()))];
}

function iso(value: Date | string): string | null {
  if (!(value instanceof Date) && (typeof value !== 'string' || value.trim() === '')) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function timestampResource(
  selection: ObjectiveOperationalSelection,
  title: string | null,
  updatedAt: Date | string,
  observedAt: string,
): ObjectiveOperationalResource | null {
  const value = iso(updatedAt);
  return value === null
    ? null
    : {
        selection,
        title,
        ownerVersion: { kind: 'timestamp', value },
        observedAt,
      };
}

/**
 * Owner gates precede current Core Objective/client authority on a new command.
 * These locks do not establish same-client eligibility: read below must still run
 * in this transaction after Core authority. No link is an access capability.
 */
export async function lockObjectiveLocalResource(
  tx: ObjectiveOperationalTx,
  actor: ObjectiveOperationalActor,
  selection: ObjectiveOperationalSelection,
  clientId?: string,
): Promise<ObjectiveLocalResourceGate | undefined> {
  if (!UUID.test(selection.id)) return;
  if (selection.kind === 'outreach_session') {
    if (!outreachEnabled()) return;
    await tx.$queryRaw`
      SELECT id FROM outreach_sessions
      WHERE id = ${selection.id}::uuid
        AND tenant_id = ${actor.tenantId}::uuid
        AND created_by_user_id = ${actor.userId}::uuid
        AND status = 'active' AND archived_at IS NULL
      FOR UPDATE
    `;
  } else if (selection.kind === 'meeting') {
    if (!clientId || !UUID.test(clientId)) gateUnavailable();
    // Connection first: deleting it may update its meetings through the FK.
    // Recheck its identity under the meeting lock rather than holding a stale
    // connection witness after concurrent reassignment.
    const initial = await tx.$queryRaw<Array<{ id: string; connectionId: string | null }>>`
      SELECT id, connection_id AS "connectionId" FROM meetings
      WHERE id = ${selection.id}::uuid AND tenant_id = ${actor.tenantId}::uuid LIMIT 1
    `;
    const prior = initial[0];
    if (
      !prior ||
      prior.id.toLowerCase() !== selection.id.toLowerCase() ||
      (prior.connectionId !== null && !UUID.test(prior.connectionId))
    )
      gateUnavailable();
    if (prior.connectionId !== null) {
      const connections = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM engagement_connections
        WHERE id = ${prior.connectionId}::uuid AND tenant_id = ${actor.tenantId}::uuid FOR SHARE
      `;
      if (
        connections.length !== 1 ||
        connections[0]!.id.toLowerCase() !== prior.connectionId.toLowerCase()
      )
        gateUnavailable();
    }
    const meetings = await tx.$queryRaw<Array<{ id: string; connectionId: string | null }>>`
      SELECT m.id, m.connection_id AS "connectionId" FROM meetings m
      WHERE m.id = ${selection.id}::uuid AND m.tenant_id = ${actor.tenantId}::uuid
        AND m.connection_id IS NOT DISTINCT FROM ${prior.connectionId}::uuid
        AND m.status NOT IN ('deleted', 'cancelled', 'canceled')
        AND (m.created_by_user_id = ${actor.userId}::uuid OR EXISTS (
          SELECT 1 FROM engagement_connections c
          WHERE c.id = m.connection_id AND c.tenant_id = m.tenant_id
            AND c.created_by_user_id = ${actor.userId}::uuid
        ) OR (m.visibility = 'shared' AND m.client_id = ${clientId}::uuid))
      FOR UPDATE OF m
    `;
    const current = meetings[0];
    if (
      !current ||
      current.id.toLowerCase() !== selection.id.toLowerCase() ||
      (current.connectionId !== null && typeof current.connectionId !== 'string') ||
      current.connectionId?.toLowerCase() !== prior.connectionId?.toLowerCase()
    )
      gateUnavailable();
    const people = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM client_people WHERE tenant_id = ${actor.tenantId}::uuid
        AND client_id = ${clientId}::uuid ORDER BY id FOR SHARE
    `;
    const attendees = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM meeting_attendees WHERE tenant_id = ${actor.tenantId}::uuid
        AND meeting_id = ${selection.id}::uuid ORDER BY id FOR SHARE
    `;
    return {
      kind: 'meeting',
      tenantId: actor.tenantId.toLowerCase(),
      userId: actor.userId.toLowerCase(),
      meetingId: selection.id.toLowerCase(),
      clientId: clientId.toLowerCase(),
      lockedPersonIds: lockedIds(people),
      lockedAttendeeIds: lockedIds(attendees),
    };
  } else if (selection.kind === 'budget_package') {
    await tx.$queryRaw`SELECT id FROM budget_package WHERE id = ${selection.id}::uuid FOR SHARE`;
  } else if (selection.kind === 'defense_budget_cycle') {
    if (!(await canReadInternalCycle(tx, actor))) return;
    await tx.$queryRaw`SELECT id FROM defense_budget_cycle WHERE id = ${selection.id}::uuid FOR SHARE`;
  }
}

interface MeetingRow {
  id: string;
  clientId: string | null;
  status: string;
  title: string | null;
  updatedAt: Date | string;
  startsAt: Date | string;
  endsAt: Date | string | null;
}

async function readMeeting(
  tx: ObjectiveOperationalTx,
  actor: ObjectiveOperationalActor,
  binding: ObjectiveOperationalBinding,
  selection: ObjectiveOperationalSelection,
  observedAt: string,
  asOf: string,
  gate?: ObjectiveLocalResourceGate,
): Promise<ObjectiveOperationalSourceRead | null> {
  if (iso(asOf) === null) return null;
  if (
    gate &&
    (gate.kind !== 'meeting' ||
      gate.tenantId !== actor.tenantId.toLowerCase() ||
      gate.userId !== actor.userId.toLowerCase() ||
      gate.meetingId !== selection.id.toLowerCase() ||
      gate.clientId !== binding.clientId.toLowerCase())
  )
    gateUnavailable();
  const personIds = gate ? gate.lockedPersonIds : null;
  const attendeeIds = gate ? gate.lockedAttendeeIds : null;
  // SQL translation is required by the narrow tagged-SQL transaction port.
  // Exact source rules: engagement-access.helpers.ts ownMeetingWhere and
  // clientAssociatedMeetingWhere; engagement-meetings.spec.ts
  // listSharedMeetingsForClient pins shared visibility to an explicit client;
  // intelligence-portfolio-coming-up.ts pins cancellation/deletion and time.
  // Only metadata is selected. Encrypted notes/preps/debriefs are never joined.
  const rows = await tx.$queryRaw<MeetingRow[]>`
    SELECT m.id, m.client_id AS "clientId", m.status, m.subject AS title, m.updated_at AS "updatedAt",
      m.starts_at AS "startsAt", m.ends_at AS "endsAt"
    FROM meetings m
    WHERE m.id = ${selection.id}::uuid AND m.tenant_id = ${actor.tenantId}::uuid
      AND m.status NOT IN ('deleted', 'cancelled', 'canceled')
      AND (
        m.created_by_user_id = ${actor.userId}::uuid OR EXISTS (
          SELECT 1 FROM engagement_connections c
          WHERE c.id = m.connection_id AND c.tenant_id = m.tenant_id
            AND c.created_by_user_id = ${actor.userId}::uuid
        ) OR (m.visibility = 'shared' AND m.client_id = ${binding.clientId}::uuid)
      )
      AND (
        m.client_id = ${binding.clientId}::uuid OR (
          m.client_id IS NULL AND m.is_internal = false
          AND (m.association_signals_jsonb -> 'manual' IS NULL
            OR m.association_signals_jsonb -> 'manual' = 'null'::jsonb
            OR m.association_signals_jsonb -> 'manual' = 'false'::jsonb)
          AND EXISTS (
            SELECT 1 FROM (
              SELECT lower(btrim(c.primary_contact_email::text, ${CONTACT_TRIM_CHARACTERS})) AS email
              FROM clients c WHERE c.id = ${binding.clientId}::uuid
                AND c.tenant_id = ${actor.tenantId}::uuid
              UNION
              SELECT lower(btrim(p.email::text, ${CONTACT_TRIM_CHARACTERS})) AS email FROM client_people p
              WHERE p.client_id = ${binding.clientId}::uuid AND p.tenant_id = ${actor.tenantId}::uuid
                AND (${personIds}::uuid[] IS NULL OR p.id = ANY(${personIds}::uuid[]))
            ) contacts
            WHERE contacts.email IS NOT NULL AND contacts.email <> ''
              AND (m.organizer_email = contacts.email::citext OR EXISTS (
                SELECT 1 FROM meeting_attendees a
                WHERE a.meeting_id = m.id AND a.tenant_id = m.tenant_id
                  AND (${attendeeIds}::uuid[] IS NULL OR a.id = ANY(${attendeeIds}::uuid[]))
                  AND a.email = contacts.email::citext
              ))
          )
        )
      )
    LIMIT 1
  `;
  const row = rows[0];
  if (
    !row ||
    row.id.toLowerCase() !== selection.id.toLowerCase() ||
    ['deleted', 'cancelled', 'canceled'].includes(row.status) ||
    (row.clientId !== null && row.clientId.toLowerCase() !== binding.clientId.toLowerCase())
  )
    return null;
  const resource = timestampResource(selection, row.title, row.updatedAt, observedAt);
  const startsAt = iso(row.startsAt);
  const endsAt = row.endsAt === null ? null : iso(row.endsAt);
  // Past scheduled meetings are still verified metadata. The projection owns
  // startsAt >= asOf selection; null here means unavailable, not simply past.
  if (!resource || !startsAt || (row.endsAt !== null && endsAt === null)) return null;
  return { resource, startsAt, endsAt };
}

interface OutreachRow {
  id: string;
  title: string | null;
  currentStateVersion: number;
  status: string;
  archivedAt: Date | string | null;
  specJsonb: unknown;
  specHash: string;
  hasPending: unknown;
}

async function readOutreach(
  tx: ObjectiveOperationalTx,
  actor: ObjectiveOperationalActor,
  binding: ObjectiveOperationalBinding,
  selection: ObjectiveOperationalSelection,
  observedAt: string,
): Promise<ObjectiveOperationalSourceRead | null> {
  if (!outreachEnabled()) return null;
  // Session, current spec, and pending applicability are one statement snapshot.
  // A read lock here would invert the write path's owner -> association gate.
  const rows = await tx.$queryRaw<OutreachRow[]>`
    SELECT s.id, s.title, s.current_state_version AS "currentStateVersion",
      s.status, s.archived_at AS "archivedAt", v.spec_jsonb AS "specJsonb", v.spec_hash AS "specHash",
      EXISTS (
        SELECT 1 FROM outreach_command_proposals p
        WHERE p.tenant_id = s.tenant_id AND p.session_id = s.id
          AND p.created_by_user_id = ${actor.userId}::uuid AND p.status = 'pending'
          AND p.expected_state_version = s.current_state_version
      ) AS "hasPending"
    FROM outreach_sessions s
    INNER JOIN outreach_state_versions v ON v.session_id = s.id
      AND v.tenant_id = s.tenant_id AND v.version = s.current_state_version
    WHERE s.id = ${selection.id}::uuid AND s.tenant_id = ${actor.tenantId}::uuid
      AND s.created_by_user_id = ${actor.userId}::uuid
      AND s.status = 'active' AND s.archived_at IS NULL
    LIMIT 1
  `;
  const row = rows[0];
  if (
    !row ||
    row.id.toLowerCase() !== selection.id.toLowerCase() ||
    row.status !== 'active' ||
    row.archivedAt !== null ||
    !Number.isSafeInteger(row.currentStateVersion) ||
    row.currentStateVersion < 1 ||
    typeof row.hasPending !== 'boolean'
  )
    return null;
  try {
    // Same parse, sponsor isolation, and canonical hash witness as the owner.
    const spec = parseCampaignSpecV1(row.specJsonb);
    assertOutreachContextSponsorIsolation(spec);
    if (
      hashCampaignSpecV1(spec) !== row.specHash ||
      spec.sponsor.kind !== 'client' ||
      spec.sponsor.clientRefs.length !== 1 ||
      spec.sponsor.clientRefs[0]?.clientId.toLowerCase() !== binding.clientId.toLowerCase()
    )
      return null;
  } catch {
    return null;
  }
  return {
    resource: {
      selection,
      title: row.title,
      observedAt,
      ownerVersion: { kind: 'counter', value: row.currentStateVersion },
    },
    // No canonical proposal title exists. The wire requires a nonnull title, so
    // do not invent one or turn untitled pending decisions into a verified zero.
    pendingProposals: [],
    decisionSourceUnavailable: row.hasPending,
  };
}

/** Current local owner metadata only; root has to revalidate current Core authority. */
export async function readObjectiveLocalResource(
  tx: ObjectiveOperationalTx,
  actor: ObjectiveOperationalActor,
  binding: ObjectiveOperationalBinding,
  selection: ObjectiveOperationalSelection,
  observedAt: string,
  asOf: string,
  gate?: ObjectiveLocalResourceGate,
): Promise<ObjectiveOperationalSourceRead | null> {
  if (!UUID.test(selection.id)) return null;
  if (selection.kind === 'meeting')
    return readMeeting(tx, actor, binding, selection, observedAt, asOf, gate);
  if (gate) gateUnavailable();
  if (selection.kind === 'outreach_session')
    return readOutreach(tx, actor, binding, selection, observedAt);
  if (selection.kind === 'budget_package') {
    const rows = await tx.$queryRaw<Array<{ id: string; title: string; updatedAt: Date | string }>>`
      SELECT id, name AS title, updated_at AS "updatedAt" FROM budget_package WHERE id = ${selection.id}::uuid LIMIT 1
    `;
    const row = rows[0];
    const resource =
      row && row.id.toLowerCase() === selection.id.toLowerCase()
        ? timestampResource(selection, row.title, row.updatedAt, observedAt)
        : null;
    return resource ? { resource } : null;
  }
  if (selection.kind === 'defense_budget_cycle') {
    if (!(await canReadInternalCycle(tx, actor))) return null;
    const rows = await tx.$queryRaw<Array<{ id: string; updatedAt: Date | string }>>`
      SELECT id, updated_at AS "updatedAt" FROM defense_budget_cycle
      WHERE id = ${selection.id}::uuid LIMIT 1
    `;
    const row = rows[0];
    const resource =
      row && row.id.toLowerCase() === selection.id.toLowerCase()
        ? timestampResource(selection, null, row.updatedAt, observedAt)
        : null;
    return resource ? { resource } : null;
  }
  return null;
}

/** An annotation stays a human annotation even when its optional context exists. */
export async function validateObjectiveCycleContext(
  tx: ObjectiveOperationalTx,
  actor: ObjectiveOperationalActor,
  input: Pick<OperationalCycle, 'fiscalYear' | 'authorityTrack' | 'context'>,
): Promise<boolean> {
  if (
    !Number.isInteger(input.fiscalYear) ||
    input.fiscalYear < 1 ||
    input.fiscalYear > 9999 ||
    (input.authorityTrack !== null &&
      (typeof input.authorityTrack !== 'string' ||
        Array.from(input.authorityTrack).length < 1 ||
        Array.from(input.authorityTrack).length > 600))
  )
    return false;
  if (input.context === null) return true;
  if (!UUID.test(input.context.id)) return false;
  if (input.context.kind === 'budget_package') {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM budget_package WHERE id = ${input.context.id}::uuid AND fiscal_year = ${input.fiscalYear} LIMIT 1
    `;
    return rows.some((row) => row.id.toLowerCase() === input.context!.id.toLowerCase());
  }
  if (input.context.kind !== 'defense_budget_cycle' || !(await canReadInternalCycle(tx, actor)))
    return false;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM defense_budget_cycle
    WHERE id = ${input.context.id}::uuid AND fiscal_year = ${input.fiscalYear}
      AND (${input.authorityTrack}::text IS NULL OR authority_track = ${input.authorityTrack})
    LIMIT 1
  `;
  return rows.some((row) => row.id.toLowerCase() === input.context!.id.toLowerCase());
}
