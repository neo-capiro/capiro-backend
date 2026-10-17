import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { ObjectiveWorkOwnerPort } from './objective-work.service.js';
import { ObjectivePlannerWorkOwner } from './objective-planner-work-owner.js';
import { ObjectiveStrategyWorkOwner } from './objective-strategy-work-owner.js';
import type { ObjectiveStrategySelectionRequest } from './objective-strategy-selection.js';
import { unavailableObjectiveWorkOutputs, type ObjectiveWorkOutputRequest } from './objective-work-output.js';
import type { StoredWorkReceipt, WorkAction, WorkAuthority, WorkReadRequest, WorkRequest, WorkState } from './objective-work-command.js';

type Tx = Prisma.TransactionClient;
/** Routes to the real action owners; Planner's existing authority stays local. */
export class ObjectiveWorkOwnerRouter implements ObjectiveWorkOwnerPort {
  constructor(readonly planner = new ObjectivePlannerWorkOwner(), readonly strategy = new ObjectiveStrategyWorkOwner()) {}
  private owner(action: WorkAction): ObjectiveWorkOwnerPort { return action === 'objective.plan.prepare' ? this.planner : this.strategy; }
  bindStrategySelectionWithinTx(tx: Tx, ctx: TenantContext, request: ObjectiveStrategySelectionRequest) {
    this.strategy.bindStrategySelectionWithinTx(tx, ctx, request);
  }
  reserveStrategyWithinTx(tx: Tx, a: WorkAuthority, stored: StoredWorkReceipt, request: ObjectiveStrategySelectionRequest) {
    return this.strategy.reserveStrategyWithinTx(tx, a, stored, request);
  }
  observeLockedStrategyStateWithinTx(tx: Tx, a: WorkAuthority, action: WorkAction, state: WorkState) {
    this.strategy.observeLockedStrategyStateWithinTx(tx, a, action, state);
  }
  lockWithinTx(tx: Tx, ctx: TenantContext, request: WorkRequest) { return this.owner(request.command.workAction).lockWithinTx(tx, ctx, request); }
  async lockReadWithinTx(tx: Tx, ctx: TenantContext, request: WorkReadRequest) { await this.owner(request.workAction).lockReadWithinTx?.(tx, ctx, request); }
  reconcileWithinTx(tx: Tx, a: WorkAuthority, action: WorkAction, state: WorkState) { return this.owner(action).reconcileWithinTx(tx, a, action, state); }
  policyWithinTx(tx: Tx, a: WorkAuthority, action: WorkAction, state: WorkState) { return this.owner(action).policyWithinTx(tx, a, action, state); }
  outputsWithinTx(tx: Tx, ctx: TenantContext, a: WorkAuthority, state: WorkState, request: ObjectiveWorkOutputRequest, observedAt: string) {
    return this.owner(request.workAction).outputsWithinTx?.(tx, ctx, a, state, request, observedAt)
      ?? Promise.resolve(unavailableObjectiveWorkOutputs());
  }
}
