import { Injectable, Logger } from '@nestjs/common';
import { classifyStatus, redact, redactWithKnownSecret, type TangoRateMetadata } from './tango.errors.js';
import type { TangoDibbsGateway } from './tango-dibbs.client.js';
import type { TangoSbirGateway } from './tango-sbir.client.js';

/**
 * The DIAGNOSTIC-ONLY probe surface — the second and last file in this
 * repository that imports `@makegov/tango-node` directly.
 *
 * ── Why a second file, when P14 said "exactly one" ───────────────────────────
 *
 * `TangoGateway` (tango.client.ts) is deliberately narrow: 8 methods, the ones
 * P19–P27's actual product code needs. P17's job is the opposite of narrow —
 * "make the smallest possible shaped call against every dataset the plan might
 * depend on, so a false assumption is caught before a phase is built around
 * it." Widening `TangoGateway` itself to ~30 rarely-used diagnostic methods
 * would pollute the contract product code actually relies on. So this is a
 * SEPARATE, clearly-labeled class: still inside `external/tango/` (the
 * boundary that matters — no code OUTSIDE this directory may ever import the
 * SDK), still redacting the same way, still going through no retry/circuit
 * logic of its own (P18 owns that; this is a one-off operator tool, run at
 * most a handful of times total).
 *
 * `tango.client.spec.ts`'s import-boundary test was updated to name both
 * files explicitly — the invariant it protects ("nothing outside
 * external/tango touches the SDK") is unchanged; only the enumeration of
 * which files INSIDE the boundary do is now two instead of one.
 *
 * ── What this must NEVER do ───────────────────────────────────────────────────
 *
 * No Prisma write. No SyncRun row. No file upload. No webhook endpoint. No
 * alert. Every probe here is a GET or the smallest possible LIST call — never
 * a create/update/delete, even a reversible one, because "reversible" still
 * means a webhook subscription or alert rule now exists against the real
 * account that did not exist before this ran. Every mutating SDK method is
 * catalogued as `not_attempted` with an explicit reason, never invoked.
 */

export const PROBE_STATUSES = [
  'supported',
  'unsupported',
  'tier_gated',
  'not_found',
  /**
   * The provider throttled this call. Says NOTHING about the capability — the
   * account simply ran out of request budget mid-run. Its own status for the
   * same reason `not_found` is: folding it into `error` makes a throttled
   * probe indistinguishable from a broken one, and a reader diffing two
   * reports would see a phantom regression.
   */
  'rate_limited',
  'error',
  'not_attempted',
] as const;
export type ProbeStatus = (typeof PROBE_STATUSES)[number];

export interface ProbeResult {
  key: string;
  /** What Capiro program area(s) this capability feeds. Empty = nothing yet planned. */
  usedByPhases: string[];
  /**
   * `not_found` is deliberately its OWN status, not folded into `error`. It
   * means the call reached the provider and got a classified 404
   * (tango.errors.ts's `classifyStatus`) — for a single-resource lookup that
   * is unambiguous ("no such record"), but for a SEARCH/LIST-shaped probe
   * (e.g. `attachment_metadata`) a 404 is itself a noteworthy finding: most
   * REST search endpoints answer "nothing matched" with 200 + an empty page,
   * not 404, so seeing 404 here is a real fact worth a human's attention
   * before P29/P30 builds on it — collapsing it into generic `error` would
   * make it indistinguishable from a genuinely broken call.
   */
  status: ProbeStatus;
  /** Always redacted. Never the raw response body verbatim. */
  reason: string;
  rate: TangoRateMetadata | null;
  durationMs: number;
}

export interface CapabilityReport {
  generatedAt: string;
  /** Wall-clock request count actually issued. Must stay <= the configured ceiling. */
  requestsIssued: number;
  requestCeiling: number;
  /**
   * Set when the FIRST probe call (a version check) itself fails with an auth
   * classification. The remaining probes are then all reported `not_attempted`
   * rather than run — hammering ~20 more guaranteed-401s against a key already
   * known to be rejected is not "the smallest possible shaped call," it is 20
   * of them for no new information.
   */
  authenticationFailed: boolean;
  probes: ProbeResult[];
}

