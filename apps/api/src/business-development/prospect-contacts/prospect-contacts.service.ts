import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ROLE_RANK, type TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  CreateProspectContactDto,
  UpdateProspectContactDto,
} from './prospect-contacts.dto.js';
import {
  contactView,
  fields,
  prospectScope,
  requireContact,
  requireWritable,
  type ContactRow,
} from './prospect-contacts.store.js';

@Injectable()
export class ProspectContactsService {
  constructor(private readonly prisma: PrismaService) {}
  private authorize(ctx: TenantContext) {
    const rank = ROLE_RANK[ctx.role];
    if (!ctx.tenantId || !ctx.userId || typeof rank !== 'number' || rank < ROLE_RANK.standard_user)
      throw new ForbiddenException();
  }
  async list(ctx: TenantContext, prospectId: string, after?: string) {
    this.authorize(ctx);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const readOnly = await prospectScope(tx, ctx.tenantId, prospectId);
      const rows = after
        ? await tx.$queryRaw<ContactRow[]>`SELECT * FROM business_development_prospect_contacts
          WHERE tenant_id=${ctx.tenantId}::uuid AND prospect_id=${prospectId}::uuid AND removed_at IS NULL
          AND id > ${after}::uuid ORDER BY id LIMIT 51`
        : await tx.$queryRaw<ContactRow[]>`SELECT * FROM business_development_prospect_contacts
          WHERE tenant_id=${ctx.tenantId}::uuid AND prospect_id=${prospectId}::uuid AND removed_at IS NULL ORDER BY id LIMIT 51`;
      return {
        prospectId,
        readOnly,
        contacts: rows.slice(0, 50).map(contactView),
        nextCursor: rows.length > 50 ? (rows[49]?.id ?? null) : null,
      };
    });
  }
  async create(ctx: TenantContext, prospectId: string, body: CreateProspectContactDto) {
    this.authorize(ctx);
    const data = fields(body);
    const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const readOnly = await prospectScope(tx, ctx.tenantId, prospectId);
      // A retry can recover an already committed create even if lifecycle changed meanwhile.
      const existing = await tx.$queryRaw<
        ContactRow[]
      >`SELECT * FROM business_development_prospect_contacts
        WHERE tenant_id=${ctx.tenantId}::uuid AND prospect_id=${prospectId}::uuid AND request_id=${body.requestId}::uuid`;
      if (existing[0]) {
        if (existing[0].create_hash !== hash || existing[0].removed_at)
          throw new ConflictException('This create request was already used.');
        return contactView(existing[0]);
      }
      requireWritable(readOnly);
      const rows = await tx.$queryRaw<
        ContactRow[]
      >`INSERT INTO business_development_prospect_contacts
        (id,tenant_id,prospect_id,request_id,create_hash,name,title,email,phone,notes,created_by_user_id,updated_by_user_id)
        VALUES (${randomUUID()}::uuid,${ctx.tenantId}::uuid,${prospectId}::uuid,${body.requestId}::uuid,${hash},
        ${data.name},${data.title},${data.email},${data.phone},${data.notes},${ctx.userId}::uuid,${ctx.userId}::uuid) RETURNING *`;
      if (!rows[0]) throw new InternalServerErrorException('Contact insert returned no record.');
      return contactView(rows[0]);
    });
  }
  async update(ctx: TenantContext, prospectId: string, id: string, body: UpdateProspectContactDto) {
    this.authorize(ctx);
    const data = fields(body);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      requireWritable(await prospectScope(tx, ctx.tenantId, prospectId));
      await requireContact(tx, ctx.tenantId, prospectId, id);
      const rows = await tx.$queryRaw<ContactRow[]>`UPDATE business_development_prospect_contacts
        SET name=${data.name},title=${data.title},email=${data.email},phone=${data.phone},notes=${data.notes},
        version=version+1,updated_at=now(),updated_by_user_id=${ctx.userId}::uuid
        WHERE tenant_id=${ctx.tenantId}::uuid AND prospect_id=${prospectId}::uuid AND id=${id}::uuid
        AND removed_at IS NULL AND version=${body.expectedVersion} RETURNING *`;
      if (!rows[0])
        throw new ConflictException('Contact changed. Reload the latest version before saving.');
      return contactView(rows[0]);
    });
  }
  async remove(ctx: TenantContext, prospectId: string, id: string, expectedVersion: number) {
    this.authorize(ctx);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      requireWritable(await prospectScope(tx, ctx.tenantId, prospectId));
      await requireContact(tx, ctx.tenantId, prospectId, id);
      const rows = await tx.$queryRaw<ContactRow[]>`UPDATE business_development_prospect_contacts
        SET removed_at=now(),updated_at=now(),version=version+1,updated_by_user_id=${ctx.userId}::uuid
        WHERE tenant_id=${ctx.tenantId}::uuid AND prospect_id=${prospectId}::uuid AND id=${id}::uuid
        AND removed_at IS NULL AND version=${expectedVersion} RETURNING *`;
      if (!rows[0]) throw new ConflictException('Contact changed. Reload before removing.');
      return { id, prospectId, removed: true as const, version: rows[0].version };
    });
  }
}
