/**
 * District Nexus R5 — Proactive district alerts service.
 *
 * Queries district_nexus_change for alertable events (observationKind='change',
 * severity >= material|notable per preference), computes client/district
 * relevance via the verified footprint, and delivers in_app notifications
 * through the existing NotificationLog/AlertPreference system.
 *
 * Design rules:
 *   - Baseline rows (observationKind='baseline') are never alertable.
 *   - An event is relevant to (tenant, client) only when the event's
 *     state/district is in that client's VERIFIED District Nexus footprint.
 *   - Statewide events match any footprint district in that state.
 *   - No fuzzy matching. In-app only; no SMS or email.
 *   - Idempotency key = (tenant, client, recipient, channel, change dedupe_key)
 *     through NotificationLog's @@unique([alertId, userId, channel]).
 *   - Replaying the same window sends nothing new.
 *   - Opt-out via new trigger key 'district_nexus_change' on AlertPreference.
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { isR5FeatureEnabled, DISTRCT_NEXUS_R5_ALERTS } from './r5-flag.guard.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DistrictAlertEvent {
  /** district_nexus_change.id */
  changeId: string;
  dedupeKey: string;
  changeKind: string;
  source: string;
  sourceLabel: string;
  sourceRecordId: string;
  stateCode: string;
  districtCode: string;
  severity: string;
  /** Whether this is statewide (districtCode is null/empty or '00' with no sub-state scope) */
  isStatewide: boolean;
  oldState: string | null;
  newState: string | null;
  observedAt: Date;
  detectedAt: Date;
  sourceYear: number | null;
  observationKind: string;
  /** Human-readable title */
  title: string;
  /** The district label (e.g. "TX-23") */
  districtLabel: string;
  /** Source freshness: was the source run successful/stale/failed/unknown */
  sourceFreshness: 'fresh' | 'stale' | 'failed' | 'unknown';
}

export interface DistrictAlertPayload {
  changeId: string;
  title: string;
  districtLabel: string;
  sourceLabel: string;
  eventTime: string | null;
  detectedTime: string;
  severity: string;
  freshness: string;
  caveats: string[];
  deepLink: string;
  changeKind: string;
  oldState: string | null;
  newState: string | null;
}

