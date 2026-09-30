import { Prisma } from '@prisma/client';

export const FOUNDATION_FULLCHAT_FLAG = 'meriv3.fullChat' as const;
export const FOUNDATION_FULLCHAT_TENANTS = [
  {
    id: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
    slug: 'meri-foundation-20260928-t1',
  },
  {
    id: '52e91176-08f0-4d89-9633-bc212f5bdbbf',
    slug: 'meri-foundation-20260928-t2',
  },
] as const;
export const FOUNDATION_APPLY_CONFIRMATION = 'APPLY_FIXED_MERI_FOUNDATION_FULLCHAT' as const;
export const FOUNDATION_ROLLBACK_CONFIRMATION = 'ROLLBACK_FIXED_MERI_FOUNDATION_FULLCHAT' as const;

export type FoundationMode = 'plan' | 'apply' | 'rollback';

export type FlagState =
  | { present: false }
  | { present: true; value: Prisma.JsonValue };

export interface FoundationState {
  tenantId: string;
  tenantSlug: string;
  flag: typeof FOUNDATION_FULLCHAT_FLAG;
  state: FlagState;
}

export interface FoundationReceipt {
  schemaVersion: 1;
  operation: 'meri-foundation-fullchat';
  mode: FoundationMode;
  result: 'PLAN_ONLY' | 'APPLIED_AND_VERIFIED' | 'ROLLED_BACK_AND_VERIFIED';
  flag: typeof FOUNDATION_FULLCHAT_FLAG;
  tenants: Array<{
    tenantId: string;
    tenantSlug: string;
    before: FlagState;
    after: FlagState;
  }>;
}

interface LockedFlagRow {
  id: string;
  slug: string;
  present: boolean;
  value: Prisma.JsonValue | null;
  settings_type: string | null;
  flags_type: string | null;
}

export interface FoundationTransaction {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface FoundationDatabase {
  $transaction<T>(
    fn: (tx: FoundationTransaction) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number },
  ): Promise<T>;
}

const LOCK_FLAG_SQL = `
SELECT
  id::text AS id,
  slug,
  COALESCE((settings_jsonb -> 'clioFeatureFlags') ? $3, false) AS present,
  settings_jsonb #> ARRAY['clioFeatureFlags', $3] AS value,
  jsonb_typeof(settings_jsonb) AS settings_type,
  jsonb_typeof(settings_jsonb -> 'clioFeatureFlags') AS flags_type
FROM tenants
WHERE id = $1::uuid AND slug = $2
FOR UPDATE
`;

const SET_FLAG_SQL = `
UPDATE tenants
SET settings_jsonb = jsonb_set(
  settings_jsonb,
  ARRAY['clioFeatureFlags'],
  COALESCE(settings_jsonb -> 'clioFeatureFlags', '{}'::jsonb)
    || jsonb_build_object($3, $4::jsonb),
  true
)
WHERE id = $1::uuid
  AND slug = $2
  AND COALESCE((settings_jsonb -> 'clioFeatureFlags') ? $3, false) = $5::boolean
  AND (
    ($5::boolean = false AND settings_jsonb #> ARRAY['clioFeatureFlags', $3] IS NULL)
    OR
    ($5::boolean = true AND settings_jsonb #> ARRAY['clioFeatureFlags', $3] = $6::jsonb)
  )
RETURNING id::text AS id
`;

const REMOVE_FLAG_SQL = `
UPDATE tenants
SET settings_jsonb = settings_jsonb #- ARRAY['clioFeatureFlags', $3]
WHERE id = $1::uuid
  AND slug = $2
  AND COALESCE((settings_jsonb -> 'clioFeatureFlags') ? $3, false) = $4::boolean
  AND (
    ($4::boolean = false AND settings_jsonb #> ARRAY['clioFeatureFlags', $3] IS NULL)
    OR
    ($4::boolean = true AND settings_jsonb #> ARRAY['clioFeatureFlags', $3] = $5::jsonb)
  )
RETURNING id::text AS id
`;

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function flagState(row: LockedFlagRow): FlagState {
  if (!row.present) return { present: false };
  return { present: true, value: row.value as Prisma.JsonValue };
}

