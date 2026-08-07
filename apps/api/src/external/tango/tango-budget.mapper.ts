import type { Prisma } from '@prisma/client';
import { int, num, str } from './tango.mappers.js';

/**
 * MakeGov/Tango budget-account and vendor-flow mapping (P44).
 *
 * â”€â”€ The field names here were observed live, not inferred â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 *
 * The SDK declares NO schema for `/api/budget/accounts/` â€” `listBudgetAccounts`
 * goes through `_genericPaginatedList` and returns `AnyRecord`, so nothing in
 * the package states what a row contains. Deriving the field names from
 * `ListBudgetAccountsOptions`' filter names would have been a guess, and this
 * program has four decision-log entries (D-35, D-41, D-42, D-45) about what
 * guessing a provider shape costs. The names below come from a read-only probe
 * of the real account on 2026-09-01: one page of `/api/budget/accounts/`, one
 * `/quarters/` page and one `/recipients/` page, plus the server's own
 * `available_fields` error payload.
 *
 * Two findings from that probe are encoded here rather than left as prose:
 *
 *   1. MOST MONEY FIELDS WERE NULL on a genuine row while `contract_obligated`
 *      carried a number. `enacted_ba`, `requested_ba`, `apportioned`,
 *      `obligated_total`, `outlayed_total` and `unobligated_balance` were all
 *      null together. An account the provider has not attributed is not an
 *      account with no money, so every one of them maps to `number | null` and
 *      never to 0.
 *   2. `agency_code` WAS NULL beside a populated `agency_name`. The account's
 *      own agency identifier is not guaranteed, which is why nothing downstream
 *      may join on it alone.
 *
 * â”€â”€ Allow-listed, like every other mapper in this directory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 *
 * `pick` restricts the raw record to the fields named below. An unrequested or
 * newly-added provider field cannot enter a normalized object, so a provider
 * release cannot silently widen what Capiro stores.
 */

/**
 * Allow-list a raw record down to the fields named.
 *
 * A LOCAL helper rather than `tango.mappers.ts`'s `pick`, and the difference is
 * the point: that one is keyed on a shape NAME registered in
 * `tango.shapes.ts`, and every entry there mirrors a schema the SDK actually
 * declares. The budget resource declares none â€” `listBudgetAccounts` returns
 * `AnyRecord` â€” so registering a shape for it would put a Capiro-invented field
 * list in a file whose whole contract is "these mirror the SDK". The list lives
 * here instead, next to the note recording where it came from.
 */
function pickFields(
  raw: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of fields) if (Object.hasOwn(raw, key)) out[key] = raw[key];
  return out;
}

/** The fields P44 reads from a budget-account row. Observed live. */
export const BUDGET_ACCOUNT_FIELDS = [
  'id',
  'federal_account_symbol',
  'fiscal_year',
  'account_title',
  'agency_code',
  'agency_name',
  'bureau_name',
  'bea_category',
  'on_off_budget',
  'subfunction_code',
  'requested_ba',
  'enacted_ba',
  'apportioned',
  'obligated_total',
  'outlayed_total',
  'unobligated_balance',
  'contract_obligated',
  'assistance_obligated',
  'attribution_status',
  'attribution_confidence',
] as const;

/** The fields P44 reads from a `/recipients/` row. Observed live. */
export const BUDGET_RECIPIENT_FIELDS = [
  'funding_organization_id',
  'recipient_id',
  'contract_obligated',
  'contract_outlayed',
  'n_contracts',
  'funding_office',
  'recipient',
] as const;

/** Capiro's normalized budget account. */
export interface TangoBudgetAccountRecord {
  /** The provider's own row id. Integer, and the sync's upsert key. */
  accountRowId: number;
  federalAccountSymbol: string;
  fiscalYear: number;
  accountTitle: string;
  agencyCode: string | null;
  agencyName: string | null;
  bureauName: string | null;
  beaCategory: string | null;
  onOffBudget: string | null;
  subfunctionCode: string | null;
  /** Every one nullable. Null is not zero â€” see the file doc. */
  money: {
    requestedBa: number | null;
    enactedBa: number | null;
    apportioned: number | null;
    obligatedTotal: number | null;
    outlayedTotal: number | null;
    unobligatedBalance: number | null;
    contractObligated: number | null;
    assistanceObligated: number | null;
  };
  /** The provider's own confidence in its attribution, carried verbatim. */
  attributionStatus: string | null;
  attributionConfidence: string | null;
  fetchedAt: string;
}

export interface TangoBudgetVendorFlowRecord {
  recipientUei: string;
  recipientName: string | null;
  fundingOrganizationId: string | null;
  fundingOfficeCode: string | null;
  fundingOfficeName: string | null;
  fundingAgencyCode: string | null;
  fundingAgencyName: string | null;
  contractObligated: number | null;
  contractOutlayed: number | null;
  contractCount: number | null;
}

/**
 * Map one raw budget-account row.
 *
 * Returns null when the record has no usable IDENTITY â€” no provider row id, no
 * account symbol, or no fiscal year. Dropped rather than written with an
 * invented placeholder, matching `toForecastRow`'s posture for a title-less
 * forecast: a row keyed on a fabricated identifier is worse than a row Capiro
 * never stored, because the next sync creates a second one.
 *
 * `account_title` is also required, and for a different reason: it is the only
 * human-readable thing on the row. A panel showing "097-0400" with no title is
 * a number nobody can act on.
 */
