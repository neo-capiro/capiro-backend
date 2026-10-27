/**
 * Narrow internal Meri route for the two intel-api canonical watch owners. It adds
 * NO new transport, secret, base URL, scheduler or ingestion loop: it reuses the
 * existing `internal/legiwatch/meri` prefix, the existing WorkflowSourceGuard and
 * the existing service-account ctx shape, and it delegates every authorization,
 * version/CAS, preview and delivery decision to the owner services.
 *
 * Owners reached here:
 *  - LegiWatch keyword rule (KeywordRuleService / KeywordDiscoveryService /
 *    KeywordDeliveryService): rule activation and the delivery switch stay two
 *    distinct owner operations;
 *  - tracker watchlist (TrackerWatchlistService): the watchlist head read plus the
 *    acting user's own alert-preference row, which is the only lever that stops
 *    future alert events. Watchlist targeting is never rewritten from here.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { object } from '../reports/report-domain.js';
import { WorkflowSourceGuard } from '../keywords/internal-workflow.controller.js';
import { KeywordRuleService, checkedVersion } from '../keywords/keyword-rule.service.js';
import { KeywordDiscoveryService } from '../keywords/keyword-discovery.service.js';
import { KeywordDeliveryService } from '../keywords/keyword-delivery.service.js';
import { TrackerWatchlistService } from '../tracker-watchlist.service.js';

type Operation = 'subscribe' | 'pause' | 'resume' | 'unsubscribe' | 'set_delivery';
const KEYWORD_OPERATIONS: readonly Operation[] = [
  'subscribe',
  'pause',
  'resume',
  'unsubscribe',
  'set_delivery',
];
const WATCHLIST_OPERATIONS: readonly Operation[] = ['subscribe', 'pause'];

const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.length || value.length > 200)
    throw new BadRequestException(`${name.toUpperCase()}_REQUIRED`);
  return value;
};

const keywordState = (state: string): 'active' | 'paused' | 'needs_review' => {
  if (state === 'active' || state === 'paused' || state === 'needs_review') return state;
  throw new ServiceUnavailableException('WATCH_OWNER_STATE_UNSUPPORTED');
};

interface KeywordRuleRow {
  id: string;
  version: number;
  state: string;
  activation: { version?: number; fromNow?: string } | null;
  config: {
    deliveryEnabled?: boolean;
    folderIds: string[];
    recipients?: unknown;
    cadence?: string | null;
    source?: { kind?: string } | null;
  };
}

interface AlertPrefRow {
  triggers: string[];
  materiality: string;
  emailEnabled: boolean;
  emailAddress: string | null;
  emailCadence: string;
  smsEnabled: boolean;
  smsPhone: string | null;
  smsPhoneVerified: boolean;
  smsCadence: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  jurisdictions: string[];
}

@Controller('internal/legiwatch/meri')
@UseGuards(WorkflowSourceGuard)
export class WatchMeriController {
  constructor(
    readonly rules: KeywordRuleService,
    readonly discovery: KeywordDiscoveryService,
    readonly delivery: KeywordDeliveryService,
    readonly watchlists: TrackerWatchlistService,
  ) {}

  @Post('watch')
  watch(@Body() body: unknown) {
    return this.route(body);
  }

  async route(body: unknown) {
    const b = object(body),
      input = object(b.input);
    if (
      typeof b.tenantId !== 'string' ||
      typeof b.actor !== 'string' ||
      !b.actor ||
      b.actor.length > 200 ||
      !/^[0-9a-f-]{36}$/i.test(b.tenantId)
    )
      throw new BadRequestException('CANONICAL_ACTOR_SCOPE_REQUIRED');
    const ctx = { tenantId: b.tenantId, clerkUserId: b.actor, role: null };
    const inspect = b.tool === 'watch_inspect';
    if (!inspect && b.tool !== 'watch_apply') throw new BadRequestException('UNKNOWN_WATCH_TOOL');
    if (b.family === 'legiwatch_keyword')
      return inspect ? this.keywordInspect(ctx, input) : this.keywordApply(ctx, input);
    if (b.family === 'client_watchlist')
      return inspect ? this.watchlistInspect(ctx, input) : this.watchlistApply(ctx, input);
    throw new BadRequestException('UNKNOWN_WATCH_FAMILY');
  }

  private async loaded(ctx: never, input: Record<string, unknown>) {
    const ruleId = text(input.ruleId, 'rule');
    await this.rules.authorize(ctx);
    const requested = typeof input.clientId === 'string' ? input.clientId : null;
    return this.rules.reports.folders.withActor(ctx, async (tx) => {
      const rule = (await this.rules.get(tx, ctx, ruleId)) as unknown as KeywordRuleRow;
      const folderIds = rule.config.folderIds ?? [];
      const clients = new Set<string | null>();
      for (const folderId of folderIds)
        clients.add((await this.rules.folder(tx, ctx, folderId)).clientId ?? null);
      // The rule's own folders are the exact client wall; a Meri request may never
      // widen or substitute it.
      if (clients.size !== 1 || [...clients][0] !== requested)
        throw new ForbiddenException('CURRENT_CLIENT_FOLDER_SCOPE_REQUIRED');
      return { rule, folderCount: folderIds.length, clientId: requested };
    });
  }

  private keywordTarget(rule: KeywordRuleRow, clientId: string | null, folderCount: number) {
    return {
      identity: rule.id,
      state: keywordState(rule.state),
      version: rule.version,
      deliveryEnabled: rule.config.deliveryEnabled === true,
      clientId,
      facts: {
        activationVersion: rule.activation?.version ?? null,
        activationFromNow: rule.activation?.fromNow ?? null,
        sourceKind: rule.config.source?.kind ?? null,
        cadence: rule.config.cadence ?? null,
        folderCount,
      },
    };
  }

  private async keywordInspect(ctx: never, input: Record<string, unknown>) {
    const { rule, clientId, folderCount } = await this.loaded(ctx, input);
    return { version: 1, target: this.keywordTarget(rule, clientId, folderCount) };
  }

  private async keywordApply(ctx: never, input: Record<string, unknown>) {
    const operation = text(input.operation, 'operation') as Operation;
    if (!KEYWORD_OPERATIONS.includes(operation))
      throw new BadRequestException('UNSUPPORTED_WATCH_OPERATION');
    const ruleId = text(input.ruleId, 'rule');
    const { rule: before, clientId, folderCount } = await this.loaded(ctx, input);
    const expectedVersion = checkedVersion(input.expectedVersion);
    const acknowledge = (
      after: KeywordRuleRow,
      desired: { state?: string; delivery?: boolean },
    ) => ({
      version: 1,
      applied: true,
      partial: false,
      acknowledgement: {
        identity: after.id,
        state: keywordState(after.state),
        version: after.version,
        deliveryEnabled: after.config.deliveryEnabled === true,
        eventId: null,
        alreadyInState:
          (desired.state === undefined || keywordState(before.state) === desired.state) &&
          (desired.delivery === undefined ||
            (before.config.deliveryEnabled === true) === desired.delivery),
      },
      clientId,
      folderCount,
    });
    if (operation === 'pause')
      return acknowledge(
        (await this.discovery.activation(ctx, ruleId, {
          action: 'pause',
          expectedVersion,
        })) as unknown as KeywordRuleRow,
        { state: 'paused' },
      );
    if (operation === 'subscribe' || operation === 'resume')
      return acknowledge(
        (await this.discovery.activation(ctx, ruleId, {
          action: 'activate',
          expectedVersion,
          // The owner accepts activation only against its own COMPLETE current
          // preview run, from a from-now baseline.
          previewRunId: text(input.previewRunId, 'previewRunId'),
          baseline: 'from_now',
        })) as unknown as KeywordRuleRow,
        { state: 'active' },
      );
    if (operation === 'set_delivery') {
      if (typeof input.enabled !== 'boolean')
        throw new BadRequestException('EXPLICIT_DELIVERY_SWITCH_REQUIRED');
      await this.delivery.activation(ctx, ruleId, {
        enabled: input.enabled,
        expectedVersion,
        ...(typeof input.previewHash === 'string' ? { previewHash: input.previewHash } : {}),
      });
      const after = (await this.reload(ctx, ruleId)) as unknown as KeywordRuleRow;
      return acknowledge(after, { delivery: input.enabled });
    }
    // unsubscribe: the owner has no delete. Stop its future work — rule paused AND
    // the delivery switch off. A failure between the two is a PARTIAL outcome and
    // is reported as unconfirmed so the ledger can never store it as applied.
    const paused = (await this.discovery.activation(ctx, ruleId, {
      action: 'pause',
      expectedVersion,
    })) as unknown as KeywordRuleRow;
    try {
      await this.delivery.activation(ctx, ruleId, {
        enabled: false,
        expectedVersion: paused.version,
      });
    } catch {
      return { version: 1, applied: false, partial: true, acknowledgement: null };
    }
    const after = (await this.reload(ctx, ruleId)) as unknown as KeywordRuleRow;
    return acknowledge(after, { state: 'paused', delivery: false });
  }

  private async reload(ctx: never, ruleId: string) {
    return this.rules.reports.folders.withActor(ctx, (tx) => this.rules.get(tx, ctx, ruleId));
  }

  private async watchlistLoad(ctx: never, input: Record<string, unknown>) {
    const clientId = text(input.clientId, 'client');
    const tenantId = (ctx as { tenantId: string }).tenantId,
      actor = (ctx as { clerkUserId: string }).clerkUserId;
    const [view, prefs, revisions] = await Promise.all([
      this.watchlists.getWatchlist(tenantId, clientId, {}),
      this.watchlists.getAlertPrefs(tenantId, clientId, actor) as Promise<AlertPrefRow>,
      this.watchlists.getRevisions(tenantId, clientId),
    ]);
    return { clientId, tenantId, actor, view, prefs, revisions };
  }

  private async watchlistInspect(ctx: never, input: Record<string, unknown>) {
    const { clientId, view, prefs, revisions } = await this.watchlistLoad(ctx, input);
    return {
      version: 1,
      target: {
        // One watchlist per (tenant, client): the client is the owner's identity.
        identity: clientId,
        state: view.version > 0 ? 'active' : 'absent',
        version: view.version,
        deliveryEnabled: prefs.emailEnabled === true || prefs.smsEnabled === true,
        clientId,
        facts: {
          topics: view.topics.length,
          terms: view.topics.reduce((count, topic) => count + topic.terms.length, 0),
          issueAreas: view.issueAreas.length,
          jurisdictions: view.jurisdictions.length,
          revisions: revisions.length,
          emailEnabled: prefs.emailEnabled === true,
          smsEnabled: prefs.smsEnabled === true,
          smsPhoneVerified: prefs.smsPhoneVerified === true,
          quietHoursStart: prefs.quietHoursStart,
          quietHoursEnd: prefs.quietHoursEnd,
          updatedAt: view.updatedAt,
        },
      },
    };
  }

  private async watchlistApply(ctx: never, input: Record<string, unknown>) {
    const operation = text(input.operation, 'operation') as Operation;
    if (!WATCHLIST_OPERATIONS.includes(operation))
      throw new BadRequestException('UNSUPPORTED_WATCH_OPERATION');
    const { clientId, tenantId, actor, view, prefs } = await this.watchlistLoad(ctx, input);
    const expectedVersion = checkedVersion(input.expectedVersion);
    // Stale-version guard against the watchlist head the caller read. The
    // alert-preference row itself carries NO CAS token at this boundary, so this
    // read-check is NOT claimed to be atomic — that gap is reported, not faked.
    if (view.version !== expectedVersion) throw new ConflictException('WATCHLIST_CHANGED_RELOAD');
    const emailAddress =
      typeof prefs.emailAddress === 'string' && prefs.emailAddress ? prefs.emailAddress : null;
    const smsPhone =
      typeof prefs.smsPhone === 'string' && prefs.smsPhone && prefs.smsPhoneVerified === true
        ? prefs.smsPhone
        : null;
    const enabled = prefs.emailEnabled === true || prefs.smsEnabled === true;
    if (operation === 'pause')
      // Every channel off stops future events for this actor. The watchlist and
      // its topics/terms are intentionally left untouched — there is no delete.
      await this.watchlists.putAlertPrefs(tenantId, clientId, actor, {
        ...this.preserved(prefs),
        emailEnabled: false,
        smsEnabled: false,
      });
    else {
      if (!emailAddress && !smsPhone)
        throw new BadRequestException('WATCH_OWNER_DELIVERY_CHANNELS_UNCONFIGURED');
      await this.watchlists.putAlertPrefs(tenantId, clientId, actor, {
        ...this.preserved(prefs),
        emailEnabled: emailAddress !== null,
        emailAddress,
        smsEnabled: smsPhone !== null,
        smsPhone,
      });
    }
    const after = (await this.watchlists.getAlertPrefs(tenantId, clientId, actor)) as AlertPrefRow;
    return {
      version: 1,
      applied: true,
      partial: false,
      acknowledgement: {
        identity: clientId,
        state: operation === 'pause' ? 'paused' : 'active',
        version: view.version,
        deliveryEnabled: after.emailEnabled === true || after.smsEnabled === true,
        eventId: null,
        alreadyInState:
          operation === 'pause' ? enabled === false : enabled && emailAddress !== null,
      },
    };
  }

  /** Everything the user set, minus the two enable flags: putAlertPrefs defaults any omitted field. */
  private preserved(prefs: AlertPrefRow) {
    return {
      triggers: prefs.triggers,
      materiality: prefs.materiality,
      emailCadence: prefs.emailCadence,
      smsCadence: prefs.smsCadence,
      quietHoursStart: prefs.quietHoursStart,
      quietHoursEnd: prefs.quietHoursEnd,
      jurisdictions: prefs.jurisdictions,
    };
  }
}
