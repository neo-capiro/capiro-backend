import type { AxiosInstance } from 'axios';

/**
 * Web API for a client's FEC money flow — specifically the client's OWN PAC
 * disbursements (Schedule B).
 *
 * Mirrors apps/api/src/intelligence/intelligence.controller.ts
 * (GET /api/intelligence/clients/:clientId/fec-money-flow → service
 * getFecMoneyFlow, whose `pacGiving` block comes from the private getPacGiving).
 *
 * ── Two facts this file exists to keep distinguishable ──────────────────────
 *
 * `tracked: false` means NO FEC committee has been mapped to this client, so
 * nothing can be said about its giving. It is NOT "this client gave $0" — the
 * same distinction `district-nexus-api.ts` draws with `linked: false`, and the
 * reason `summary` is optional: the untracked early-return path omits it
 * entirely rather than sending zeroes that would render as real totals.
 *
 * Deliberately a PARTIAL mirror. The endpoint also returns individual
 * employer-linked contributions (`committees`, `summary`, `contributionType`),
 * which are a different kind of money with different disclosure rules; nothing
 * consumes them here, so they are not typed here. Add them when a surface
 * actually renders them rather than mirroring fields no caller reads.
 */

export interface PacRecipient {
  recipientName: string;
  candidateName: string | null;
  totalAmount: number;
}

export interface PacCommittee {
  committeeId: string;
  committeeName: string | null;
  totalAmount: number;
  disbursementCount: number;
  recipients: PacRecipient[];
}

export interface PacGiving {
  /** False = no committee mapped for this client. Never render as $0. */
  tracked: boolean;
  committees: PacCommittee[];
  /** Absent on the untracked path — see the file docblock. */
  summary?: { totalAmount: number; disbursementCount: number; recipientCount: number };
  coverage?: {
    status: 'unmapped' | 'pending' | 'partial' | 'error' | 'complete';
    cycles: number[];
    lastSyncedAt: string | null;
    message: string | null;
  };
}

/** A mapped committee without verified ingestion is not evidence of zero giving. */
export function pacGivingStatus(giving: PacGiving): NonNullable<PacGiving['coverage']>['status'] {
  if (!giving.tracked) return 'unmapped';
  return giving.coverage?.status ?? ((giving.summary?.disbursementCount ?? 0) > 0 ? 'partial' : 'pending');
}

export function pacGivingAmount(giving: PacGiving): number | null {
  if (!giving.tracked || !giving.summary) return null;
  return pacGivingStatus(giving) === 'complete' || giving.summary.disbursementCount > 0
    ? giving.summary.totalAmount
    : null;
}

export function pacGivingPeriod(giving: PacGiving): string {
  const cycles = [...new Set(giving.coverage?.cycles ?? [])].sort((a, b) => a - b);
  return cycles.length > 0
    ? `${cycles.join(', ')} election cycle${cycles.length === 1 ? '' : 's'}`
    : 'Reporting period unavailable';
}

export interface ClientFecMoneyFlow {
  pacGiving?: PacGiving;
  /** Legal/compliance text; the API is the single source of truth for it. */
  disclaimer?: string;
}

export async function getClientFecMoneyFlow(
  api: AxiosInstance,
  clientId: string,
): Promise<ClientFecMoneyFlow> {
  return (
    await api.get<ClientFecMoneyFlow>(
      `/api/intelligence/clients/${encodeURIComponent(clientId)}/fec-money-flow`,
    )
  ).data;
}

/** Top recipients across every mapped committee, largest first. */
export function topPacRecipients(giving: PacGiving, limit = 3): PacRecipient[] {
  const merged = new Map<string, PacRecipient>();
  for (const committee of giving.committees) {
    for (const recipient of committee.recipients) {
      const key = `${recipient.recipientName}::${recipient.candidateName ?? ''}`;
      const existing = merged.get(key);
      if (existing) existing.totalAmount += recipient.totalAmount;
      else merged.set(key, { ...recipient });
    }
  }
  return [...merged.values()].sort((a, b) => b.totalAmount - a.totalAmount).slice(0, limit);
}
