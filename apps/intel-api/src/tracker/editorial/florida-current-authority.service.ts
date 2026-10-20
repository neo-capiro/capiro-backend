import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  RequestTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PHASE8_FEATURES } from '@capiro/shared';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { Phase8EvidenceService, phase8Scope } from './evidence.service.js';

/** Supplied only by the separately authenticated principal owner, never a body. */
export interface FloridaCurrentAuthorityPrincipal {
  tenantId: string;
  actorId: string;
  clerkUserId: string;
}
export interface FloridaCurrentAuthoritySelector {
  schemaVersion: 1;
  sessionKey: string;
  folderId: string | null;
  clientSelector: string | null;
}
export interface FloridaCurrentAuthorityControl {
  deadlineMs: number;
  assertActive(): void;
}
export interface FloridaCurrentAuthorityFacts {
  effectiveScope: {
    jurisdiction: 'FL';
    sessionKey: string;
    folderId: string | null;
    clientId: string | null;
  };
  clientResolution: { selector: string; clientId: string } | null;
  resourceRevision: string;
}

type Tx = Prisma.TransactionClient;
type FeatureFacts = [id: string, feature: string, tenantId: string, enabled: boolean];
type MemberFacts = [
  id: string,
  tenantId: string,
  actorId: string,
  clerkUserId: string,
  status: string,
  role: string,
];
type FolderFacts = [
  id: string,
  tenantId: string,
  version: number,
  clientId: string | null,
  archived: boolean,
];
type ClientFacts = [
  id: string,
  tenantId: string,
  status: string,
  memoryWall: boolean,
  grantId: string | null,
];
interface Snapshot {
  scope: FloridaCurrentAuthorityFacts['effectiveScope'];
  feature: FeatureFacts;
  member: MemberFacts;
  folder: FolderFacts | null;
  client: ClientFacts | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = () => new BadRequestException('Invalid Florida authority request');
const unavailable = () => new ServiceUnavailableException('Florida authority source unavailable');
const changed = () => new ConflictException('Florida authority changed; reload');

function requireFact(value: unknown): asserts value {
  if (!value) throw unavailable();
}
function row(value: unknown): Record<string, unknown> {
  requireFact(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function parseFloridaCurrentAuthoritySelector(
  raw: unknown,
): FloridaCurrentAuthoritySelector {
  const keys = ['schemaVersion', 'sessionKey', 'folderId', 'clientSelector'];
  if (
    !raw ||
    typeof raw !== 'object' ||
    types.isProxy(raw) ||
    Array.isArray(raw) ||
    (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)
  )
    throw invalid();
  const own = Reflect.ownKeys(raw);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    throw invalid();
  const input: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw invalid();
    input[key] = descriptor.value;
  }
  if (
    input.schemaVersion !== 1 ||
    typeof input.sessionKey !== 'string' ||
    input.sessionKey.length > 256 ||
    (input.folderId !== null && !uuid(input.folderId)) ||
    (input.clientSelector !== null &&
      (!text(input.clientSelector, 256) || input.clientSelector.trim() !== input.clientSelector))
  )
    throw invalid();
  return {
    schemaVersion: 1,
    sessionKey: input.sessionKey,
    folderId: input.folderId as string | null,
    clientSelector: input.clientSelector as string | null,
  };
}

function same(before: unknown, after: unknown): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw changed();
}

/** Current business facts only. Caller owns native identity/run/task capture.
 * These repeated observations are neither a lease nor an atomic cross-service
 * snapshot, and cannot prove a change-and-revert did not happen between reads. */
@Injectable()
export class FloridaCurrentAuthorityService {
  constructor(private readonly phase8: Phase8EvidenceService) {}

