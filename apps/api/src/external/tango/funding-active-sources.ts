/**
 * Active-only descriptors for the two provider catalogs the consolidated
 * funding writer ingests beyond grants and SAM notices: the DLA bid board
 * (DIBBS) and SBIR/STTR.
 *
 * These are DESCRIPTORS, not a pipeline. Paging, quota accounting, retry
 * behaviour and the durable cursor all belong to `FundingCatalogClient` and
 * `walk()` in sync-tango-funding, which already do exactly this for grants and
 * notices. Each descriptor below supplies only what genuinely differs: the
 * provider path, the provider's own lifecycle filter, the field shape to request,
 * the existing mapper, and the one store write.
 *
 * ACTIVE ONLY. `open: true` and `activity: 'open'` are the provider's documented
 * lifecycle filters, so a solicitation opened weeks ago with a future close date
 * is covered without inferring activity from an issue date. DIBBS awards are
 * deliberately absent: an award is a historical award fact, not an opportunity.
 */
import { CatalogQuotaPause } from './funding-catalog.client.js';
import type { RecordData } from './funding-catalog.mapper.js';
import type { FundingCatalogResource, TangoCheckpointResourceType } from './tango.types.js';
import { DIBBS_PROVIDER_UUID, mapDibbsRfp, mapDibbsRfq, type TangoDibbsSolicitationRow } from './tango-dibbs.mapper.js';
import { mapSbirSolicitation, mapSbirTopic, type TangoSbirSolicitationRow, type TangoSbirTopicRow } from './tango-sbir.mapper.js';

/** The exact row each mapper produces — no `RecordData`, no `as never`. */
export type ActiveSourceRow = TangoDibbsSolicitationRow | TangoSbirTopicRow | TangoSbirSolicitationRow;

export type ActiveSourceLane = 'dibbs' | 'sbir';

/** Fixed page size for every active endpoint. Never changed mid-run. */
export const ACTIVE_SOURCE_PAGE_SIZE = 100;

/**
 * Explicit topic projection. The provider's DEFAULT topic list omits
 * `description`, so mapping it without asking for it would store nothing while
 * looking correct. Field names are the ones a parent-authorized live contract
 * read exercised (HTTP 200, ROOT/outputs/SCRUM250-PROVIDER-CONTRACT-20261103.json).
 */
export const SBIR_TOPIC_SHAPE =
  'topic_id,title,topic_number,solicitation_number,cycle_name,agency,description,activity,open_date,close_date,release_date,year,solicitation_status,listed_open,topic_url,official_solicitation_url,source_last_updated';

/**
 * DIBBS shapes are SPLIT per endpoint. The provider rejects an unknown field
 * with HTTP 400, and RFQ-only fields (`purchase_request`, `quantity`,
 * `unit_of_issue`, `set_aside`, `status_code`, `issue_date`, `return_by_date`)
 * do not exist on RFP, whose own fields (`buyer_code`, `issued_date`,
 * `closes_date`, `tech_docs_url`) do not exist on RFQ. One shared list would
 * fail the first real call.
 */
const DIBBS_RFQ_SHAPE =
  'uuid,solicitation,solicitation_formatted,purchase_request,nsn,part_number,nomenclature,quantity,unit_of_issue,set_aside,status_code,issue_date,return_by_date,is_open,document_url';

const DIBBS_RFP_SHAPE =
  'uuid,solicitation,nsn,part_number,nomenclature,buyer_code,issued_date,closes_date,is_open,document_url,tech_docs_url';

const SBIR_SOLICITATION_SHAPE =
  'solicitation_id,solicitation_number,title,program,cycle_name,year,activity,start_date,end_date,out_of_cycle,solicitation_status,sol_download_url';

export interface ActiveSourceEndpoint {
  /** Provider endpoint segment, used in the checkpoint fingerprint. */
  endpoint: string;
  resource: FundingCatalogResource;
  /** Checkpoint type for THIS table — never shared with a sibling endpoint. */
  checkpointResource: TangoCheckpointResourceType;
  /** Provider filters. Active lifecycle plus the explicit shape. */
  filter: RecordData;
  /**
   * Existing source mapper. Returns null when the record has no provider
   * identity; the lane treats a null as a skipped record and keeps the page
   * honest, while a THROWN mapper error stops the page so it is replayed.
   */
  map: (raw: RecordData) => ActiveSourceRow | null;
}

export interface ActiveSourceLaneDefinition {
  lane: ActiveSourceLane;
  /** The legacy SyncRun verb this lane reports under, so health is unchanged. */
  syncSource: 'sync-tango-dibbs' | 'sync-tango-sbir';
  endpoints: ActiveSourceEndpoint[];
}

