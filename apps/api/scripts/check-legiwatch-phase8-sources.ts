import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

const officialHosts = new Set([
  'www.flsenate.gov',
  'laws.flrules.org',
  'www.flhouse.gov',
  'floridalobbyist.gov',
  'floridafiscalportal.state.fl.us',
  'www.flgov.com',
  'flgov.com',
]);

/** Revisit retained, reviewed public sources through the existing RSS worker.
 * Changed bytes require extraction review; a fetch never silently promotes new fiscal amounts. */
export async function checkPhase8Sources(prisma: PrismaClient, maxSources = 12) {
  if (process.env.LEGIWATCH_FISCAL_REFRESH_ENABLED !== 'true')
    return { state: 'disabled', checked: 0 };
  const sources = await prisma.$queryRaw<
    Array<{ source_url: string; content_hash: string }>
  >`SELECT DISTINCT ON (r.source_url) r.source_url,r.content_hash FROM legiwatch_source_receipt r WHERE r.content_bytes IS NOT NULL AND r.source<>'phase8-refresh' ORDER BY r.source_url,r.observed_at DESC LIMIT ${Math.min(20, Math.max(1, maxSources))}`;
  const results: Array<Record<string, unknown>> = [];
  for (const source of sources) {
    const url = new URL(source.source_url);
    if (url.protocol !== 'https:' || !officialHosts.has(url.hostname)) continue;
    // A daily source receipt bounds work shared by repeated RSS worker invocations.
    const day = new Date().toISOString().slice(0, 10),
      lock = `phase8-refresh:${day}:${source.source_url}`;
    const result = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock},0))`;
        const existing = await tx.$queryRaw<
          Array<{ manifest: Record<string, unknown> }>
        >`SELECT manifest FROM legiwatch_source_receipt WHERE source='phase8-refresh' AND source_url=${source.source_url} AND observed_at>=${new Date(day)} ORDER BY observed_at DESC LIMIT 1`;
        if (existing[0])
          return { sourceUrl: source.source_url, replayed: true, ...existing[0].manifest };
        let status = 'unavailable',
          hash = source.content_hash,
          bytes: Buffer | null = null;
        try {
          const response = await fetch(url, {
            redirect: 'error',
            signal: AbortSignal.timeout(25000),
            headers: { 'User-Agent': 'Capiro source verification' },
          });
          if (
            !response.ok ||
            Number(response.headers.get('content-length') ?? 0) > 20000000 ||
            !response.body
          )
            throw Error('SOURCE_FETCH_UNAVAILABLE');
          const reader = response.body.getReader(),
            chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.length;
              if (size > 20000000) throw Error('SOURCE_BYTE_LIMIT');
              chunks.push(chunk.value);
            }
          } finally {
            await reader.cancel();
          }
          const data = Buffer.concat(chunks);
          hash = createHash('sha256').update(data).digest('hex');
          status = hash === source.content_hash ? 'unchanged' : 'changed_review_required';
          if (status === 'changed_review_required') bytes = data;
        } catch {
          status = 'unavailable';
        }
        const manifest = {
          status,
          previousHash: source.content_hash,
          currentHash: hash,
          amountPromotion: 'operator_review_required',
        };
        await tx.$executeRaw`INSERT INTO legiwatch_source_receipt(id,source,source_url,content_hash,scope,manifest,complete,content_bytes) VALUES(${randomUUID()},'phase8-refresh',${source.source_url},${hash},${JSON.stringify({ day })}::jsonb,${JSON.stringify(manifest)}::jsonb,${status === 'unchanged'},${bytes})`;
        return { sourceUrl: source.source_url, ...manifest };
      },
      { timeout: 35000 },
    );
    results.push(result);
  }
  return { state: 'checked', checked: results.length, results };
}
