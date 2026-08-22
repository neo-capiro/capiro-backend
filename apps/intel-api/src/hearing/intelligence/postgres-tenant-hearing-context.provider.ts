import type { PrismaService } from '../../prisma/prisma.service.js';
import type {
  TenantHearingClientContext,
  TenantHearingRelevanceContext,
  TenantHearingRelevanceContextProvider,
} from './public-hearing-intelligence.types.js';

interface ClientRow {
  clientId: string;
  clientName: string;
  issueCodes: string[] | null;
  naicsCodes: string[] | null;
  pscCodes: string[] | null;
}

interface WatchlistRow {
  clientId: string;
  issueAreas: string[] | null;
  tags: unknown;
}

interface TrackedBillRow {
  clientId: string;
  billId: string;
}

interface CapabilityRow {
  clientId: string;
  name: string;
  description: string | null;
  sector: string | null;
  tags: unknown;
  issueCodes: unknown;
  peNumber: string | null;
  peNumbers: string[] | null;
  keywords: string[] | null;
  serviceBranch: string | null;
  targetSubcommittee: string | null;
  appropriationAccount: string | null;
}

interface TargetRow {
  clientId: string;
  committee: string | null;
}

function add(target: Set<string>, value: unknown, max = 240): void {
  if (typeof value !== 'string') return;
  const clean = value.replace(/\s+/g, ' ').trim().slice(0, max);
  if (clean) target.add(clean);
}

