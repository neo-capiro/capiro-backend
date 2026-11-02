import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

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

/** Public legislative writers share the existing checkpoint lease per source.
 * The supplied Prisma facade fences every mutation inside its actual transaction,
 * so an expired process cannot publish after a successor acquires the lease.
 * This also supports existing canonical writers' nested callback transactions. */
export async function withLegislativeWriter<T>(
  prisma: PrismaClient,
  requestedSources: readonly string[],
  errorPrefix: 'STATE_WRITER' | 'FEDERAL_WRITER',
  run: (writer: PrismaClient) => Promise<T>,
): Promise<T> {
  const selected = [...new Set(requestedSources)].sort();
  if (
    !selected.length ||
    selected.some((source) => !/^(?:state-bills:[A-Z]{2}|congress-bills)$/.test(source))
  )
    throw Error(`${errorPrefix}_SCOPE_INVALID`);
  const inherited = scopes.get(prisma);
  if (inherited) {
    if (selected.some((state) => !inherited.includes(state)))
      throw Error(`${errorPrefix}_SCOPE_MISMATCH`);
    return run(prisma);
  }
  const sources = selected,
    token = randomUUID();
  const acquired: string[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let renewal: Promise<void> = Promise.resolve(),
    lost = false;
  let operations: Promise<void> = Promise.resolve();
  // A foreground transaction holds the lease row until commit. Queue this
  // owner's heartbeat behind it instead of timing out on our own row lock.
  function serialize<R>(operation: () => Promise<R>): Promise<R> {
    const result = operations.then(operation);
    operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function fence(tx: any) {
    if (lost) throw Error(`${errorPrefix}_LEASE_LOST`);
    const rows = await tx.$queryRawUnsafe(
      `SELECT source FROM federal_evidence_checkpoint WHERE source=ANY($1::text[])
       AND lease_token=$2::uuid AND lease_until>clock_timestamp() ORDER BY source FOR UPDATE`,
      sources,
      token,
    );
    if (rows.length !== sources.length) throw Error(`${errorPrefix}_LEASE_LOST`);
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
            if (typeof fn !== 'function')
              throw Error(`${errorPrefix}_CALLBACK_TRANSACTION_REQUIRED`);
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
    return serialize(() =>
      prisma.$transaction(
        async (tx) => {
          await fence(tx);
          return fn(transactionView(tx));
        },
        { timeout: 60000, ...options },
      ),
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
      if (rows.length !== 1) throw Error(`${errorPrefix}_ALREADY_RUNNING`);
      acquired.push(source);
    }
    timer = setInterval(() => {
      renewal = renewal.then(() =>
        serialize(async () => {
          try {
            await prisma.$transaction(fence);
          } catch (error: unknown) {
            const firstFailure = !lost;
            lost = true;
            if (!firstFailure) return;
            // Never log provider/SQL messages, connection strings or lease tokens.
            const name = error instanceof Error ? error.name : '';
            const code = (error as { code?: unknown } | null)?.code;
            console.error(
              JSON.stringify({
                event: 'LEGISLATIVE_WRITER_RENEWAL_FAILED',
                owner: errorPrefix,
                errorClass: /^(?:Error|PrismaClient(?:KnownRequest|UnknownRequest|Initialization|Validation|RustPanic)Error)$/.test(name)
                  ? name : 'Unknown',
                errorCode: typeof code === 'string' && /^(?:P[0-9]{4}|[0-9]{2}[A-Z0-9]{3}|ECONNRESET|ETIMEDOUT)$/.test(code)
                  ? code : null,
              }),
            );
          }
        }),
      );
    }, 30000);
    timer.unref();
    return await run(writer);
  } finally {
    if (timer) clearInterval(timer);
    await renewal;
    await operations;
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
