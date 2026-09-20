/**
 * C-11: profile-lease coordination across two separately booted HTTP servers.
 *
 * Unlike the cross-replica spec's two service objects in one Jest process, each
 * contender here has its own Node process, Nest container, Prisma client/pool,
 * module globals and in-memory state. The only shared coordinator is Postgres.
 */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { PrismaService } from '../../prisma/prisma.service.js';
import { privateExecutionScopeId } from './meri-hermes-worker-token.js';

function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url)
    throw new Error(
      'DATABASE_URL is required to run meri-hermes-profile-lease-http-process.spec.ts',
    );
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-profile-lease-http-process.spec.ts refuses non-local DATABASE_URL host ${parsed.hostname}`,
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

jest.setTimeout(90_000);

interface HttpReplica {
  child: ChildProcessByStdio<null, Readable, Readable>;
  name: string;
  runId: string;
  port: number;
  stderr: string[];
}

interface HttpResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

function post<T = Record<string, unknown>>(
  port: number,
  path: string,
  body: Record<string, unknown>,
): Promise<HttpResult<T>> {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(encoded),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as T });
          } catch (error) {
            reject(
              new Error(
                `HTTP ${res.statusCode} returned non-JSON ${raw.slice(0, 500)}: ${String(error)}`,
              ),
            );
          }
        });
      },
    );
    req.once('error', reject);
    req.end(encoded);
  });
}

async function spawnReplica(name: string, runId: string): Promise<HttpReplica> {
  const fixture = join(__dirname, 'meri-hermes-profile-lease-http-process.fixture.ts');
  const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    [tsxCli, fixture, name, runId],
    { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stderr: string[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  let ready: string;
  try {
    ready = await new Promise<string>((resolve, reject) => {
      let buffered = '';
      const timer = setTimeout(
        () =>
          reject(new Error(`${name} never reported READY. stderr=${stderr.join('').slice(-1000)}`)),
        60_000,
      );
      child.stdout.on('data', (chunk: Buffer) => {
        buffered += chunk.toString();
        const line = buffered
          .split('\n')
          .find((candidate) => candidate.startsWith('READY ') || candidate.startsWith('FAILED '));
        if (!line) return;
        clearTimeout(timer);
        resolve(line.trim());
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`${name} could not be spawned: ${String(error)}`));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `${name} exited before READY with code ${code}. stderr=${stderr.join('').slice(-1000)}`,
          ),
        );
      });
    });
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  const match = /^READY \S+ (\d+)$/.exec(ready);
  if (!match) {
    child.kill('SIGKILL');
    throw new Error(
      `${name} fixture startup failed: ${ready}. stderr=${stderr.join('').slice(-1000)}`,
    );
  }
  return { child, name, runId, port: Number(match[1]), stderr };
}

async function killReplica(replica: HttpReplica): Promise<void> {
  if (replica.child.exitCode !== null || replica.child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => replica.child.once('exit', () => resolve()));
  replica.child.kill('SIGKILL');
  await Promise.race([
    exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${replica.name} did not exit after SIGKILL`)), 10_000),
    ),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('C-11 profile lease coordination across real HTTP processes', () => {
  let prisma: PrismaService;
  let tenantId: string;
  let userId: string;
  let scopeId: string;
  const replicas: HttpReplica[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    tenantId = randomUUID();
    userId = randomUUID();
    scopeId = privateExecutionScopeId(tenantId, userId);
    await prisma.withSystem(async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenantId,
          slug: `meri-hermes-http-process-${tenantId}`,
          name: 'Meri Hermes HTTP process lease fixture',
          status: 'active',
        },
      });
      await tx.user.create({
        data: { id: userId, clerkUserId: userId, email: `${userId}@example.test` },
      });
    });
    await prisma.withTenant(tenantId, (tx) =>
      tx.meriExecutionScope.create({
        data: {
          id: scopeId,
          tenantId,
          principalType: 'user',
          principalId: userId,
          kind: 'private',
          authorizationVersion: 'v1:http-process-spec',
        },
      }),
    );
  });

  afterEach(async () => {
    await Promise.all(
      replicas.splice(0).map((replica) => killReplica(replica).catch(() => undefined)),
    );
  });

  afterAll(async () => {
    await Promise.all(
      replicas.splice(0).map((replica) => killReplica(replica).catch(() => undefined)),
    );
    await prisma
      .withTenant(
        tenantId,
        (tx) => tx.$executeRaw`DELETE FROM meri_agent_profile_leases WHERE scope_id = ${scopeId}`,
      )
      .catch(() => undefined);
    await prisma
      .withSystem((tx) => tx.tenant.delete({ where: { id: tenantId } }))
      .catch(() => undefined);
    await prisma
      .withSystem((tx) => tx.user.delete({ where: { id: userId } }))
      .catch(() => undefined);
    await prisma.$disconnect();
  });

  test('two HTTP processes elect one writer; after process death the loser takes over with a new fence and rejects the dead writer token', async () => {
    const runA = randomUUID();
    const runB = randomUUID();
    // Register each process immediately after boot so a failure while starting
    // the second still leaves the first reachable by afterEach teardown.
    const replicaA = await spawnReplica('replica-a', runA);
    replicas.push(replicaA);
    const replicaB = await spawnReplica('replica-b', runB);
    replicas.push(replicaB);

    const ttlMs = 1_200;
    const [resultA, resultB] = await Promise.all([
      post<{ acquired: boolean; runId: string; fence?: number; holderRunId?: string }>(
        replicaA.port,
        '/lease/acquire',
        {
          scopeId,
          tenantId,
          ttlMs,
        },
      ),
      post<{ acquired: boolean; runId: string; fence?: number; holderRunId?: string }>(
        replicaB.port,
        '/lease/acquire',
        {
          scopeId,
          tenantId,
          ttlMs,
        },
      ),
    ]);

    const winners = [resultA, resultB].filter(
      (result) => result.status === 201 && result.body.acquired,
    );
    const losers = [resultA, resultB].filter(
      (result) => result.status === 409 && !result.body.acquired,
    );
    if (winners.length !== 1 || losers.length !== 1) {
      throw new Error(
        `Expected one winner and one rejected loser; A=${JSON.stringify(resultA)} stderr=${replicaA.stderr.join('').slice(-1500)} ` +
          `B=${JSON.stringify(resultB)} stderr=${replicaB.stderr.join('').slice(-1500)}`,
      );
    }
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const winnerResult = winners[0]!;
    const loserResult = losers[0]!;
    const winner = resultA === winnerResult ? replicaA : replicaB;
    const loser = resultA === loserResult ? replicaA : replicaB;
    expect(loserResult.body.holderRunId).toBe(winner.runId);
    const deadFence = winnerResult.body.fence!;

    // Abrupt process death: no route call, release or finally block can run.
    await killReplica(winner);
    await sleep(ttlMs + 350);

    const takeover = await post<{ acquired: boolean; runId: string; fence: number }>(
      loser.port,
      '/lease/acquire',
      {
        scopeId,
        tenantId,
        ttlMs: 30_000,
      },
    );
    expect(takeover.status).toBe(201);
    expect(takeover.body).toMatchObject({
      acquired: true,
      runId: loser.runId,
      fence: deadFence + 1,
    });

    // Present the killed process's exact old (holder, fence) pair over HTTP.
    // The database fence rejects it before the mutation can execute.
    const staleWrite = await post<{
      code: string;
      currentHolderRunId: string;
      currentFence: number;
    }>(loser.port, '/lease/write', {
      scopeId,
      tenantId,
      runId: winner.runId,
      fence: deadFence,
      key: 'writtenByDeadProcess',
    });
    expect(staleWrite.status).toBe(409);
    expect(staleWrite.body).toMatchObject({
      code: 'stale_profile_writer',
      currentHolderRunId: loser.runId,
      currentFence: deadFence + 1,
    });

    const currentWrite = await post<{ state: Record<string, unknown> }>(
      loser.port,
      '/lease/write',
      {
        scopeId,
        tenantId,
        runId: loser.runId,
        fence: takeover.body.fence,
        key: 'writtenBySurvivor',
      },
    );
    expect(currentWrite.status).toBe(201);
    expect(currentWrite.body.state).toMatchObject({ writtenBySurvivor: true });
    expect(currentWrite.body.state.writtenByDeadProcess).toBeUndefined();
  });
});
