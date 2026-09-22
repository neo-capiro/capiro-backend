import { MERI_FEDERAL_MARKET_TOOL_DEFINITIONS } from '@capiro/shared';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { FederalMarketGeographyService } from './federal-market-geography.service.js';
import { FederalMarketService } from './federal-market.service.js';
import type { FederalMarketQuery } from './federal-market.types.js';
import { resolveEvidenceAccuracyModeForTenant } from '../common/meri-evidence-accuracy-flags.js';
import { serializeFederalAwardDates } from '../common/federal-award-date-serialization.js';

export const FEDERAL_MARKET_MERI_TOOL_DEFINITIONS = MERI_FEDERAL_MARKET_TOOL_DEFINITIONS;

export type FederalMarketMeriToolName =
  (typeof FEDERAL_MARKET_MERI_TOOL_DEFINITIONS)[number]['name'];

interface JsonSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

const commonProperties: JsonSchema['properties'] = {
  clientId: {
    type: 'string',
    description:
      'Optional client UUID. In a client-scoped Meri session, the server pins this to the conversation client.',
  },
  query: { type: 'string', description: 'Keyword search over visible fields.' },
  agency: { type: 'string', description: 'Agency or office name filter.' },
  state: { type: 'string', description: 'Two-letter place-of-performance state.' },
  district: {
    type: 'string',
    description: 'Congressional district number or 00/AL for at-large.',
  },
  fiscalYear: {
    type: 'integer',
    description: 'Fiscal-year filter where the source supplies one.',
  },
  limit: { type: 'integer', description: 'Maximum rows, 1–25. Default 10.' },
};

const schemas: Record<FederalMarketMeriToolName, JsonSchema> = {
  search_federal_contract_awards: {
    type: 'object',
    properties: {
      ...commonProperties,
      recipient: { type: 'string', description: 'Recipient/contractor name filter.' },
      dateFrom: { type: 'string', description: 'Optional ISO date lower bound.' },
      dateTo: { type: 'string', description: 'Optional ISO date upper bound.' },
    },
  },
  search_federal_subawards: {
    type: 'object',
    properties: {
      ...commonProperties,
      recipient: { type: 'string', description: 'Prime or subrecipient name filter.' },
      dateFrom: { type: 'string', description: 'Optional ISO date lower bound.' },
      dateTo: { type: 'string', description: 'Optional ISO date upper bound.' },
    },
  },
  search_contract_vehicles: {
    type: 'object',
    properties: commonProperties,
  },
  search_procurement_forecasts: {
    type: 'object',
    properties: commonProperties,
  },
  get_district_federal_market: {
    type: 'object',
    properties: {
      clientId: commonProperties.clientId!,
      state: commonProperties.state!,
      district: commonProperties.district!,
      agency: commonProperties.agency!,
    },
    required: ['state', 'district'],
  },
};

function objectInput(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function limitOf(input: Record<string, unknown>): number {
  const raw = input.limit;
  if (raw == null) return 10;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 25) {
    throw new BadRequestException('limit must be an integer from 1 to 25');
  }
  return parsed;
}

function queryOf(input: Record<string, unknown>): FederalMarketQuery {
  const fiscalYearRaw = input.fiscalYear;
  const fiscalYear =
    fiscalYearRaw == null
      ? undefined
      : typeof fiscalYearRaw === 'number'
        ? fiscalYearRaw
        : Number(fiscalYearRaw);
  if (
    fiscalYear != null &&
    (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 2200)
  ) {
    throw new BadRequestException('fiscalYear must be an integer from 1900 to 2200');
  }
  const state = optionalString(input, 'state')?.toUpperCase();
  if (state && !/^[A-Z]{2}$/.test(state)) {
    throw new BadRequestException('state must be a two-letter code');
  }
  const district = optionalString(input, 'district')?.toUpperCase();
  if (district && !/^(?:[0-9]{1,2}|00|AL)$/.test(district)) {
    throw new BadRequestException('district must be 1–2 digits, 00, or AL');
  }
  return {
    clientId: optionalString(input, 'clientId'),
    q: optionalString(input, 'query'),
    agency: optionalString(input, 'agency'),
    recipient: optionalString(input, 'recipient'),
    state,
    district,
    fiscalYear,
    dateFrom: optionalString(input, 'dateFrom'),
    dateTo: optionalString(input, 'dateTo'),
    page: 1,
    pageSize: limitOf(input),
  };
}

@Injectable()
export class FederalMarketMeriToolsService {
  constructor(
    private readonly market: FederalMarketService,
    private readonly geographyMarket: FederalMarketGeographyService,
  ) {}

  has(name: string): name is FederalMarketMeriToolName {
    return FEDERAL_MARKET_MERI_TOOL_DEFINITIONS.some((tool) => tool.name === name);
  }

  anthropicSchemas() {
    return FEDERAL_MARKET_MERI_TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: schemas[tool.name],
    }));
  }

  async execute(ctx: TenantContext, name: FederalMarketMeriToolName, rawInput: unknown) {
    const input = objectInput(rawInput);
    const query = queryOf(input);
    const generatedAt = new Date().toISOString();

    if (name === 'search_federal_contract_awards') {
      const result = await this.market.listContracts(ctx.tenantId, query);
      const mode = resolveEvidenceAccuracyModeForTenant(ctx.tenantId, 'chat');
      return {
        ...result,
        items:
          mode === 'enforce'
            ? result.items.map((row) => serializeFederalAwardDates(row, true))
            : result.items,
        tool: name,
        generatedAt,
      };
    }
    if (name === 'search_federal_subawards') {
      return {
        ...(await this.market.listSubawards(ctx.tenantId, query)),
        tool: name,
        generatedAt,
      };
    }
    if (name === 'search_contract_vehicles') {
      return {
        ...(await this.market.listVehicles(ctx.tenantId, query)),
        tool: name,
        generatedAt,
      };
    }
    if (name === 'search_procurement_forecasts') {
      // Forecast search is global public data. `clientId` remains in the schema
      // so a client-scoped conversation cannot smuggle a different client, but
      // it is not used to manufacture a client match here.
      const { clientId: _clientId, ...globalQuery } = query;
      return {
        ...(await this.market.listForecasts(globalQuery)),
        tool: name,
        generatedAt,
      };
    }
    if (name === 'get_district_federal_market') {
      if (!query.state || !query.district) {
        throw new BadRequestException('state and district are required');
      }
      return {
        ...(await this.geographyMarket.geography(ctx.tenantId, query)),
        tool: name,
        generatedAt,
      };
    }

    throw new BadRequestException(`Unknown federal-market Meri tool: ${name}`);
  }
}