function validateRowShape(row: LockedFlagRow, tenant: (typeof FOUNDATION_FULLCHAT_TENANTS)[number]): void {
  if (row.id !== tenant.id || row.slug !== tenant.slug) {
    throw new Error(`Foundation tenant identity mismatch for ${tenant.slug}`);
  }
  if (row.settings_type !== 'object') {
    throw new Error(`Foundation tenant ${tenant.slug} settings_jsonb is not an object`);
  }
  if (row.flags_type !== null && row.flags_type !== 'object') {
    throw new Error(`Foundation tenant ${tenant.slug} clioFeatureFlags is not an object`);
  }
}

async function lockState(
  tx: FoundationTransaction,
  tenant: (typeof FOUNDATION_FULLCHAT_TENANTS)[number],
): Promise<FoundationState> {
  // New fixed mode deliberately uses the ordinary tenant GUC and explicitly
  // disables the generic command's historical bypass. The exact UUID+slug row
  // predicate remains in every SELECT/UPDATE.
  await tx.$queryRawUnsafe(`SELECT set_config('app.bypass_rls', 'off', true)`);
  await tx.$queryRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, tenant.id);
  const rows = await tx.$queryRawUnsafe<LockedFlagRow[]>(LOCK_FLAG_SQL, tenant.id, tenant.slug, FOUNDATION_FULLCHAT_FLAG);
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`Foundation tenant ${tenant.slug} was not uniquely visible through tenant-scoped RLS`);
  }
  validateRowShape(rows[0], tenant);
  return {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    flag: FOUNDATION_FULLCHAT_FLAG,
    state: flagState(rows[0]),
  };
}

function validateExpectedState(value: unknown): FoundationState[] {
  if (!Array.isArray(value) || value.length !== FOUNDATION_FULLCHAT_TENANTS.length) {
    throw new Error('Expected state must contain exactly the two fixed foundation tenants');
  }
  return value.map((candidate, index) => {
    const tenant = FOUNDATION_FULLCHAT_TENANTS[index];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Expected state has an invalid tenant entry');
    }
    const entry = candidate as Record<string, unknown>;
    if (
      entry.tenantId !== tenant.id ||
      entry.tenantSlug !== tenant.slug ||
      entry.flag !== FOUNDATION_FULLCHAT_FLAG ||
      !entry.state ||
      typeof entry.state !== 'object' ||
      Array.isArray(entry.state)
    ) {
      throw new Error('Expected state is not bound to the fixed tenant IDs, slugs, and flag');
    }
    const state = entry.state as Record<string, unknown>;
    if (state.present === false && Object.keys(state).length === 1) {
      return { tenantId: tenant.id, tenantSlug: tenant.slug, flag: FOUNDATION_FULLCHAT_FLAG, state: { present: false } };
    }
    if (state.present === true && Object.keys(state).sort().join(',') === 'present,value' && 'value' in state) {
      return {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        flag: FOUNDATION_FULLCHAT_FLAG,
        state: { present: true, value: state.value as Prisma.JsonValue },
      };
    }
    throw new Error('Expected state must contain only prior flag presence/value');
  });
}

export function encodeExpectedState(states: FoundationState[]): string {
  return Buffer.from(JSON.stringify(validateExpectedState(states)), 'utf8').toString('base64url');
}

export function decodeExpectedState(encoded: string): FoundationState[] {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('Expected state token is not canonical base64url');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Expected state token is not valid JSON');
  }
  const canonical = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url');
  if (canonical !== encoded) {
    throw new Error('Expected state token is not canonical base64url');
  }
  return validateExpectedState(parsed);
}

function assertState(actual: FoundationState, expected: FoundationState, context: string): void {
  if (
    actual.tenantId !== expected.tenantId ||
    actual.tenantSlug !== expected.tenantSlug ||
    actual.flag !== expected.flag ||
    !jsonEqual(actual.state, expected.state)
  ) {
    throw new Error(`${context} no longer matches the receipt-bound expected prior state`);
  }
}

