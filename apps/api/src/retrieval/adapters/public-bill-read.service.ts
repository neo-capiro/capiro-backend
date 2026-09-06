import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RetrievalRequest, RetrievalRecord } from '../retrieval-v2.types.js';
import { publicRecord } from './public-domain-retrieval.helpers.js';

/**
 * Public, read-only projection of the same CongressBill/StateBill catalogs used
 * by LdaIntelService.getCongressBills and MeriToolsService.searchStateBills.
 * It adds deterministic pagination and both date bounds, without reimplementing
 * legislative-status derivation, client matching, or any write path.
 */
@Injectable()
export class PublicBillReadService {
  constructor(private readonly prisma: PrismaService) {}

  async readPage(
    family: 0 | 1,
    request: RetrievalRequest,
    page: number,
    pageSize: number,
  ): Promise<{
    records: RetrievalRecord[];
    total: number;
    lastSyncAt: Date | null;
  }> {
    const query = request.query?.trim();
    const range = {
      ...(request.windowStart ? { gte: request.windowStart } : {}),
      ...(request.windowEnd ? { lte: request.windowEnd } : {}),
    };
    const hasRange = Boolean(request.windowStart || request.windowEnd);
    // Only the two global public bill tables are read under system scope.
    // No tenant watches, alert subscriptions, or client associations are exposed.
    return this.prisma.withSystem(async (tx) => {
      if (family === 0) {
        const where: Prisma.CongressBillWhereInput = {
          ...(query
            ? {
                OR: [
                  { title: { contains: query, mode: 'insensitive' } },
                  { id: { equals: query, mode: 'insensitive' } },
                ],
              }
            : {}),
          ...(hasRange ? { latestActionDate: range } : {}),
        };
        const [rows, total, freshness] = await Promise.all([
          tx.congressBill.findMany({
            where,
            orderBy: { id: 'asc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.congressBill.count({ where }),
          tx.congressBill.aggregate({ _max: { lastSyncedAt: true } }),
        ]);
        return {
          records: rows.map((row) =>
            publicRecord(
              'legiwatch_bills',
              `federal:${row.id}`,
              row,
              {
                sourceType: 'congress_bill',
                sourceId: row.id,
                sourceUrl: row.url,
                scope: 'public_bill_catalog',
                content: 'current_bill_summary',
                dateFilterBasis: 'latestActionDate',
                freshnessBasis: 'latest_observed_record_sync',
              },
              {
                occurredAt: row.latestActionDate,
                updatedAt: row.updateDate ?? row.lastSyncedAt,
              },
            ),
          ),
          total,
          lastSyncAt: freshness._max.lastSyncedAt,
        };
      }
      const where: Prisma.StateBillWhereInput = {
        ...(query
          ? {
              OR: [
                { title: { contains: query, mode: 'insensitive' } },
                { identifier: { contains: query, mode: 'insensitive' } },
                { id: { equals: query, mode: 'insensitive' } },
                { subjects: { hasSome: [query] } },
              ],
            }
          : {}),
        ...(hasRange ? { latestActionDate: range } : {}),
      };
      const [rows, total, freshness] = await Promise.all([
        tx.stateBill.findMany({
          where,
          orderBy: { id: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.stateBill.count({ where }),
        tx.stateBill.aggregate({ _max: { syncedAt: true } }),
      ]);
      return {
        records: rows.map((row) =>
          publicRecord(
            'legiwatch_bills',
            `state:${row.id}`,
            row,
            {
              sourceType: 'state_bill',
              sourceId: row.id,
              sourceUrl: row.stateUrl ?? row.url,
              scope: 'public_bill_catalog',
              content: 'current_bill_summary',
              dateFilterBasis: 'latestActionDate',
              freshnessBasis: 'latest_observed_record_sync',
            },
            { occurredAt: row.latestActionDate, updatedAt: row.syncedAt },
          ),
        ),
        total,
        lastSyncAt: freshness._max.syncedAt,
      };
    });
  }
}
