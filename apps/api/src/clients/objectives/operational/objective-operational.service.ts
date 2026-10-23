import { Injectable } from '@nestjs/common';
import {
  lockObjectivePlanResource,
  readObjectivePlanResource,
  type ObjectiveOperationalActor,
  type ObjectiveOperationalBinding,
  type ObjectiveOperationalSelection,
  type ObjectiveOperationalSourceRead,
  type ObjectiveOperationalTx,
  type TenantContext,
} from '@capiro/shared';
import { PrismaService } from '../../../prisma/prisma.service.js';
import {
  lockObjectiveLocalResource,
  readObjectiveLocalResource,
  validateObjectiveCycleContext,
  type ObjectiveLocalResourceGate,
} from './objective-local-resources.js';
import { ObjectiveOperationalCursors } from './objective-operational.cursor.js';
import { assembleOperationalProjection } from './objective-operational.projection.js';
import {
  OperationalBoundaryError,
  operationalDigest,
  operationalFailure,
} from './objective-operational.rules.js';
import {
  commitOperationalCommand,
  findOperationalReceipt,
  listOperationalLinks,
  loadCurrentOperationalScopeWithinTx,
  matchOperationalReplay,
  readOperationalSetVersion,
  type OperationalLinkRecord,
} from './objective-operational.store.js';
import type {
  OperationalCommand,
  OperationalAssociationsRequest,
  OperationalAssociationsPage,
  OperationalReadRequest,
  OperationalReceiptRequest,
  OperationalScope,
} from './objective-operational.types.js';

const PLAN_KINDS = ['strategy', 'planner_project', 'planner_task'];
function actorFrom(ctx: TenantContext): ObjectiveOperationalActor {
  if (!ctx?.tenantId || !ctx.userId || !ctx.clerkUserId) operationalFailure('UNAUTHENTICATED');
  if (!['standard_user', 'user_admin', 'capiro_admin'].includes(ctx.role))
    operationalFailure('FORBIDDEN');
  return ctx;
}
function binding(scope: OperationalScope): ObjectiveOperationalBinding {
  return {
    clientId: scope.clientId,
    objectiveId: scope.objectiveId,
    objectiveVersion: scope.objectiveVersion,
    objectiveRevisionId: scope.currentRevisionId,
  };
}
async function lockSource(
  tx: ObjectiveOperationalTx,
  actor: ObjectiveOperationalActor,
  selection: ObjectiveOperationalSelection,
  clientId?: string,
): Promise<ObjectiveLocalResourceGate | undefined> {
  if (PLAN_KINDS.includes(selection.kind)) await lockObjectivePlanResource(tx, actor, selection);
  else return lockObjectiveLocalResource(tx, actor, selection, clientId);
  return undefined;
}
async function readSource(
  tx: ObjectiveOperationalTx,
  actor: ObjectiveOperationalActor,
  scope: OperationalScope,
  selection: ObjectiveOperationalSelection,
  observedAt: string,
  asOf: string,
  gate?: ObjectiveLocalResourceGate,
): Promise<ObjectiveOperationalSourceRead | null> {
  if (PLAN_KINDS.includes(selection.kind))
    return readObjectivePlanResource(tx, actor, binding(scope), selection, observedAt, asOf);
  return gate
    ? readObjectiveLocalResource(tx, actor, binding(scope), selection, observedAt, asOf, gate)
    : readObjectiveLocalResource(tx, actor, binding(scope), selection, observedAt, asOf);
}