async function updateFlag(
  tx: FoundationTransaction,
  tenant: (typeof FOUNDATION_FULLCHAT_TENANTS)[number],
  current: FlagState,
  target: FlagState,
): Promise<void> {
  await tx.$queryRawUnsafe(`SELECT set_config('app.bypass_rls', 'off', true)`);
  await tx.$queryRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, tenant.id);
  let rows: Array<{ id: string }>;
  if (target.present) {
    rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      SET_FLAG_SQL,
      tenant.id,
      tenant.slug,
      FOUNDATION_FULLCHAT_FLAG,
      JSON.stringify(target.value),
      current.present,
      JSON.stringify(current.present ? current.value : null),
    );
  } else {
    rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      REMOVE_FLAG_SQL,
      tenant.id,
      tenant.slug,
      FOUNDATION_FULLCHAT_FLAG,
      current.present,
      JSON.stringify(current.present ? current.value : null),
    );
  }
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].id !== tenant.id) {
    throw new Error(`Compare-and-update refused foundation tenant ${tenant.slug}`);
  }
}

export async function runFoundationFullchat(
  database: FoundationDatabase,
  mode: FoundationMode,
  expectedStates?: FoundationState[],
): Promise<FoundationReceipt> {
  const expected = mode === 'plan' ? undefined : validateExpectedState(expectedStates);
  return database.$transaction(
    async (tx) => {
      const before: FoundationState[] = [];
      for (const tenant of FOUNDATION_FULLCHAT_TENANTS) {
        before.push(await lockState(tx, tenant));
      }

      if (mode !== 'plan') {
        for (let index = 0; index < before.length; index += 1) {
          const expectedEntry = expected![index];
          if (mode === 'apply') {
            assertState(before[index], expectedEntry, 'Apply state');
          } else {
            const applied: FoundationState = {
              tenantId: expectedEntry.tenantId,
              tenantSlug: expectedEntry.tenantSlug,
              flag: FOUNDATION_FULLCHAT_FLAG,
              state: { present: true, value: true },
            };
            // Exact prior state is accepted as reconciliation of an already
            // completed rollback. Any third state is drift and fails closed.
            if (!jsonEqual(before[index].state, expectedEntry.state)) {
              assertState(before[index], applied, 'Rollback current state');
            }
          }
        }

        for (let index = 0; index < FOUNDATION_FULLCHAT_TENANTS.length; index += 1) {
          const tenant = FOUNDATION_FULLCHAT_TENANTS[index];
          const target: FlagState = mode === 'apply' ? { present: true, value: true } : expected![index].state;
          if (!jsonEqual(before[index].state, target)) {
            await updateFlag(tx, tenant, before[index].state, target);
          }
        }
      }

      const after: FoundationState[] = [];
      for (const tenant of FOUNDATION_FULLCHAT_TENANTS) {
        after.push(await lockState(tx, tenant));
      }
      for (let index = 0; index < after.length; index += 1) {
        const target = mode === 'plan'
          ? before[index]
          : {
              tenantId: FOUNDATION_FULLCHAT_TENANTS[index].id,
              tenantSlug: FOUNDATION_FULLCHAT_TENANTS[index].slug,
              flag: FOUNDATION_FULLCHAT_FLAG,
              state: mode === 'apply' ? { present: true, value: true } as FlagState : expected![index].state,
            };
        assertState(after[index], target, 'Strict transaction readback');
      }

      return {
        schemaVersion: 1,
        operation: 'meri-foundation-fullchat',
        mode,
        result: mode === 'plan' ? 'PLAN_ONLY' : mode === 'apply' ? 'APPLIED_AND_VERIFIED' : 'ROLLED_BACK_AND_VERIFIED',
        flag: FOUNDATION_FULLCHAT_FLAG,
        tenants: FOUNDATION_FULLCHAT_TENANTS.map((tenant, index) => ({
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          before: before[index].state,
          after: after[index].state,
        })),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 },
  );
}
