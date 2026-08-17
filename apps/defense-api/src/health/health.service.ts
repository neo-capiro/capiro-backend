import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { validateDefenseServeEnvironment } from '../config/defense-config.validation.js';
import {
  decideDefenseReadiness,
  type DefenseReadinessDecision,
} from './readiness-policy.js';

const DEFENSE_BUDGET_DOMAIN = 'defense_budget';

interface RoleSafetyRow {
  readonly currentUser: string;
  readonly capabilityMember: boolean;
  readonly isSuperuser: boolean;
  readonly hasBypassRls: boolean;
  readonly hasCreateDb: boolean;
  readonly hasCreateRole: boolean;
  readonly hasSchemaCreate: boolean;
  readonly isPromoterMember: boolean;
  readonly canMutateActiveSnapshot: boolean;
  readonly unexpectedDirectGrantCount: number;
}

interface SnapshotPointerRow {
  readonly status: string;
  readonly snapshotId: string;
}

/**
 * A login is safe to serve HTTP traffic only if capability-role membership is
 * the ONLY authority it holds. `pg_has_role(..., 'member')` alone proves
 * membership; it says nothing about a superuser, a schema owner, a BYPASSRLS
 * role, the promoter, or a directly over-granted login also passing that same
 * membership check. Every clause below has to hold.
 */
export function isRoleSafe(row: RoleSafetyRow): boolean {
  return (
    row.capabilityMember === true &&
    row.isSuperuser === false &&
    row.hasBypassRls === false &&
    row.hasCreateDb === false &&
    row.hasCreateRole === false &&
    row.hasSchemaCreate === false &&
    row.isPromoterMember === false &&
    row.canMutateActiveSnapshot === false &&
    Number(row.unexpectedDirectGrantCount) === 0
  );
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  liveness(): Record<string, unknown> {
    return {
      ok: true,
      service: 'defense-api',
      status: 'alive',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Same convention as PeSnapshotGateService.environment() in apps/api
   * (src/program-element/snapshot/pe-snapshot-gate.service.ts): an explicit
   * override first, falling back to NODE_ENV. Reusing it is what makes
   * "the active snapshot /readyz sees" and "the active snapshot the canonical
   * read path sees" the same question.
   */
  private snapshotEnvironment(): string {
    const explicit = process.env.PE_SNAPSHOT_ENVIRONMENT?.trim();
    return explicit && explicit.length > 0
      ? explicit
      : (this.config.get<string>('NODE_ENV') ?? 'development');
  }

  async readiness(): Promise<
    DefenseReadinessDecision & {
      readonly service: 'defense-api';
      readonly databaseUser: string | null;
      readonly activeSnapshotId: string | null;
      readonly timestamp: string;
    }
  > {
    const configResult = validateDefenseServeEnvironment(process.env);
    const expectedRole =
      this.config.get<string>('DEFENSE_SERVE_DB_ROLE') ?? 'capiro_defense_serve';

    let databaseReachable = false;
    let databaseRoleAuthorized = false;
    let databaseUser: string | null = null;
    let activeSnapshotId: string | null = null;

    try {
      const [role] = await this.prisma.$queryRaw<RoleSafetyRow[]>`
        SELECT
          current_user::text AS "currentUser",
          pg_has_role(current_user, ${expectedRole}, 'member') AS "capabilityMember",
          EXISTS (
            SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper
          ) AS "isSuperuser",
          EXISTS (
            SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls
          ) AS "hasBypassRls",
          EXISTS (
            SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolcreatedb
          ) AS "hasCreateDb",
          EXISTS (
            SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolcreaterole
          ) AS "hasCreateRole",
          has_schema_privilege(current_user, 'public', 'CREATE') AS "hasSchemaCreate",
          pg_has_role(current_user, 'capiro_pe_promoter', 'member') AS "isPromoterMember",
          (
            has_table_privilege(current_user, 'public.defense_budget_active_snapshot', 'INSERT')
            OR has_table_privilege(current_user, 'public.defense_budget_active_snapshot', 'UPDATE')
            OR has_table_privilege(current_user, 'public.defense_budget_active_snapshot', 'DELETE')
          ) AS "canMutateActiveSnapshot",
          (
            SELECT count(*)::int FROM information_schema.role_table_grants g
            WHERE g.grantee = current_user
          ) AS "unexpectedDirectGrantCount"
      `;
      databaseReachable = true;
      databaseUser = role?.currentUser ?? null;
      databaseRoleAuthorized = role != null && isRoleSafe(role);

      const domain = DEFENSE_BUDGET_DOMAIN;
      const environment = this.snapshotEnvironment();
      const [pointer] = await this.prisma.$queryRaw<SnapshotPointerRow[]>`
        SELECT s."status"::text AS "status", p."snapshot_id"::text AS "snapshotId"
        FROM "defense_budget_active_snapshot" p
        JOIN "defense_budget_canonical_snapshot" s ON s."id" = p."snapshot_id"
        WHERE p."domain" = ${domain} AND p."environment" = ${environment}
        LIMIT 1
      `;
      activeSnapshotId = pointer?.status === 'ACTIVE' ? pointer.snapshotId : null;
    } catch {
      databaseReachable = false;
    }

    const decision = decideDefenseReadiness({
      configValid: configResult.valid,
      databaseReachable,
      databaseRoleAuthorized,
      activeSnapshotId,
      cutoverMode:
        this.config.get<string>('DEFENSE_CUTOVER_MODE') === 'strict'
          ? 'strict'
          : 'dark',
    });

    return {
      ...decision,
      service: 'defense-api',
      databaseUser,
      activeSnapshotId,
      timestamp: new Date().toISOString(),
    };
  }
}
