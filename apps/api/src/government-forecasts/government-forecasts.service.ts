import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  parsePage,
  parseRange,
  type ForecastContent,
  type ForecastRecord,
} from './forecast-contract.js';

type Row = {
  id: string;
  revision: number;
  content: ForecastContent;
  observed_at: Date;
  recorded_at: Date;
};
const project = (row: Row): ForecastRecord => ({
  ...row.content,
  id: row.id,
  revision: row.revision,
  observedAt: row.observed_at.toISOString(),
  recordedAt: row.recorded_at.toISOString(),
});

@Injectable()
export class GovernmentForecastsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(input: Parameters<typeof parseRange>[0]) {
    let q: ReturnType<typeof parseRange>;
    try {
      q = parseRange(input);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const where = Prisma.sql`
      f.current_revision > 0 AND (${q.includeWithdrawn} OR f.status = 'published') AND
      ((f.window_from < ${q.to}::date AND f.window_to > ${q.from}::date) OR
       (${q.includeUndated} AND f.window_from IS NULL))`;
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
        SELECT f.id, r.revision, r.content, f.observed_at, r.recorded_at
        FROM government_forecast f JOIN government_forecast_revision r
          ON r.forecast_id=f.id AND r.revision=f.current_revision
        WHERE ${where} ORDER BY f.window_from NULLS LAST, f.id
        LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`);
        const [count] = await tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
        SELECT count(*) AS total FROM government_forecast f WHERE ${where}`);
        if (!count) throw new InternalServerErrorException('Forecast count unavailable');
        const checks = await tx.$queryRaw<
          { attempted_at: Date; status: string; edition: string | null }[]
        >`
        SELECT attempted_at,status,edition FROM government_forecast_check ORDER BY attempted_at DESC,id DESC LIMIT 1`;
        const successes = await tx.$queryRaw<
          { attempted_at: Date; edition: string; accepted_count: number; rejected_count: number }[]
        >`
        SELECT attempted_at,edition,accepted_count,rejected_count FROM government_forecast_check WHERE status='success'
        ORDER BY attempted_at DESC,id DESC LIMIT 1`;
        return {
          schemaVersion: 1,
          items: rows.map(project),
          page: q.page,
          pageSize: q.pageSize,
          total: Number(count.total),
          coverage: {
            lastSuccessfulCheckAt: successes[0]?.attempted_at.toISOString() ?? null,
            lastAttemptAt: checks[0]?.attempted_at.toISOString() ?? null,
            lastCheckStatus: checks[0]?.status ?? 'unavailable',
            edition: successes[0]?.edition ?? null,
            acceptedCount: successes[0]?.accepted_count ?? 0,
            rejectedCount: successes[0]?.rejected_count ?? 0,
            partial: Boolean(successes[0]?.rejected_count),
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async history(id: string, input: Parameters<typeof parsePage>[0]) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new BadRequestException('Invalid forecast identity');
    let q: ReturnType<typeof parsePage>;
    try {
      q = parsePage(input);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    return this.prisma.$transaction(
      async (tx) => {
        const [count] = await tx.$queryRaw<{ total: bigint }[]>`
        SELECT count(*) AS total FROM government_forecast_revision WHERE forecast_id=${id}`;
        if (!count) throw new InternalServerErrorException('Forecast history count unavailable');
        if (!Number(count.total)) throw new NotFoundException('Forecast not found');
        const rows = await tx.$queryRaw<Row[]>`
        SELECT forecast_id AS id,revision,content,observed_at,recorded_at FROM government_forecast_revision
        WHERE forecast_id=${id} ORDER BY revision DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
        return { schemaVersion: 1, items: rows.map(project), ...q, total: Number(count.total) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
