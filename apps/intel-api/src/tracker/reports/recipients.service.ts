import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { isFolderAdmin } from '../folders/folder-tracker.service.js';
import { ReportService } from './report.service.js';
import { digest, ids, object, text, version } from './report-domain.js';

export interface RecipientSnapshot {
  email: string;
  role: 'to' | 'bcc';
  name: string;
  contacts: Array<{ id: string; version: number }>;
  lists: Array<{ id: string; version: number }>;
  manual: boolean;
}
export function normalizeEmail(v: unknown) {
  const value = text(v, 254).toLowerCase();
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value))
    throw new BadRequestException('VALID_EMAIL_REQUIRED');
  return value;
}
export function mergeRecipients(rows: RecipientSnapshot[]): RecipientSnapshot[] {
  const out = new Map<string, RecipientSnapshot>();
  for (const row of rows) {
    const old = out.get(row.email);
    if (!old) out.set(row.email, { ...row, contacts: [...row.contacts], lists: [...row.lists] });
    else {
      // Conflicting To/BCC selection needs an explicit review; never silently
      // expose a destination selected as BCC through another source alias.
      if (old.role !== row.role)
        throw new BadRequestException('RECIPIENT_HAS_CONFLICTING_TO_BCC_ROLES');
      old.contacts = [
        ...new Map([...old.contacts, ...row.contacts].map((c) => [c.id, c])).values(),
      ];
      old.lists = [...new Map([...old.lists, ...row.lists].map((l) => [l.id, l])).values()];
      old.manual ||= row.manual;
    }
  }
  return [...out.values()].sort((a, b) => a.email.localeCompare(b.email));
}

