import type { SettledProfileV1Sources } from './client-profile-v1-sources.js';
import type { ProfileV1Context } from './client-profile-v1.shared.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ProfileV1Ports } from './client-profile-v1.shared.js';
import { billStage, passageProbability } from '@capiro/shared';

export function buildProfileV1Kanban(values: SettledProfileV1Sources) {
  const { trackedBills } = values;
  const kanbanColumns: Array<{
    id: 'introduced' | 'committee' | 'passed' | 'enacted';
    label: string;
    count: number;
    bills: Array<{
      identifier: string;
      title: string;
      latestActionDate: Date | null;
      latestActionText: string | null;
      probability: number;
      isManual: boolean;
    }>;
  }> = [
    { id: 'introduced', label: 'Introduced', count: 0, bills: [] },
    { id: 'committee', label: 'In Committee', count: 0, bills: [] },
    { id: 'passed', label: 'Passed Chamber', count: 0, bills: [] },
    { id: 'enacted', label: 'Enacted', count: 0, bills: [] },
  ];
  const columnById = new Map(kanbanColumns.map((c) => [c.id, c]));
  for (const bill of trackedBills.bills) {
    const stage = billStage(bill.latestActionText, bill.status, bill.actionTexts);
    const col = columnById.get(stage);
    if (!col) continue;
    col.count += 1;
    col.bills.push({
      identifier: bill.identifier,
      title: bill.title,
      latestActionDate: bill.latestActionDate ? new Date(bill.latestActionDate) : null,
      latestActionText: bill.latestActionText,
      probability: passageProbability(bill),
      isManual: (bill as { isManual?: boolean }).isManual ?? false,
    });
  }
  for (const col of kanbanColumns) {
    // Manually pinned bills sort to the top of each column, then by passage
    // probability — a deliberate pin should never be buried below auto matches.
    col.bills.sort((a, b) => {
      if (a.isManual !== b.isManual) return a.isManual ? -1 : 1;
      return b.probability - a.probability;
    });
    col.bills = col.bills.slice(0, 12);
  }
  return kanbanColumns;
}

export function prepareProfileV1HearingScope(values: SettledProfileV1Sources) {
  const { trackedBills } = values;
  const billTitleVariants = trackedBills.bills.map((b) => {
    const parts = b.identifier.split('-');
    const variants: string[] = [];
    if (parts.length === 3 && parts[1] && parts[2]) {
      const chamber = parts[1].toLowerCase(); // hr, s, hres, sres, hjres…
      const num = parts[2];
      variants.push(`${chamber} ${num}`);
      variants.push(`${chamber}${num}`);
      // Dotted long form for the common House/Senate prefixes.
      if (chamber === 'hr') variants.push(`h.r. ${num}`);
      if (chamber === 's') variants.push(`s. ${num}`);
    }
    return { identifier: b.identifier, variants };
  });
  const jurisdictionCommitteeNames = new Set<string>();
  const jurisdictionCommitteeCodes = new Set<string>();
  const trackedBillIdList = trackedBills.bills
    .map((b) => b.identifier)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  const normalizeCommittee = (value: string | null | undefined): string =>
    (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return {
    billTitleVariants,
    jurisdictionCommitteeNames,
    jurisdictionCommitteeCodes,
    trackedBillIdList,
    normalizeCommittee,
  };
}

export async function readProfileV1CommitteeJurisdiction(
  prisma: PrismaService,
  ports: Pick<ProfileV1Ports, 'warn'>,
  clientId: string,
  scope: ReturnType<typeof prepareProfileV1HearingScope>,
) {
  const {
    trackedBillIdList,
    jurisdictionCommitteeNames,
    jurisdictionCommitteeCodes,
    normalizeCommittee,
  } = scope;
  try {
    const committeeRows = await prisma.$queryRaw<
      Array<{ committee_name: string; committee_code: string | null }>
    >`
          SELECT DISTINCT cbc.committee_name, cbc.committee_code
          FROM congress_bill_committee cbc
          WHERE cbc.bill_id = ANY(${trackedBillIdList}::text[])
            AND cbc.committee_name IS NOT NULL
            AND cbc.committee_name <> ''
        `;
    for (const row of committeeRows) {
      const name = normalizeCommittee(row.committee_name);
      if (name) jurisdictionCommitteeNames.add(name);
      if (row.committee_code) jurisdictionCommitteeCodes.add(row.committee_code.toLowerCase());
    }
  } catch (err) {
    ports.warn(
      `hearings client-scoping committee join failed for client ${clientId}: ${(err as Error).message}`,
    );
  }
}

export function buildProfileV1Hearings(
  values: SettledProfileV1Sources,
  scope: ReturnType<typeof prepareProfileV1HearingScope>,
) {
  const { hearings } = values;
  const {
    billTitleVariants,
    jurisdictionCommitteeNames,
    jurisdictionCommitteeCodes,
    normalizeCommittee,
  } = scope;
  const jurisdictionNameList = Array.from(jurisdictionCommitteeNames);
  const hearingsList = hearings
    .map((h) => {
      const titleLower = h.title.toLowerCase();
      const linked = billTitleVariants
        .filter((b) => b.variants.some((v) => titleLower.includes(v)))
        .map((b) => b.identifier);
      const hearingCommittee = normalizeCommittee(h.committeeName);
      const hearingCode = (h.committeeCode ?? '').toLowerCase();
      // Committee-of-jurisdiction match: exact normalized name, OR committee
      // code, OR one name being a substring of the other (handles "Committee
      // on Armed Services" vs "Armed Services" / chamber-prefixed variants).
      const committeeMatch =
        (hearingCommittee.length > 0 &&
          (jurisdictionCommitteeNames.has(hearingCommittee) ||
            jurisdictionNameList.some(
              (j) => j.includes(hearingCommittee) || hearingCommittee.includes(j),
            ))) ||
        (hearingCode.length > 0 && jurisdictionCommitteeCodes.has(hearingCode));
      return {
        id: h.id,
        committeeName: h.committeeName,
        chamber: h.chamber,
        title: h.title,
        date: h.date,
        time: h.time,
        type: h.type,
        linkedBills: linked,
        isTracked: linked.length > 0 || committeeMatch,
      };
    })
    // Drop the global (non-client-relevant) calendar entries: a hearing is
    // kept only when it cites a tracked bill (linkedBills) or is held by a
    // committee with jurisdiction over a tracked bill (isTracked).
    .filter((h) => h.isTracked);
  return hearingsList;
}
