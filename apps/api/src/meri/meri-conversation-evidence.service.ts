import { Injectable } from '@nestjs/common';
import { type MeriCitation, type TenantContext } from '@capiro/shared';
import { EngagementService } from '../engagement/engagement.service.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import { PrismaService } from '../prisma/prisma.service.js';

const PAGE_REFERENCE = /^([a-zA-Z0-9-]{1,80}):([a-f0-9]{16}):(\d+):(\d+)-(\d+)$/;
const MAX_SOURCES = 8;
const MAX_CHARACTERS = 80_000;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Reuse saved observations, never saved assistant prose, through the current
 * canonical document ACL, parent permissions, readiness gate and byte hash.
 * Institutional memory intentionally remains governed by live recall. */
@Injectable()
export class MeriConversationEvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engagement: EngagementService,
  ) {}

  async load(
    ctx: TenantContext,
    conversationId: string | undefined,
    clientId: string | null,
    signal?: AbortSignal,
    snapshotMessages?: readonly { role: string; metadata: unknown }[],
  ): Promise<{ citations: MeriCitation[]; unavailable: number; omitted: number }> {
    const empty = { citations: [] as MeriCitation[], unavailable: 0, omitted: 0 };
    if (!conversationId || !clientId) return empty;
    signal?.throwIfAborted();
    const messages = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const conversation = await tx.clioConversation.findFirst({
        where: {
          id: conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId,
          archivedAt: null,
        },
        select: { id: true },
      });
      if (!conversation || !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId)))
        return [];
      if (snapshotMessages) return [...snapshotMessages].reverse();
      return tx.clioMessage.findMany({
        where: {
          conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId,
          role: 'assistant',
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 80,
        select: { role: true, metadata: true },
      });
    });
    const candidates: MeriCitation[] = [];
    const seen = new Set<string>();
    for (const message of messages) {
      if (
        message.role !== 'assistant' ||
        !object(message.metadata) ||
        !Array.isArray(message.metadata.citations)
      )
        continue;
      for (const value of message.metadata.citations) {
        if (
          !object(value) ||
          value.tool !== 'read_client_documents' ||
          typeof value.id !== 'string' ||
          !PAGE_REFERENCE.test(value.id) ||
          typeof value.n !== 'number' ||
          !Number.isInteger(value.n) ||
          value.n < 1 ||
          value.n > 999 ||
          typeof value.title !== 'string'
        )
          continue;
        if (seen.has(value.id)) continue;
        seen.add(value.id);
        candidates.push(value as unknown as MeriCitation);
      }
    }
    const result = { ...empty, omitted: Math.max(0, candidates.length - MAX_SOURCES) };
    const budget = AbortSignal.timeout(12_000);
    const readSignal = signal ? AbortSignal.any([signal, budget]) : budget;
    const numbers = new Set<number>();
    const sourceChecks = new Map<string, ReturnType<EngagementService['extractAttachmentText']>>();
    let characters = 0;
    for (const candidate of candidates.slice(0, MAX_SOURCES)) {
      signal?.throwIfAborted();
      if (budget.aborted) {
        result.omitted += 1;
        continue;
      }
      const [, documentId, hashPrefix, sectionText, startText, endText] = PAGE_REFERENCE.exec(
        candidate.id,
      )!;
      const section = Number(sectionText),
        start = Number(startText),
        end = Number(endText);
      if (
        ![section, start, end].every(Number.isSafeInteger) ||
        section < 1 ||
        start < 0 ||
        end <= start ||
        end - start > 6000
      ) {
        result.unavailable += 1;
        continue;
      }
      if (numbers.has(candidate.n)) {
        result.omitted += 1;
        continue;
      }
      try {
        let checked = sourceChecks.get(documentId!);
        if (!checked) {
          checked = this.engagement.extractAttachmentText(ctx, documentId!, {
            clientId,
            contextSourceOnly: true,
            signal: readSignal,
          });
          sourceChecks.set(documentId!, checked);
        }
        const current = await checked;
        if (!current.contentHash.startsWith(hashPrefix!)) throw new Error('document_changed');
        let citation = candidate;
        const saved = candidate.documentEvidence;
        if (
          !saved ||
          saved.clientId !== clientId ||
          saved.documentId !== documentId ||
          saved.contentHash !== current.contentHash ||
          !object(saved.record) ||
          saved.record.recordId !== candidate.id ||
          !object(saved.coverage)
        ) {
          // Historical metadata has only the saved snippet. Preserve exactly
          // that observation with its gaps; preflight must never invoke OCR or
          // a visual provider to rebuild every old page on unrelated turns.
          if (!candidate.snippet?.trim()) throw new Error('document_excerpt_unavailable');
          citation = {
            ...candidate,
            documentEvidence: {
              clientId,
              documentId: documentId!,
              contentHash: current.contentHash,
              observedAt: null,
              record: {
                recordId: candidate.id,
                payload: {
                  id: candidate.id,
                  documentId,
                  title: candidate.title,
                  text: candidate.snippet,
                  section,
                  sectionLabel: `Section ${section}`,
                  savedReferenceCharacterStart: start,
                  savedReferenceCharacterEnd: end,
                },
                provenance: {
                  sourceRecordId: documentId,
                  contentHash: current.contentHash,
                  sourceType: 'saved_citation_snippet',
                },
              },
              coverage: {
                complete: false,
                truncated: true,
                legacySnippetOnly: true,
                fullExcerptAvailable: false,
                extractionMetadata: null,
                note: `Only the saved truncated citation snippet is available. Original extraction method, limitations and full excerpt were not saved. If more evidence is needed, use read_client_documents for documentId=${documentId}, section=${section}, characterOffset=${start}, limit=${end - start}. Do not infer missing text or claim a fresh page read.`,
              },
            },
          };
        }
        const size = JSON.stringify(citation).length;
        if (characters + size > MAX_CHARACTERS) {
          result.omitted += 1;
          continue;
        }
        characters += size;
        numbers.add(citation.n);
        result.citations.push(citation);
      } catch {
        signal?.throwIfAborted();
        // A historical source is never admitted after failed reauthorization.
        result.unavailable += 1;
      }
    }
    return result;
  }
}
