import { Logger } from '@nestjs/common';
import { embedText } from '../../../src/embeddings/embedder.js';
import type { PrismaService } from '../../../src/prisma/prisma.service.js';
import { SourceDataRepository } from '../../../src/sourcedata/source-data.repository.js';
import { StateSourceDataRepository } from '../../../src/sourcedata/state-source-data.repository.js';
import { TrackerBoardService } from '../../../src/tracker/tracker-board.service.js';
import { TrackerWatchlistService } from '../../../src/tracker/tracker-watchlist.service.js';
import { NewMatchDetectorService } from '../../../src/tracker/new-match-detector.service.js';
import type { CompiledTopicForFit } from '../../../src/tracker/bill-fit.util.js';
import { now } from './rows.js';
import { FixtureIo, type IOCall, type Options } from './io.js';
export type { IOCall, Options } from './io.js';

jest.mock('../../../src/embeddings/embedder.js', () => ({
  ...jest.requireActual('../../../src/embeddings/embedder.js'),
  embedText: jest.fn(),
}));

export interface PrivateSubject {
  compiledTopics(
    tenantId: string,
    clientId: string,
  ): Promise<{
    topics: CompiledTopicForFit[];
    issueAreas: string[];
    terms: string[];
    jurisdictions: string[];
  }>;
  compileTopicsForClients(
    tenantId: string,
    clientIds: string[],
  ): Promise<Map<string, { topics: CompiledTopicForFit[]; issueAreas: string[] }>>;
}
export interface Harness {
  service: TrackerBoardService;
  subject: PrivateSubject;
  worker: NewMatchDetectorService;
  prisma: PrismaService;
  repo: SourceDataRepository;
  stateRepo: StateSourceDataRepository;
  watchlists: TrackerWatchlistService;
  calls: IOCall[];
  events: string[];
  callsOf(operation: string): IOCall[];
  started(operation: string): Promise<void>;
  queue(operation: string, ...values: unknown[]): void;
}
export function installHooks() {
  beforeEach(() => {
    jest.useFakeTimers({ now, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No fixture network'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.mocked(embedText).mockReset().mockRejectedValue(new Error('Offline embedding boundary'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
}

export function harness(options: Options = {}): Harness {
  const io = new FixtureIo(options);
  const repo = new SourceDataRepository(io.prisma);
  const stateRepo = new StateSourceDataRepository(io.prisma);
  const watchlists = new TrackerWatchlistService(io.prisma);
  const service = new TrackerBoardService(io.prisma, repo, watchlists, stateRepo);
  return {
    service,
    subject: service as unknown as PrivateSubject,
    worker: new NewMatchDetectorService(io.prisma, service),
    prisma: io.prisma,
    repo,
    stateRepo,
    watchlists,
    calls: io.calls,
    events: io.events,
    callsOf: (operation) => io.callsOf(operation),
    queue: (operation, ...values) => io.queue(operation, ...values),
    started: (operation) => io.started(operation),
  };
}

export function args(call: IOCall): Record<string, unknown> {
  return call.args[0] as Record<string, unknown>;
}

export { embedText };
