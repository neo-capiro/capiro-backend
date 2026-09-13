import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import type { Prisma, LegiWatchDelivery } from '../../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import {
  KeywordRuleService,
  KEYWORD_DELIVERY_FEATURE,
  checkedVersion,
} from './keyword-rule.service.js';
import type { KeywordRule } from './keyword-domain.js';
import { queryReadiness } from './keyword-domain.js';
import { digest, object, json, escapeHtml } from '../reports/report-domain.js';
import { localTime, localOccurrence } from '../reports/report-schedule.js';
import { isWithinQuietHours } from '../../intel-alert/intel-alert.types.js';

@Injectable()
export class KeywordDeliveryService {
  constructor(readonly rules: KeywordRuleService) {}
  async history(ctx: WorkspaceTenantContext, id: string) {
    await this.rules.authorize(ctx);
    return this.rules.reports.folders.withActor(ctx, async (tx) => {
      const rule = await this.rules.get(tx, ctx, id);
      for (const folderId of rule.config.folderIds) await this.rules.folder(tx, ctx, folderId);
      const deliveries = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT d.id FROM intel_legiwatch_delivery d
        WHERE d.tenant_id=${ctx.tenantId} AND d.owner_clerk_id=${ctx.clerkUserId} AND d.kind='bill_keyword'
        AND EXISTS(SELECT 1 FROM intel_legiwatch_keyword_delivery_reference r
          WHERE r.tenant_id=d.tenant_id AND r.owner_clerk_id=d.owner_clerk_id AND r.rule_id=${id}
          AND (r.intent_key=d.intent_key OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(d.composition->'records','[]'::jsonb)) item WHERE item->>'eventKey'=r.intent_key)))
        ORDER BY d.approved_at DESC,d.id DESC LIMIT 100`;
      const controls = await tx.$queryRaw<
        Array<{ id: string; created_at: Date; payload: unknown }>
      >`SELECT id,created_at,payload FROM intel_legiwatch_keyword_control_history
        WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND rule_id=${id} ORDER BY created_at DESC,id DESC LIMIT 100`;
      return {
        limit: 100,
        controls,
        deliveries: await tx.legiWatchDelivery.findMany({
          where: {
            tenantId: ctx.tenantId,
            id: { in: deliveries.map((d) => d.id) },
            ownerClerkId: ctx.clerkUserId,
          },
          include: { recipients: true },
          orderBy: { approvedAt: 'desc' },
        }),
      };
    });
  }
  async readiness(ctx: WorkspaceTenantContext, id: string) {
    await this.rules.authorize(ctx);
    return this.rules.reports.folders.withActor(ctx, async (tx) => {
      const rule = await this.rules.get(tx, ctx, id),
        issues = queryReadiness(rule.config);
      if (rule.state !== 'active' || rule.activation?.version !== rule.version)
        issues.push('CURRENT_RULE_ACTIVATION_REQUIRED');
      if (rule.config.source?.recipientMapping !== 'reviewed' && rule.config.source)
        issues.push('IMPORTED_RECIPIENT_MAPPING_REQUIRED');
      if (!(rule.config.recipients ?? []).some((r) => r.email || r.inApp))
        issues.push('NO_STAFF_CHANNEL_SELECTED');
      for (const r of rule.config.recipients ?? [])
        try {
          await this.recipient(tx, ctx, rule, r.userId, r.email ? 'email' : 'in_app');
        } catch {
          issues.push('CURRENT_STAFF_PREFERENCES_REQUIRED');
        }
      return {
        ruleId: id,
        version: rule.version,
        issues: [...new Set(issues)],
        previewHash: digest([
          rule.id,
          rule.version,
          rule.config.recipients,
          rule.config.cadence,
          rule.config.timezone,
          rule.config.localMinutes,
          rule.activation,
        ]),
        recipientCount: rule.config.recipients?.length ?? 0,
      };
    });
  }
  async activation(ctx: WorkspaceTenantContext, id: string, input: unknown) {
    await this.rules.authorize(ctx);
    const b = object(input);
    if (typeof b.enabled !== 'boolean')
      throw new BadRequestException('EXPLICIT_CHANNEL_ACTIVATION_REQUIRED');
    const ready = b.enabled ? await this.readiness(ctx, id) : null;
    if (ready && (ready.issues.length || b.previewHash !== ready.previewHash))
      throw new ConflictException({
        message: 'KEYWORD_DELIVERY_REVIEW_REQUIRED',
        issues: ready.issues,
      });
    return this.rules.reports.folders.withActor(ctx, async (tx) => {
      const row = await this.rules.get(tx, ctx, id, true);
      if (row.version !== checkedVersion(b.expectedVersion))
        throw new ConflictException('RULE_CHANGED_RELOAD');
      if (
        b.enabled &&
        (row.state !== 'active' ||
          row.activation?.version !== row.version ||
          ready?.previewHash !==
            digest([
              row.id,
              row.version,
              row.config.recipients,
              row.config.cadence,
              row.config.timezone,
              row.config.localMinutes,
              row.activation,
            ]))
      )
        throw new ConflictException('KEYWORD_DELIVERY_REVIEW_REQUIRED');
      await tx.$executeRaw`UPDATE intel_legiwatch_keyword_rule SET config=jsonb_set(config,'{deliveryEnabled}',${JSON.stringify(b.enabled)}::jsonb),updated_at=now()
    WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id}`;
      return { id, enabled: b.enabled };
    });
  }
  private async recipient(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    rule: KeywordRule,
    userId: string,
    channel: string,
    email?: string,
  ) {
    const selected = rule.config.recipients?.find((r) => r.userId === userId);
    const members = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT u.id FROM users u JOIN tenant_memberships m ON m.user_id=u.id WHERE m.tenant_id=${ctx.tenantId}::uuid AND u.clerk_user_id=${userId} AND m.status::text='active' FOR SHARE OF m`;
    if (!members.length) throw new ForbiddenException('ACTIVE_RECIPIENT_REQUIRED');
    if (
      !selected ||
      !['email', 'in_app'].includes(channel) ||
      (channel === 'email' ? !selected.email : !selected.inApp)
    )
      throw new ForbiddenException('CURRENT_STAFF_SUBSCRIPTION_REQUIRED');
    const dest = await this.rules.reports.folders.source.staffDestination(ctx.tenantId, userId);
    if (
      !dest ||
      (channel === 'email' &&
        (!dest.email || (email && email.toLowerCase() !== dest.email.toLowerCase())))
    )
      throw new ConflictException('STAFF_DESTINATION_CHANGED');
    for (const id of rule.config.folderIds) {
      const f = await this.rules.folder(tx, ctx, id);
      // Folder links and client associations must also be visible to the recipient.
      await this.rules.folder(tx, { ...ctx, clerkUserId: userId, role: null }, id);
      if (
        f.archived ||
        !f.ownerClerkId ||
        !(await this.rules.reports.folders.source.activeMember(ctx.tenantId, f.ownerClerkId, tx))
      )
        throw new ConflictException('FOLDER_OWNER_CHANGED');
      if (channel === 'email' && f.clientId) {
        const pref = await tx.intelAlertPreference.findFirst({
          where: { tenantId: ctx.tenantId, clientId: f.clientId, userId },
        });
        if (
          !pref?.emailEnabled ||
          pref.emailAddress?.toLowerCase() !== dest.email?.toLowerCase() ||
          pref.emailCadence !== (rule.config.cadence === 'realtime' ? 'realtime' : 'daily') ||
          (pref.jurisdictions.length &&
            !pref.jurisdictions.includes(rule.config.scope.jurisdiction))
        )
          throw new ForbiddenException('CURRENT_CLIENT_EMAIL_PREFERENCE_REQUIRED');
        if (isWithinQuietHours(pref.quietHoursStart, pref.quietHoursEnd))
          throw new ConflictException('STAFF_QUIET_HOURS');
      }
    }
    return dest;
  }
  async checkDispatch(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    delivery: LegiWatchDelivery,
    recipient: Record<string, unknown>,
    channel: string,
  ) {
    const gates = await tx.$queryRaw<
      Array<{ enabled: boolean }>
    >`SELECT enabled FROM intel_feature_flag WHERE tenant_id=${ctx.tenantId} AND feature=${KEYWORD_DELIVERY_FEATURE} AND enabled FOR SHARE`;
    if (process.env.LEGIWATCH_KEYWORD_DELIVERY_ENABLED !== 'true' || !gates.length)
      throw new ForbiddenException('KEYWORD_DELIVERY_PAUSED');
    if (!(await this.rules.reports.folders.source.activeMember(ctx.tenantId, ctx.clerkUserId, tx)))
      throw new ForbiddenException('ACTIVE_OWNER_REQUIRED');
    const packet = object(delivery.composition);
    if (Array.isArray(packet.records)) {
      if (!packet.records.length || packet.records.length > 50)
        throw new BadRequestException('INVALID_KEYWORD_DIGEST');
      for (const record of packet.records)
        await this.checkDispatch(
          tx,
          ctx,
          { ...delivery, composition: json(record) },
          recipient,
          channel,
        );
      return;
    }
    const refs = Array.isArray(packet.ruleRefs) ? packet.ruleRefs.map(object) : [];
    const retained = await tx.$queryRaw<
      Array<Record<string, unknown>>
    >`SELECT rule_id AS id,rule_version AS version,suggestion_id AS "suggestionId"
      FROM intel_legiwatch_keyword_delivery_reference WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND intent_key=${String(packet.eventKey)}`;
    refs.push(...retained);
    if (!refs.length) throw new BadRequestException('KEYWORD_REFERENCE_REQUIRED');
    let eligible = false;
    let quiet = false;
    for (const ref of refs) {
      try {
        const rule = await this.rules.get(tx, ctx, String(ref.id), true);
        if (
          rule.state !== 'active' ||
          rule.version !== ref.version ||
          !rule.config.deliveryEnabled ||
          rule.activation?.version !== rule.version ||
          queryReadiness(rule.config).length
        )
          continue;
        await this.recipient(
          tx,
          ctx,
          rule,
          String(recipient.userId),
          channel,
          typeof recipient.email === 'string' ? recipient.email : undefined,
        );
        const [s] = await tx.$queryRaw<
          Array<{
            payload: Record<string, unknown>;
            state: string;
            rule_version: number;
            folder_id: string;
            bill_id: string;
            created_at: Date;
          }>
        >`SELECT payload,state,rule_version,folder_id,bill_id,created_at FROM intel_legiwatch_suggestion
     WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${String(ref.suggestionId)}`;
        if (
          !s ||
          s.rule_version !== rule.version ||
          s.bill_id !== packet.billId ||
          s.created_at <= new Date(rule.activation.fromNow) ||
          s.payload.origin !== 'deterministic' ||
          !['pending', 'added', 'already_present'].includes(s.state) ||
          !object(s.payload.coverage).complete
        )
          continue;
        const f = await this.rules.folder(tx, ctx, s.folder_id, true);
        if (f.version !== s.payload.folderVersion || !rule.config.folderIds.includes(f.id))
          continue;
        const excluded = await tx.$queryRaw<Array<{ blocked: boolean }>>`SELECT (
     EXISTS(SELECT 1 FROM intel_legiwatch_membership_state WHERE tenant_id=${ctx.tenantId} AND folder_id=${f.id} AND bill_id=${s.bill_id} AND suppressed)
     OR EXISTS(SELECT 1 FROM intel_legiwatch_rule_exclusion WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND rule_id=${rule.id} AND folder_id=${f.id} AND bill_id=${s.bill_id} AND excluded)) AS blocked`;
        if (excluded[0]?.blocked) continue;
        const source = await this.rules.sources.lockBill(tx, rule.config.scope, s.bill_id);
        if (
          !source ||
          source.fingerprint !== s.payload.sourceFingerprint ||
          !source.coverage.complete
        )
          continue;
        eligible = true;
      } catch (error) {
        if (error instanceof Error && error.message === 'STAFF_QUIET_HOURS') quiet = true;
        continue;
      }
    }
    if (!eligible)
      throw new ConflictException(
        quiet ? 'STAFF_QUIET_HOURS' : 'KEYWORD_SOURCE_RULE_OR_SUBSCRIPTION_CHANGED',
      );
  }
  async enqueue(tenantId: string, now = new Date()) {
    if (
      process.env.LEGIWATCH_KEYWORD_DELIVERY_ENABLED !== 'true' ||
      !(await this.rules.reports.flags.isEnabled(KEYWORD_DELIVERY_FEATURE, tenantId))
    )
      return { state: 'disabled', queued: 0 };
    const owners = await this.rules.reports.folders.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<
          Array<{ id: string; owner_clerk_id: string }>
        >`SELECT id,owner_clerk_id FROM intel_legiwatch_keyword_rule WHERE tenant_id=${tenantId} AND state='active' AND config->>'deliveryEnabled'='true' ORDER BY updated_at,id LIMIT 10`,
    );
    let queued = 0;
    for (const owner of owners) {
      const ctx = { tenantId, clerkUserId: owner.owner_clerk_id, role: null };
      try {
        await this.rules.authorize(ctx);
        queued += await this.rules.reports.folders.withActor(
          ctx,
          async (tx) => {
            const rule = await this.rules.get(tx, ctx, owner.id, true);
            const rows = await tx.$queryRaw<
              Array<{
                id: string;
                bill_id: string;
                folder_id: string;
                payload: Record<string, unknown>;
                created_at: Date;
              }>
            >`SELECT s.id,s.bill_id,s.folder_id,s.payload,s.created_at FROM intel_legiwatch_suggestion s
      JOIN intel_legiwatch_discovery_run r ON r.id=s.run_id AND r.tenant_id=s.tenant_id
      WHERE s.tenant_id=${tenantId} AND s.owner_clerk_id=${ctx.clerkUserId} AND s.rule_id=${rule.id} AND s.rule_version=${rule.version}
      AND r.input->>'mode'='active' AND s.created_at>${new Date(rule.activation!.fromNow)} AND s.state IN ('pending','added','already_present')
      AND NOT EXISTS(SELECT 1 FROM intel_legiwatch_keyword_notified n WHERE n.tenant_id=s.tenant_id AND n.owner_clerk_id=s.owner_clerk_id AND n.suggestion_id=s.id)
      ORDER BY s.created_at,s.id LIMIT 25`;
            let count = 0;
            for (const s of rows) {
              const f = await this.rules.folder(tx, ctx, s.folder_id),
                bill = object(s.payload.bill);
              const day = rule.config.timezone
                ? localTime(s.created_at, rule.config.timezone).date
                : '';
              const due =
                rule.config.cadence === 'end_of_day'
                  ? localOccurrence(day, rule.config.localMinutes!, rule.config.timezone!)
                  : now;
              const title = `${String(bill.number)}: Keyword match ready for review`;
              const content = `${String(bill.title)}\nMatched in the reviewed ${rule.config.scope.fields.join(', ')} scope.\nOpen the tracked folder: ${(process.env.REPORT_APP_ORIGIN ?? 'https://os.capiro.ai').replace(/\/+$/, '')}/legiwatch?tab=bills&folder=${encodeURIComponent(f.id)}&jurisdiction=${rule.config.scope.jurisdiction}&session=${encodeURIComponent(rule.config.scope.sessionKey)}`;
              for (const recipient of rule.config.recipients ?? [])
                for (const channel of ['email', 'in_app']) {
                  if (channel === 'email' ? !recipient.email : !recipient.inApp) continue;
                  const dest = await this.rules.reports.folders.source.staffDestination(
                    tenantId,
                    recipient.userId,
                  );
                  const key =
                    'keyword:' +
                    digest([
                      s.bill_id,
                      s.payload.sourceFingerprint,
                      f.id,
                      ctx.clerkUserId,
                      recipient.userId,
                      channel,
                      rule.config.cadence,
                      day,
                      rule.config.timezone,
                      rule.config.localMinutes,
                    ]);
                  const composition = {
                    kind: 'bill_keyword',
                    eventKey: key,
                    billId: s.bill_id,
                    clientId: f.clientId,
                    title,
                    content,
                    html: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(content).replace(/\n/g, '<br>')}</p>`,
                    ruleRefs: [{ id: rule.id, version: rule.version, suggestionId: s.id }],
                    cadence: rule.config.cadence,
                    timezone: rule.config.timezone,
                    localMinutes: rule.config.localMinutes,
                    localDay: day,
                  };
                  const delivery = {
                    kind: 'bill_keyword',
                    composition: json(composition),
                  } as LegiWatchDelivery;
                  let holdReason: string | null = null;
                  try {
                    await this.checkDispatch(
                      tx,
                      ctx,
                      delivery,
                      { userId: recipient.userId, email: dest?.email },
                      channel,
                    );
                  } catch (error) {
                    holdReason =
                      error instanceof Error ? error.message : 'CURRENT_SCOPE_REVIEW_REQUIRED';
                  }
                  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':' + key},0))`;
                  const existing = await tx.legiWatchDelivery.findFirst({
                    where: { tenantId, intentKey: key },
                  });
                  await tx.$executeRaw`INSERT INTO intel_legiwatch_keyword_delivery_reference(tenant_id,owner_clerk_id,intent_key,rule_id,rule_version,suggestion_id)
                    VALUES(${tenantId},${ctx.clerkUserId},${key},${rule.id},${rule.version},${s.id}) ON CONFLICT DO NOTHING`;
                  if (!existing) {
                    await tx.legiWatchDelivery.create({
                      data: {
                        tenantId,
                        ownerClerkId: ctx.clerkUserId,
                        intentKey: key,
                        kind: 'bill_keyword',
                        contentHash: digest([title, content]),
                        composition: json(composition),
                        recipients: {
                          create: [
                            {
                              destinationHash: digest(recipient.userId),
                              channel,
                              state:
                                holdReason && holdReason !== 'STAFF_QUIET_HOURS'
                                  ? 'held'
                                  : 'queued',
                              error: holdReason,
                              nextAttemptAt:
                                holdReason === 'STAFF_QUIET_HOURS' && due < now
                                  ? new Date(now.getTime() + 300000)
                                  : due,
                              recipient: json({
                                userId: recipient.userId,
                                email: dest?.email,
                                role: 'to',
                              }),
                            },
                          ],
                        },
                      },
                    });
                    count++;
                  }
                }
              await tx.$executeRaw`INSERT INTO intel_legiwatch_keyword_notified(tenant_id,owner_clerk_id,suggestion_id) VALUES(${tenantId},${ctx.clerkUserId},${s.id}) ON CONFLICT DO NOTHING`;
            }
            await tx.$executeRaw`UPDATE intel_legiwatch_keyword_rule SET updated_at=now() WHERE tenant_id=${tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${rule.id}`;
            return count;
          },
          { timeoutMs: 30000 },
        );
      } catch {
        /* Current owner, source and recipient readiness hold this owner scope. */
      }
    }
    return { queued };
  }
}
