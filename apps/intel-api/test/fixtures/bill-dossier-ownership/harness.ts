import { BillDossierService } from '../../../src/bill-dossier/bill-dossier.service.js';
import type { SourceDataRepository } from '../../../src/sourcedata/source-data.repository.js';
import type { StateSourceDataRepository } from '../../../src/sourcedata/state-source-data.repository.js';
import type {
  BillContext,
  BillDossierResponse,
  BillKpi,
  BillVote,
  DossierOverview,
  FundingBlock,
  LatestAction,
} from '../../../src/bill-dossier/bill-dossier.types.js';
import { identity, stateBill, now, type AlertRow } from './rows.js';

const sourceMethods = [
  'getBillDossierIdentity',
  'getBillActions',
  'getBillVotes',
  'getGoverningRules',
  'getBillCommittees',
  'getBillFiscalNotes',
  'getBillSourceFreshness',
  'getUpcomingHearingsForBills',
  'getBillMemberVoteSummary',
  'getBillFundingPositions',
  'getBillProgramElementImpacts',
  'getRelatedBudgetVehicles',
  'getBillFundingProvisions',
  'getParentBudgetPackage',
  'getClientProfile',
] as const satisfies readonly (keyof SourceDataRepository)[];
const stateMethods = [
  'getStateBillById',
  'getStateBillActionsByIds',
  'getStateVotesForBills',
  'getMovedCompanions',
  'getRecordPage',
  'getVoteMembers',
] as const satisfies readonly (keyof StateSourceDataRepository)[];
export type SourcePort = Pick<SourceDataRepository, (typeof sourceMethods)[number]>;
export type StatePort = Pick<StateSourceDataRepository, (typeof stateMethods)[number]>;
export type Operation =
  | (typeof sourceMethods)[number]
  | (typeof stateMethods)[number]
  | 'tracking'
  | 'alerts'
  | 'match'
  | 'clientHearings';
