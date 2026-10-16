/** Internal NON-MERI Objective resource port. A selection/observation grants no authority. */
export type ObjectiveOperationalResourceKind =
  | 'strategy'
  | 'planner_project'
  | 'planner_task'
  | 'outreach_session'
  | 'meeting'
  | 'budget_package'
  | 'defense_budget_cycle';
export interface ObjectiveOperationalSelection {
  kind: ObjectiveOperationalResourceKind;
  id: string;
}
export interface ObjectiveOperationalActor {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  clerkUserId: string;
  role: string;
}
export interface ObjectiveOperationalBinding {
  clientId: string;
  objectiveId: string;
  objectiveVersion: number;
  objectiveRevisionId: string;
}
export interface ObjectiveOperationalTx {
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}
export type ObjectiveOperationalOwnerVersion =
  | { kind: 'counter'; value: number }
  | { kind: 'timestamp'; value: string }
  | { kind: 'unversioned' };
export interface ObjectiveOperationalResource {
  selection: ObjectiveOperationalSelection;
  title: string | null;
  ownerVersion: ObjectiveOperationalOwnerVersion;
  observedAt: string;
}
export type ObjectiveOperationalStrategyType =
  | 'appropriations'
  | 'authorization'
  | 'regulatory'
  | 'coalition'
  | 'procurement'
  | 'earmark'
  | 'amendment';
export interface ObjectiveOperationalTaskObservation {
  resource: ObjectiveOperationalResource;
  status: string;
  subtype: string;
  approval: string;
  overdue: boolean;
  projectIds: string[];
  createdAt: string;
}
export interface ObjectiveOperationalSourceRead {
  resource: ObjectiveOperationalResource;
  strategyType?: ObjectiveOperationalStrategyType;
  tasks?: ObjectiveOperationalTaskObservation[];
  taskSourceUnavailable?: boolean;
  pendingProposals?: Array<{ id: string; title: string; stateVersion: number }>;
  /** Owner has pending records but cannot supply the required safe public title. */
  decisionSourceUnavailable?: boolean;
  startsAt?: string;
  endsAt?: string | null;
}