  async read(
    principal: FloridaCurrentAuthorityPrincipal,
    rawSelector: unknown,
    control: FloridaCurrentAuthorityControl,
  ): Promise<FloridaCurrentAuthorityFacts> {
    const selector = parseFloridaCurrentAuthoritySelector(rawSelector);
    this.checkpoint(control);
    if (
      !principal ||
      !uuid(principal.tenantId) ||
      !uuid(principal.actorId) ||
      !text(principal.clerkUserId, 256) ||
      /\s/.test(principal.clerkUserId)
    ) {
      throw new ForbiddenException('Canonical Florida principal required');
    }
    const currentPrincipal = {
      tenantId: principal.tenantId,
      actorId: principal.actorId,
      clerkUserId: principal.clerkUserId,
    };
    const boundedControl = {
      deadlineMs: control.deadlineMs,
      assertActive: () => control.assertActive(),
    };
    const clientId = selector.clientSelector?.toLowerCase() ?? null;
    // The legacy Core exact-name resolver is private. A name is not an ID,
    // and this producer has no allocated current resolver to attest one.
    if (clientId !== null && !UUID.test(clientId)) {
      throw new ServiceUnavailableException('Florida client selector resolver unavailable');
    }
    if (!this.phase8?.research?.keywords?.reports?.folders) throw unavailable();
    const first = await this.snapshot(currentPrincipal, selector, clientId, boundedControl);
    this.checkpoint(boundedControl);
    const second = await this.snapshot(currentPrincipal, selector, clientId, boundedControl);
    this.checkpoint(boundedControl);
    same(first, second);
    return {
      effectiveScope: { ...second.scope },
      clientResolution:
        selector.clientSelector === null
          ? null
          : { selector: selector.clientSelector, clientId: clientId! },
      resourceRevision: createHash('sha256')
        .update(
          JSON.stringify([
            'capiro-florida-resource-v1',
            second.feature,
            second.member,
            second.folder,
            second.client,
            second.scope,
          ]),
        )
        .digest('hex'),
    };
  }

  private checkpoint(control: FloridaCurrentAuthorityControl): void {
    if (
      !control ||
      typeof control.assertActive !== 'function' ||
      !Number.isSafeInteger(control.deadlineMs)
    )
      throw unavailable();
    control.assertActive();
    if (Date.now() >= control.deadlineMs)
      throw new RequestTimeoutException('Florida authority request no longer active');
  }

  private async observe<T>(
    control: FloridaCurrentAuthorityControl,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.checkpoint(control);
    try {
      const result = await operation();
      this.checkpoint(control);
      return result;
    } catch (error) {
      this.checkpoint(control);
      if (error instanceof HttpException) throw error;
      throw unavailable();
    }
  }

  private async snapshot(
    principal: FloridaCurrentAuthorityPrincipal,
    selector: FloridaCurrentAuthoritySelector,
    clientId: string | null,
    control: FloridaCurrentAuthorityControl,
  ): Promise<Snapshot> {
    const ctx: WorkspaceTenantContext = {
      tenantId: principal.tenantId,
      clerkUserId: principal.clerkUserId,
      role: null,
    };
    await this.observe(control, () => this.phase8.reports.authorize(ctx, PHASE8_FEATURES.budget));
    const result = await this.observe(control, () =>
      this.phase8.reports.folders.withActor(
        ctx,
        async (tx) => {
          const firstFeature = await this.feature(tx, principal.tenantId, control);
          const firstMember = await this.member(tx, principal, control);
          const scope = phase8Scope({
            sessionKey: selector.sessionKey,
            folderId: selector.folderId,
            clientId,
          });
          await this.observe(control, () => this.phase8.context(tx, ctx, scope));
          requireFact(
            scope.jurisdiction === 'FL' &&
              scope.sessionKey === selector.sessionKey &&
              scope.folderId === selector.folderId &&
              (scope.clientId === null || uuid(scope.clientId)),
          );
          const folder =
            selector.folderId === null
              ? null
              : this.folderFacts(
                  await this.observe(control, () =>
                    this.phase8.research.keywords.folder(tx, ctx, selector.folderId!, false),
                  ),
                  principal,
                  selector.folderId,
                );
          const client =
            scope.clientId === null
              ? null
              : await this.client(tx, principal, scope.clientId, control);
          await this.observe(control, () => this.phase8.context(tx, ctx, scope));
          const finalFeature = await this.feature(tx, principal.tenantId, control);
          const finalMember = await this.member(tx, principal, control);
          same(firstFeature, finalFeature);
          same(firstMember, finalMember);
          if (folder !== null && folder[3] !== scope.clientId) throw changed();
          if (
            (client !== null && client[0] !== scope.clientId) ||
            (client === null && scope.clientId !== null) ||
            (clientId !== null && clientId !== scope.clientId)
          )
            throw changed();
          return {
            scope: {
              jurisdiction: 'FL' as const,
              sessionKey: selector.sessionKey,
              folderId: selector.folderId,
              clientId: scope.clientId,
            },
            feature: finalFeature,
            member: finalMember,
            folder,
            client,
          };
        },
        { timeoutMs: Math.max(1, Math.min(5000, control.deadlineMs - Date.now())) },
      ),
    );
    await this.observe(control, () => this.phase8.reports.authorize(ctx, PHASE8_FEATURES.budget));
    return result;
  }

