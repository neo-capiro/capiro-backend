import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export type RetainedNewsRights = 'headline_link' | 'excerpt' | 'full_text';
export interface RetainedNewsObservation {
  articleId: string;
  observationId: string;
  revision: string;
  title: string;
  publisher: string;
  sourceUrl: string;
  summary: string | null;
  rights: RetainedNewsRights;
  complete: boolean;
  observedAt: string;
  currentObservationId: string;
  currentRights: RetainedNewsRights;
}
const token = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
const rights = ['headline_link', 'excerpt', 'full_text'];

/** Public retained corpus owned by this service. Never creates an observation,
 * ingests a URL, upgrades rights or substitutes the current observation. */
export async function readRetainedNewsObservation(
  tx: Prisma.TransactionClient,
  articleId: string,
  observationId: string,
): Promise<RetainedNewsObservation> {
  if (!token(articleId) || !/^[a-f0-9]{64}$/.test(observationId))
    throw new BadRequestException('Invalid retained news selection.');
  const rows = await tx.$queryRaw<
    Array<{
      articleId: string;
      observationId: string;
      revision: string;
      title: string;
      publisher: string;
      sourceUrl: string;
      summary: string | null;
      rights: RetainedNewsRights;
      complete: boolean;
      observedAt: Date;
      currentObservationId: string;
      currentRights: RetainedNewsRights;
    }>
  >`SELECT o.article_id AS "articleId",o.id AS "observationId",o.revision,o.title,o.publisher,
      o.source_url AS "sourceUrl",o.summary,o.rights,o.body_complete AS complete,o.observed_at AS "observedAt",
      c.observation_id AS "currentObservationId",n.rights AS "currentRights"
    FROM legiwatch_news_observation o
    JOIN legiwatch_news_current c ON c.article_id=o.article_id
    JOIN legiwatch_news_observation n ON n.id=c.observation_id AND n.article_id=o.article_id
    WHERE o.article_id=${articleId} AND o.id=${observationId} FOR SHARE OF c`;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    row.articleId !== articleId ||
    row.observationId !== observationId ||
    !/^[a-f0-9]{64}$/.test(row.revision) ||
    !rights.includes(row.rights) ||
    !/^[a-f0-9]{64}$/.test(row.currentObservationId) ||
    typeof row.title !== 'string' ||
    !row.title.trim() ||
    row.title.length > 2000 ||
    typeof row.publisher !== 'string' ||
    row.publisher.length > 2000 ||
    typeof row.sourceUrl !== 'string' ||
    row.sourceUrl.length > 8192 ||
    (row.summary !== null && (typeof row.summary !== 'string' || row.summary.length > 10000)) ||
    !(row.observedAt instanceof Date) ||
    !Number.isFinite(row.observedAt.getTime()) ||
    !rights.includes(row.currentRights) ||
    rights.indexOf(row.currentRights) < rights.indexOf(row.rights)
  )
    throw new NotFoundException('Retained news observation unavailable.');
  return {
    ...row,
    summary: row.rights === 'headline_link' ? null : row.summary,
    complete: row.rights === 'full_text' && row.complete,
    observedAt: row.observedAt.toISOString(),
  };
}

/** Lexical keyset over current retained observations; absent observations stay absent. */
export async function listRetainedNewsObservations(
  tx: Prisma.TransactionClient,
  search: string,
  cursor?: string,
) {
  if (search.length > 200 || (cursor && !token(cursor)))
    throw new BadRequestException('Invalid retained news query.');
  const rows = await tx.$queryRaw<Array<{ articleId: string; observationId: string }>>`
    SELECT o.article_id AS "articleId",o.id AS "observationId"
    FROM legiwatch_news_current c JOIN legiwatch_news_observation o
      ON o.id=c.observation_id AND o.article_id=c.article_id
    WHERE (${cursor ?? ''}='' OR o.article_id>${cursor ?? ''})
      AND (${search}='' OR POSITION(LOWER(${search}) IN LOWER(o.title || ' ' || o.publisher))>0)
    ORDER BY o.article_id LIMIT 21`;
  return { items: rows.slice(0, 20), nextCursor: rows.length > 20 ? rows[19]!.articleId : null };
}