async function readableAssociationItems(
  tx: ObjectiveOperationalTx,
  actor: ObjectiveOperationalActor,
  scope: OperationalScope,
  links: OperationalLinkRecord[],
  observedAt: string,
  asOf: string,
) {
  const items: OperationalAssociationsPage['items'] = [];
  let pageCoverage: 'complete' | 'partial' = 'complete';
  for (const link of links) {
    const selection = { kind: link.resourceKind, id: link.resourceId };
    let source = await readSource(tx, actor, scope, selection, observedAt, asOf);
    for (const cycle of link.cycles)
      if (cycle.context && !(await validateObjectiveCycleContext(tx, actor, cycle))) source = null;
    if (!source) {
      pageCoverage = 'partial';
      continue;
    }
    items.push({
      associationId: link.id,
      linkedRevision: { id: link.linkedRevisionId, version: link.linkedObjectiveVersion },
      linkedAt: new Date(link.linkedAt).toISOString(),
      resource: source.resource,
      cycles: link.cycles,
    });
  }
  return { items, pageCoverage };
}
/** No HTTP/provider calls, scheduler or generated-applied publication in this service. */
@Injectable()
export class ObjectiveOperationalService {
  private readonly cursors = new ObjectiveOperationalCursors();
  constructor(private readonly prisma: PrismaService) {}

