import type { TenantContext } from '@capiro/shared';
import { Logger } from '@nestjs/common';
import {
  ClientProfileFillCompletionService,
  type RefreshScheduleRow,
} from '../../src/clients/client-profile-fill-completion.service.js';

export const ctx = {
  tenantId: 'tenant-one',
  userId: 'user-one',
  role: 'user_admin',
} as unknown as TenantContext;
export const clientId = 'client-one';
export const sources = [
  'public_web',
  'synced_email',
  'sam_gov',
  'lda',
  'program_elements',
  'bill_tracker',
];
export const dueRow = (overrides: Record<string, unknown> = {}) => ({
  tenantId: 'tenant-due',
  clientId: 'due-client',
  userId: 'due-user' as string | null,
  sources: ['lda'],
  cadenceHours: 168,
  ...overrides,
});
export type Due = ReturnType<typeof dueRow>;
interface Options {
  stored?: RefreshScheduleRow;
  authorized?: boolean[];
  due?: Due[];
  claim?: () => Promise<Due[]>;
  bumps?: Array<Error | undefined>;
  readError?: Error;
  holdRead?: Promise<Record<string, unknown>>;
  active?: boolean;
}
interface Call {
  kind: string;
  args: unknown[];
  sql?: string;
  scope: string;
}
interface State {
  options: Options;
  calls: Call[];
  phases: string[];
  warnings: string[];
  authIndex: number;
  bumpIndex: number;
}
function record(state: State, kind: string, args: unknown[], scope: string, sql?: string) {
  state.calls.push({ kind, args, scope, sql });
  state.phases.push(kind);
}
function raw(state: State, scope: string) {
  const { options } = state;
  return {
    $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      if (sql.includes('WITH due AS')) {
        record(state, 'claim', args, scope, sql);
        return options.claim ? options.claim() : (options.due ?? []);
      }
      if (sql.includes('SELECT enabled')) {
        record(state, 'read', args, scope, sql);
        return options.stored ? [options.stored] : [];
      }
      if (sql.includes('SELECT DISTINCT')) {
        record(state, 'active', args, scope, sql);
        return options.active === false ? [] : [{ id: 'active-run' }];
      }
      if (sql.includes('SELECT EXISTS')) {
        record(state, 'present', args, scope, sql);
        return [{ present: false }];
      }
      if (sql.includes('SELECT id FROM client_profile_fill_run')) {
        record(state, 'run', args, scope, sql);
        return [{ id: 'new-run' }];
      }
      if (sql.includes('WITH candidates AS') || sql.includes('SELECT r.id AS "runId"')) {
        record(state, 'empty-worker-query', args, scope, sql);
        return [];
      }
      throw new Error(`Unexpected refresh schedule query: ${sql}`);
    }),
    $executeRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      const kind = sql.includes('INSERT INTO client_profile_fill_schedule')
        ? 'edit'
        : sql.includes('UPDATE client_profile_fill_schedule')
          ? 'bump'
          : 'task-write';
      if (
        kind === 'task-write' &&
        !sql.includes('INSERT INTO client_profile_fill_extension_task') &&
        !sql.includes('UPDATE client_profile_fill_run') &&
        !sql.includes("error_code = 'stale_worker'")
      )
        throw new Error(`Unexpected refresh schedule write: ${sql}`);
      record(state, kind, args, scope, sql);
      if (kind === 'bump' && options.bumps?.[state.bumpIndex++])
        throw options.bumps[state.bumpIndex - 1];
      return 1;
    }),
  };
}
async function scoped(state: State, scope: string, callback: (tx: unknown) => Promise<unknown>) {
  state.phases.push(`${scope}:begin`);
  try {
    const result = await callback(raw(state, scope));
    state.phases.push(`${scope}:commit`);
    return result;
  } catch (error) {
    state.phases.push(`${scope}:rollback`);
    throw error;
  }
}
function prismaFor(state: State) {
  return {
    withTenant: jest.fn((tenant: string, cb: (tx: unknown) => Promise<unknown>) =>
      scoped(state, `tenant:${tenant}`, cb),
    ),
    withSystem: jest.fn((cb: (tx: unknown) => Promise<unknown>) => scoped(state, 'system', cb)),
    withTenantUser: jest.fn(
      async (tenant: string, user: string, cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          client: {
            findFirst: jest.fn(async (input: unknown) => {
              record(state, 'auth', [tenant, user, input], 'user');
              return state.options.authorized?.[state.authIndex++] === false
                ? null
                : { id: clientId };
            }),
          },
        }),
    ),
  };
}
export function fixture(options: Options = {}) {
  const state: State = { options, calls: [], phases: [], warnings: [], authIndex: 0, bumpIndex: 0 };
  const prisma = prismaFor(state);
  const workflow = {
    startRun: jest.fn(async (...args: unknown[]) => {
      record(state, 'workflow-start', args, 'workflow');
      return { id: 'new-run' };
    }),
    getRun: jest.fn(async (...args: unknown[]) => {
      record(state, 'workflow-read', args, 'workflow');
      if (options.readError) throw options.readError;
      return options.holdRead ?? { id: args[2], status: 'completed' };
    }),
  };
  const service = new ClientProfileFillCompletionService(
    prisma as never,
    workflow as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
    state.warnings.push(String(message));
  });
  return {
    service,
    options,
    calls: state.calls,
    phases: state.phases,
    warnings: state.warnings,
    workflow,
    callsOf: (kind: string) => state.calls.filter((entry) => entry.kind === kind),
  };
}