export function mapBudgetAccount(
  raw: Record<string, unknown>,
  fetchedAt: string,
): TangoBudgetAccountRecord | null {
  const r = pickFields(raw, BUDGET_ACCOUNT_FIELDS);

  const accountRowId = int(r.id);
  const federalAccountSymbol = str(r.federal_account_symbol);
  const fiscalYear = int(r.fiscal_year);
  const accountTitle = str(r.account_title);
  if (accountRowId == null || !federalAccountSymbol || fiscalYear == null || !accountTitle) {
    return null;
  }

  return {
    accountRowId,
    federalAccountSymbol,
    fiscalYear,
    accountTitle,
    agencyCode: str(r.agency_code),
    agencyName: str(r.agency_name),
    bureauName: str(r.bureau_name),
    beaCategory: str(r.bea_category),
    onOffBudget: str(r.on_off_budget),
    subfunctionCode: str(r.subfunction_code),
    money: {
      requestedBa: num(r.requested_ba),
      enactedBa: num(r.enacted_ba),
      apportioned: num(r.apportioned),
      obligatedTotal: num(r.obligated_total),
      outlayedTotal: num(r.outlayed_total),
      unobligatedBalance: num(r.unobligated_balance),
      contractObligated: num(r.contract_obligated),
      assistanceObligated: num(r.assistance_obligated),
    },
    attributionStatus: str(r.attribution_status),
    attributionConfidence: str(r.attribution_confidence),
    fetchedAt,
  };
}

/**
 * Map one raw `/recipients/` row, if its recipient is a UEI Capiro knows.
 *
 * `knownUeis` is the relevance filter, applied HERE rather than after mapping:
 * the provider's recipients endpoint returns every recipient of an account, and
 * the overwhelming majority are read, checked and discarded â€” the same
 * discipline P22 applied to vehicle awardees. Mapping first and filtering later
 * would allocate a normalized object for every federal contractor on the
 * account.
 *
 * A UEI is always 12 characters (the database enforces it too); anything else
 * is a mapping bug that would silently match no client, which reads as "this
 * vendor received nothing".
 */
export function mapBudgetVendorFlow(
  raw: Record<string, unknown>,
  knownUeis: ReadonlySet<string>,
): TangoBudgetVendorFlowRecord | null {
  const r = pickFields(raw, BUDGET_RECIPIENT_FIELDS);

  const recipient = isRecord(r.recipient) ? r.recipient : {};
  const uei = str(recipient.uei);
  if (!uei || uei.length !== 12 || !knownUeis.has(uei)) return null;

  const office = isRecord(r.funding_office) ? r.funding_office : {};

  return {
    recipientUei: uei,
    // The provider carries both a legal name and a DBA. The legal name is the
    // one that matches a Capiro client record; the DBA is a trading name and
    // using it would produce a row a reader cannot reconcile.
    recipientName: str(recipient.legal_business_name),
    fundingOrganizationId: str(r.funding_organization_id) ?? str(office.organization_id),
    fundingOfficeCode: str(office.office_code),
    fundingOfficeName: str(office.office_name),
    fundingAgencyCode: str(office.agency_code),
    fundingAgencyName: str(office.agency_name),
    contractObligated: num(r.contract_obligated),
    contractOutlayed: num(r.contract_outlayed),
    contractCount: int(r.n_contracts),
  };
}

// â”€â”€ Persistence shapes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type TangoBudgetAccountRow = Omit<
  Prisma.TangoBudgetAccountCreateInput,
  'id' | 'vendorFlows' | 'firstSyncedAt' | 'lastSyncedAt' | 'createdAt' | 'updatedAt'
>;

/**
 * The second mapping step: domain object â†’ database row.
 *
 * Kept separate from `mapBudgetAccount` for the reason `tango-forecast.mapper`
 * states: a provider quirk is the first step's problem, a storage decision is
 * this one's, and conflating them means every future provider change risks
 * touching persistence code.
 *
 * `snapshot` carries the full normalized record so a debugging session can see
 * what the provider actually said without a second call. It is overwritten on
 * upsert, not versioned â€” the fiscal-year dimension already IS this resource's
 * history axis.
 */
export function toBudgetAccountRow(record: TangoBudgetAccountRecord): TangoBudgetAccountRow {
  return {
    tangoAccountRowId: record.accountRowId,
    federalAccountSymbol: record.federalAccountSymbol,
    fiscalYear: record.fiscalYear,
    accountTitle: record.accountTitle,
    agencyCode: record.agencyCode,
    agencyName: record.agencyName,
    bureauName: record.bureauName,
    beaCategory: record.beaCategory,
    onOffBudget: record.onOffBudget,
    subfunctionCode: record.subfunctionCode,
    requestedBa: record.money.requestedBa,
    enactedBa: record.money.enactedBa,
    apportioned: record.money.apportioned,
    obligatedTotal: record.money.obligatedTotal,
    outlayedTotal: record.money.outlayedTotal,
    unobligatedBalance: record.money.unobligatedBalance,
    contractObligated: record.money.contractObligated,
    assistanceObligated: record.money.assistanceObligated,
    attributionStatus: record.attributionStatus,
    attributionConfidence: record.attributionConfidence,
    snapshot: record as unknown as Prisma.InputJsonValue,
    sourceUrl: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