/** Minimal shape of what this probe needs from the SDK client — kept narrow on purpose. */
interface ProbeClient {
  rateLimitInfo: TangoRateMetadata | null;
  getVersion(): Promise<unknown>;
  getEntity(uei: string, opts?: unknown): Promise<unknown>;
  listOpportunities(opts?: unknown): Promise<unknown>;
  listNotices(opts?: unknown): Promise<unknown>;
  searchOpportunityAttachments(opts: { q: string; topK?: number; includeExtractedText?: boolean }): Promise<unknown>;
  listForecasts(opts?: unknown): Promise<unknown>;
  listVehicles(opts?: unknown): Promise<unknown>;
  listVehicleAwardees(uuid: string, opts?: unknown): Promise<unknown>;
  listVehicleOrders(uuid: string, opts?: unknown): Promise<unknown>;
  listContracts(opts?: unknown): Promise<unknown>;
  listIdvs(opts?: unknown): Promise<unknown>;
  listOtas(opts?: unknown): Promise<unknown>;
  listOtidvs(opts?: unknown): Promise<unknown>;
  listProtests(opts?: unknown): Promise<unknown>;
  listBudgetAccounts(opts?: unknown): Promise<unknown>;
  getEntityBudgetFlows(uei: string, opts?: unknown): Promise<unknown>;
  listWebhookEventTypes(): Promise<unknown>;
  listWebhookEndpoints(opts?: unknown): Promise<unknown>;
  listApiKeys(): Promise<unknown>;
}

/**
 * REST surfaces that exist on the provider but are NOT wrapped by the SDK.
 *
 * Kept separate from `ProbeClient` deliberately: conflating "the SDK can do
 * this" with "the provider can do this" is exactly the error D-62 corrects.
 * A probe backed by one of these is answering a question about the PROVIDER,
 * using a client this repo wrote, not one the SDK supplied.
 */
export interface ProbeRestClients {
  dibbs: TangoDibbsGateway | null;
  sbir: TangoSbirGateway | null;
}

/**
 * One probe definition: a key, the phases that depend on it, and the call.
 *
 * `call` returns `null` when there is genuinely nothing to invoke. Read
 * `skippedReason` for WHICH of the four reasons applies — they do not all mean
 * the same thing, and collapsing them is how this file previously reported a
 * documented REST dataset as "unsupported by provider" (D-62).
 */
interface ProbeDef {
  key: string;
  usedByPhases: string[];
  call: ((client: ProbeClient, rest: ProbeRestClients) => Promise<unknown>) | null;
  /** Set only when `call` is null — WHY there is nothing to call. */
  unavailableReason?: string;
  /**
   * Distinguishes the THREE reasons `call` can be null, because they report as
   * only two DIFFERENT statuses, deliberately collapsed:
   *
   * - `unsupported_by_provider` → `unsupported`. A genuine SDK gap (no DIBBS/
   *   SBIR-STTR method, no dedicated exclusions endpoint, MCP not wrapped at
   *   all) — a fact about the provider/SDK surface itself.
   * - `no_identifier_supplied` → `not_attempted`. A fact about how THIS run
   *   was invoked (no --uei/--vehicle-uuid given), not about the provider —
   *   reporting this as `unsupported` would wrongly tell a reader the
   *   provider lacks a capability it was simply never asked to prove.
   * - `mutating_write_excluded` → `not_attempted`. The SDK DEMONSTRABLY has
   *   these methods (createWebhookEndpoint et al.) — this is not a provider
   *   gap at all. This probe's own read-only policy (see the class doc)
   *   forbids calling them. Reporting this as `unsupported` would be actively
   *   wrong: it would tell a reader the provider/SDK cannot do webhook
   *   writes, when the true fact is narrower — this diagnostic run chose not
   *   to try.
   * - `no_rest_client_wired` → `not_attempted`. The provider DOCUMENTS a REST
   *   endpoint for this dataset, but this repo has no client for it yet (or
   *   this run was not given one). A fact about Capiro's code, not about the
   *   provider. Reporting it as `unsupported` is precisely the D-62 error —
   *   it told readers "escalate to MakeGov before designing P40" about a
   *   dataset that has had a published REST API the whole time.
   */
  skippedReason?:
    | 'unsupported_by_provider'
    | 'no_identifier_supplied'
    | 'mutating_write_excluded'
    | 'no_rest_client_wired';
}

const SDK_VERSION_CHECKED = '@makegov/tango-node@1.1.0';

