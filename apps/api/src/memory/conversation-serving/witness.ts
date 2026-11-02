/** Core's private, content-free read of the existing Meri retention owner.
 * No cached proof or new retention store. A missing proof is not permission;
 * the SQL policy decides whether the operation needs a conversation proof. */
export type MemoryRetentionWitness = { sequence: number; entrySha256: string | null };
const PATH = '/v1/internal/retention/serving-witness';

export async function readMemoryRetentionWitness(
  options: {
    origin?: string;
    secret?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<MemoryRetentionWitness | null> {
  const origin = options.origin ?? process.env.MERI_CONTROL_ORIGIN;
  const secret = options.secret ?? process.env.INTERNAL_SERVICE_SECRET;
  const timeoutMs = options.timeoutMs ?? 2000;
  let base: URL;
  try {
    base = new URL(origin ?? '');
  } catch {
    return null;
  }
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/' ||
    !secret ||
    secret.length < 16 ||
    secret.length > 8192 ||
    /[\s\x00-\x1f\x7f]/u.test(secret) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5000
  )
    return null;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let responseBody: ReadableStream<Uint8Array> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(Error('MEMORY_RETENTION_UNAVAILABLE'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await (options.fetchImpl ?? fetch)(new URL(PATH, base), {
          method: 'GET',
          redirect: 'error',
          signal: abort.signal,
          headers: {
            'x-internal-service-secret': secret,
            accept: 'application/json',
            'accept-encoding': 'identity',
            'cache-control': 'no-store',
          },
        });
        responseBody = response.body;
        if (abort.signal.aborted) {
          void responseBody?.cancel().catch(() => undefined);
          throw Error('unavailable');
        }
        if (
          response.status !== 200 ||
          !response.body ||
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
            response.headers.get('content-type') ?? '',
          ) ||
          ![null, 'identity'].includes(response.headers.get('content-encoding'))
        )
          throw Error('unavailable');
        const length = response.headers.get('content-length');
        if (length !== null && (!/^[0-9]+$/u.test(length) || Number(length) > 512))
          throw Error('unavailable');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const next = await reader.read();
          if (abort.signal.aborted) throw Error('unavailable');
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 512) throw Error('unavailable');
          chunks.push(next.value);
        }
        const value = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
        );
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          Object.keys(value).sort().join() !== 'entrySha256,schemaVersion,sequence' ||
          value.schemaVersion !== 1 ||
          !Number.isSafeInteger(value.sequence) ||
          value.sequence < 0 ||
          (value.sequence === 0
            ? value.entrySha256 !== null
            : typeof value.entrySha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.entrySha256))
        )
          throw Error('unavailable');
        return {
          sequence: value.sequence,
          entrySha256: value.entrySha256,
        } as MemoryRetentionWitness;
      })(),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    abort.abort();
    if (reader) void reader.cancel().catch(() => undefined);
    else if (responseBody)
      void (responseBody as ReadableStream<Uint8Array>).cancel().catch(() => undefined);
  }
}