export interface EmitResult {
  tenant: string;
  tenantId: string;
  enabled: boolean;
  eventsConsidered: number;
  recipientsConsidered: number;
  delivered: number;
  skippedDuplicate: number;
  skippedPreference: number;
  samples: DistrictAlertPayload[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class R5DistrictAlertsService {

  private readonly appBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {

    this.appBaseUrl = (config.get<string>('APP_BASE_URL') || 'https://os.capiro.ai').replace(/\/$/, '');
  }

  // -----------------------------------------------------------------------
  // Flag check
  // -----------------------------------------------------------------------

  /** Check if the tenant has the R5 alerts flag enabled. */
  async isEnabled(tenantId: string): Promise<boolean> {
    return isR5FeatureEnabled(this.prisma, tenantId, DISTRCT_NEXUS_R5_ALERTS);
  }

  // -----------------------------------------------------------------------
  // Material event detection
  // -----------------------------------------------------------------------

  /**
   * Alertable events: DistrictNexusChange rows with observationKind='change'
   * and severity 'material' (always) or 'notable' (only when the recipient
   * has opted in via preference). Baseline rows are never alertable.
   * `info` severity rows are never alertable.
   */
  async findAlertableChanges(
    since: Date,
    tenantId?: string,
    stateCode?: string,
    districtCode?: string,
    minSeverity: 'material' | 'notable' = 'material',
  ): Promise<DistrictAlertEvent[]> {
    const where: Prisma.DistrictNexusChangeWhereInput = {
      observationKind: 'change',
      severity: minSeverity === 'notable' ? { in: ['material', 'notable'] } : 'material',
      observedAt: { gte: since },
    };
    if (stateCode) where.stateCode = stateCode;
    if (districtCode) where.districtCode = districtCode;

    const rows = await this.prisma.withSystem((tx) =>
      tx.districtNexusChange.findMany({
        where,
        orderBy: { observedAt: 'desc' },
        take: 500,
      }),
    );

    return rows.map((r) => ({
      changeId: r.id,
      dedupeKey: r.dedupeKey,
      changeKind: r.changeKind,
      source: r.source,
      sourceLabel: sourceToLabel(r.source),
      sourceRecordId: r.sourceRecordId,
      stateCode: r.stateCode ?? '',
      districtCode: r.districtCode ?? '',
      severity: r.severity,
      isStatewide: !r.districtCode || r.districtCode === '00',
      oldState: r.oldState,
      newState: r.newState,
      observedAt: r.observedAt,
      detectedAt: r.detectedAt,
      sourceYear: r.sourceYear,
      observationKind: r.observationKind,
      title: buildChangeTitle(r.changeKind, r.source, r.stateCode, r.districtCode),
      districtLabel: r.stateCode
        ? r.districtCode && r.districtCode !== '00'
          ? `${r.stateCode}-${r.districtCode.padStart(2, '0')}`
          : `${r.stateCode} (statewide)`
        : 'Unknown',
      sourceFreshness: 'unknown',
    }));
  }

  // -----------------------------------------------------------------------
  // Client/district relevance
  // -----------------------------------------------------------------------

  /**
   * An event is relevant to (tenant, client) only when the event's
   * state/district is in that client's VERIFIED District Nexus footprint.
   * Statewide events match any footprint district in that state.
   */
  async findRelevantClients(
    tenantId: string,
    event: DistrictAlertEvent,
  ): Promise<Array<{ clientId: string; clientName: string }>> {
    if (!/^[A-Z]{2}$/.test(event.stateCode)) return [];
    // DN aggregate uses these facility trust fields. Only matched Census
    // geocodes with geocoded districts establish verified alert relevance.
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientFacility.findMany({
        where: {
          tenantId,
          state: event.stateCode,
          geocodeStatus: 'matched',
          districtSource: 'geocoded',
          congressionalDistrict: event.isStatewide
            ? { not: null }
            : event.districtCode.padStart(2, '0'),
          client: { status: { not: 'archived' }, profileStatus: 'ACTIVE' },
        },
        select: { clientId: true, client: { select: { name: true } } },
      }),
    );
    return [...new Map(rows.map((r) => [r.clientId, {
      clientId: r.clientId, clientName: r.client.name,
    }])).values()];
  }

  // -----------------------------------------------------------------------
  // Recipients via AlertPreference
  // -----------------------------------------------------------------------

  /**
   * Find users who should receive alerts for this client. Reuses the existing
   * AlertPreference model. Only returns users whose triggers array includes
   * 'district_nexus_change'.
   */
  async findRecipients(
    tenantId: string,
    clientId: string,
    event: DistrictAlertEvent,
  ): Promise<
    Array<{
      userId: string;
      pref: {
        id: string;
        triggers: string[];
        materiality: string;

      };
    }>
  > {
    const prefs = await this.prisma.withTenant(tenantId, (tx) =>
      tx.alertPreference.findMany({
        where: { clientId },
        select: {
          id: true,
          userId: true,
          triggers: true,
          materiality: true,

        },
      }),
    );

    return prefs
      .filter((p) => p.triggers.includes('district_nexus_change'))
      .filter((p) => {
        // Materiality gate: notable events only for users with low materiality
        if (event.severity === 'material') return true;
        if (event.severity === 'notable' && p.materiality === 'low') return true;
        return false;
      })
      .map((p) => ({
        userId: p.userId,
        pref: {
          id: p.id,
          triggers: p.triggers,
          materiality: p.materiality,

        },
      }));
  }

  // -----------------------------------------------------------------------
  // Delivery
  // -----------------------------------------------------------------------

  /**
   * Idempotency key for NotificationLog.
   * Format: district-nexus-change:<tenantId>:<clientId>:<changeDedupeKey>
   */
  static alertId(tenantId: string, clientId: string, changeDedupeKey: string): string {
    return `district-nexus-change:${tenantId}:${clientId}:${changeDedupeKey}`;
  }

  /** Persist the in-app event and mark sent in the same tenant transaction. */
  private async deliver(
    tenantId: string,
    clientId: string,
    userId: string,
    alertId: string,
    event: DistrictAlertEvent,
    payload: DistrictAlertPayload,
  ): Promise<boolean> {
    const key = { alertId_userId_channel: { alertId, userId, channel: 'in_app' } };
    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const prior = await tx.notificationLog.findUnique({ where: key });
        if (prior && prior.status !== 'failed') return false;
        if (prior) {
          const claimed = await tx.notificationLog.updateMany({
            where: { id: prior.id, tenantId, clientId, status: 'failed' },
            data: { status: 'queued', error: null },
          });
          if (!claimed.count) return false;
        }
        const row = prior ?? await tx.notificationLog.create({
          data: { tenantId, clientId, userId, alertId, channel: 'in_app', status: 'queued' },
        });
        await tx.$executeRaw`
          INSERT INTO district_nexus_alert_payload
            (notification_log_id, tenant_id, client_id, state_code, district_code, payload)
          VALUES (${row.id}::uuid, ${tenantId}::uuid, ${clientId}::uuid,
                  ${event.stateCode}, ${event.districtCode || null}, ${JSON.stringify(payload)}::jsonb)
          ON CONFLICT (notification_log_id) DO UPDATE SET payload = EXCLUDED.payload
        `;
        await tx.notificationLog.update({ where: { id: row.id }, data: { status: 'sent' } });
        return true;
      });
    } catch (error) {
      // A rollback leaves no sent row. A failed row is retryable next run.
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.withTenant(tenantId, async (tx) => {
        const prior = await tx.notificationLog.findUnique({ where: key });
        if (prior) {
          if (prior.status !== 'sent') await tx.notificationLog.updateMany({
            where: { id: prior.id, tenantId, clientId, status: { not: 'sent' } },
            data: { status: 'failed', error: message.slice(0, 1000) },
          });
        } else {
          try {
            await tx.notificationLog.create({
              data: { tenantId, clientId, userId, alertId, channel: 'in_app', status: 'failed', error: message.slice(0, 1000) },
            });
          } catch (claimError) {
            if ((claimError as { code?: string }).code !== 'P2002') throw claimError;
          }
        }
      });
      return false;
    }
  }

  private async alreadySent(tenantId: string, userId: string, alertId: string): Promise<boolean> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.notificationLog.findUnique({
        where: { alertId_userId_channel: { alertId, userId, channel: 'in_app' } },
        select: { status: true },
      }),
    );
    return row !== null && row.status !== 'failed';
  }

  /** Deep link to the District Nexus drawer for this district+client. */
  deepLink(stateCode: string, districtCode: string, clientId: string): string {
    const districtKey = `${stateCode}-${districtCode.padStart(2, '0')}`;
    return `${this.appBaseUrl}/intelligence/district-nexus?district=${encodeURIComponent(districtKey)}&clientId=${encodeURIComponent(clientId)}`;
  }

  /** Build the payload for one alert. */
  buildPayload(
    event: DistrictAlertEvent,
    clientId: string,
  ): DistrictAlertPayload {
    const observedAt = event.observedAt instanceof Date ? event.observedAt : new Date(event.observedAt);
    const detectedAt = event.detectedAt instanceof Date ? event.detectedAt : new Date(event.detectedAt);

    const caveats: string[] = [];
    if (event.sourceFreshness === 'stale') caveats.push('Stale source — data may be outdated');
    if (event.sourceFreshness === 'failed') caveats.push('Source sync failed — data may be incomplete');
    if (event.sourceFreshness === 'unknown') caveats.push('Source freshness unknown');

    // Delayed detection: when detectedAt ≫ observedAt by more than 48h
    const detectionLagMs = detectedAt.getTime() - observedAt.getTime();
    if (detectionLagMs > 48 * 60 * 60 * 1000) {
      caveats.push('Delayed detection — change detected well after event time');
    }

    return {
      changeId: event.changeId,
      title: event.title,
      districtLabel: event.districtLabel,
      sourceLabel: event.sourceLabel,
      eventTime: observedAt.toISOString(),
      detectedTime: detectedAt.toISOString(),
      severity: event.severity,
      freshness: event.sourceFreshness,
      caveats,
      deepLink: this.deepLink(event.stateCode, event.districtCode, clientId),
      changeKind: event.changeKind,
      oldState: event.oldState,
      newState: event.newState,
    };
  }

  /**
   * Emit alerts for ONE tenant. Returns counts and sample payloads.
   * This is the core fan-out: find changes → find relevant clients →
   * find recipients → claim + deliver in_app.
   */
  async emitForTenant(
    tenantId: string,
    tenantSlug: string,
    since: Date,
    commit: boolean,
  ): Promise<EmitResult> {
    const result: EmitResult = {
      tenant: tenantSlug,
      tenantId,
      enabled: false,
      eventsConsidered: 0,
      recipientsConsidered: 0,
      delivered: 0,
      skippedDuplicate: 0,
      skippedPreference: 0,
      samples: [],
    };

    const enabled = await this.isEnabled(tenantId);
    result.enabled = enabled;
    if (!enabled) return result;

    // Find changes since the window — material only, notable on opt-in
    const changes = await this.findAlertableChanges(since, undefined, undefined, undefined, 'notable');
    result.eventsConsidered = changes.length;

    for (const change of changes) {
      // Enrich source freshness
      change.sourceFreshness = await this.getSourceFreshness(change.source);

      // Find relevant clients
      const clients = await this.findRelevantClients(tenantId, change);

      for (const client of clients) {
        // Find recipients
        const recipients = await this.findRecipients(tenantId, client.clientId, change);
        result.recipientsConsidered += recipients.length;

        if (recipients.length === 0) {
          result.skippedPreference++;
          continue;
        }

        const alertId = R5DistrictAlertsService.alertId(
          tenantId,
          client.clientId,
          change.dedupeKey,
        );

        for (const recipient of recipients) {
          const payload = this.buildPayload(change, client.clientId);
          // Dry-run performs only reads; a failed row is eligible for one retry.
          const sent = commit
            ? await this.deliver(tenantId, client.clientId, recipient.userId, alertId, change, payload)
            : !await this.alreadySent(tenantId, recipient.userId, alertId);
          if (sent) {
            result.delivered++;
            if (result.samples.length < 3) {
              result.samples.push(payload);
            }
          } else {
            result.skippedDuplicate++;
          }
        }
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Source freshness
  // -----------------------------------------------------------------------

  /** Determine source freshness by checking the latest source run. */
  async getSourceFreshness(
    source: string,
  ): Promise<'fresh' | 'stale' | 'failed' | 'unknown'> {
    try {
      const row = await this.prisma.withSystem((tx) =>
        tx.$queryRawUnsafe<Array<{ status: string; attempted_at: string }>>(
          `SELECT status, attempted_at::text FROM district_economic_source_run WHERE source = $1 ORDER BY attempted_at DESC LIMIT 1`,
          source,
        ),
      );
      const latest = row[0];
      if (!latest) return 'unknown';
      const { status, attempted_at } = latest;
      if (status === 'failed') return 'failed';
      // Stale: last run > 7 days ago
      const ageMs = Date.now() - new Date(attempted_at).getTime();
      if (ageMs > 7 * 24 * 60 * 60 * 1000) return 'stale';
      return 'fresh';
    } catch {
      return 'unknown';
    }
  }

  // -----------------------------------------------------------------------
  // Client access verification
  // -----------------------------------------------------------------------

  /** Verify a client belongs to the given tenant (throws if not found). */
  async verifyClientAccess(tenantId: string, clientId: string): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirstOrThrow({
        where: { id: clientId, tenantId, status: { not: 'archived' }, profileStatus: 'ACTIVE' },
      }),
    );
  }

  /** Mutate only the DN trigger for the authenticated user and client. */
  async setPreference(tenantId: string, clientId: string, userId: string, enabled: boolean): Promise<boolean> {
    await this.verifyClientAccess(tenantId, clientId);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const key = { userId_clientId: { userId, clientId } };
      const existing = await tx.alertPreference.findUnique({ where: key });
      const triggers = existing?.triggers.filter((trigger) => trigger !== 'district_nexus_change') ?? [];
      if (enabled) triggers.push('district_nexus_change');
      await tx.alertPreference.upsert({
        where: key,
        create: { tenantId, clientId, userId, triggers },
        update: { triggers },
      });
      return enabled;
    });
  }

  async getPreference(tenantId: string, clientId: string, userId: string): Promise<boolean> {
    await this.verifyClientAccess(tenantId, clientId);
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.alertPreference.findUnique({ where: { userId_clientId: { userId, clientId } }, select: { triggers: true } }),
    );
    return row?.triggers.includes('district_nexus_change') ?? false;
  }

  // -----------------------------------------------------------------------
  // API: List alerts for a client
  // -----------------------------------------------------------------------

  /**
   * List recent alerts for a client, optionally filtered by state/district.
   * Reads NotificationLog rows with alertId prefix + in_app channel.
   */
  async listClientAlerts(
    tenantId: string,
    clientId: string,
    state?: string,
    district?: string,
  ): Promise<DistrictAlertPayload[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<
      Array<{ payload: DistrictAlertPayload; change_id: string | null }>
    >`
      SELECT p.payload, c.id::text AS change_id
      FROM district_nexus_alert_payload p
      JOIN notification_log n ON n.id = p.notification_log_id
      LEFT JOIN district_nexus_change c ON c.id::text = p.payload->>'changeId'
      WHERE p.tenant_id = ${tenantId}::uuid AND p.client_id = ${clientId}::uuid
        AND n.tenant_id = ${tenantId}::uuid AND n.client_id = ${clientId}::uuid
        AND n.channel = 'in_app' AND n.status = 'sent'
        AND n.alert_id LIKE 'district-nexus-change:%'
        AND (${state ?? null}::text IS NULL OR p.state_code = ${state ?? null})
        AND (${district ?? null}::text IS NULL OR p.district_code = ${district ?? null})
      ORDER BY n.created_at DESC LIMIT 100
    `);
    // Never re-derive an event from a mutable dedupe key. Preserve the snapshot,
    // or explicitly label a deleted ledger event as unavailable.
    return rows.map((r) => r.change_id ? r.payload : {
      ...r.payload,
      title: 'Event no longer available',
      caveats: [...r.payload.caveats, 'Event no longer available in the change ledger'],
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sourceToLabel(source: string): string {
  const labels: Record<string, string> = {
    gsa: 'GSA FRPP',
    cpf_cds: 'CPF/CDS',
    sector: 'Economic',
  };
  return labels[source] ?? source;
}

function buildChangeTitle(
  changeKind: string,
  source: string,
  stateCode: string | null,
  districtCode: string | null,
): string {
  const district = stateCode
    ? districtCode
      ? `${stateCode}-${districtCode.padStart(2, '0')}`
      : stateCode
    : 'Unknown district';
  const src = sourceToLabel(source);
  const kind = changeKind.replace(/_/g, ' ');
  return `${src} ${kind} — ${district}`;
}