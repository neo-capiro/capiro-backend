import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

export interface CongressActionApiItem {
  actionDate?: string | null;
  text?: string | null;
  type?: string | null;
  actionCode?: string | null;
  sourceSystem?: { code?: number; name?: string } | null;
  chamber?: string | null;
}

export interface CongressActionsResponse {
  actions?: CongressActionApiItem[] | null;
  pagination?: {
    next?: string | null;
  } | null;
}

export interface NormalizedCongressAction {
  date: Date;
  text: string;
  type: string | null;
  chamber: string | null;
}

export type CongressActionPrisma = Pick<
  PrismaClient,
  '$transaction' | '$executeRaw' | 'congressBillAction' | 'federalEvidenceCheckpoint'
>;

export type CongressActionSyncResult =
  | { ok: true; actions: NormalizedCongressAction[] }
  | { ok: false; stage: 'fetch' | 'replace'; error: Error };

export type FetchCongressActionsPage = (
  nextPageUrl: string | null,
) => Promise<CongressActionsResponse | null>;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function usableActionText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeAction(action: CongressActionApiItem): NormalizedCongressAction | null {
  if (!action.actionDate) return null;
  const date = new Date(action.actionDate);
  if (Number.isNaN(date.getTime())) return null;
  const text =
    typeof action.text === 'string' && action.text.trim()
      ? action.text
      : (usableActionText(action.actionCode) ?? usableActionText(action.type));
  if (!text) return null;

  return {
    date,
    text,
    type: action.type ?? null,
    chamber: action.chamber ?? null,
  };
}

/**
 * Fetch the complete Congress.gov action history. A null/malformed page or a
 * failure on any page invalidates the whole result so callers never persist a
 * partial history.
 */
export async function fetchAllCongressBillActions(
  fetchPage: FetchCongressActionsPage,
): Promise<CongressActionSyncResult> {
  const actions: NormalizedCongressAction[] = [];
  const seenNextUrls = new Set<string>();
  let nextPageUrl: string | null = null;

  try {
    for (;;) {
      const response = await fetchPage(nextPageUrl);
      if (!response || !Array.isArray(response.actions)) {
        throw new Error('Congress actions endpoint returned no valid actions array');
      }

      for (const action of response.actions) {
        const normalized = normalizeAction(action);
        if (!normalized) {
          throw new Error('Congress actions endpoint returned a malformed action');
        }
        actions.push(normalized);
      }

      const next = response.pagination?.next ?? null;
      if (!next) return { ok: true, actions };
      if (seenNextUrls.has(next)) {
        throw new Error('Congress actions pagination repeated a continuation URL');
      }
      seenNextUrls.add(next);
      nextPageUrl = next;
    }
  } catch (error) {
    return { ok: false, stage: 'fetch', error: asError(error) };
  }
}

/** Replace one bill's normalized action history in a single database transaction. */
export async function replaceCongressBillActionsAtomically(
  prisma: CongressActionPrisma,
  billId: string,
  actions: NormalizedCongressAction[],
): Promise<void> {
  const inventorySource = `congress-actions:${billId}`;
  const baseline = await prisma.federalEvidenceCheckpoint.findUnique({
    where: { source: inventorySource },
    select: { status: true },
  });
  const hasCompleteBaseline = baseline?.status === 'completed';
  const previous = await prisma.congressBillAction.findMany({
    where: { billId },
    select: { date: true, text: true, type: true, chamber: true },
  });
  const fingerprint = (action: NormalizedCongressAction) =>
    createHash('sha256')
      .update(
        JSON.stringify({
          date: action.date.toISOString(),
          text: action.text,
          type: action.type,
          chamber: action.chamber,
        }),
      )
      .digest('hex');
  const known = new Set(previous.map((action) => fingerprint(action)));
  const deleteExisting = prisma.congressBillAction.deleteMany({ where: { billId } });
  const operations: Prisma.PrismaPromise<unknown>[] = [deleteExisting];
  if (actions.length > 0) {
    operations.push(
      prisma.congressBillAction.createMany({
        data: actions.map((action) => ({ billId, ...action })),
      }),
    );
  }
  const completedAt = new Date();
  const historyHash = createHash('sha256')
    .update(actions.map((action) => fingerprint(action)).sort().join('\n'))
    .digest('hex');
  const baselineOperation = prisma.federalEvidenceCheckpoint.upsert({
    where: { source: inventorySource },
    create: {
      source: inventorySource,
      cursor: { actionCount: actions.length, historyHash },
      status: 'completed',
      completedAt,
    },
    update: {
      cursor: { actionCount: actions.length, historyHash },
      status: 'completed',
      completedAt,
      lastError: null,
    },
  });
  operations.push(baselineOperation);
  // Initial history hydration is a backfill, not breaking news. Once a bill has
  // a prior complete history, newly observed actions are registered in the same
  // transaction as the replacement and delivered through the Package 4 outbox.
  if (hasCompleteBaseline) {
    for (const action of actions) {
      const actionHash = fingerprint(action);
      if (known.has(actionHash)) continue;
      const sourceKey = `congress-action:${billId}`;
      const eventKey = createHash('sha256')
        .update(`federal-action-event-v1\0${billId}\0${actionHash}`)
        .digest('hex');
      const payload = {
        eventKey,
        sourceKey,
        billId,
        eventType: 'action_added',
        candidateKey: `action:${actionHash}`,
        rawMention: action.text,
        canonicalPeCode: null,
        previousRevisionId: null,
        currentRevisionId: null,
        before: null,
        after: {
          date: action.date.toISOString(),
          text: action.text,
          type: action.type,
          chamber: action.chamber,
        },
        historical: false,
      };
      operations.push(
        prisma.$executeRaw(Prisma.sql`
          WITH inserted AS (
            INSERT INTO federal_evidence_mention_event(
              event_key, source_key, bill_id, event_type, candidate_key,
              raw_mention, canonical_pe_code, before_jsonb, after_jsonb, historical
            ) VALUES (
              ${eventKey}, ${sourceKey}, ${billId}, 'action_added',
              ${`action:${actionHash}`}, ${action.text}, NULL, NULL,
              ${JSON.stringify(payload.after)}::jsonb, false
            ) ON CONFLICT (event_key) DO NOTHING
            RETURNING id
          ), event AS (
            SELECT id FROM inserted
            UNION ALL
            SELECT id FROM federal_evidence_mention_event WHERE event_key = ${eventKey}
            LIMIT 1
          )
          INSERT INTO federal_evidence_change_outbox(event_id, dedupe_key, payload_jsonb)
          SELECT id, ${`federal-evidence:${eventKey}`}, ${JSON.stringify(payload)}::jsonb FROM event
          ON CONFLICT (dedupe_key) DO NOTHING`),
      );
    }
  }
  await prisma.$transaction(operations);
}

/**
 * Fetch then atomically replace a bill's actions. Fetch failures never invoke
 * persistence, and transaction failures roll back the delete with the insert.
 */
export async function syncCongressBillActions(args: {
  prisma: CongressActionPrisma;
  billId: string;
  fetchPage: FetchCongressActionsPage;
}): Promise<CongressActionSyncResult> {
  const fetched = await fetchAllCongressBillActions(args.fetchPage);
  if (!fetched.ok) return fetched;

  try {
    await replaceCongressBillActionsAtomically(args.prisma, args.billId, fetched.actions);
    return fetched;
  } catch (error) {
    return { ok: false, stage: 'replace', error: asError(error) };
  }
}
