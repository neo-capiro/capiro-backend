import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { runScheduledTasks } from './run-clio-scheduled-tasks.js';

const CONFIG_PATH = 'C:/dev/cap-meri-foundation-evidence/private/local-postgres.json';
const schema = process.env.MERI_SCHEDULER_RUNNER_SCHEMA ?? '';
const checkpointTarget = process.env.MERI_SCHEDULER_RUNNER_CHECKPOINT ?? '';

if (!/^meri_scheduler_runner_[a-f0-9]{32}$/.test(schema)) {
  throw new Error('invalid owned scheduler runner schema');
}

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  scope: string;
};
if (config.host !== '127.0.0.1' || config.port !== 55433 || !config.user || !config.scope) {
  throw new Error('private owned local PostgreSQL identity not established');
}

const pool = new Pool({
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
  database: config.database,
  max: 4,
});

function transactionClient(client: PoolClient) {
  return {
    client: {
      findFirst: async ({ where }: { where: Record<string, string> }) => {
        const result = await client.query(
          `SELECT id
             FROM clients
            WHERE id::text = $1 AND tenant_id::text = $2 AND status <> 'archived'
            LIMIT 1`,
          [where.id, where.tenantId],
        );
        return result.rows[0] ?? null;
      },
    },
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) =>
      (await client.query(sql, params)).rows,
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) =>
      (await client.query(sql, params)).rowCount ?? 0,
  };
}

async function withTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    const value = await fn(transactionClient(client));
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const prisma = {
  withSystem: withTransaction,
  withTenant: async (_tenantId: string, fn: (tx: any) => Promise<any>) => withTransaction(fn),
  withTenantUser: async (_tenantId: string, _userId: string, fn: (tx: any) => Promise<any>) =>
    withTransaction(fn),
};

const toolsService = {
  sendScheduledBriefingEmail: async () => {
    await pool.query(
      `INSERT INTO "${schema}".controlled_effects (kind, worker_pid)
       VALUES ('email', $1)`,
      [process.pid],
    );
    return { ok: true, sentFrom: 'controlled@example.test' };
  },
};

const aiCreds = {
  resolveProvider: async () => ({
    apiKey: 'controlled-no-network-key',
    model: 'controlled-no-network-model',
    usedTenantKey: false,
  }),
};

async function checkpoint(
  stage: 'claimed' | 'result_saved' | 'email_effect',
  input: { claim: { occurrenceId: string; fence: string; recovered: boolean } },
): Promise<void> {
  const targetMatches =
    checkpointTarget === stage ||
    (checkpointTarget === 'claimed_recovered' && stage === 'claimed' && input.claim.recovered);
  if (!targetMatches) return;
  await pool.query(
    `INSERT INTO "${schema}".runner_checkpoints
       (stage, occurrence_id, fence, recovered, worker_pid)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5)`,
    [stage, input.claim.occurrenceId, input.claim.fence, input.claim.recovered, process.pid],
  );
  // The parent owns and records this exact child before terminating it.
  await new Promise<void>(() => undefined);
}

void runScheduledTasks({
  services: { prisma, toolsService, aiCreds },
  commit: true,
  research: async ({ task, executeAuthorized }) => {
    const effect = await executeAuthorized(async () => {
      await pool.query(
        `INSERT INTO "${schema}".controlled_effects (kind, worker_pid)
         VALUES ('provider', $1)`,
        [process.pid],
      );
      return { text: `controlled result for ${task.name}`, toolsUsed: [] as string[] };
    });
    return effect.executed === true ? effect.value : { blocked: effect.boundary };
  },
  checkpoint: checkpointTarget ? checkpoint : undefined,
})
  .then(async () => {
    await pool.end();
  })
  .catch(async (error) => {
    console.error('[scheduler-postgres-child] FAILED', error);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
