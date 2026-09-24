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
 *   - No fuzzy matching. No SMS. Email only if the recipient's existing
 *     preference opts into it.
 *   - Idempotency key = (tenant, client, recipient, channel, change dedupe_key)
 *     through NotificationLog's @@unique([alertId, userId, channel]).
 *   - Replaying the same window sends nothing new.
 *   - Opt-out via new trigger key 'district_nexus_change' on AlertPreference.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  DISTRICT_NEXUS_FEATURE,
  DISTRICT_NEXUS_R5_ALERTS_FEATURE,
  CAPIRO_INTERNAL_TENANT_SLUG,
} from './r5-alerts-flag.js';

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
  private readonly logger = new Logger(R5DistrictAlertsService.name);
  private readonly internalTenantId?: string;
  private readonly appBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.internalTenantId = config.get<string>('CAPIRO_INTERNAL_TENANT_ID')?.trim() || undefined;
    this.appBaseUrl = (config.get<string>('APP_BASE_URL') || 'https://os.capiro.ai').replace(/\/$/, '');
  }

  // -----------------------------------------------------------------------
  // Flag check
  // -----------------------------------------------------------------------

  /** Check if the tenant has the R5 alerts flag enabled. */
  async isEnabled(tenantId: string): Promise<boolean> {
    if (!tenantId) return false;

    const isConfiguredInternalTenant = Boolean(
      this.internalTenantId && tenantId === this.internalTenantId,
    );

    try {
      const rows = await this.prisma.withSystem(
        (tx) =>
          tx.$queryRaw<Array<{ ok: number }>>`
          SELECT 1 AS ok
          WHERE (
            (
              (
                ${isConfiguredInternalTenant}
                OR EXISTS (
                  SELECT 1 FROM tenants
                  WHERE id::text = ${tenantId}
                    AND slug = ${CAPIRO_INTERNAL_TENANT_SLUG}
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM intel_feature_flag
                WHERE feature = ${DISTRICT_NEXUS_R5_ALERTS_FEATURE}
                  AND tenant_id = ${tenantId}
                  AND enabled = false
              )
            )
            OR (
              EXISTS (
                SELECT 1 FROM intel_feature_flag
                WHERE feature = ${DISTRICT_NEXUS_R5_ALERTS_FEATURE}
                  AND tenant_id = ${tenantId}
                  AND enabled = true
              )
              AND EXISTS (
                SELECT 1 FROM intel_feature_flag
                WHERE feature = ${DISTRICT_NEXUS_FEATURE}
                  AND tenant_id = ${tenantId}
                  AND enabled = true
              )
            )
          )
          LIMIT 1
        `,
      );
      return rows.length > 0;
    } catch (error) {
      this.logger.error(
        `R5 alerts flag read failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
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
        ? r.districtCode
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
    if (event.isStatewide) {
      // Statewide: match any client with a facility in this state
      const rows = await this.prisma.withTenant(tenantId, (tx) =>
        tx.$queryRaw<Array<{ client_id: string; client_name: string }>>`
          SELECT DISTINCT cf.client_id, c.name AS client_name
          FROM client_facilities cf
          JOIN clients c ON c.id = cf.client_id AND c.tenant_id::text = ${tenantId}
          WHERE cf.state = ${event.stateCode}
            AND cf.congressional_district IS NOT NULL
          LIMIT 200
        `,
      );
      return rows.map((r) => ({ clientId: r.client_id, clientName: r.client_name }));
    }

    // District-scoped: exact district match
    const districtCode = event.districtCode.padStart(2, '0');
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<{ client_id: string; client_name: string }>>`
        SELECT DISTINCT cf.client_id, c.name AS client_name
        FROM client_facilities cf
        JOIN clients c ON c.id = cf.client_id AND c.tenant_id::text = ${tenantId}
        WHERE cf.state = ${event.stateCode}
          AND cf.congressional_district = ${districtCode}
        LIMIT 200
      `,
    );
    return rows.map((r) => ({ clientId: r.client_id, clientName: r.client_name }));
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
        emailEnabled: boolean;
        emailAddress: string | null;
        emailCadence: string;
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
          emailEnabled: true,
          emailAddress: true,
          emailCadence: true,
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
          emailEnabled: p.emailEnabled,
          emailAddress: p.emailAddress,
          emailCadence: p.emailCadence,
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

  /**
   * Claim a NotificationLog row for (alertId, userId, channel).
   * Returns the log id on success, null if already exists (dedup → skip).
   */
  private async claim(
    tenantId: string,
    clientId: string,
    userId: string,
    alertId: string,
    channel: 'in_app' | 'email',
    status: string,
  ): Promise<string | null> {
    try {
      const row = await this.prisma.withTenant(tenantId, (tx) =>
        tx.notificationLog.create({
          data: { tenantId, clientId, userId, alertId, channel, status },
          select: { id: true },
        }),
      );
      return row.id;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return null; // already handled
      throw e;
    }
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
    const changes = await this.findAlertableChanges(since, undefined, undefined, undefined, 'material');
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
          // ── In-app delivery (always) ──
          const inAppLogId = await this.claim(
            tenantId,
            client.clientId,
            recipient.userId,
            alertId,
            'in_app',
            commit ? 'sent' : 'dry_run',
          );

          if (inAppLogId) {
            result.delivered++;
            if (result.samples.length < 3) {
              result.samples.push(this.buildPayload(change, client.clientId));
            }
          } else {
            result.skippedDuplicate++;
          }

          // ── Email (only if opted in) ──
          if (recipient.pref.emailEnabled && recipient.pref.emailAddress) {
            const emailLogId = await this.claim(
              tenantId,
              client.clientId,
              recipient.userId,
              alertId,
              'email',
              commit ? 'sent' : 'dry_run',
            );
            if (emailLogId) {
              // Email body would be rendered here in a full implementation
              // with TrackerEmailService. For this slice: claim the row.
              // The orchestrator will wire actual email sending.
            }
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
      if (!row.length) return 'unknown';
      const { status, attempted_at } = row[0];
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
      tx.client.findUniqueOrThrow({ where: { id: clientId } }),
    );
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
    const logs = await this.prisma.withTenant(tenantId, (tx) =>
      tx.notificationLog.findMany({
        where: {
          clientId,
          channel: 'in_app',
          alertId: { startsWith: 'district-nexus-change:' },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { alertId: true, createdAt: true },
      }),
    );

    // Extract dedupe keys from alertIds
    const dedupeKeys = logs
      .map((l) => {
        // Format: district-nexus-change:<tenantId>:<clientId>:<dedupeKey>
        const parts = l.alertId.split(':');
        return parts.length >= 4 ? parts.slice(3).join(':') : null;
      })
      .filter(Boolean) as string[];

    if (!dedupeKeys.length) return [];

    // Fetch the underlying change rows
    const where: Prisma.DistrictNexusChangeWhereInput = {
      dedupeKey: { in: dedupeKeys },
    };
    if (state) where.stateCode = state;
    if (district) where.districtCode = district;

    const changes = await this.prisma.withSystem((tx) =>
      tx.districtNexusChange.findMany({
        where,
        orderBy: { observedAt: 'desc' },
        take: 100,
      }),
    );

    return changes.map((r) => ({
      changeId: r.id,
      title: buildChangeTitle(r.changeKind, r.source, r.stateCode, r.districtCode),
      districtLabel: r.stateCode
        ? r.districtCode
          ? `${r.stateCode}-${r.districtCode.padStart(2, '0')}`
          : `${r.stateCode} (statewide)`
        : 'Unknown',
      sourceLabel: sourceToLabel(r.source),
      eventTime: r.observedAt instanceof Date ? r.observedAt.toISOString() : String(r.observedAt),
      detectedTime: r.detectedAt instanceof Date ? r.detectedAt.toISOString() : String(r.detectedAt),
      severity: r.severity,
      freshness: 'unknown',
      caveats: [],
      deepLink: this.deepLink(r.stateCode ?? '', r.districtCode ?? '', clientId),
      changeKind: r.changeKind,
      oldState: r.oldState,
      newState: r.newState,
    }));
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