export const ACTIVE_SOURCE_LANES: Record<ActiveSourceLane, ActiveSourceLaneDefinition> = {
  dibbs: {
    lane: 'dibbs',
    syncSource: 'sync-tango-dibbs',
    endpoints: [
      {
        endpoint: 'rfq',
        resource: 'dibbs/rfqs',
        checkpointResource: 'dibbs_solicitation',
        filter: { open: true, shape: DIBBS_RFQ_SHAPE },
        map: (raw) => mapDibbsRfq(raw),
      },
      {
        endpoint: 'rfp',
        resource: 'dibbs/rfps',
        checkpointResource: 'dibbs_solicitation',
        filter: { open: true, shape: DIBBS_RFP_SHAPE },
        map: (raw) => mapDibbsRfp(raw),
      },
    ],
  },
  sbir: {
    lane: 'sbir',
    syncSource: 'sync-tango-sbir',
    endpoints: [
      {
        endpoint: 'topic',
        resource: 'sbir/topics',
        checkpointResource: 'sbir_topic',
        filter: { activity: 'open', shape: SBIR_TOPIC_SHAPE },
        map: (raw) => mapSbirTopic(raw),
      },
      {
        endpoint: 'solicitation',
        resource: 'sbir/solicitations',
        checkpointResource: 'sbir_solicitation',
        filter: { activity: 'open', shape: SBIR_SOLICITATION_SHAPE },
        map: (raw) => mapSbirSolicitation(raw),
      },
    ],
  },
};

/**
 * A locally-open row the completed sweep did not refresh.
 * `providerId` is the VERIFIED provider key the row already stores — never a
 * reconstructed or guessed one.
 */
export interface UnseenActiveRow {
  localId: string;
  providerId: string;
}

export interface ClosureAdapters {
  /** Locally-open, not-yet-expired rows of THIS endpoint older than the epoch. */
  unseen(epochIso: string, limit: number): Promise<UnseenActiveRow[]>;
  /** Provider detail by verified id; null when the provider answers 404. */
  detail(providerId: string): Promise<RecordData | null>;
  /** Clear only the derived lifecycle flag and bump the observation time. */
  markUnconfirmed(localId: string): Promise<void>;
}

export interface ClosureResult {
  checked: number;
  confirmed: number;
  unconfirmed: number;
  complete: boolean;
}

function matchesStoredProviderId(mapped: ActiveSourceRow, storedId: string): boolean {
  if (!('tangoDibbsId' in mapped)) return mapped.tangoSbirId === storedId;
  const detailId = mapped.tangoDibbsId;
  if (detailId === storedId) return true;
  return DIBBS_PROVIDER_UUID.test(detailId) && DIBBS_PROVIDER_UUID.test(storedId)
    && detailId.toLowerCase() === storedId.toLowerCase();
}

/**
 * Exact re-check of previously-active rows, after an endpoint's active walk
 * COMPLETED.
 *
 * Absence from a mutable active list is NOT evidence of closure, so this never
 * retires by absence. For each unseen row it re-reads the provider detail for
 * the id the row already stores:
 *   - detail confirms closed/withdrawn → the normal mapper + upsert records the
 *     real lifecycle and dates;
 *   - detail answers 404 → the row is marked unconfirmed (derived flag only,
 *     ids/content preserved);
 *   - a different id comes back, or the record cannot be mapped → NOTHING is
 *     written, because a mismatch is not a closure;
 *   - the shared quota stops the walk → the pass reports incomplete and the
 *     remaining rows are picked up by the next bounded run.
 */
export async function reconcileUnconfirmedActive(
  endpoint: ActiveSourceEndpoint,
  epochIso: string,
  adapters: ClosureAdapters,
  options: { persist: (row: ActiveSourceRow) => Promise<void>; limit?: number },
): Promise<ClosureResult> {
  const limit = options.limit ?? 100;
  const rows = await adapters.unseen(epochIso, limit);
  let confirmed = 0;
  let unconfirmed = 0;
  let checked = 0;
  let complete = rows.length < limit;
  for (const row of rows) {
    checked += 1;
    let detail: RecordData | null;
    try {
      detail = await adapters.detail(row.providerId);
    } catch (error) {
      // Budget/reserve reached: stop and let the next invocation continue. Any
      // other failure is a real error and must not be read as a closure.
      if (error instanceof CatalogQuotaPause) return { checked, confirmed, unconfirmed, complete: false };
      throw error;
    }
    if (detail == null) {
      await adapters.markUnconfirmed(row.localId);
      unconfirmed += 1;
      continue;
    }
    const mapped = endpoint.map(detail);
    // A detail we cannot map, or one whose identity is not the row we asked for,
    // means this pass could NOT establish coverage. Report incomplete instead of
    // counting it as checked-and-fine.
    if (mapped == null || !matchesStoredProviderId(mapped, row.providerId)) {
      return { checked, confirmed, unconfirmed, complete: false };
    }
    await options.persist(mapped);
    confirmed += 1;
  }
  return { checked, confirmed, unconfirmed, complete };
}
