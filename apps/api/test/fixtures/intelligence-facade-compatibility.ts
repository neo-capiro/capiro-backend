import { Logger } from '@nestjs/common';
import {
  IntelligenceService,
  AWARD_BEARING_MAPPING_SOURCES,
} from '../../src/intelligence/intelligence.service.js';
import type { ProfileV1Ports } from '../../src/intelligence/client-profile-v1.shared.js';
import type { RelevantBillPorts } from '../../src/intelligence/intelligence-bill-discovery.shared.js';
import type { ClientRelationshipsV1Ports } from '../../src/intelligence/client-relationships-v1.js';
import type { ClientMappingV1ReviewPorts } from '../../src/intelligence/client-mapping-v1-review.js';
import type { ClientFinancialLobbyingPorts } from '../../src/intelligence/client-financial-v1.types.js';
import type {
  ClientRegulatoryPorts,
  ClientAlertsPorts,
} from '../../src/intelligence/client-alerts-v1.shared.js';
import type { PortfolioAlertsPorts } from '../../src/intelligence/intelligence-portfolio-alerts.js';

export const now = new Date('2026-10-13T12:00:00.000Z');
export const clientId = 'client-one';
export const tenantId = 'tenant-one';
export interface Policies {
  PORTFOLIO_ALERTS_TTL_MS: number;
  PORTFOLIO_ALERTS_REQUEST_BUDGET_MS: number;
  PROFILE_V1_SOURCE_BUDGET_MS: number;
  PROFILE_V1_SLOW_SOURCE_MS: number;
}
export const policies = IntelligenceService as unknown as Policies;
export const awardSources = AWARD_BEARING_MAPPING_SOURCES as Set<string>;
export interface Fields {
  prisma: unknown;
  prepopulation: unknown;
  officeRecommender: unknown;
  logger: Pick<Logger, 'warn'>;
  portfolioAlertsCache: Map<string, { expiresAt: number; value: unknown }>;
  portfolioAlertsInflight: Map<string, Promise<unknown>>;
  portfolioAlertsGate: Promise<unknown>;
  profileV1: { prisma: unknown; ports: ProfileV1Ports };
  relevantBillDiscovery: { prisma: unknown; ports: RelevantBillPorts };
  clientSources: {
    identityProfile: { getClientProfile: IntelligenceService['getClientProfile'] };
    identityLda: { ports: Pick<ClientFinancialLobbyingPorts, 'pickLdaClientIds'> };
    mappingReview: { ports: ClientMappingV1ReviewPorts };
  };
  supportingSources: {
    financial: { ports: ClientFinancialLobbyingPorts };
    relationships: { ports: ClientRelationshipsV1Ports };
  };
  finalSources: {
    regulatory: { ports: ClientRegulatoryPorts };
    alerts: { ports: ClientAlertsPorts };
    portfolioAlerts: { ports: PortfolioAlertsPorts };
  };
}
export type Subject = Omit<IntelligenceService, never> & {
  confirmedLdaIds(client: string, tenant: string): Promise<number[]>;
  pickLdaClientIds(cached: number[] | null | undefined, confirmed: string[]): number[];
  withSourceBudget<T>(label: string, client: string, work: Promise<T>): Promise<T>;
};
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}
export function installHooks() {
  let originalPolicies: Policies;
  let originalSources: string[];
  beforeEach(() => {
    originalPolicies = {
      PORTFOLIO_ALERTS_TTL_MS: policies.PORTFOLIO_ALERTS_TTL_MS,
      PORTFOLIO_ALERTS_REQUEST_BUDGET_MS: policies.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS,
      PROFILE_V1_SOURCE_BUDGET_MS: policies.PROFILE_V1_SOURCE_BUDGET_MS,
      PROFILE_V1_SLOW_SOURCE_MS: policies.PROFILE_V1_SLOW_SOURCE_MS,
    };
    originalSources = [...awardSources];
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider forbidden'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    Object.assign(policies, originalPolicies);
    awardSources.clear();
    for (const source of originalSources) awardSources.add(source);
    jest.useRealTimers();
  });
}
export function harness(optional = true) {
  const forbidden = jest.fn((..._args: unknown[]) => {
    throw new Error('Facade characterization forbids external I/O');
  });
  const prisma = {
    withTenant: forbidden,
    $queryRaw: forbidden,
    $queryRawUnsafe: forbidden,
    $executeRawUnsafe: forbidden,
  };
  const prepopulation = { prepopulate: forbidden };
  const officeRecommender = { recommend: forbidden };
  const service = new IntelligenceService(
    prisma as never,
    optional ? (prepopulation as never) : undefined,
    optional ? (officeRecommender as never) : undefined,
  );
  const fields = service as unknown as Fields;
  const warnings: string[] = [];
  const warn = jest.spyOn(fields.logger, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(String(args[0]));
  });
  return {
    service,
    subject: service as unknown as Subject,
    fields,
    prisma,
    prepopulation,
    officeRecommender,
    forbidden,
    warn,
    warnings,
  };
}