const NO_IDENTIFIER_REASON =
  'Not attempted: no real identifier was supplied for this probe. A made-up UEI or vehicle ' +
  'uuid would only prove the 404 path, not real access — pass --uei / --vehicle-uuid to run this check.';

/**
 * `uei`/`vehicleUuid` are OPTIONAL. An invented identifier would only prove
 * the 404 path, telling nobody anything about real access — so a probe that
 * needs one and did not get one is `not_attempted` with an explicit reason,
 * never silently skipped or run against a guess.
 */
function probes(
  uei: string | undefined,
  vehicleUuid: string | undefined,
  dibbs: TangoDibbsGateway | null,
  sbir: TangoSbirGateway | null,
): ProbeDef[] {
  return [
    { key: 'version', usedByPhases: [], call: (c) => c.getVersion() },
    {
      key: 'entities',
      usedByPhases: ['P19', 'P20', 'P21'],
      call: uei ? (c) => c.getEntity(uei) : null,
      unavailableReason: uei ? undefined : NO_IDENTIFIER_REASON,
      skippedReason: uei ? undefined : 'no_identifier_supplied',
    },
    {
      key: 'opportunities',
      usedByPhases: ['P27'],
      call: (c) => c.listOpportunities({ limit: 1 }),
    },
    {
      key: 'notice_history',
      usedByPhases: ['P28'],
      call: (c) => c.listNotices({ limit: 1 }),
    },
    {
      // The plan lists "attachment metadata" and "extracted_text" as separate
      // capabilities. They are NOT separate SDK endpoints: `extracted_text` is
      // a boolean OPTION on the one attachments-search method
      // (`includeExtractedText`), confirmed by reading the installed SDK's own
      // type declarations rather than assumed from the plan's wording. Both are
      // probed here, as two calls, so a tier gate on the flag specifically
      // (extracted text often costs more / requires a higher tier than bare
      // metadata) is visible as a SEPARATE result from the metadata-only call.
      key: 'attachment_metadata',
      usedByPhases: ['P29'],
      call: (c) => c.searchOpportunityAttachments({ q: 'a', topK: 1, includeExtractedText: false }),
    },
    {
      key: 'extracted_text',
      usedByPhases: ['P30'],
      call: (c) => c.searchOpportunityAttachments({ q: 'a', topK: 1, includeExtractedText: true }),
    },
    { key: 'forecasts', usedByPhases: ['P24', 'P25', 'P26'], call: (c) => c.listForecasts({ limit: 1 }) },
    { key: 'vehicles', usedByPhases: ['P22', 'P23'], call: (c) => c.listVehicles({ limit: 1 }) },
    {
      key: 'vehicle_awardees',
      usedByPhases: ['P22', 'P23'],
      call: vehicleUuid ? (c) => c.listVehicleAwardees(vehicleUuid, { limit: 1 }) : null,
      unavailableReason: vehicleUuid ? undefined : NO_IDENTIFIER_REASON,
      skippedReason: vehicleUuid ? undefined : 'no_identifier_supplied',
    },
    {
      key: 'vehicle_orders',
      usedByPhases: ['P22'],
      call: vehicleUuid ? (c) => c.listVehicleOrders(vehicleUuid, { limit: 1 }) : null,
      unavailableReason: vehicleUuid ? undefined : NO_IDENTIFIER_REASON,
      skippedReason: vehicleUuid ? undefined : 'no_identifier_supplied',
    },
    { key: 'contracts', usedByPhases: ['P22'], call: (c) => c.listContracts({ limit: 1 }) },
    { key: 'idvs', usedByPhases: ['P22'], call: (c) => c.listIdvs({ limit: 1 }) },
    { key: 'otas', usedByPhases: [], call: (c) => c.listOtas({ limit: 1 }) },
    { key: 'otidvs', usedByPhases: [], call: (c) => c.listOtidvs({ limit: 1 }) },
    { key: 'protests', usedByPhases: ['P45'], call: (c) => c.listProtests({ limit: 1 }) },
    {
      // No dedicated "exclusions" endpoint exists in this SDK version.
      // ENTITY_SCHEMA carries `exclusion_status_flag` / `exclusion_url` as
      // FIELDS on the entity resource (tango.shapes.ts, P14, deliberately
      // excludes both from ENTITY_FIELDS pending P45's own review design).
      // Reported unsupported-as-a-distinct-resource so P45 does not go looking
      // for an endpoint that isn't there.
      key: 'exclusions',
      usedByPhases: ['P45'],
      call: null,
      unavailableReason: `No dedicated exclusions endpoint in ${SDK_VERSION_CHECKED}. Exclusion fields ` +
        '(exclusion_status_flag, exclusion_url) are embedded on the Entity resource instead — ' +
        'probe the "entities" capability and read those fields, not a separate call.',
      skippedReason: 'unsupported_by_provider',
    },
    {
      // CORRECTED AT D-62. This probe previously reported `unsupported` with
      // "escalate to MakeGov before designing P40 around it" — which read as a
      // PROVIDER gap. The true fact was narrower and only ever about the SDK:
      // no method with "dibbs" in its name exists anywhere in
      // SDK_VERSION_CHECKED's 96-method surface. That remains true. The dataset
      // has a fully documented REST API at /api/dibbs/rfqs|rfps|awards/, so it
      // is now probed through TangoDibbsClient — the repo's own client, not the
      // SDK's.
      //
      // The smallest possible shaped call, same policy as every probe here:
      // one RFQ list, limit 1, read-only.
      key: 'dibbs',
      usedByPhases: ['P40', 'P41'],
      call: dibbs ? (_c, r) => r.dibbs!.listRfqs({ limit: 1 }) : null,
      unavailableReason: dibbs
        ? undefined
        : 'Not attempted: this run was given no DIBBS REST client. The provider DOES document ' +
          '/api/dibbs/rfqs|rfps|awards/ — this is a fact about how the probe was invoked, not about ' +
          'provider support. See decision-log D-62.',
      skippedReason: dibbs ? undefined : 'no_rest_client_wired',
    },
    {
      // Same D-62 correction as `dibbs`, and as of P42 part 1 the same
      // resolution: there IS an SBIR client now, so this is a real call when
      // one is supplied.
      //
      // Why the client came before the schema: P42's plan gates the phase on
      // "P17 must show access", and P17 reported `no_rest_client_wired` —
      // a fact about Capiro's code, not the provider (D-64). That gate could
      // never be satisfied by waiting, because nothing would ever make the
      // call. Building the client first makes the entitlement question
      // ANSWERABLE, before any table is designed around an assumption about
      // the answer.
      //
      // The smallest possible shaped call, same policy as every probe here:
      // one topic list, limit 1, read-only.
      key: 'sbir_sttr',
      usedByPhases: ['P42', 'P43'],
      call: sbir ? (_c, r) => r.sbir!.listTopics({ limit: 1 }) : null,
      unavailableReason: sbir
        ? undefined
        : 'Not attempted: this run was given no SBIR REST client. The provider DOES document ' +
          `/api/sbir/topics/ and /api/sbir/solicitations/ (no SBIR/STTR method exists in ${SDK_VERSION_CHECKED}, ` +
          'which is a fact about the SDK only — see decision-log D-62). This is a fact about how the ' +
          'probe was invoked, not about provider support.',
      skippedReason: sbir ? undefined : 'no_rest_client_wired',
    },
    {
      key: 'budget_accounts_flows',
      usedByPhases: ['P44'],
      call: (c) => c.listBudgetAccounts({ limit: 1 }),
    },
    {
      key: 'budget_flows_by_entity',
      usedByPhases: ['P44'],
      call: uei ? (c) => c.getEntityBudgetFlows(uei) : null,
      unavailableReason: uei ? undefined : NO_IDENTIFIER_REASON,
      skippedReason: uei ? undefined : 'no_identifier_supplied',
    },
    {
      key: 'webhook_event_types',
      usedByPhases: ['P46', 'P47'],
      call: (c) => c.listWebhookEventTypes(),
    },
    {
      key: 'webhook_endpoints_list',
      usedByPhases: ['P46', 'P47'],
      call: (c) => c.listWebhookEndpoints({ limit: 1 }),
    },
    {
      // THE DOCUMENTATION DISCREPANCY the plan asks this phase to resolve: does
      // "all tiers" (filter SUBSCRIPTIONS, i.e. listWebhookEventTypes above)
      // actually match what the SDK's own webhook WRITE methods
      // (createWebhookEndpoint et al.) require? This phase does not attempt the
      // write — see the class doc — so it cannot answer "would a write
      // succeed" directly. What it CAN and does report: whether the READ side
      // of webhooks (event types, existing endpoints) is reachable on this
      // key's tier, which is the necessary precondition. The write-side
      // question is marked not_attempted below with the exact reasoning a
      // human needs to resolve it out-of-band (read MakeGov's own plan-tier
      // docs, or have P46/47 perform ONE deliberate, approved test write).
      key: 'webhook_write_apis',
      usedByPhases: ['P46', 'P47'],
      call: null,
      unavailableReason: 'Not attempted: createWebhookEndpoint/createWebhookAlert/updateWebhookEndpoint/' +
        'deleteWebhookEndpoint/testWebhookEndpoint/testWebhookDelivery are all MUTATING — calling any of ' +
        'them for real would create or exercise a live webhook subscription against the account, which ' +
        'this read-only probe is explicitly forbidden from doing. The plan\'s documentation discrepancy ' +
        '("all tiers" filter subscriptions vs. SDK docs describing webhook writes as Large/Enterprise) ' +
        'is NOT resolved by this run and requires either (a) MakeGov\'s own current plan-tier ' +
        'documentation, read out-of-band, or (b) one deliberate, approved test write performed by P46/P47 ' +
        'themselves, which own the webhook feature and its rollback path.',
      skippedReason: 'mutating_write_excluded',
    },
    {
      key: 'api_keys_list',
      usedByPhases: [],
      call: (c) => c.listApiKeys(),
    },
    {
      // MCP is a SEPARATE network surface (a distinct connector endpoint), not
      // wrapped by this Node SDK at all. Testing "API-key-header compatibility"
      // for it would mean a raw HTTP request to a documented MCP endpoint URL —
      // which this implementation does not have. Reported unsupported rather
      // than guessed at, so P39 knows this specific check still needs doing
      // with real endpoint details from MakeGov's own MCP documentation.
      key: 'mcp_key_header_compatibility',
      usedByPhases: ['P39'],
      call: null,
      unavailableReason: 'Not probed: MCP is a separate connector endpoint this Node SDK does not wrap, ' +
        'and no documented MCP endpoint URL is available to this implementation. Requires MakeGov\'s own ' +
        'MCP connection details before P39 can verify API-key-header auth against it directly.',
      skippedReason: 'unsupported_by_provider',
    },
  ];
}

