import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { getBillText, getSupportingDocument } from '../external/legiscan/legiscan.client.js';
import { persistDocumentEvidence } from './legiscan-document-evidence.js';
import { currentQuotaMonth, LEGISCAN_HARD_CAP, monthToDateQueries } from './legiscan-quota.util.js';
import type { LegalResearchManifest } from './legal-research-manifest.js';

/** Selected documents use the existing provider, evidence writer and quota cursor.
 * Four query units are reserved before retrieval (including transport retries).
 * A crash keeps the conservative reservation; a completed attempt releases only
 * units definitely unused. No bill list/hash, folder, capture or delivery is changed. */
export async function hydrateResearchDocuments(
  prisma: PrismaClient,
  manifest: LegalResearchManifest,
) {
  if (!manifest.hydrateDocuments) return { requested: false, outcomes: [] };
  if (process.env.LEGISCAN_DOCUMENT_EVIDENCE_ENABLED !== 'true')
    throw Error('DOCUMENT_EVIDENCE_PROCESS_DISABLED');
  const apiKey = process.env.LEGISCAN_API_KEY;
  if (!apiKey) throw Error('LEGISCAN_PROVIDER_NOT_CONFIGURED');
  const bills = await prisma.stateBill.findMany({
    where: {
      id: { in: manifest.billIds },
      state: manifest.jurisdiction,
      sessionKey: manifest.sessionKey,
    },
    select: { id: true, legiscanBillId: true, legiscanChangeHash: true, reportSourceFacts: true },
  });
  const session = await prisma.stateSession.findFirst({
    where: { state: manifest.jurisdiction, sessionKey: manifest.sessionKey },
    select: { legiscanSessionId: true },
  });
  if (!session) throw Error('EXACT_RETAINED_PROVIDER_SESSION_REQUIRED');
  const cursorId = `${manifest.jurisdiction}-${session.legiscanSessionId}`,
    outcomes: Array<Record<string, unknown>> = [];
  let documentsRequested = 0;
  for (const bill of bills) {
    const facts = bill.reportSourceFacts as Record<string, any> | null,
      inventory = facts?.documentInventory;
    if (
      !bill.legiscanBillId ||
      !inventory ||
      inventory.providerChangeHash !== bill.legiscanChangeHash ||
      !Array.isArray(inventory.expected)
    ) {
      outcomes.push({
        billId: bill.id,
        status: 'held',
        reason: 'REFRESH_EXACT_BILL_DOCUMENT_INVENTORY',
      });
      continue;
    }
    if (inventory.expected.length > 500) throw Error('PROVIDER_DOCUMENT_LIST_LIMIT');
    for (const stub of inventory.expected as Array<{
      kind: 'text' | 'amendment' | 'supplement';
      providerId: number;
      providerHash: string | null;
    }>) {
      if (
        !['text', 'amendment', 'supplement'].includes(stub.kind) ||
        !Number.isSafeInteger(stub.providerId) ||
        stub.providerId < 1 ||
        !stub.providerHash
      ) {
        outcomes.push({
          billId: bill.id,
          status: 'held',
          reason: 'DOCUMENT_IDENTITY_OR_HASH_UNQUALIFIED',
        });
        continue;
      }
      const retained = await prisma.$queryRaw<
        Array<{ document_id: string }>
      >`SELECT document_id FROM legiwatch_research_document_source WHERE bill_id=${bill.id} AND document_kind=${stub.kind} AND provider_id=${String(stub.providerId)} AND provider_hash=${stub.providerHash} AND is_current AND coverage='complete_document' AND extraction_state='extracted' LIMIT 1`;
      if (retained.length) {
        outcomes.push({ billId: bill.id, providerId: stub.providerId, status: 'already_retained' });
        continue;
      }
      if (documentsRequested >= manifest.documentBudget!) {
        outcomes.push({
          billId: bill.id,
          status: 'held',
          reason: 'SELECTED_DOCUMENT_BUDGET_REACHED',
        });
        continue;
      }
      const month = currentQuotaMonth(),
        budget = Math.min(LEGISCAN_HARD_CAP, Number(process.env.LEGISCAN_MONTHLY_BUDGET ?? 28000)),
        reservationId = randomUUID();
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('legiscan-research-quota',0))`;
        const cursors = await tx.stateSyncCursor.findMany({
          select: { queriesUsed: true, quotaMonth: true },
        });
        if (!Number.isFinite(budget) || monthToDateQueries(cursors, month) + 4 > budget)
          throw Error('EXISTING_PROVIDER_BUDGET_HOLD');
        const updated =
          await tx.$executeRaw`UPDATE state_sync_cursor SET queries_used=CASE WHEN quota_month=${month} THEN queries_used+4 ELSE 4 END,quota_month=${month} WHERE id=${cursorId}`;
        if (updated !== 1) throw Error('EXISTING_PROVIDER_CURSOR_REQUIRED');
        await tx.$executeRaw`INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES(${reservationId},'legiscan-research-query-reservation',${JSON.stringify({ jurisdiction: manifest.jurisdiction, sessionKey: manifest.sessionKey, billId: bill.id })}::jsonb,${JSON.stringify({ providerId: stub.providerId, kind: stub.kind, reservedQueries: 4, quotaMonth: month })}::jsonb,false)`;
      });
      documentsRequested++;
      let attempts = 1;
      try {
        const doc =
          stub.kind === 'text'
            ? await getBillText(apiKey, stub.providerId, () => {
                attempts++;
              })
            : await getSupportingDocument(apiKey, stub.kind, stub.providerId, () => {
                attempts++;
              });
        if (
          !doc ||
          doc.bill_id !== bill.legiscanBillId ||
          doc.doc_id !== stub.providerId ||
          doc.text_hash !== stub.providerHash
        )
          throw Error('DOCUMENT_IDENTITY_OR_SOURCE_HASH_CHANGED');
        const state = await persistDocumentEvidence(
          prisma,
          bill.id,
          doc,
          stub.kind === 'text'
            ? undefined
            : { id: stub.providerId, kind: stub.kind, billId: bill.legiscanBillId },
        );
        outcomes.push({
          billId: bill.id,
          providerId: stub.providerId,
          kind: stub.kind,
          status: state,
          reservationId,
          attempts,
        });
      } catch {
        outcomes.push({
          billId: bill.id,
          providerId: stub.providerId,
          kind: stub.kind,
          status: 'failed',
          reason: 'DOCUMENT_RETRIEVAL_OR_EXTRACTION_FAILED',
          reservationId,
          attempts,
        });
      } finally {
        if (attempts < 4)
          await prisma.$executeRaw`UPDATE state_sync_cursor SET queries_used=greatest(0,queries_used-${4 - attempts}) WHERE id=${cursorId} AND quota_month=${month}`;
      }
    }
  }
  return { requested: true, documentsRequested, outcomes };
}
