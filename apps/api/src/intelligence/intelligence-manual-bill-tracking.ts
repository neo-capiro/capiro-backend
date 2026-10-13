import type { PrismaService } from '../prisma/prisma.service.js';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  projectBillDetail,
  type BillDetailRow,
  type BillDetail,
  type ManualBillPorts,
} from './intelligence-bill-discovery.shared.js';

export class IntelligenceManualBillTracking {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: ManualBillPorts,
  ) {}

  async getManualTrackedBillIds(clientId: string, tenantId: string): Promise<string[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.findMany({ where: { clientId }, select: { billId: true } }),
    );
    return rows.map((r) => r.billId);
  }

  async fetchBillsByIds(ids: string[]): Promise<BillDetail[]> {
    if (!ids.length) return [];
    const bills = await this.prisma.$queryRaw<BillDetailRow[]>`
      SELECT cb.id, cb.title, cb.latest_action_date, cb.latest_action_text, cb.status,
             ARRAY(SELECT a.text FROM congress_bill_action a WHERE a.bill_id = cb.id) AS action_texts,
             cb.sponsor_name, cb.sponsor_party, cb.subjects
      FROM congress_bill cb
      WHERE cb.id = ANY(${ids}::text[])
      ORDER BY cb.latest_action_date DESC NULLS LAST
    `;
    return bills.map(projectBillDetail);
  }

  async listTrackedBills(clientId: string, tenantId: string) {
    const tracked = await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.findMany({
        where: { clientId },
        orderBy: { createdAt: 'desc' },
      }),
    );
    const billIds = tracked.map((t) => t.billId);
    const bills = await this.ports.fetchBillsByIds(billIds);
    const billById = new Map(bills.map((b) => [b.identifier, b]));
    return tracked.map((t) => ({
      id: t.id,
      billId: t.billId,
      note: t.note,
      createdAt: t.createdAt,
      bill: billById.get(t.billId) ?? null,
    }));
  }

  async addTrackedBill(
    clientId: string,
    tenantId: string,
    billId: string,
    note?: string,
    createdBy?: string,
  ) {
    const trimmedId = billId.trim();
    if (!trimmedId) {
      throw new BadRequestException('billId is required');
    }
    // Verify the bill exists (global table) and the client belongs to the tenant.
    const [billExists] = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM congress_bill WHERE id = ${trimmedId} LIMIT 1
    `;
    if (!billExists) {
      throw new NotFoundException(`Bill ${trimmedId} not found`);
    }
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true } }),
    );
    if (!client) {
      throw new NotFoundException(`Client ${clientId} not found`);
    }
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.upsert({
        where: { clientId_billId: { clientId, billId: trimmedId } },
        update: { note: note ?? undefined },
        create: {
          tenantId,
          clientId,
          billId: trimmedId,
          note: note ?? null,
          createdBy: createdBy ?? null,
        },
      }),
    );
  }

  async removeTrackedBill(clientId: string, tenantId: string, billId: string) {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.deleteMany({ where: { clientId, billId: billId.trim() } }),
    );
    return { removed: true };
  }
}