  private async feature(
    tx: Tx,
    tenantId: string,
    control: FloridaCurrentAuthorityControl,
  ): Promise<FeatureFacts> {
    const value = await this.observe(control, () =>
      tx.featureFlag.findUnique({
        where: { feature_tenantId: { feature: PHASE8_FEATURES.budget, tenantId } },
        select: { id: true, feature: true, tenantId: true, enabled: true },
      }),
    );
    // Budget is explicitly opt-in in the current feature owner; no missing-row
    // internal-tenant fallback exists for this feature. Authorization ran above.
    if (value === null) throw changed();
    const current = row(value);
    requireFact(
      text(current.id, 256) &&
        current.feature === PHASE8_FEATURES.budget &&
        current.tenantId === tenantId &&
        typeof current.enabled === 'boolean',
    );
    if (!current.enabled) throw changed();
    return [current.id, PHASE8_FEATURES.budget, tenantId, current.enabled];
  }

  private async member(
    tx: Tx,
    principal: FloridaCurrentAuthorityPrincipal,
    control: FloridaCurrentAuthorityControl,
  ): Promise<MemberFacts> {
    const rows = await this.observe(control, () =>
      tx.$queryRawUnsafe<unknown[]>(
        `SELECT tm.id::text AS id, tm.tenant_id::text AS "tenantId", tm.user_id::text AS "actorId",
         u.clerk_user_id AS "clerkUserId", tm.status::text AS status, tm.role::text AS role
       FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id
       WHERE tm.tenant_id=$1::uuid AND tm.user_id=$2::uuid AND u.clerk_user_id=$3 LIMIT 2`,
        principal.tenantId,
        principal.actorId,
        principal.clerkUserId,
      ),
    );
    requireFact(Array.isArray(rows) && rows.length <= 1);
    if (!rows.length) throw new ForbiddenException('Canonical Florida principal unavailable');
    const current = row(rows[0]);
    requireFact(
      uuid(current.id) &&
        current.tenantId === principal.tenantId &&
        current.actorId === principal.actorId &&
        current.clerkUserId === principal.clerkUserId &&
        text(current.role, 64) &&
        text(current.status, 64),
    );
    if (current.status !== 'active') throw new ForbiddenException('ACTIVE_MEMBERSHIP_REQUIRED');
    return [
      current.id,
      principal.tenantId,
      principal.actorId,
      principal.clerkUserId,
      current.status,
      current.role,
    ];
  }

  private folderFacts(
    value: unknown,
    principal: FloridaCurrentAuthorityPrincipal,
    folderId: string,
  ): FolderFacts {
    const current = row(value);
    requireFact(
      current.id === folderId &&
        current.tenantId === principal.tenantId &&
        Number.isSafeInteger(current.version) &&
        (current.version as number) >= 0 &&
        (current.clientId === null || uuid(current.clientId)) &&
        typeof current.archived === 'boolean',
    );
    // Current read rules allow archived folders; archive/version remain facts.
    return [
      folderId,
      principal.tenantId,
      current.version as number,
      current.clientId as string | null,
      current.archived,
    ];
  }

  private async client(
    tx: Tx,
    principal: FloridaCurrentAuthorityPrincipal,
    clientId: string,
    control: FloridaCurrentAuthorityControl,
  ): Promise<ClientFacts> {
    const rows = await this.observe(control, () =>
      tx.$queryRawUnsafe<unknown[]>(
        `SELECT c.id::text AS id, c.tenant_id::text AS "tenantId", c.status::text AS status,
         c.memory_wall AS "memoryWall", a.id::text AS "grantId"
       FROM clients c LEFT JOIN client_memory_access a
         ON a.tenant_id=c.tenant_id AND a.client_id=c.id AND a.user_id=$3::uuid
       WHERE c.tenant_id=$1::uuid AND c.id=$2::uuid LIMIT 2`,
        principal.tenantId,
        clientId,
        principal.actorId,
      ),
    );
    requireFact(Array.isArray(rows) && rows.length === 1);
    const current = row(rows[0]);
    requireFact(
      current.id === clientId &&
        current.tenantId === principal.tenantId &&
        text(current.status, 64) &&
        typeof current.memoryWall === 'boolean' &&
        (current.grantId === null || uuid(current.grantId)),
    );
    // Canonical Phase8/Research context owns the access decision before/after
    // this projection. These raw current facts add no alternate permission rule.
    return [
      clientId,
      principal.tenantId,
      current.status,
      current.memoryWall,
      current.grantId as string | null,
    ];
  }
}