/** Extract bounded string facts from the watchlist/capability JSON shapes. */
function addJsonStrings(target: Set<string>, value: unknown, depth = 0): void {
  if (depth > 4 || target.size >= 500) return;
  if (typeof value === 'string') {
    add(target, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) addJsonStrings(target, item, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    // Store values, not arbitrary JSON property names such as "priority".
    if (['tag', 'issueArea', 'name', 'label', 'value', 'synonyms', 'relatedEntities', 'riskTerms'].includes(key)) {
      addJsonStrings(target, child, depth + 1);
    }
  }
}

function sorted(values: Set<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

/**
 * Reads only tenant-owned, already-authorized context needed by the deterministic
 * matcher. Bodies are not copied into public insight storage, and this provider
 * is never called until the public insight transaction has committed.
 */
export class PostgresTenantHearingContextProvider
  implements TenantHearingRelevanceContextProvider
{
  constructor(private readonly prisma: PrismaService) {}

  async activeTenantIds(): Promise<string[]> {
    return this.prisma.withSystem(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id
         FROM tenants
         WHERE status='active'
         ORDER BY id`,
      );
      return rows.map((row) => row.id);
    });
  }

  async contextsForHearing(_hearingId: string): Promise<TenantHearingRelevanceContext[]> {
    const tenantIds = await this.activeTenantIds();
    const output: TenantHearingRelevanceContext[] = [];
    for (const tenantId of tenantIds) {
      const context = await this.contextForTenant(tenantId);
      if (context.clients.length) output.push(context);
    }
    return output;
  }

  async contextForTenant(tenantId: string): Promise<TenantHearingRelevanceContext> {
    return this.prisma.withTenant(
      tenantId,
      async (tx) => {
        const [clients, watchlists, bills, capabilities, targets] = await Promise.all([
          tx.$queryRawUnsafe<ClientRow[]>(
            `SELECT id::text AS "clientId",
                    name AS "clientName",
                    issue_codes AS "issueCodes",
                    naics_codes AS "naicsCodes",
                    psc_codes AS "pscCodes"
             FROM clients
             WHERE tenant_id=$1::uuid
             ORDER BY id`,
            tenantId,
          ),
          tx.$queryRawUnsafe<WatchlistRow[]>(
            `SELECT client_id::text AS "clientId",
                    issue_areas AS "issueAreas",
                    tags
             FROM client_watchlist
             WHERE tenant_id=$1::uuid`,
            tenantId,
          ),
          tx.$queryRawUnsafe<TrackedBillRow[]>(
            `SELECT client_id::text AS "clientId", bill_id AS "billId"
             FROM tracked_bill
             WHERE tenant_id=$1::uuid`,
            tenantId,
          ),
          tx.$queryRawUnsafe<CapabilityRow[]>(
            `SELECT client_id::text AS "clientId",
                    name,
                    description,
                    sector,
                    tags,
                    issue_codes_jsonb AS "issueCodes",
                    pe_number AS "peNumber",
                    pe_numbers AS "peNumbers",
                    keywords,
                    service_branch AS "serviceBranch",
                    target_subcommittee AS "targetSubcommittee",
                    appropriation_account AS "appropriationAccount"
             FROM client_capabilities
             WHERE tenant_id=$1::uuid`,
            tenantId,
          ),
          tx.$queryRawUnsafe<TargetRow[]>(
            `SELECT client_id::text AS "clientId", committee
             FROM client_targets
             WHERE tenant_id=$1::uuid`,
            tenantId,
          ),
        ]);

        const watchlistByClient = new Map<string, WatchlistRow[]>();
        const billsByClient = new Map<string, string[]>();
        const capabilitiesByClient = new Map<string, CapabilityRow[]>();
        const targetsByClient = new Map<string, TargetRow[]>();
        for (const row of watchlists) {
          const list = watchlistByClient.get(row.clientId) ?? [];
          list.push(row);
          watchlistByClient.set(row.clientId, list);
        }
        for (const row of bills) {
          const list = billsByClient.get(row.clientId) ?? [];
          list.push(row.billId);
          billsByClient.set(row.clientId, list);
        }
        for (const row of capabilities) {
          const list = capabilitiesByClient.get(row.clientId) ?? [];
          list.push(row);
          capabilitiesByClient.set(row.clientId, list);
        }
        for (const row of targets) {
          const list = targetsByClient.get(row.clientId) ?? [];
          list.push(row);
          targetsByClient.set(row.clientId, list);
        }

        const clientContexts: TenantHearingClientContext[] = clients.map((client) => {
          const keywords = new Set<string>();
          const billIds = new Set<string>();
          const programElementIds = new Set<string>();
          const agencies = new Set<string>();
          const committees = new Set<string>();

          // A stated client name is itself a legitimate public mention signal.
          add(keywords, client.clientName);
          for (const value of client.issueCodes ?? []) add(keywords, value);
          for (const value of client.naicsCodes ?? []) add(keywords, value);
          for (const value of client.pscCodes ?? []) add(keywords, value);

          for (const watchlist of watchlistByClient.get(client.clientId) ?? []) {
            for (const value of watchlist.issueAreas ?? []) add(keywords, value);
            addJsonStrings(keywords, watchlist.tags);
          }
          for (const billId of billsByClient.get(client.clientId) ?? []) add(billIds, billId);

          for (const capability of capabilitiesByClient.get(client.clientId) ?? []) {
            add(keywords, capability.name);
            add(keywords, capability.description);
            add(keywords, capability.sector);
            for (const value of capability.keywords ?? []) add(keywords, value);
            addJsonStrings(keywords, capability.tags);
            addJsonStrings(keywords, capability.issueCodes);
            add(programElementIds, capability.peNumber);
            for (const value of capability.peNumbers ?? []) add(programElementIds, value);
            add(agencies, capability.serviceBranch);
            add(agencies, capability.appropriationAccount);
            add(committees, capability.targetSubcommittee);
          }
          for (const target of targetsByClient.get(client.clientId) ?? []) {
            add(committees, target.committee);
          }

          return {
            clientId: client.clientId,
            clientName: client.clientName,
            keywords: sorted(keywords).slice(0, 500),
            billIds: sorted(billIds).slice(0, 500),
            programElementIds: sorted(programElementIds).slice(0, 500),
            agencies: sorted(agencies).slice(0, 250),
            committees: sorted(committees).slice(0, 250),
          };
        });

        return { tenantId, clients: clientContexts };
      },
      { timeoutMs: 30_000 },
    );
  }
}
