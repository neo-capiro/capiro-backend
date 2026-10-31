import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { isFolderAdmin } from '../folders/folder-tracker.service.js';
import { DraftAccessService } from './draft-access.service.js';
import { object, text } from './delivery-domain.js';

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
export class RecipientsService {
  constructor(readonly reports: DraftAccessService) {}
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
}
