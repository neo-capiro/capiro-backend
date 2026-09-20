import type { PrismaClient } from '@prisma/client';

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

export type CongressActionPrisma = Pick<PrismaClient, '$transaction' | 'congressBillAction'>;

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
  const deleteExisting = prisma.congressBillAction.deleteMany({ where: { billId } });

  if (actions.length === 0) {
    await prisma.$transaction([deleteExisting]);
    return;
  }

  const insertReplacement = prisma.congressBillAction.createMany({
    data: actions.map((action) => ({ billId, ...action })),
  });
  await prisma.$transaction([deleteExisting, insertReplacement]);
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
