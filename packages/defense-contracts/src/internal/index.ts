/**
 * Internal ports used during the strangler migration.
 *
 * These are dependency-inversion contracts only. They intentionally contain no
 * NestJS, Prisma, HTTP, auth, or application bootstrap concerns.
 */
export interface DefenseRequestContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly roles: readonly string[];
  readonly nowIso: string;
}

export interface ProgramElementReadPort {
  listProgramElements(context: DefenseRequestContext, query: Readonly<Record<string, unknown>>): Promise<unknown>;
  getProgramElement(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  getSummary(context: DefenseRequestContext, query?: Readonly<Record<string, unknown>>): Promise<unknown>;
  getIntelligence(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  getTimeline(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  getNarrative(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  getBills(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  getBillActions(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  getContractors(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  getProjects(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  getProcurementLines(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  getSources(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  getRelated(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  getPrograms(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  getProvisions(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  listOpportunities(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  getPositions(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  getPbComparison(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  getDeltas(
    context: DefenseRequestContext,
    peCode: string,
    query?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  getNeedsAttention(
    context: DefenseRequestContext,
    query?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

export interface ProgramElementWritePort {
  setWatch(
    context: DefenseRequestContext,
    peCode: string,
    input: Readonly<{ watching: boolean }>,
  ): Promise<unknown>;
  getAlertEmailPreference(context: DefenseRequestContext): Promise<unknown>;
  setAlertEmailPreference(
    context: DefenseRequestContext,
    input: Readonly<{ mode: string }>,
  ): Promise<unknown>;
  createDataIssue(
    context: DefenseRequestContext,
    peCode: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  listDataIssues(
    context: DefenseRequestContext,
    peCode: string | null,
    query?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  resolveDataIssue(
    context: DefenseRequestContext,
    id: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  listReconciliationQueue(
    context: DefenseRequestContext,
    query?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  resolveReconciliationQueueItem(
    context: DefenseRequestContext,
    id: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  approveReconciliationQueueItem(
    context: DefenseRequestContext,
    id: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

export interface BudgetLinesReadPort {
  getMovement(context: DefenseRequestContext, query?: Readonly<Record<string, unknown>>): Promise<unknown>;
  getGraph(context: DefenseRequestContext, query?: Readonly<Record<string, unknown>>): Promise<unknown>;
  getWatchlistSignals(context: DefenseRequestContext, query?: Readonly<Record<string, unknown>>): Promise<unknown>;
  listCapabilities(context: DefenseRequestContext, query?: Readonly<Record<string, unknown>>): Promise<unknown>;
  getCapabilityRecommendations(
    context: DefenseRequestContext,
    slug: string,
    query?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  searchCapabilities(
    context: DefenseRequestContext,
    query?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  getActions(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  getRelationships(context: DefenseRequestContext, peCode: string): Promise<unknown>;
  getIncumbents(context: DefenseRequestContext, peCode: string): Promise<unknown>;
}

export interface ProgramsPort {
  list(context: DefenseRequestContext, query?: Readonly<Record<string, unknown>>): Promise<unknown>;
  get(context: DefenseRequestContext, id: string): Promise<unknown>;
  listMatchQueue(
    context: DefenseRequestContext,
    query?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  resolveMatch(
    context: DefenseRequestContext,
    id: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  listDuplicateAliases(context: DefenseRequestContext): Promise<unknown>;
  merge(
    context: DefenseRequestContext,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  listAliases(context: DefenseRequestContext, programId: string): Promise<unknown>;
  createAlias(
    context: DefenseRequestContext,
    programId: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  updateAlias(
    context: DefenseRequestContext,
    id: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  deleteAlias(context: DefenseRequestContext, id: string): Promise<unknown>;
}

export interface DeltaEnginePort {
  deriveForProgramElement(input: Readonly<{
    peCode: string;
    snapshotId: string;
    reason: string;
  }>): Promise<Readonly<{ derived: number; superseded: number }>>;
  deriveForSnapshot(input: Readonly<{
    snapshotId: string;
    reason: string;
  }>): Promise<Readonly<{ derived: number; superseded: number; failed: number }>>;
}

export type DefenseInternalOperationId =
  | 'defense.ingest.plan'
  | 'defense.ingest.parse'
  | 'defense.ingest.persist'
  | 'defense.verify.snapshot'
  | 'defense.verify.negative-controls'
  | 'defense.snapshot.compare'
  | 'defense.snapshot.activate'
  | 'defense.promotion.plan'
  | 'defense.promotion.authorize'
  | 'defense.promotion.execute'
  | 'defense.promotion.rollback'
  | 'defense.promotion.resume';
export * from './cross-domain.js';
