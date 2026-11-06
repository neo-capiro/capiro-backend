import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { isDatabaseBusyError, PrismaService } from '../prisma/prisma.service.js';
import { PrismaTransactionDeadlineError } from '../prisma/prisma-transaction-deadline.js';
import { EMBEDDING_DIM, embedText, normalize, vectorLiteral } from '../embeddings/embedder.js';
import { getDefaultEmbeddingProvider } from '../embeddings/embedding-provider.factory.js';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.js';
import { assertMeriToolRequestActive, meriToolRequestControl } from './meri-tool-request-control.js';
import {
  parseSemanticSearchInput,
  projectSemanticSearch,
  semanticCoverageSql,
  semanticSearchSql,
  SEMANTIC_SEARCH_LIMITS,
  type SemanticCoverageRow,
  type SemanticSearchOperation,
  type SemanticSearchResult,
  type SemanticSearchRow,
} from './semantic-search.js';

const unavailable = () =>
  new ServiceUnavailableException('Semantic search is unavailable; no records were searched');

/** The query vector comes from the same provider and model that wrote the
 * stored vectors; a hung or malformed provider answer is a closed failure. */
async function boundedQueryVector(query: string, provider: EmbeddingProvider): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const vector = await Promise.race([
      embedText(normalize(query), provider),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Semantic query-vector deadline exceeded')),
          SEMANTIC_SEARCH_LIMITS.embedTimeoutMs,
        );
      }),
    ]);
    if (
      vector.length !== EMBEDDING_DIM ||
      vector.some((value) => !Number.isFinite(value)) ||
      !vector.some((value) => value !== 0)
    )
      throw new Error('Invalid query vector');
    return vectorLiteral(vector);
  } catch {
    throw unavailable();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read-only owner of the three public-record semantic reads. The controller
 * has already required the verified service identity and the signed-in
 * member; the owner rechecks active membership inside the ranking transaction. */
@Injectable()
export class SemanticSearchService {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    ctx: TenantContext,
    operation: SemanticSearchOperation,
    raw: unknown,
    provider: EmbeddingProvider = getDefaultEmbeddingProvider(),
  ): Promise<SemanticSearchResult> {
    const input = parseSemanticSearchInput(operation, raw);
    assertMeriToolRequestActive();
    const vector = await boundedQueryVector(input.query, provider);
    assertMeriToolRequestActive();
    const model = provider.metadata.model;
    // The engine timeout alone does not cancel a running PostgreSQL statement.
    // Reuse the shared owner to bound acquisition, SQL and settlement together.
    const deadlineAt = Math.min(Date.now() + SEMANTIC_SEARCH_LIMITS.statementTimeoutMs,
      meriToolRequestControl()?.deadlineAt ?? Infinity);
    // A statement cancelled by the lane's statement_timeout (57014) or a pool/transaction wait that ran out
    // (P2024/P2028) is the same closed "unavailable" answer as a provider failure, never a 500.
    const rows = await this.prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
        const member = await tx.tenantMembership.findFirst({
          where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
          select: { id: true },
        });
        if (!member) throw new ForbiddenException('Current active tenant membership is required');
        // pgvector's HNSW scan returns at most hnsw.ef_search rows (default 40);
        // the candidate window must be served whole so chunk de-duplication and
        // filters still leave a full page. Transaction-local, like the lane
        // statement_timeout in PrismaService.
        await tx.$executeRaw`SELECT set_config('hnsw.ef_search', ${String(SEMANTIC_SEARCH_LIMITS.candidateLimit)}, true)`;
        // Avoid compiling RLS-heavy plans for longer than this bounded read.
        await tx.$executeRaw`SELECT set_config('jit', 'off', true)`;
        const page = await tx.$queryRaw<SemanticSearchRow[]>(semanticSearchSql(operation, input, vector, model));
        // Coverage is read in the same transaction so the page and its "indexed of total" statement agree.
        const coverage = await tx.$queryRaw<SemanticCoverageRow[]>(semanticCoverageSql(operation, model));
        return { page, coverage: coverage[0] };
      },
      { timeoutMs: SEMANTIC_SEARCH_LIMITS.statementTimeoutMs, deadline: { at: deadlineAt } },
    ).catch((error: unknown) => {
      if (error instanceof PrismaTransactionDeadlineError || isDatabaseBusyError(error)) throw unavailable();
      throw error;
    });
    assertMeriToolRequestActive();
    return projectSemanticSearch(operation, input, rows.page, rows.coverage, model, new Date().toISOString());
  }
}
