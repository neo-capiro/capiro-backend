import { posix, win32 } from 'node:path';
import { types } from 'node:util';

/** Pure qualification fences. This module imports no Prisma, opens no files,
 * starts no process and performs no SQL. A marker is never ownership proof. */
export const OBJECTIVE_PLANNER_NATIVE_OWNER = 'objective-planner-continuation-qualification';
export interface ObjectivePlannerNativeManifest {
  schemaVersion: 1;
  kind: 'task-owned-objective-planner-postgres';
  owner: typeof OBJECTIVE_PLANNER_NATIVE_OWNER;
  sourceHead: string;
  workspaceRoot: string;
  dataDirectory: string;
  hostname: '127.0.0.1' | 'localhost';
  port: number;
  database: 'planner_qa';
  databaseOid: number;
  runtimeRole: string;
  processId: number;
  postmasterStartedAtSeconds: number;
  ownershipToken: string;
  createdAt: string;
  expiresAt: string;
}
export type ObjectivePlannerNativeTarget = { enabled: false } | {
  enabled: true;
  databaseUrl: string;
  manifest: Readonly<ObjectivePlannerNativeManifest>;
};
export class ObjectivePlannerNativeTargetError extends Error {
  readonly code: 'OPT_IN_REQUIRED' | 'TARGET_INVALID' | 'OWNERSHIP_INVALID';
  constructor(code: 'OPT_IN_REQUIRED' | 'TARGET_INVALID' | 'OWNERSHIP_INVALID') {
    super(`Objective Planner native qualification refused: ${code}`);
    this.code = code;
  }
}
const refuse = (code: ObjectivePlannerNativeTargetError['code'] = 'TARGET_INVALID'): never => {
  throw new ObjectivePlannerNativeTargetError(code);
};
const SHA = /^[0-9a-f]{40}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return refuse('OWNERSHIP_INVALID');
  const ds = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(value);
  if (own.length !== keys.length || keys.some(k => !Object.hasOwn(ds, k) || !ds[k]!.enumerable ||
      !Object.hasOwn(ds[k]!, 'value'))) return refuse('OWNERSHIP_INVALID');
  return Object.fromEntries(keys.map(k => [k, ds[k]!.value]));
}
function path(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) return refuse('OWNERSHIP_INVALID');
  const p = /^[A-Za-z]:[\\/]/.test(value) ? win32 : posix;
  if (!p.isAbsolute(value) || value.startsWith('\\\\') || value.startsWith('//')) return refuse('OWNERSHIP_INVALID');
  const normalized = p.normalize(value);
  return p === win32 ? normalized.toLowerCase() : normalized;
}
function ownedDataDirectory(root: string): string {
  const p = /^[A-Za-z]:[\\/]/.test(root) ? win32 : posix;
  return path(p.join(root, '.objective-planner-native', 'postgres-data'));
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) return refuse('OWNERSHIP_INVALID');
  return Date.parse(value);
}
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function objectivePlannerNativeOptIn(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.OBJECTIVE_PLANNER_NATIVE_OPT_IN === undefined) return false;
  if (env.OBJECTIVE_PLANNER_NATIVE_OPT_IN !== '1') return refuse('OPT_IN_REQUIRED');
  return true;
}

