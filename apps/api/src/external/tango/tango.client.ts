import { Injectable, Logger } from '@nestjs/common';
import {
  TangoError,
  TangoNotConfiguredError,
  classifyStatus,
  redactUnknown,
  redactWithKnownSecret,
  type TangoRateMetadata,
} from './tango.errors.js';
import {
  mapEntity,
  mapForecast,
  mapNotice,
  mapOpportunity,
  mapVehicle,
  mapVehicleAwardee,
} from './tango.mappers.js';
import { TANGO_SHAPES } from './tango.shapes.js';
import type {
  TangoEntity,
  TangoEntityListOptions,
  TangoForecast,
  TangoForecastListOptions,
  TangoGateway,
  TangoListOptions,
  TangoNotice,
  TangoNoticeListOptions,
  TangoOpportunity,
  TangoOpportunityListOptions,
  TangoPage,
  TangoVehicle,
  TangoVehicleListOptions,
  TangoVehicleAwardee,
} from './tango.types.js';

/**
 * The MakeGov/Tango boundary.
 *
 * ── This is the ONLY file in the repository that imports the SDK ─────────────
 *
 * Enforced by a test, not by convention. Everything upstream of here programs
 * against `TangoGateway`, so:
 *
 *   - a vendor concept (dynamic shapes, `Record<string, unknown>` responses,
 *     the SDK's own error taxonomy) cannot leak into a product service;
 *   - every later phase can fake the whole provider by implementing one
 *     interface with checked-in fixtures;
 *   - swapping or removing the SDK is a change to one file.
 *
 * ── A missing key is a STATE, not a failure ──────────────────────────────────
 *
 * The constructor never throws and never touches the network, so a deployment
 * with no `TANGO_API_KEY` boots normally and every product read keeps serving
 * local data. Calling a method in that state raises
 * {@link TangoNotConfiguredError}, which is deliberately a different type from an
 * auth failure: "we never had a credential" is a configuration task and "the
 * credential was rejected" is an incident.
 *
 * ── What this file deliberately does NOT do ──────────────────────────────────
 *
 * No retry. No circuit breaker. No usage persistence. No metrics. Those are P18,
 * and putting them here would mean two places decide when to give up. The SDK's
 * own retry is turned OFF for the same reason — it would silently multiply every
 * request against an account-level rate limit that P18 has not yet learned to
 * respect, and its backoff would be invisible to the ceiling P18 enforces.
 *
 * What it DOES do is surface typed rate metadata from every response, which is
 * the input P18 needs.
 */

/**
 * THE SDK IS ESM-ONLY AND apps/api IS COMMONJS. This is why the import is dynamic.
 *
 * `@makegov/tango-node@1.1.0` declares `"type": "module"` and ships no CommonJS
 * build. apps/api compiles to CJS (`module: Node16`, no `"type"` in
 * package.json), and TypeScript REFUSES a static import of an ESM package from a
 * CJS file — TS1479, whose own message says to write a dynamic `import()` instead.
 *
 * So that is what this is. Under `module: Node16` the compiler PRESERVES
 * `import()`, and Node resolves it through the real ESM loader. Under jest,
 * ts-jest compiles to CommonJS so `import()` becomes a `require`, and
 * `jest.config.cjs` transforms this one package down to CJS so that require
 * succeeds — carved out by `transformIgnorePatterns`, so nothing else in
 * node_modules is affected.
 *
 * Three simpler things were tried and rejected first:
 *   - a static import: TS1479 at typecheck, and dead at jest collection;
 *   - `new Function('return import(s)')`: jest's VM intercepts it and demands
 *     `--experimental-vm-modules`;
 *   - `createRequire(__filename)`: still lands in jest's patched compiler.
 *
 * A SIDE BENEFIT worth keeping: the SDK module is not loaded until the first
 * provider call, so a deployment with no key never even parses it.
 */
type TangoSdk = typeof import('@makegov/tango-node', { with: { 'resolution-mode': 'import' } });
type SdkClient = InstanceType<TangoSdk['TangoClient']>;

let sdkPromise: Promise<TangoSdk> | null = null;
function loadSdk(): Promise<TangoSdk> {
  sdkPromise ??= import('@makegov/tango-node');
  return sdkPromise;
}

/**
 * Provider page size.
 *
 * MAX_LIMIT is 100 because that is the SDK's own hard cap
 * (`Math.min(limit, 100)` in its list helpers). Clamping to anything higher here
 * would be a lie: the caller would be told 500 and 100 would be sent, and a sync
 * sizing its request ceiling off the number it asked for would be wrong by 5x.
 */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

export interface TangoClientConfig {
  /** Absent means "not configured", which is a normal state. */
  apiKey?: string | null;
  /** HTTPS only. Validated by the config schema in P16. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Test seam. Never set in production; the SDK falls back to global fetch. */
  fetchImpl?: typeof fetch;
}

@Injectable()
export class TangoGatewayService implements TangoGateway {
  private readonly logger = new Logger(TangoGatewayService.name);
  private readonly apiKey: string | null;
  private readonly config: TangoClientConfig;
  private clientPromise: Promise<SdkClient> | null = null;
  private rate: TangoRateMetadata | null = null;

