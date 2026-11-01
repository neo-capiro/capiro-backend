import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  contentHash,
  forecastId,
  monthBounds,
  type ForecastContent,
  type ForecastSource,
} from './forecast-contract.js';

export interface ForecastCandidate extends Omit<ForecastContent, 'source'> {
  sourceKey: string;
  rin: string;
  source: Omit<ForecastSource, 'rin'>;
}
export interface ForecastSnapshot {
  candidates: ForecastCandidate[];
  completedMilestones?: {
    sourceKey: string;
    rin: string;
    source: Omit<ForecastSource, 'rin'>;
    action: string;
    rawDate: string;
  }[];
  withdrawnRins: {
    rin: string;
    source: Omit<ForecastSource, 'rin'>;
    action: 'Withdrawn';
    rawDate: string;
  }[];
  rejected: unknown[];
}
type Head = {
  current_revision: number;
  content_hash: string | null;
  observed_at: Date | null;
  status: string;
};

/** Existing sync-job owner supplies a qualified snapshot. No HTTP mutation or scheduler. */
export async function persistForecastSnapshot(
  prisma: PrismaClient,
  snapshot: ForecastSnapshot,
  metadata: { sha256: string; edition: string; observedAt: Date; sourceXml: string },
) {
  if (
    typeof metadata.sourceXml !== 'string' ||
    Buffer.byteLength(metadata.sourceXml, 'utf8') > 40 * 1024 * 1024 ||
    createHash('sha256').update(metadata.sourceXml).digest('hex') !== metadata.sha256
  )
    throw new Error('Snapshot source archive mismatch');
  if (
    !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
    !/^\d{6}$/.test(metadata.edition) ||
    !Number.isFinite(metadata.observedAt.getTime()) ||
    metadata.observedAt.getTime() > Date.now() + 60000 ||
    snapshot.candidates.length > 10000 ||
    snapshot.withdrawnRins.length > 10000 ||
    (snapshot.completedMilestones?.length ?? 0) > 10000
  )
    throw new Error('Invalid snapshot metadata');
  if (
    snapshot.rejected.some(
      (item) => (item as { reason?: string })?.reason === 'edition_mismatch',
    ) ||
    (!snapshot.candidates.length &&
      !snapshot.withdrawnRins.length &&
      !snapshot.completedMilestones?.length &&
      snapshot.rejected.length)
  )
    throw new Error('Unqualified forecast snapshot');
  const identities = new Set<string>();
  for (const candidate of snapshot.candidates) {
    if (candidate.sourceKey !== `${candidate.rin}:${candidate.eventType}`)
      throw new Error('Invalid source milestone identity');
    const id = forecastId(candidate.sourceKey);
    if (identities.has(id)) throw new Error('Ambiguous duplicate forecast identity');
    identities.add(id);
    if (
      candidate.source.sha256 !== metadata.sha256 ||
      candidate.source.edition !== metadata.edition
    )
      throw new Error('Forecast snapshot provenance mismatch');
    contentHash({ ...candidate, source: { ...candidate.source, rin: candidate.rin } });
  }
  for (const withdrawal of snapshot.withdrawnRins) {
    if (
      withdrawal.source.sha256 !== metadata.sha256 ||
      withdrawal.source.edition !== metadata.edition ||
      withdrawal.action !== 'Withdrawn' ||
      !withdrawal.rawDate
    )
      throw new Error('Invalid withdrawal evidence');
    if (snapshot.candidates.some((candidate) => candidate.rin === withdrawal.rin))
      throw new Error('Contradictory published and withdrawn source');
  }
  for (const completed of snapshot.completedMilestones ?? []) {
    if (
      completed.source.sha256 !== metadata.sha256 ||
      completed.source.edition !== metadata.edition ||
      !['NPRM', 'Final Rule'].includes(completed.action) ||
      !completed.rawDate
    )
      throw new Error('Invalid source completion evidence');
    if (
      completed.sourceKey !==
      `${completed.rin}:${completed.action === 'NPRM' ? 'proposed_rule' : 'final_rule'}`
    )
      throw new Error('Invalid completed milestone identity');
    if (identities.has(forecastId(completed.sourceKey)))
      throw new Error('Contradictory completion and forecast');
  }
  return prisma.$transaction(
    async (tx) => {
      // Serialize this one public producer; there are no per-user locks/ledgers.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(721111, 1)`;
      const replay = await tx.$queryRaw<
        { id: bigint; accepted_count: number; rejected_count: number }[]
      >`
      SELECT id,accepted_count,rejected_count FROM government_forecast_check
      WHERE snapshot_sha256=${metadata.sha256} AND attempted_at=${metadata.observedAt} AND status='success'`;
      if (replay.length)
        return {
          checkId: String(replay[0].id),
          accepted: replay[0].accepted_count,
          rejected: replay[0].rejected_count,
          replay: true,
        };
      const latest = await tx.$queryRaw<{ edition: string; attempted_at: Date }[]>`
      SELECT edition,attempted_at FROM government_forecast_check WHERE status='success'
      ORDER BY attempted_at DESC,id DESC LIMIT 1`;
      if (
        latest[0] &&
        (metadata.edition < latest[0].edition || metadata.observedAt <= latest[0].attempted_at)
      )
        throw new Error('Out-of-order forecast snapshot');
      await tx.$executeRaw`
      INSERT INTO government_forecast_source(sha256,edition,source_xml)
      VALUES (${metadata.sha256},${metadata.edition},${metadata.sourceXml}) ON CONFLICT (sha256) DO NOTHING`;
      const [check] = await tx.$queryRaw<{ id: bigint }[]>`
      INSERT INTO government_forecast_check(snapshot_sha256,edition,attempted_at,status,rejected_count)
      VALUES (${metadata.sha256},${metadata.edition},${metadata.observedAt},'success',${snapshot.rejected.length}) RETURNING id`;
      let accepted = 0;
      let held = 0;
      const apply = async (id: string, content: ForecastContent) => {
        const [head] = await tx.$queryRaw<Head[]>`
        SELECT current_revision,content_hash,observed_at,status FROM government_forecast WHERE id=${id} FOR UPDATE`;
        if (content.status === 'published' && head.status !== 'published') {
          held++;
          return;
        }
        const hash = contentHash(content);
        const revision =
          head.content_hash === hash ? head.current_revision : head.current_revision + 1;
        if (revision !== head.current_revision) {
          await tx.$executeRaw`
          INSERT INTO government_forecast_revision(forecast_id,revision,content,observed_at)
          VALUES (${id},${revision},${JSON.stringify(content)}::jsonb,${metadata.observedAt})`;
        }
        const bounds = monthBounds(content.period);
        await tx.$executeRaw`
        UPDATE government_forecast SET current_revision=${revision},content_hash=${hash},observed_at=${metadata.observedAt},
          window_from=${bounds?.from ?? null}::date,window_to=${bounds?.to ?? null}::date,status=${content.status} WHERE id=${id}`;
        await tx.$executeRaw`
        INSERT INTO government_forecast_observation(check_id,forecast_id,revision) VALUES (${check.id},${id},${revision})`;
        accepted++;
      };
      for (const candidate of snapshot.candidates) {
        const id = forecastId(candidate.sourceKey);
        const terminal = await tx.$queryRaw<{ source_key: string }[]>`
        SELECT source_key FROM government_forecast_terminal WHERE source_key=${candidate.sourceKey}`;
        if (terminal.length) {
          held++;
          continue;
        }
        await tx.$executeRaw`
        INSERT INTO government_forecast(id,source_key,rin) VALUES (${id},${candidate.sourceKey},${candidate.rin})
        ON CONFLICT (id) DO NOTHING`;
        const { sourceKey: _key, rin, ...content } = candidate;
        await apply(id, { ...content, source: { ...content.source, rin } });
      }
      // A proceeding can be withdrawn after its NPRM already happened. Apply explicit
      // milestone completions first so that a RIN withdrawal retires only pending work.
      for (const completed of snapshot.completedMilestones ?? []) {
        await tx.$executeRaw`
        INSERT INTO government_forecast_terminal(source_key,status,check_id,evidence)
        VALUES (${completed.sourceKey},'source_completed',${check.id},${JSON.stringify(completed)}::jsonb)
        ON CONFLICT (source_key) DO NOTHING`;
        const id = forecastId(completed.sourceKey);
        const previous = await tx.$queryRaw<{ content: ForecastContent }[]>`
        SELECT r.content FROM government_forecast f JOIN government_forecast_revision r
          ON r.forecast_id=f.id AND r.revision=f.current_revision WHERE f.id=${id} AND f.status <> 'withdrawn'`;
        if (previous[0])
          await apply(id, {
            ...previous[0].content,
            status: 'source_completed',
            completionEvidence: { action: completed.action, rawDate: completed.rawDate },
            source: { ...completed.source, rin: completed.rin },
          });
      }
      for (const withdrawal of snapshot.withdrawnRins) {
        for (const eventType of ['proposed_rule', 'final_rule'])
          await tx.$executeRaw`
        INSERT INTO government_forecast_terminal(source_key,status,check_id,evidence)
        VALUES (${`${withdrawal.rin}:${eventType}`},'withdrawn',${check.id},${JSON.stringify(withdrawal)}::jsonb)
        ON CONFLICT (source_key) DO NOTHING`;
        const previous = await tx.$queryRaw<{ id: string; content: ForecastContent }[]>`
        SELECT f.id,r.content FROM government_forecast f JOIN government_forecast_revision r
          ON r.forecast_id=f.id AND r.revision=f.current_revision WHERE f.rin=${withdrawal.rin} AND f.status <> 'source_completed'`;
        for (const row of previous)
          await apply(row.id, {
            ...row.content,
            status: 'withdrawn',
            withdrawalEvidence: { action: withdrawal.action, rawDate: withdrawal.rawDate },
            source: { ...withdrawal.source, rin: withdrawal.rin },
          });
      }
      await tx.$executeRaw`UPDATE government_forecast_check SET accepted_count=${accepted},rejected_count=${snapshot.rejected.length + held} WHERE id=${check.id}`;
      return {
        checkId: String(check.id),
        accepted,
        rejected: snapshot.rejected.length + held,
        replay: false,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120000 },
  );
}

/** A failed source check records failure only. It cannot refresh observations or withdraw forecasts. */
export async function recordForecastCheckFailure(prisma: PrismaClient, attemptedAt: Date) {
  if (!Number.isFinite(attemptedAt.getTime()) || attemptedAt.getTime() > Date.now() + 60000)
    throw new Error('Invalid check time');
  await prisma.$executeRaw`
    INSERT INTO government_forecast_check(attempted_at,status) VALUES (${attemptedAt},'failed') ON CONFLICT DO NOTHING`;
}
