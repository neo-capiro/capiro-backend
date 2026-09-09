import { randomUUID } from 'node:crypto';
import { fecSchedulePages, type FecFetcher } from './fec-api.js';

export interface ScheduleBRow {
  sub_id?: string;
  transaction_id?: string;
  file_number?: number | string;
  committee_id?: string;
  committee_name?: string;
  committee?: { name?: string };
  recipient_name?: string;
  recipient_committee_id?: string;
  candidate_id?: string;
  candidate_name?: string;
  disbursement_amount?: number;
  disbursement_date?: string;
  disbursement_description?: string;
  disbursement_type?: string;
  memo_text?: string;
  memo_code?: string;
  memoed_subtotal?: boolean;
  filing_form?: string;
  line_number?: string;
}

/** Form 3X line 23 is contributions to federal candidates and other committees. */
export function isPacGiving(row: ScheduleBRow): boolean {
  return (
    row.filing_form?.toUpperCase() === 'F3X' &&
    row.line_number === '23' &&
    row.memo_code?.toUpperCase() !== 'X' &&
    row.memoed_subtotal !== true &&
    typeof row.disbursement_amount === 'number' &&
    Number.isFinite(row.disbursement_amount) &&
    row.disbursement_amount !== 0
  );
}

function assertContributionScope(row: ScheduleBRow, committeeId: string) {
  // The query is already restricted to F3X-23. A changed response contract must
  // fail coverage instead of quietly replacing a valid snapshot with zero.
  if (
    row.committee_id !== committeeId ||
    row.filing_form?.toUpperCase() !== 'F3X' ||
    row.line_number !== '23'
  ) {
    throw new Error('FEC Schedule B returned a row outside the requested committee/form/line');
  }
  if (typeof row.disbursement_amount !== 'number' || !Number.isFinite(row.disbursement_amount)) {
    throw new Error('FEC Schedule B returned an invalid contribution amount');
  }
}

export function pacContribution(row: ScheduleBRow, committeeId: string, cycle: number) {
  if (!row.sub_id || typeof row.sub_id !== 'string') {
    throw new Error('FEC Schedule B contribution is missing its exact source sub_id');
  }
  if (row.committee_id !== committeeId)
    throw new Error('FEC Schedule B returned a different committee');
  const date = row.disbursement_date ? new Date(row.disbursement_date) : null;
  if (date && Number.isNaN(date.getTime()))
    throw new Error('FEC Schedule B returned an invalid date');
  return {
    committeeId,
    committeeName: row.committee_name ?? row.committee?.name ?? null,
    recipientName: row.recipient_name ?? null,
    recipientCommitteeId: row.recipient_committee_id ?? null,
    candidateId: row.candidate_id ?? null,
    candidateName: row.candidate_name ?? null,
    amount: row.disbursement_amount!,
    disbursementDate: date,
    disbursementType: row.disbursement_type ?? row.disbursement_description ?? null,
    memoText: row.memo_text ?? null,
    sourceSubId: row.sub_id,
    sourceTransactionId: row.transaction_id ?? null,
    sourceFileNumber: row.file_number == null ? null : String(row.file_number),
    cycle,
  };
}

type Contribution = ReturnType<typeof pacContribution>;
interface PacSyncTransaction {
  fecPacContribution: {
    deleteMany(args: { where: { committeeId: string; cycle: number } }): Promise<unknown>;
    createMany(args: { data: Contribution[] }): Promise<unknown>;
  };
  fecPacSyncState: {
    upsert(args: any): Promise<unknown>;
    updateMany(args: any): Promise<{ count: number }>;
  };
}
export interface PacSyncDatabase {
  fecPacSyncState: PacSyncTransaction['fecPacSyncState'];
  $transaction<T>(
    fn: (tx: PacSyncTransaction) => Promise<T>,
    options?: { timeout: number },
  ): Promise<T>;
}

export async function syncPacCycle(
  db: PacSyncDatabase,
  fetchFec: FecFetcher,
  committeeId: string,
  cycle: number,
) {
  const where = { committeeId_cycle: { committeeId, cycle } };
  const startedAt = new Date();
  const runId = randomUUID();
  const ownedState = { committeeId, cycle, runId };
  await db.fecPacSyncState.upsert({
    where,
    create: { ...ownedState, status: 'running', startedAt },
    update: { status: 'running', runId, startedAt, lastError: null },
  });
  try {
    const rows = new Map<string, Contribution>();
    let sourceRowCount = 0;
    for await (const page of fecSchedulePages<ScheduleBRow>(fetchFec, '/schedules/schedule_b/', {
      committee_id: committeeId,
      two_year_transaction_period: String(cycle),
      line_number: 'F3X-23',
      sort: '-disbursement_date',
    })) {
      sourceRowCount += page.length;
      for (const row of page) {
        assertContributionScope(row, committeeId);
        if (!isPacGiving(row)) continue;
        const contribution = pacContribution(row, committeeId, cycle);
        if (rows.has(contribution.sourceSubId))
          throw new Error('FEC Schedule B repeated a source transaction');
        rows.set(contribution.sourceSubId, contribution);
      }
    }
    // The processed Schedule B endpoint is the current disclosure snapshot. Replacing
    // a whole cycle handles changed/deleted/amended transactions and cleans legacy
    // vendor rows. A failed fetch must never delete the last successful snapshot.
    await db.$transaction(
      async (tx) => {
        // This conditional write locks the coverage row through commit and fences
        // any older fetch that completes after a newer run claimed this cycle.
        const claimed = await tx.fecPacSyncState.updateMany({
          where: ownedState,
          data: {
            status: 'complete',
            completedAt: new Date(),
            lastError: null,
            sourceRowCount,
            contributionCount: rows.size,
          },
        });
        if (claimed.count !== 1) throw new Error('PAC sync was superseded by a newer run');
        await tx.fecPacContribution.deleteMany({ where: { committeeId, cycle } });
        const contributions = Array.from(rows.values());
        for (let index = 0; index < contributions.length; index += 500) {
          await tx.fecPacContribution.createMany({ data: contributions.slice(index, index + 500) });
        }
      },
      { timeout: 60_000 },
    );
    return { sourceRowCount, contributionCount: rows.size };
  } catch (error) {
    const lastError = error instanceof Error ? error.message : 'PAC sync failed';
    await db.fecPacSyncState.updateMany({
      where: ownedState,
      data: { status: 'error', lastError },
    });
    throw error;
  }
}
