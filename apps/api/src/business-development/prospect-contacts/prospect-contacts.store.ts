import type { Prisma } from '@prisma/client';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ProspectContactFields } from './prospect-contacts.dto.js';

export interface ContactRow {
  id: string;
  tenant_id: string;
  prospect_id: string;
  request_id: string;
  create_hash: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  version: number;
  removed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
export function contactView(row: ContactRow) {
  return {
    id: row.id,
    prospectId: row.prospect_id,
    requestId: row.request_id,
    name: row.name,
    title: row.title,
    email: row.email,
    phone: row.phone,
    notes: row.notes,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
export const fields = (body: ProspectContactFields) => ({
  name: body.name.trim(),
  title: body.title?.trim() || null,
  email: body.email?.trim() || null,
  phone: body.phone?.trim() || null,
  notes: body.notes?.trim() || null,
});

// Raw SQL never benefits from Prisma's model extension: every statement binds tenant AND prospect.
export async function prospectScope(
  tx: Prisma.TransactionClient,
  tenantId: string,
  prospectId: string,
) {
  const rows = await tx.$queryRaw<
    { status: string; linked_client_id: string | null; converted_at: Date | null }[]
  >`
    SELECT status, linked_client_id, converted_at FROM business_development_prospects
    WHERE tenant_id=${tenantId}::uuid AND id=${prospectId}::uuid FOR UPDATE`;
  if (!rows[0]) throw new NotFoundException();
  return (
    rows[0].status !== 'active' ||
    rows[0].linked_client_id !== null ||
    rows[0].converted_at !== null
  );
}
export function requireWritable(readOnly: boolean) {
  if (readOnly)
    throw new ConflictException('Archived or converted prospects have read-only contacts.');
}
export async function requireContact(
  tx: Prisma.TransactionClient,
  tenantId: string,
  prospectId: string,
  id: string,
) {
  const rows = await tx.$queryRaw<ContactRow[]>`SELECT * FROM business_development_prospect_contacts
    WHERE tenant_id=${tenantId}::uuid AND prospect_id=${prospectId}::uuid AND id=${id}::uuid AND removed_at IS NULL`;
  if (!rows[0]) throw new NotFoundException();
  return rows[0];
}
