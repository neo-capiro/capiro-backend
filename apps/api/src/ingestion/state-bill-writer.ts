import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { ALL_US_STATE_CODES } from '../external/legiscan/us-states.js';

const scopes = new WeakMap<object, readonly string[]>();
const mutations = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

/** All state metadata/document writers share the existing checkpoint lease.
 * The supplied Prisma facade fences every mutation inside its actual transaction,
 * so an expired process cannot publish after a successor acquires the lease.
 * This also supports existing canonical writers' nested callback transactions. */
export async function withStateBillWriter<T>(
  prisma: PrismaClient,
  states: readonly string[],
  run: (writer: PrismaClient) => Promise<T>,
): Promise<T> {
  const selected = [...new Set(states)].sort();
  if (
    !selected.length ||
    selected.some((state) => !(ALL_US_STATE_CODES as readonly string[]).includes(state))
  )
    throw Error('STATE_WRITER_SCOPE_INVALID');
  const inherited = scopes.get(prisma);
  if (inherited) {
    if (selected.some((state) => !inherited.includes(state)))
      throw Error('STATE_WRITER_SCOPE_MISMATCH');
    return run(prisma);
  }
  const sources = selected.map((state) => 'state-bills:' + state),
    token = randomUUID();
  const acquired: string[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let renewal: Promise<void> = Promise.resolve(),
    lost = false;
  async function fence(tx: any) {
    if (lost) throw Error('STATE_WRITER_LEASE_LOST');
    const rows = await tx.$queryRawUnsafe(
      `SELECT source FROM federal_evidence_checkpoint WHERE source=ANY($1::text[])
       AND lease_token=$2::uuid AND lease_until>clock_timestamp() ORDER BY source FOR UPDATE`,
      sources,
      token,
    );
    if (rows.length !== sources.length) throw Error('STATE_WRITER_LEASE_LOST');
    await tx.$executeRawUnsafe(
      `UPDATE federal_evidence_checkpoint SET lease_until=clock_timestamp()+interval '15 minutes',updated_at=clock_timestamp()
       WHERE source=ANY($1::text[]) AND lease_token=$2::uuid`,
      sources,
      token,
    );
  }
  function transactionView(tx: any): PrismaClient {
    const view = new Proxy(tx, {
      get(target, key) {
        if (key === '$transaction')
          return (fn: (client: PrismaClient) => unknown) => {
            if (typeof fn !== 'function') throw Error('STATE_WRITER_CALLBACK_TRANSACTION_REQUIRED');
            return fn(view);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as PrismaClient;
    scopes.set(view, selected);
    return view;
  }
  async function write<R>(fn: (tx: PrismaClient) => Promise<R>, options?: object): Promise<R> {
    return prisma.$transaction(
      async (tx) => {
        await fence(tx);
        return fn(transactionView(tx));
      },
      { timeout: 60000, ...options },
    );
  }
  const writer = new Proxy(prisma, {
    get(target, key) {
      if (key === '$transaction') return write;
      if (typeof key === 'string' && /^\$(execute|query)Raw(Unsafe)?$/.test(key))
        return (...args: unknown[]) => write((tx: any) => tx[key](...args));
      const value = Reflect.get(target, key);
      if (value && typeof value === 'object' && typeof key === 'string' && !key.startsWith('$')) {
        return new Proxy(value, {
          get(model, operation) {
            const method = Reflect.get(model, operation);
            if (mutations.has(String(operation)))
              return (...args: unknown[]) => write((tx: any) => tx[key][operation](...args));
            return typeof method === 'function' ? method.bind(model) : method;
          },
        });
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  scopes.set(writer, selected);
  try {
    for (const source of sources) {
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        `INSERT INTO federal_evidence_checkpoint(source,status,lease_token,lease_until)
         VALUES($1,'running',$2::uuid,clock_timestamp()+interval '15 minutes')
         ON CONFLICT(source) DO UPDATE SET lease_token=EXCLUDED.lease_token,lease_until=EXCLUDED.lease_until,status='running'
         WHERE federal_evidence_checkpoint.lease_until IS NULL OR federal_evidence_checkpoint.lease_until<clock_timestamp()
         RETURNING source`,
        source,
        token,
      );
      if (rows.length !== 1) throw Error('STATE_WRITER_ALREADY_RUNNING');
      acquired.push(source);
    }
    timer = setInterval(() => {
      renewal = renewal
        .then(() => prisma.$transaction(fence))
        .catch(() => {
          lost = true;
        });
    }, 30000);
    timer.unref();
    return await run(writer);
  } finally {
    if (timer) clearInterval(timer);
    await renewal;
    if (acquired.length)
      await prisma.$executeRawUnsafe(
        `UPDATE federal_evidence_checkpoint SET lease_token=NULL,lease_until=NULL,status='idle'
       WHERE source=ANY($1::text[]) AND lease_token=$2::uuid`,
        acquired,
        token,
      );
    scopes.delete(writer);
  }
}