  constructor(config: TangoClientConfig = {}) {
    this.config = config;
    this.apiKey = config.apiKey?.trim() ? config.apiKey.trim() : null;
    if (!this.apiKey) {
      this.logger.log(
        'MakeGov/Tango is not configured (no API key). Provider calls are unavailable; ' +
          'no product read depends on them.',
      );
    }
  }

  /**
   * Configured means "a key exists", NOT "the SDK has finished loading".
   *
   * Synchronous on purpose: callers ask this to decide whether to attempt
   * anything at all, and an async predicate would make every guard a place to
   * forget an `await`.
   */
  get configured(): boolean {
    return this.apiKey != null;
  }

  get lastRate(): TangoRateMetadata | null {
    return this.rate;
  }

  // ── Calls ─────────────────────────────────────────────────────────────────

  async getVersion(): Promise<Record<string, unknown>> {
    return this.call('getVersion', (c) => c.getVersion());
  }

  /**
   * One entity by exact UEI.
   *
   * Returns NULL for a 404 rather than throwing. A UEI Tango does not hold is
   * explicit unresolved evidence — a fact worth recording — and making the caller
   * catch an exception to learn it invites a bare try/catch that swallows the
   * auth failures too.
   */
  async getEntity(uei: string): Promise<TangoEntity | null> {
    const fetchedAt = new Date().toISOString();
    const raw = await this.callAllowingNotFound('getEntity', (c) =>
      c.getEntity(uei, { shape: TANGO_SHAPES.entity }),
    );
    if (raw == null) return null;
    return mapEntity(raw, fetchedAt);
  }

  async listEntities(options: TangoEntityListOptions = {}): Promise<TangoPage<TangoEntity>> {
    return this.page('listEntities', 'entity', mapEntity, (c, base) =>
      c.listEntities({
        ...base,
        shape: TANGO_SHAPES.entity,
        ...(options.uei ? { uei: options.uei } : {}),
        ...(options.naics ? { naics: options.naics } : {}),
        ...(options.state ? { state: options.state } : {}),
      }),
      options,
    );
  }

  async listOpportunities(
    options: TangoOpportunityListOptions = {},
  ): Promise<TangoPage<TangoOpportunity>> {
    return this.page('listOpportunities', 'opportunity', mapOpportunity, (c, base) =>
      c.listOpportunities({
        ...base,
        shape: TANGO_SHAPES.opportunity,
        ...(options.solicitationNumber
          ? { solicitation_number: options.solicitationNumber }
          : {}),
        ...(options.naics ? { naics: options.naics } : {}),
        ...(options.psc ? { psc: options.psc } : {}),
        ...(options.changedSince ? { last_notice_date_after: options.changedSince } : {}),
        ...(options.active != null ? { active: options.active } : {}),
      }),
      options,
    );
  }

  async listNotices(options: TangoNoticeListOptions = {}): Promise<TangoPage<TangoNotice>> {
    return this.page('listNotices', 'notice', mapNotice, (c, base) =>
      c.listNotices({
        ...base,
        shape: TANGO_SHAPES.notice,
        ...(options.solicitationNumber
          ? { solicitation_number: options.solicitationNumber }
          : {}),
        ...(options.naics ? { naics: options.naics } : {}),
        ...(options.psc ? { psc: options.psc } : {}),
        ...(options.postedSince ? { posted_date_after: options.postedSince } : {}),
        ...(options.active != null ? { active: options.active } : {}),
      }),
      options,
    );
  }

  async listForecasts(options: TangoForecastListOptions = {}): Promise<TangoPage<TangoForecast>> {
    return this.page('listForecasts', 'forecast', mapForecast, (c, base) =>
      c.listForecasts({
        ...base,
        shape: TANGO_SHAPES.forecast,
        ...(options.changedSince ? { modified_after: options.changedSince } : {}),
        ...(options.fiscalYear ? { fiscal_year: options.fiscalYear } : {}),
        ...(options.naics ? { naics_code: options.naics } : {}),
        ...(options.agency ? { agency: options.agency } : {}),
      }),
      options,
    );
  }

  async listVehicles(options: TangoVehicleListOptions = {}): Promise<TangoPage<TangoVehicle>> {
    return this.page('listVehicles', 'vehicle', mapVehicle, (c, base) =>
      c.listVehicles({
        ...base,
        shape: TANGO_SHAPES.vehicle,
        ...(options.naics ? { naics_code: options.naics } : {}),
        ...(options.psc ? { psc_code: options.psc } : {}),
        ...(options.agency ? { agency: options.agency } : {}),
        ...(options.vehicleType ? { vehicle_type: options.vehicleType } : {}),
      }),
      options,
    );
  }