export function objectivePlannerNativeTarget(
  env: Readonly<Record<string, string | undefined>>,
  rawManifest: unknown,
  context: { workspaceRoot: string; sourceHead: string; nowMs: number },
): ObjectivePlannerNativeTarget {
  // Default-off discovery is safe even on a machine carrying unrelated DB env.
  if (!objectivePlannerNativeOptIn(env)) return { enabled: false };
  if (env.CI_DISPOSABLE_POSTGRES !== '1' || env.DATABASE_URL !== undefined ||
      ['PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']
        .some(key => env[key] !== undefined)) return refuse();
  const rawUrl = env.OBJECTIVE_PLANNER_NATIVE_DATABASE_URL;
  if (!rawUrl) return refuse();
  let url: URL;
  try { url = new URL(rawUrl); } catch { return refuse(); }
  const port = Number(url.port);
  if (!['postgresql:', 'postgres:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/planner_qa' ||
      !url.port || !Number.isInteger(port) || port < 1024 || port > 65535 || port === 5432 ||
      url.search || url.hash || !url.username || !url.password) return refuse();
  let role: string;
  try { role = decodeURIComponent(url.username); } catch { return refuse(); }
  if (!ROLE.test(role)) return refuse();
  const m = object(rawManifest, ['schemaVersion', 'kind', 'owner', 'sourceHead', 'workspaceRoot', 'dataDirectory',
    'hostname', 'port', 'database', 'databaseOid', 'runtimeRole', 'processId', 'postmasterStartedAtSeconds',
    'ownershipToken', 'createdAt', 'expiresAt']);
  const created = timestamp(m.createdAt), expires = timestamp(m.expiresAt);
  if (m.schemaVersion !== 1 || m.kind !== 'task-owned-objective-planner-postgres' ||
      m.owner !== OBJECTIVE_PLANNER_NATIVE_OWNER || !SHA.test(context.sourceHead) ||
      m.sourceHead !== context.sourceHead || path(m.workspaceRoot) !== path(context.workspaceRoot) ||
      path(m.dataDirectory) !== ownedDataDirectory(context.workspaceRoot) ||
      m.hostname !== url.hostname || m.port !== port || m.database !== 'planner_qa' || m.runtimeRole !== role ||
      !positive(m.databaseOid) || !positive(m.processId) || !positive(m.postmasterStartedAtSeconds) ||
      typeof m.ownershipToken !== 'string' || !TOKEN.test(m.ownershipToken) ||
      !Number.isSafeInteger(context.nowMs) || created > context.nowMs || expires <= context.nowMs ||
      expires <= created || expires - created > 24 * 60 * 60 * 1000 ||
      m.postmasterStartedAtSeconds * 1000 > created) return refuse('OWNERSHIP_INVALID');
  return { enabled: true, databaseUrl: rawUrl,
    manifest: Object.freeze({ ...m } as unknown as ObjectivePlannerNativeManifest) };
}

/** Verify actual local filesystem observations before constructing Prisma.
 * The caller realpaths both paths, reads PG_VERSION/postmaster.pid, and probes
 * the recorded PID with signal 0. None of those actions contacts PostgreSQL. */
export function requireObjectivePlannerNativePostmaster(
  target: Extract<ObjectivePlannerNativeTarget, { enabled: true }>,
  observed: { workspaceRealPath: string; dataDirectoryRealPath: string; pgVersion: string;
    postmasterPid: string; processAlive: boolean },
): void {
  const m = target.manifest, lines = observed.postmasterPid.trimEnd().split(/\r?\n/);
  const listeners = (lines[5] ?? '').split(',').map(s => s.trim());
  if (path(observed.workspaceRealPath) !== path(m.workspaceRoot) ||
      path(observed.dataDirectoryRealPath) !== path(m.dataDirectory) || observed.pgVersion.trim() !== '16' ||
      Number(lines[0]) !== m.processId || path(lines[1]) !== path(m.dataDirectory) ||
      Number(lines[2]) !== m.postmasterStartedAtSeconds || Number(lines[3]) !== m.port ||
      !observed.processAlive || !listeners.length ||
      listeners.some(host => !['127.0.0.1', 'localhost', '::1'].includes(host))) return refuse('OWNERSHIP_INVALID');
}

/** Read-only connected identity check, required before any fixture writes. */
export function requireObjectivePlannerNativeCatalog(
  target: Extract<ObjectivePlannerNativeTarget, { enabled: true }>,
  row: { databaseName: string; databaseOid: number; roleName: string; serverPort: number;
    databaseComment: string | null; postmasterStartedAtSeconds: string; superuser: boolean; bypassRls: boolean },
): void {
  const m = target.manifest;
  if (row.databaseName !== m.database || row.databaseOid !== m.databaseOid || row.roleName !== m.runtimeRole ||
      row.serverPort !== m.port || row.databaseComment !== `task-owned:objective-planner-native:${m.ownershipToken}` ||
      row.postmasterStartedAtSeconds !== String(m.postmasterStartedAtSeconds) || row.superuser || row.bypassRls)
    return refuse('OWNERSHIP_INVALID');
}