  private async transaction<T>(
    actor: ObjectiveOperationalActor,
    fn: (tx: ObjectiveOperationalTx) => Promise<T>,
    requestId?: string,
  ) {
    try {
      return await this.prisma.withTenant(
        actor.tenantId,
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('statement_timeout','12000',true),set_config('lock_timeout','3000',true)`;
          return fn(tx);
        },
        { timeoutMs: 15000 },
      );
    } catch (error) {
      if (error instanceof OperationalBoundaryError) throw error;
      // Keep database details, owner payloads and connection errors private.
      operationalFailure('OWNER_UNAVAILABLE', requestId);
    }
  }
  private async setGate(
    tx: ObjectiveOperationalTx,
    actor: ObjectiveOperationalActor,
    scope: OperationalScope,
    write: boolean,
  ) {
    const key = `objective-operational:${actor.tenantId}:${scope.clientId}:${scope.objectiveId}`;
    if (write) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
    else await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key},0))`;
  }
  async receipt(ctx: TenantContext, request: OperationalReceiptRequest) {
    const actor = actorFrom(ctx);
    return this.transaction(
      actor,
      async (tx) => {
        const scope = await loadCurrentOperationalScopeWithinTx(
          tx,
          actor,
          request.clientId,
          request.objectiveId,
        );
        const receipt = await findOperationalReceipt(tx, actor, scope, request.requestId);
        if (!receipt) operationalFailure('RECEIPT_NOT_AVAILABLE', request.requestId);
        return receipt;
      },
      request.requestId,
    );
  }
  async command(ctx: TenantContext, command: OperationalCommand) {
    const actor = actorFrom(ctx);
    // Historical receipt recovery does not acquire source gates, and therefore
    // does not depend on a source that was subsequently unlinked/moved/deleted.
    const replay = await this.transaction(
      actor,
      async (tx) => {
        const scope = await loadCurrentOperationalScopeWithinTx(
          tx,
          actor,
          command.clientId,
          command.objectiveId,
        );
        return matchOperationalReplay(
          await findOperationalReceipt(tx, actor, scope, command.requestId),
          command,
        );
      },
      command.requestId,
    );
    if (replay) return replay;
    return this.transaction(
      actor,
      async (tx) => {
        let localGate: ObjectiveLocalResourceGate | undefined;
        if (command.action === 'link') {
          // Owner -> Core -> association gate. Sorted budget contexts avoid
          // inverted context-row order across simultaneous Strategy links.
          localGate = await lockSource(tx, actor, command.resource, command.clientId);
          const contexts = command.cycles.flatMap((c) => (c.context ? [c.context] : []));
          const unique = new Map(contexts.map((c) => [`${c.kind}:${c.id}`, c]));
          for (const [, context] of [...unique].sort(([a], [b]) => a.localeCompare(b)))
            await lockSource(tx, actor, context);
        }
        const scope = await loadCurrentOperationalScopeWithinTx(
          tx,
          actor,
          command.clientId,
          command.objectiveId,
        );
        await this.setGate(tx, actor, scope, true);
        return commitOperationalCommand(tx, actor, scope, command, async () => {
          if (command.action !== 'link') return;
          const now = new Date().toISOString();
          const source = await readSource(tx, actor, scope, command.resource, now, now, localGate);
          if (!source) operationalFailure('NOT_AVAILABLE', command.requestId);
          for (const cycle of command.cycles) {
            if (!(await validateObjectiveCycleContext(tx, actor, cycle)))
              operationalFailure('NOT_AVAILABLE', command.requestId);
          }
        });
      },
      command.requestId,
    );
  }
  async read(ctx: TenantContext, request: OperationalReadRequest) {
    const actor = actorFrom(ctx);
    const tokens = Object.values(request.cursors).filter(
      (token): token is string => token !== null,
    );
    const cutoffs = tokens.map((token) => this.cursors.decode(token).asOf);
    if (new Set(cutoffs).size > 1) operationalFailure('CURSOR_STALE');
    const asOf = cutoffs[0] ?? new Date().toISOString();
    return this.transaction(actor, async (tx) => {
      const scope = await loadCurrentOperationalScopeWithinTx(
        tx,
        actor,
        request.clientId,
        request.objectiveId,
      );
      // Readers never acquire owner mutation gates after Core locks. A shared
      // association gate freezes membership/set version, not external services.
      await this.setGate(tx, actor, scope, false);
      const setVersion = await readOperationalSetVersion(tx, actor, scope);
      const links = await listOperationalLinks(tx, actor, scope);
      const observations = [];
      for (const link of links) {
        let source = await readSource(
          tx,
          actor,
          scope,
          { kind: link.resourceKind, id: link.resourceId },
          new Date().toISOString(),
          asOf,
        );
        // Annotation references are subject to their own current owner access.
        // Withhold rather than relabel an immutable saved annotation as absent.
        for (const cycle of link.cycles) {
          if (cycle.context && !(await validateObjectiveCycleContext(tx, actor, cycle)))
            source = null;
        }
        observations.push({ link, source });
      }
      return assembleOperationalProjection(
        {
          actor,
          scope,
          setVersion,
          request,
          asOf,
          observedAt: new Date().toISOString(),
          observations,
        },
        this.cursors,
      );
    });
  }

  /** Bounded manual-link inventory, independent of pending/upcoming projections.
   * A hidden source yields no association/resource metadata in this response. */
  async associations(
    ctx: TenantContext,
    request: OperationalAssociationsRequest,
  ): Promise<OperationalAssociationsPage> {
    const actor = actorFrom(ctx);
    const asOf = request.cursor
      ? this.cursors.decode(request.cursor).asOf
      : new Date().toISOString();
    return this.transaction(actor, async (tx) => {
      const scope = await loadCurrentOperationalScopeWithinTx(
        tx,
        actor,
        request.clientId,
        request.objectiveId,
      );
      await this.setGate(tx, actor, scope, false);
      const set = await readOperationalSetVersion(tx, actor, scope);
      const snapshot = operationalDigest({ view: 'manual-associations', version: 1 });
      const offset = request.cursor
        ? this.cursors.check(
            request.cursor,
            actor.tenantId,
            actor.userId,
            scope,
            set,
            'associations',
            snapshot,
            asOf,
            request.limit,
          )
        : 0;
      const links = await listOperationalLinks(tx, actor, scope, {
        limit: request.limit + 1,
        offset,
      });
      const observedAt = new Date().toISOString();
      const { items, pageCoverage } = await readableAssociationItems(
        tx,
        actor,
        scope,
        links.slice(0, request.limit),
        observedAt,
        asOf,
      );
      return {
        schemaVersion: 1,
        scope,
        associationSetVersion: set,
        observedAt,
        asOf,
        pageCoverage,
        items,
        nextCursor:
          links.length > request.limit
            ? this.cursors.encode(
                actor.tenantId,
                actor.userId,
                scope,
                set,
                'associations',
                snapshot,
                asOf,
                request.limit,
                offset + request.limit,
              )
            : null,
      };
    });
  }
}