  async listVehicleAwardees(
    vehicleId: string,
    options: TangoListOptions = {},
  ): Promise<TangoPage<TangoVehicleAwardee>> {
    return this.page('listVehicleAwardees', 'vehicleAwardee', mapVehicleAwardee, (c, base) =>
      c.listVehicleAwardees(vehicleId, { ...base, shape: TANGO_SHAPES.vehicleAwardee }),
      options,
    );
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  /**
   * The SDK client, constructed on first use and memoised.
   *
   * The unconfigured check happens BEFORE the import, so an unconfigured
   * deployment never loads the SDK module at all.
   */
  private async requireClient(operation: string): Promise<SdkClient> {
    if (!this.apiKey) throw new TangoNotConfiguredError(operation);
    this.clientPromise ??= loadSdk().then(
      (sdk) =>
        new sdk.TangoClient({
          apiKey: this.apiKey!,
          ...(this.config.baseUrl ? { baseUrl: this.config.baseUrl } : {}),
          timeoutMs: this.config.timeoutMs ?? 30_000,
          ...(this.config.fetchImpl ? { fetchImpl: this.config.fetchImpl } : {}),
          // OFF, on purpose. See the class comment: P18 owns retry, and the SDK
          // retrying underneath it would multiply requests against an account
          // limit invisibly to the ceiling P18 enforces.
          retries: 0,
        }),
    );
    return this.clientPromise;
  }

  private clampLimit(limit: number | undefined): number {
    if (limit == null || !Number.isFinite(limit)) return DEFAULT_LIMIT;
    return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
  }

  /** One provider call, with rate capture and error classification. */
  private async call<T>(operation: string, run: (c: SdkClient) => Promise<T>): Promise<T> {
    const client = await this.requireClient(operation);
    try {
      const result = await run(client);
      this.captureRate(client);
      return result;
    } catch (error) {
      this.captureRate(client);
      throw this.wrap(operation, error);
    }
  }

  /** As {@link call}, but a 404 resolves to null instead of throwing. */
  private async callAllowingNotFound<T>(
    operation: string,
    run: (c: SdkClient) => Promise<T>,
  ): Promise<T | null> {
    try {
      return await this.call(operation, run);
    } catch (error) {
      if (error instanceof TangoError && error.kind === 'not_found') return null;
      throw error;
    }
  }

  /** One page of a list endpoint, mapped and normalized. */
  private async page<TDomain>(
    operation: string,
    _shapeName: string,
    map: (raw: Record<string, unknown>, fetchedAt: string) => TDomain | null,
    run: (
      c: SdkClient,
      base: { limit: number; cursor?: string | null },
    ) => Promise<{ results: Array<Record<string, unknown>>; count: number; cursor: string | null }>,
    options: TangoListOptions,
  ): Promise<TangoPage<TDomain>> {
    const fetchedAt = new Date().toISOString();
    const base = {
      limit: this.clampLimit(options.limit),
      ...(options.cursor ? { cursor: options.cursor } : {}),
    };
    const response = await this.call(operation, (c) => run(c, base));
    const items: TDomain[] = [];
    let unmappable = 0;
    for (const raw of response.results ?? []) {
      const mapped = map(raw, fetchedAt);
      // A record with no usable identifier is DROPPED and COUNTED, never
      // half-mapped. A row Capiro cannot key is not evidence.
      if (mapped == null) unmappable += 1;
      else items.push(mapped);
    }
    if (unmappable > 0) {
      this.logger.warn(
        `${operation}: dropped ${unmappable} provider record(s) with no usable identifier`,
      );
    }
    return {
      items,
      totalCount: typeof response.count === 'number' ? response.count : null,
      nextCursor: response.cursor ?? null,
      rate: this.rate,
    };
  }

  private captureRate(client: SdkClient): void {
    const info = client.rateLimitInfo;
    this.rate = info
      ? {
          remaining: info.remaining ?? null,
          limit: info.limit ?? null,
          resetIn: info.resetIn ?? null,
          retryAfter: info.retryAfter ?? null,
          limitType: info.limitType ?? null,
        }
      : null;
  }

  /**
   * SDK error → classified, redacted {@link TangoError}.
   *
   * `TangoNotConfiguredError` passes through untouched: it is not a provider
   * failure and must not be classified as one.
   */
  private wrap(operation: string, error: unknown): unknown {
    if (error instanceof TangoNotConfiguredError) return error;
    if (error instanceof TangoError) return error;

    const status = readStatus(error);
    const body = readBody(error);
    const message = error instanceof Error ? error.message : String(error);
    const kind = status == null && isTimeout(error) ? 'transient' : classifyStatus(status, body);

    const detail = summarise(body, this.apiKey);
    return new TangoError(redactWithKnownSecret(message, this.apiKey), {
      kind,
      operation,
      statusCode: status,
      detail,
      rate: this.rate,
      cause: error,
    });
  }
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

function isTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  return /timeout|aborted|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(
    `${name} ${message}`,
  );
}

/** A bounded, redacted one-line summary of a response body. */
function summarise(body: unknown, secret: string | null): string | null {
  if (body == null) return null;
  const safe = redactUnknown(body, secret);
  const text = typeof safe === 'string' ? safe : JSON.stringify(safe);
  if (!text) return null;
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