@Injectable()
export class TangoCapabilityProbeService {
  private readonly logger = new Logger(TangoCapabilityProbeService.name);

  /**
   * Run every probe against a live-ish client, stopping BEFORE exceeding
   * `requestCeiling`. `uei`/`vehicleUuid` are caller-supplied so the smallest
   * real, resolvable identifiers can be used — an arbitrary made-up UEI would
   * only ever prove the 404 path, not real access.
   */
  async run(
    client: ProbeClient,
    apiKey: string | null,
    options: {
      uei?: string;
      vehicleUuid?: string;
      requestCeiling: number;
      /**
       * Provider REST surfaces the SDK does not wrap. Optional: omitting it
       * reports those probes `not_attempted` with an explicit reason, never
       * `unsupported` — see ProbeDef.skippedReason and decision-log D-62.
       */
      dibbs?: TangoDibbsGateway | null;
      sbir?: TangoSbirGateway | null;
    },
  ): Promise<CapabilityReport> {
    const rest: ProbeRestClients = { dibbs: options.dibbs ?? null, sbir: options.sbir ?? null };
    const defs = probes(options.uei, options.vehicleUuid, rest.dibbs, rest.sbir);
    const results: ProbeResult[] = [];
    let issued = 0;
    let authenticationFailed = false;

    for (const def of defs) {
      if (def.call == null) {
        // `no_identifier_supplied` and `mutating_write_excluded` are both
        // facts about how/whether THIS run tried the call, not about the
        // provider's capability — they report as `not_attempted`. Only a
        // genuine SDK gap (`unsupported_by_provider`) reports as
        // `unsupported`. See the ProbeDef.skippedReason doc for why
        // collapsing these would mislead a reader.
        const status: ProbeStatus =
          def.skippedReason === 'no_identifier_supplied' ||
          def.skippedReason === 'mutating_write_excluded' ||
          def.skippedReason === 'no_rest_client_wired'
            ? 'not_attempted'
            : 'unsupported';
        results.push({
          key: def.key,
          usedByPhases: def.usedByPhases,
          status,
          reason: def.unavailableReason ?? 'Not available.',
          rate: null,
          durationMs: 0,
        });
        continue;
      }

      if (authenticationFailed) {
        results.push({
          key: def.key,
          usedByPhases: def.usedByPhases,
          status: 'not_attempted',
          reason: 'Skipped: the version preflight already identified an authentication failure. ' +
            'Running ~20 more guaranteed-401 calls against a rejected key would not add information.',
          rate: null,
          durationMs: 0,
        });
        continue;
      }

      if (issued >= options.requestCeiling) {
        results.push({
          key: def.key,
          usedByPhases: def.usedByPhases,
          status: 'not_attempted',
          reason: `Request ceiling (${options.requestCeiling}) reached before this probe ran.`,
          rate: null,
          durationMs: 0,
        });
        continue;
      }

      const started = Date.now();
      issued += 1;
      try {
        await def.call(client, rest);
        results.push({
          key: def.key,
          usedByPhases: def.usedByPhases,
          status: 'supported',
          reason: 'Call succeeded.',
          rate: client.rateLimitInfo,
          durationMs: Date.now() - started,
        });
      } catch (error) {
        const statusCode = readStatus(error);
        const body = readBody(error);
        const kind = classifyStatus(statusCode, body);
        const message = error instanceof Error ? error.message : String(error);
        // The FIRST probe is always 'version' (see the array above). An auth
        // failure there means the key itself is rejected, not that one dataset
        // is unavailable — short-circuit the rest rather than proving the same
        // fact ~20 more times.
        if (def.key === 'version' && kind === 'auth') authenticationFailed = true;
        // `rate_limited` is its OWN status for exactly the reason `not_found`
        // is: collapsing it into `error` makes a throttled probe
        // indistinguishable from a broken capability. The 2026-08-08 run
        // reported `budget_accounts_flows` as `error: Rate limit exceeded`
        // after the account's 25-per-~31s budget ran out mid-run — a reader
        // comparing against the prior report, which had it `supported`, would
        // reasonably have read a P44 regression that did not exist.
        //
        // It says NOTHING about the capability. Re-run with a lower
        // --request-ceiling, or wait out the window, to learn anything.
        const status: ProbeStatus =
          kind === 'tier'
            ? 'tier_gated'
            : kind === 'not_found'
              ? 'not_found'
              : kind === 'rate_limit'
                ? 'rate_limited'
                : 'error';
        results.push({
          key: def.key,
          usedByPhases: def.usedByPhases,
          status,
          reason: redactWithKnownSecret(redact(message), apiKey).slice(0, 300),
          rate: client.rateLimitInfo,
          durationMs: Date.now() - started,
        });
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      requestsIssued: issued,
      requestCeiling: options.requestCeiling,
      authenticationFailed,
      probes: results,
    };
  }
}

/**
 * Constructs the REAL SDK client for the probe script to hand to
 * {@link TangoCapabilityProbeService.run}.
 *
 * This — and `tango.client.ts` — are the ONLY two places in the repository
 * that reference `@makegov/tango-node`. Kept as a factory function rather than
 * inlined in the script so `apps/api/scripts/diag-tango-capabilities.ts` never
 * needs its own SDK import; it calls this and gets back the narrow
 * `ProbeClient` shape.
 *
 * Same dynamic-import reasoning as tango.client.ts (decision-log D-21): the
 * SDK is ESM-only, apps/api is CommonJS, TypeScript requires a dynamic
 * `import()` here rather than a static one, and jest.config.cjs already
 * carries the transform carve-out this needs.
 */
export async function createProbeClient(config: {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Test seam, mirroring TangoClientConfig.fetchImpl (tango.client.ts). Never set in production. */
  fetchImpl?: typeof fetch;
}): Promise<ProbeClient> {
  const sdk = await import('@makegov/tango-node');
  return new sdk.TangoClient({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    timeoutMs: config.timeoutMs ?? 30_000,
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    // No retry here either — P18 owns retry policy; a diagnostic probe run at
    // most a handful of times total does not need it, and retrying would only
    // slow down a run that is already supposed to make the smallest possible
    // number of calls.
    retries: 0,
  }) as unknown as ProbeClient;
}

function readStatus(error: unknown): number | null {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const raw = (error as { statusCode?: unknown }).statusCode;
    if (typeof raw === 'number') return raw;
  }
  return null;
}

function readBody(error: unknown): unknown {
  if (error && typeof error === 'object' && 'responseData' in error) {
    return (error as { responseData?: unknown }).responseData;
  }
  return undefined;
}