export interface Call {
  operation: Operation;
  scope: 'global-source' | 'global-state' | 'tenant';
  args: unknown[];
  tenantId?: string;
  transaction?: number;
}
export interface Transaction {
  id: number;
  tenantId: string;
  outcome?: 'commit' | 'rollback';
}
export interface Options {
  results?: Partial<Record<Operation, unknown>>;
  queues?: Partial<Record<Operation, unknown[]>>;
  errors?: Partial<Record<Operation, unknown>>;
}
export interface Subject {
  loadFunding(
    id: string,
  ): Promise<{ block: FundingBlock; relatedVehicles: BillDossierResponse['relatedVehicles'] }>;
  buildFederalCore(id: string, opts?: { funding?: boolean }): Promise<BillDossierResponse>;
  buildStateCore(id: string): Promise<BillDossierResponse>;
  buildKpis(
    status: string,
    at: string | null,
    stage: string | null,
    latest: LatestAction,
    votes: BillVote[],
    tracking: BillContext | null,
    funding: FundingBlock | null,
  ): BillKpi[];
  mergeAnalystOverview(
    base: DossierOverview,
    tracking: BillContext | null,
    alerts?: AlertRow[],
  ): DossierOverview;
}
export interface Harness {
  service: BillDossierService;
  subject: Subject;
  source: SourcePort;
  state: StatePort;
  calls: Call[];
  events: string[];
  transactions: Transaction[];
  callsOf(operation: Operation): Call[];
  started(operation: Operation): Promise<void>;
}
interface IoState {
  options: Options;
  calls: Call[];
  events: string[];
  positions: Map<Operation, number>;
  signals: Map<Operation, Array<() => void>>;
}
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}
export function installHooks() {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['performance'] });
    jest.setSystemTime(now);
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider I/O forbidden'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
}
async function respond(state: IoState, call: Call, fallback: unknown): Promise<unknown> {
  state.calls.push(call);
  state.events.push(call.operation);
  state.signals.get(call.operation)?.forEach((resolve) => resolve());
  state.signals.delete(call.operation);
  const options = state.options;
  if (Object.hasOwn(options.errors ?? {}, call.operation)) throw options.errors![call.operation];
  const queue = options.queues?.[call.operation],
    index = state.positions.get(call.operation) ?? 0;
  let value: unknown;
  if (queue && index < queue.length) {
    state.positions.set(call.operation, index + 1);
    value = queue[index];
  } else if (Object.hasOwn(options.results ?? {}, call.operation))
    value = options.results![call.operation];
  else value = fallback;
  if (value instanceof Error) throw value;
  return typeof value === 'function' ? (value as (call: Call) => unknown)(call) : value;
}
function repository(state: IoState, methods: readonly Operation[], scope: Call['scope']) {
  const defaults: Partial<Record<Operation, unknown>> = {
    getBillDossierIdentity: identity(),
    getStateBillById: stateBill(),
    getBillSourceFreshness: null,
    getParentBudgetPackage: null,
    getClientProfile: { name: 'Acme', sectorTag: null },
    getRecordPage: { rows: [], total: 0 },
  };
  return Object.fromEntries(
    methods.map((operation) => [
      operation,
      jest.fn((...args: unknown[]) =>
        respond(
          state,
          { operation, scope, args },
          Object.hasOwn(defaults, operation) ? defaults[operation] : [],
        ),
      ),
    ]),
  );
}
function prismaIo(state: IoState) {
  const transactions: Transaction[] = [];
  const withTenant = jest.fn(async <T>(tenant: string, work: (tx: unknown) => Promise<T>) => {
    const transaction: Transaction = { id: transactions.length + 1, tenantId: tenant };
    transactions.push(transaction);
    state.events.push('tenant.begin');
    const io = (operation: Operation, fallback: unknown) =>
      jest.fn((...args: unknown[]) =>
        respond(
          state,
          { operation, scope: 'tenant', tenantId: tenant, transaction: transaction.id, args },
          fallback,
        ),
      );
    const alerts = jest.fn((...args: unknown[]) => {
      const query = args[0] as { where: { sourceType: string } };
      const operation = query.where.sourceType === 'combined' ? 'clientHearings' : 'alerts';
      return respond(
        state,
        { operation, scope: 'tenant', tenantId: tenant, transaction: transaction.id, args },
        [],
      );
    });
    const tx = {
      trackedBill: { findFirst: io('tracking', null) },
      intelAlert: { findMany: alerts },
      billMatch: { findFirst: io('match', null) },
    };
    try {
      const result = await work(tx);
      transaction.outcome = 'commit';
      state.events.push('tenant.commit');
      return result;
    } catch (error) {
      transaction.outcome = 'rollback';
      state.events.push('tenant.rollback');
      throw error;
    }
  });
  return { prisma: { withTenant }, transactions };
}
function started(state: IoState, operation: Operation): Promise<void> {
  if (state.calls.some((call) => call.operation === operation)) return Promise.resolve();
  return new Promise((resolve) => {
    const signals = state.signals.get(operation) ?? [];
    signals.push(resolve);
    state.signals.set(operation, signals);
  });
}
export function harness(options: Options = {}): Harness {
  const state: IoState = {
    options,
    calls: [],
    events: [],
    positions: new Map(),
    signals: new Map(),
  };
  const source = repository(state, sourceMethods, 'global-source') as unknown as SourcePort;
  const stateSource = repository(state, stateMethods, 'global-state') as unknown as StatePort;
  const { prisma, transactions } = prismaIo(state);
  const service = new BillDossierService(
    prisma as unknown as ConstructorParameters<typeof BillDossierService>[0],
    source as SourceDataRepository,
    stateSource as StateSourceDataRepository,
  );
  return {
    service,
    subject: service as unknown as Subject,
    source,
    state: stateSource,
    calls: state.calls,
    events: state.events,
    transactions,
    callsOf: (operation) => state.calls.filter((call) => call.operation === operation),
    started: (operation) => started(state, operation),
  };
}
export const federalBundle: readonly Operation[] = [
  'getBillActions',
  'getBillVotes',
  'getGoverningRules',
  'getBillCommittees',
  'getBillFiscalNotes',
  'getBillSourceFreshness',
  'getUpcomingHearingsForBills',
];
export const fundingBundle: readonly Operation[] = [
  'getBillFundingPositions',
  'getBillProgramElementImpacts',
  'getRelatedBudgetVehicles',
  'getBillFundingProvisions',
  'getParentBudgetPackage',
];
export const contextBundle: readonly Operation[] = [
  'tracking',
  'alerts',
  'match',
  'clientHearings',
];