@Injectable()
export class ReportRecipientsService {
  constructor(readonly reports: ReportService) {}
  async directory(ctx: WorkspaceTenantContext) {
    await this.reports.authorize(ctx);
    return this.reports.folders.withActor(ctx, async (tx) => ({
      senderEmail:
        (await this.reports.folders.source.staffDestination(ctx.tenantId, ctx.clerkUserId))
          ?.email ?? null,
      contacts: await tx.legiWatchReportContact.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      lists: await tx.legiWatchReportList.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(isFolderAdmin(ctx)
            ? {}
            : { OR: [{ private: false }, { ownerClerkId: ctx.clerkUserId }] }),
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    }));
  }
  async saveContact(ctx: WorkspaceTenantContext, input: unknown, id?: string) {
    await this.reports.authorize(ctx);
    const b = object(input);
    const data = {
      name: text(b.name),
      email: b.email ? normalizeEmail(b.email) : null,
      verified: b.verified === true,
      active: b.active !== false,
      optedOut: b.optedOut === true,
    };
    return this.reports.folders.withActor(ctx, async (tx) => {
      if (!id)
        return tx.legiWatchReportContact.create({
          data: { ...data, tenantId: ctx.tenantId, ownerClerkId: ctx.clerkUserId },
        });
      const old = await tx.legiWatchReportContact.findFirst({
        where: { tenantId: ctx.tenantId, id },
      });
      if (!old) throw new NotFoundException('CONTACT_NOT_FOUND');
      if (old.ownerClerkId !== ctx.clerkUserId && !isFolderAdmin(ctx))
        throw new ForbiddenException('CONTACT_OWNER_REQUIRED');
      const changed = await tx.legiWatchReportContact.updateMany({
        where: { tenantId: ctx.tenantId, id, version: version(b.expectedVersion) },
        data: { ...data, version: { increment: 1 } },
      });
      if (!changed.count) throw new ConflictException('CONTACT_CHANGED_RELOAD');
      return tx.legiWatchReportContact.findFirstOrThrow({ where: { tenantId: ctx.tenantId, id } });
    });
  }
  async saveList(ctx: WorkspaceTenantContext, input: unknown, id?: string) {
    await this.reports.authorize(ctx);
    const b = object(input),
      contactIds = ids(b.contactIds, 1000);
    const data = {
      name: text(b.name),
      private: b.private !== false,
      contactIds,
      active: b.active !== false,
    };
    return this.reports.folders.withActor(ctx, async (tx) => {
      if (
        (await tx.legiWatchReportContact.count({
          where: { tenantId: ctx.tenantId, id: { in: contactIds } },
        })) !== contactIds.length
      )
        throw new BadRequestException('CONTACT_MAPPING_REQUIRED');
      if (!id)
        return tx.legiWatchReportList.create({
          data: { ...data, tenantId: ctx.tenantId, ownerClerkId: ctx.clerkUserId },
        });
      const old = await tx.legiWatchReportList.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!old) throw new NotFoundException('LIST_NOT_FOUND');
      if (old.ownerClerkId !== ctx.clerkUserId && !isFolderAdmin(ctx))
        throw new ForbiddenException('LIST_OWNER_REQUIRED');
      const changed = await tx.legiWatchReportList.updateMany({
        where: { tenantId: ctx.tenantId, id, version: version(b.expectedVersion) },
        data: { ...data, version: { increment: 1 } },
      });
      if (!changed.count) throw new ConflictException('LIST_CHANGED_RELOAD');
      return tx.legiWatchReportList.findFirstOrThrow({ where: { tenantId: ctx.tenantId, id } });
    });
  }
  async resolve(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    selection: unknown,
  ): Promise<RecipientSnapshot[]> {
    if (!Array.isArray(selection) || selection.length > 500)
      throw new BadRequestException('MAX_500_RECIPIENT_SELECTIONS');
    const rows: RecipientSnapshot[] = [];
    for (const raw of selection) {
      const s = object(raw);
      if (s.role !== 'to' && s.role !== 'bcc')
        throw new BadRequestException('RECIPIENT_ROLE_REQUIRED');
      const role = s.role;
      if (s.kind === 'manual') {
        rows.push({
          email: normalizeEmail(s.email),
          role,
          name: '',
          contacts: [],
          lists: [],
          manual: true,
        });
        continue;
      }
      let contactIds: string[] = [],
        lists: RecipientSnapshot['lists'] = [];
      if (s.kind === 'list') {
        const list = await tx.legiWatchReportList.findFirst({
          where: { tenantId: ctx.tenantId, id: text(s.id), active: true },
        });
        if (!list || (list.private && list.ownerClerkId !== ctx.clerkUserId && !isFolderAdmin(ctx)))
          throw new ForbiddenException('LIST_NOT_AUTHORIZED');
        contactIds = list.contactIds;
        lists = [{ id: list.id, version: list.version }];
      } else if (s.kind === 'contact') contactIds = [text(s.id)];
      else throw new BadRequestException('UNSUPPORTED_RECIPIENT_KIND');
      for (const id of contactIds) {
        const c = await tx.legiWatchReportContact.findFirst({
          where: { tenantId: ctx.tenantId, id },
        });
        if (!c || !c.active || !c.verified || c.optedOut || !c.email)
          throw new BadRequestException('RECIPIENT_REQUIRES_REVIEW');
        rows.push({
          email: normalizeEmail(c.email),
          name: c.name,
          role,
          contacts: [{ id: c.id, version: c.version }],
          lists,
          manual: false,
        });
      }
    }
    const recipients = mergeRecipients(rows);
    if (recipients.length > 500) throw new BadRequestException('MAX_500_DESTINATIONS');
    for (const r of recipients) await this.recheck(tx, ctx, r);
    return recipients;
  }
  async recheck(tx: Prisma.TransactionClient, ctx: WorkspaceTenantContext, r: RecipientSnapshot) {
    // An opt-out applies to the destination across every alias and manual entry.
    const suppressed = await tx.legiWatchReportContact.count({
      where: {
        tenantId: ctx.tenantId,
        email: { equals: r.email, mode: 'insensitive' },
        optedOut: true,
      },
    });
    if (suppressed) throw new ForbiddenException('DESTINATION_OPTED_OUT');
    for (const ref of r.contacts) {
      const c = await tx.legiWatchReportContact.findFirst({
        where: { tenantId: ctx.tenantId, id: ref.id },
      });
      if (
        !c ||
        !c.active ||
        !c.verified ||
        c.optedOut ||
        c.version !== ref.version ||
        !c.email ||
        normalizeEmail(c.email) !== r.email
      )
        throw new ConflictException('APPROVED_RECIPIENT_CHANGED');
    }
    for (const ref of r.lists) {
      const l = await tx.legiWatchReportList.findFirst({
        where: { tenantId: ctx.tenantId, id: ref.id },
      });
      if (
        !l ||
        !l.active ||
        l.version !== ref.version ||
        (l.private && l.ownerClerkId !== ctx.clerkUserId && !isFolderAdmin(ctx)) ||
        !r.contacts.some((c) => l.contactIds.includes(c.id))
      )
        throw new ConflictException('APPROVED_LIST_CHANGED');
    }
  }
  async promote(ctx: WorkspaceTenantContext, sourceAccount: string) {
    await this.reports.authorize(ctx);
    if (!isFolderAdmin(ctx)) throw new ForbiddenException('PROMOTION_REQUIRES_ADMIN');
    return this.reports.folders.withActor(
      ctx,
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`phase2-contacts:${ctx.tenantId}:${sourceAccount}`}))`;
        const staged = await tx.legiWatchStagedConfiguration.findMany({
          where: {
            tenantId: ctx.tenantId,
            sourceAccount,
            kind: { in: ['contact', 'mailing_list', 'list_membership'] },
            state: { not: 'excluded' },
          },
        });
        const mapped = await tx.legiWatchPromotion.findMany({
          where: {
            tenantId: ctx.tenantId,
            sourceAccount,
            kind: { in: ['contact', 'mailing_list'] },
          },
        });
        let contacts = 0,
          lists = 0,
          memberships = 0;
        const unresolved: string[] = [];
        for (const s of [
          ...staged.filter((s) => s.kind === 'contact'),
          ...staged.filter((s) => s.kind === 'mailing_list'),
        ]) {
          if (mapped.some((m) => m.stagedId === s.id)) continue;
          const raw = object(s.payload);
          let targetId: string;
          if (s.kind === 'contact') {
            let email: string | null = null;
            try {
              email = raw.email ? normalizeEmail(raw.email) : null;
            } catch {
              /* visible unverified contact */
            }
            const c = await tx.legiWatchReportContact.create({
              data: {
                tenantId: ctx.tenantId,
                ownerClerkId: ctx.clerkUserId,
                name:
                  String(
                    raw.full_name ?? `${raw.first_name ?? ''} ${raw.last_name ?? ''}`,
                  ).trim() || `Contact ${s.sourceId}`,
                email,
              },
            });
            targetId = c.id;
            contacts++;
          } else {
            const sourceMembers = staged.filter(
              (m) =>
                m.kind === 'list_membership' &&
                String(object(m.payload).mailing_list_id) === s.sourceId,
            );
            const members = sourceMembers.map(
              (m) =>
                mapped.find(
                  (p) =>
                    p.kind === 'contact' && p.sourceId === String(object(m.payload).contact_id),
                )?.targetId,
            );
            if (members.some((m) => !m)) {
              unresolved.push(s.sourceId);
              continue;
            }
            const l = await tx.legiWatchReportList.create({
              data: {
                tenantId: ctx.tenantId,
                ownerClerkId: ctx.clerkUserId,
                name: text(raw.name),
                private: raw.visibility !== 'Public',
                contactIds: members as string[],
              },
            });
            targetId = l.id;
            lists++;
            memberships += members.length;
          }
          const link = await tx.legiWatchPromotion.create({
            data: {
              tenantId: ctx.tenantId,
              stagedId: s.id,
              sourceAccount,
              sourceId: s.sourceId,
              sourceVersion: s.version,
              sourceHash: digest(s.payload),
              kind: s.kind,
              targetId,
              reviewedBy: ctx.clerkUserId,
            },
          });
          mapped.push(link);
        }
        return { contacts, lists, memberships, unresolved, allNewContactsUnverified: true };
      },
      { timeoutMs: 60000 },
    );
  }
}
