import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import { MemoryStoreService } from './memory-store.service.js';
import {
  clioMemoryToItem,
  clioMemorySlug,
  type ClioMemoryRow,
  type NameResolver,
} from './memory-clio-adapter.helpers.js';
import { meetingToItem, emailThreadToItem, meriSessionToItem } from './memory-ingest.helpers.js';
import type { MemoryItem } from './memory.types.js';
import { MEMORY_SCHEMA_VERSION, defaultMemoryGovernanceFields } from './memory.types.js';
import { embedAndUpsert, normalize } from '../embeddings/embedder.js';
import { MeetingNotesCryptoService } from '../engagement/meeting-notes-crypto.service.js';

/** Build the text we embed for a memory item: title + human-authored section bodies
 *  (engine sections are skipped — they're boilerplate that would dilute relevance). */
export function embeddableText(item: MemoryItem): string {
  const sectionText = (item.sections ?? [])
    .filter((s) => s.owner === 'human' && s.body?.trim())
    .map((s) => `${s.heading}: ${s.body}`)
    .join('\n');
  return normalize([item.title, sectionText].filter(Boolean).join('\n'));
}

/** Distill a transcript to a short summary without an LLM (first/last user turns + counts).
 *  Deliberately conservative: we never store the raw transcript in the graph. */
function distillSession(turns: Array<{ role: string; content: string }>): string {
  const userTurns = turns
    .filter((t) => t.role === 'user')
    .map((t) => t.content.trim())
    .filter(Boolean);
  if (userTurns.length === 0) return 'Meri session (no user prompts captured).';
  const first = userTurns[0]!.slice(0, 240);
  const topics = userTurns.slice(0, 5).map((t) => t.split(/[.?!\n]/)[0]!.slice(0, 80));
  return [
    `Opening ask: ${first}`,
    topics.length > 1 ? `\nTopics touched: ${topics.join('; ')}` : '',
    `\n_${turns.length} turns._`,
  ]
    .join('')
    .trim();
}

/**
 * Backfill / ingestion service (Phases A-C).
 *
 * Idempotent: every item has a stable slug, upsertSystem does ON CONFLICT
 * update, so re-running never duplicates. Each phase reads a source under
 * withSystem (trusted backfill) and projects rows into MemoryItems.
 *
 * Phase A entity nodes (clients/bills/people/issues) are created so the graph
 * has labeled nodes even before they carry narrative; the FK loader supplies
 * the structural edges at query time.
 */
@Injectable()
export class MemoryIngestService {
  private readonly logger = new Logger(MemoryIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: MemoryStoreService,
    private readonly tenantCtx: TenantContextStore,
    private readonly notesCrypto?: MeetingNotesCryptoService,
  ) {}

  /** Run the full backfill for the current tenant. Returns per-phase counts. */
  async backfillCurrentTenant(): Promise<{
    clients: number;
    clioMemories: number;
    meetings: number;
    emails: number;
    meriSessions: number;
    embedded: number;
    failed: number;
    failures: Array<{ slug: string; error: string }>;
  }> {
    const ctx = this.tenantCtx.require();
    const counts = {
      clients: 0,
      clioMemories: 0,
      meetings: 0,
      emails: 0,
      meriSessions: 0,
      embedded: 0,
      failed: 0,
      failures: [] as Array<{ slug: string; error: string }>,
    };

    // ---- Phase A: client entity nodes ----
    const clients = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT id, name FROM clients WHERE tenant_id = ${ctx.tenantId}::uuid AND status = 'active'
      `,
    );
    const nameResolver: NameResolver = buildClientNameResolver(clients);
    for (const c of clients) {
      await this.store.upsertSystem(clientToItem(ctx.tenantId, c));
      counts.clients++;
    }

    // ---- Phase B: ClioMemory unification ----
    const memories = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<ClioMemoryRow[]>`
        SELECT id, tenant_id AS "tenantId", scope, owner_user_id AS "ownerUserId",
               client_id AS "clientId", expires_at AS "expiresAt",
               key, value, source, metadata_jsonb AS metadata,
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM clio_memory WHERE tenant_id = ${ctx.tenantId}::uuid
      `,
    );
    for (const m of memories) {
      const row: ClioMemoryRow = {
        ...m,
        createdAt: new Date(m.createdAt as unknown as string).toISOString(),
        updatedAt: new Date(m.updatedAt as unknown as string).toISOString(),
      };
      await this.store.upsertSystem(clioMemoryToItem(row, nameResolver));
      counts.clioMemories++;
    }

    // ---- Phase C: meetings (non-internal, client-linked) ----
    const meetings = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<Array<{ id: string; client_id: string; subject: string; starts_at: Date }>>`
        SELECT id, client_id, subject, starts_at
        FROM meetings
        WHERE tenant_id = ${ctx.tenantId}::uuid AND client_id IS NOT NULL AND is_internal = false
      `,
    );
    // Tenant-readable debriefs only: NOT confidential, OR explicitly shared with
    // all tenant members. Author-only / restricted debriefs are excluded so the
    // shared graph never exposes content the whole firm can't already read.
    // Decrypted content is attached as an ENGINE section (never embedded).
    const debriefRows = this.notesCrypto
      ? await this.prisma.withSystem(
          (tx) =>
            tx.$queryRaw<
              Array<{ meeting_id: string; body_ciphertext: string; iv: string; auth_tag: string }>
            >`
            SELECT meeting_id, body_ciphertext, iv, auth_tag
            FROM meeting_debriefs
            WHERE tenant_id = ${ctx.tenantId}::uuid
              AND (confidential = false OR access_level = 'tenant_members')
          `,
        )
      : [];
    const debriefByMeeting = new Map<string, string>();
    for (const d of debriefRows) {
      try {
        const text = this.notesCrypto!.decrypt({
          bodyCiphertext: d.body_ciphertext,
          iv: d.iv,
          authTag: d.auth_tag,
        });
        // Keep the most recent/last one per meeting (rows are unordered; fine for a snapshot).
        if (text?.trim()) debriefByMeeting.set(d.meeting_id, text.trim());
      } catch (err) {
        this.logger.warn(
          `debrief decrypt skipped for meeting ${d.meeting_id}: ${(err as Error).message}`,
        );
      }
    }
    for (const mt of meetings) {
      const date = new Date(mt.starts_at).toISOString().slice(0, 10);
      await this.store.upsertSystem(
        meetingToItem({
          tenantId: ctx.tenantId,
          meetingId: mt.id,
          clientId: mt.client_id,
          title: mt.subject || 'Meeting',
          date,
          prep: '_Linked from engagement calendar._',
          wikilinks: [`[[client:${mt.client_id}]]`],
          debriefBody: debriefByMeeting.get(mt.id),
        }),
      );
      counts.meetings++;
    }

    // ---- Phase D: email threads (read-only; respects the product's existing
    // client scoping via MailThread.clientId — null => user-private, no domain
    // bleed). We summarize from snippet + participants; we do NOT read message
    // bodies here. ----
    const threads = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<
          Array<{
            id: string;
            client_id: string | null;
            subject: string;
            snippet: string | null;
            participants: unknown;
            last_message_at: Date | null;
            msg_count: bigint;
            owner_user_id: string | null;
          }>
        >`
        SELECT t.id, t.client_id, t.subject, t.snippet, t.participants_jsonb AS participants,
               t.last_message_at,
               (SELECT count(*) FROM mail_messages m WHERE m.thread_id = t.id) AS msg_count,
               (t.metadata_jsonb->>'ownerUserId')::uuid AS owner_user_id
        FROM mail_threads t
        WHERE t.tenant_id = ${ctx.tenantId}::uuid
      `,
    );
    for (const th of threads) {
      const domains = extractDomains(th.participants);
      const ownerUserId = th.owner_user_id ?? ctx.userId ?? null;
      // A thread with no resolvable owner and no client is skipped (cannot scope safely).
      if (!th.client_id && !ownerUserId) continue;
      await this.store.upsertSystem(
        emailThreadToItem({
          tenantId: ctx.tenantId,
          threadId: th.id,
          subject: th.subject || '(no subject)',
          clientId: th.client_id,
          ownerUserId: ownerUserId ?? 'system',
          inScopeDomains: domains,
          messageCount: Number(th.msg_count ?? 0),
          lastMessageAt: (th.last_message_at ?? new Date()).toISOString(),
          summary: th.snippet?.trim() || '(no preview available)',
          wikilinks: th.client_id ? [`[[client:${th.client_id}]]`] : [],
        }),
      );
      counts.emails++;
    }

    // ---- Phase E: Meri sessions (user-private, distilled — never raw
    // transcripts; promotion to firm memory is human-gated). A "session" is a
    // clio_conversation; its turns live in clio_messages — the LIVE Meri backing
    // store. (The old legacy chat table this used to read was dropped by
    // migration 20260627130000; only substantive user/assistant turns count.) ----
    const sessions = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<
          Array<{
            session_id: string;
            user_id: string;
            client_id: string | null;
            ended_at: Date;
            turns: bigint;
          }>
        >`
        SELECT c.id AS session_id, c.user_id, c.client_id,
               max(m.created_at) AS ended_at, count(*) AS turns
        FROM clio_conversations c
        JOIN clio_messages m ON m.conversation_id = c.id
        WHERE c.tenant_id = ${ctx.tenantId}::uuid
          AND m.role IN ('user', 'assistant')
        GROUP BY c.id, c.user_id, c.client_id
        HAVING count(*) >= 2
      `,
    );
    for (const s of sessions) {
      const turns = await this.prisma.withSystem(
        (tx) =>
          tx.$queryRaw<Array<{ role: string; content: string }>>`
          SELECT role, body AS content FROM clio_messages
          WHERE tenant_id = ${ctx.tenantId}::uuid
            AND conversation_id = ${s.session_id}::uuid
            AND role IN ('user', 'assistant')
          ORDER BY created_at ASC
        `,
      );
      const summary = distillSession(turns);
      const firstUser =
        turns.find((t) => t.role === 'user')?.content?.slice(0, 60) ?? 'Meri session';
      await this.store.upsertSystem(
        meriSessionToItem({
          tenantId: ctx.tenantId,
          sessionId: s.session_id,
          ownerUserId: s.user_id,
          // clientId stays null on purpose. meriSessionToItem always emits
          // visibility:'user' (private) and memory_items RLS is tenant-only, so a
          // client-linked private session would be reachable from the client
          // graph before owner-gating is structural. Client-linking is deferred
          // until the Phase 3 fail-closed hardening lands.
          clientId: null,
          title: firstUser,
          endedAt: new Date(s.ended_at).toISOString(),
          transcriptSummary: summary,
          wikilinks: [],
        }),
      );
      counts.meriSessions++;
    }

    // ---- Phase F: embeddings — make memory semantically searchable. Read all
    // of the tenant's memory_items and embed (idempotent via content hash, so
    // re-runs only embed changed items). Each item embeds independently: a
    // failure is recorded in counts.failures and the pass continues (never
    // aborts), so one bad row can't strand the rest. ----
    try {
      const items = await this.prisma.withSystem(
        (tx) =>
          tx.$queryRaw<
            Array<{
              id: string;
              client_id: string | null;
              owner_user_id: string | null;
              type: string;
              title: string;
              slug: string;
              sections: unknown;
            }>
          >`
          SELECT id, client_id, owner_user_id, type, title, slug, sections_jsonb AS sections
          FROM memory_items WHERE tenant_id = ${ctx.tenantId}::uuid
        `,
      );
      for (const it of items) {
        const sections = Array.isArray(it.sections) ? (it.sections as MemoryItem['sections']) : [];
        const text = embeddableText({ title: it.title, sections } as MemoryItem);
        if (text.length < 10) continue;
        try {
          const outcome = await embedAndUpsert(this.prisma as never, {
            tenantId: ctx.tenantId,
            clientId: it.client_id,
            ownerUserId: it.owner_user_id,
            sourceType: 'memory_item',
            sourceId: it.id,
            text,
            bypassRls: true,
          });
          if (outcome !== 'skipped') counts.embedded++;
        } catch (err) {
          counts.failures.push({ slug: it.slug, error: (err as Error).message });
        }
      }
    } catch (err) {
      // Failure to even LIST items strands the whole pass — record it as a
      // single synthetic failure so the caller sees the pass did not complete.
      this.logger.warn(`memory embedding pass failed: ${(err as Error).message}`);
      counts.failures.push({ slug: '(embedding-pass)', error: (err as Error).message });
    }
    counts.failed = counts.failures.length;

    this.logger.log(
      `backfill tenant=${ctx.tenantId} ${JSON.stringify({ ...counts, failures: counts.failures.length })}`,
    );
    return counts;
  }

  /**
   * Write-through projection for a SINGLE ClioMemory row (Gap 6). Meri calls this
   * right after it writes clio_memory so the memory graph + semantic index
   * reflect the save immediately, without waiting for the nightly refresh.
   *
   * Runs under withSystem (trusted projection; clio_memory + memory_items are
   * RLS-protected). No name resolver at request time — slug-form [[type:slug]]
   * tokens already in the memory text are still captured as edges, and the
   * nightly refresh-memory-graph adds full name-based links. The embedding is
   * fire-and-forget in spirit: this method NEVER throws, so a projection/embed
   * failure can never fail the user's save. Callers invoke it with `void`.
   */
  async projectClioMemory(tenantId: string, clioMemoryId: string): Promise<void> {
    try {
      const rows = await this.prisma.withSystem(
        (tx) =>
          tx.$queryRaw<ClioMemoryRow[]>`
          SELECT id, tenant_id AS "tenantId", scope, owner_user_id AS "ownerUserId",
                 client_id AS "clientId", expires_at AS "expiresAt",
                 key, value, source, metadata_jsonb AS metadata,
                 created_at AS "createdAt", updated_at AS "updatedAt"
          FROM clio_memory
          WHERE id = ${clioMemoryId}::uuid AND tenant_id = ${tenantId}::uuid
        `,
      );
      const m = rows[0];
      if (!m) return; // row was deleted/never existed — nothing to project
      const row: ClioMemoryRow = {
        ...m,
        createdAt: new Date(m.createdAt as unknown as string).toISOString(),
        updatedAt: new Date(m.updatedAt as unknown as string).toISOString(),
      };
      const item = clioMemoryToItem(row);
      const itemId = await this.store.upsertSystem(item);
      const text = embeddableText(item);
      if (text.length >= 10) {
        await embedAndUpsert(this.prisma as never, {
          tenantId,
          clientId: item.clientId,
          ownerUserId: item.ownerUserId,
          sourceType: 'memory_item',
          sourceId: itemId,
          text,
          bypassRls: true,
        });
      }
    } catch (err) {
      this.logger.warn(
        `projectClioMemory ${clioMemoryId} failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Write-through removal for a DELETED ClioMemory row (Gap 6). Removes the
   * projected memory_item (its memory_edges cascade via FK) and its
   * context_embeddings row (which has no cascade). Non-fatal; never throws.
   */
  async removeClioMemory(tenantId: string, clioMemoryId: string): Promise<void> {
    try {
      const slug = clioMemorySlug(clioMemoryId);
      await this.prisma.withSystem(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM memory_items
          WHERE tenant_id = ${tenantId}::uuid AND type = 'note' AND slug = ${slug}
          LIMIT 1
        `;
        const itemId = rows[0]?.id;
        if (!itemId) return;
        // context_embeddings.source_id is the memory_item id as text; no FK cascade.
        await tx.$executeRaw`
          DELETE FROM context_embeddings
          WHERE source_type = 'memory_item' AND source_id = ${itemId}
        `;
        // memory_edges cascade via memory_items_src_fk ON DELETE CASCADE.
        await tx.$executeRaw`DELETE FROM memory_items WHERE id = ${itemId}::uuid`;
      });
    } catch (err) {
      this.logger.warn(
        `removeClioMemory ${clioMemoryId} failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }
}

/** Pull unique email domains from a participants JSON array (best-effort). */
function extractDomains(participants: unknown): string[] {
  if (!Array.isArray(participants)) return [];
  const out = new Set<string>();
  for (const p of participants) {
    const email =
      typeof p === 'string'
        ? p
        : p && typeof p === 'object' && 'email' in p
          ? String((p as { email: unknown }).email)
          : '';
    const at = email.indexOf('@');
    if (at > -1) out.add(email.slice(at + 1).toLowerCase());
  }
  return [...out];
}

function clientToItem(tenantId: string, c: { id: string; name: string }): MemoryItem {
  const ts = new Date().toISOString();
  return {
    id: '',
    tenantId,
    clientId: c.id,
    ownerUserId: null,
    type: 'client-hub',
    visibility: 'tenant',
    entityId: c.id,
    slug: c.id,
    title: c.name,
    aliases: [],
    tags: ['client'],
    source: 'ingest',
    sourceRef: c.id,
    provenance: `ingest@${MEMORY_SCHEMA_VERSION}`,
    sections: [
      { key: 'overview', heading: 'Overview', owner: 'engine', body: `Client: ${c.name}.` },
    ],
    createdAt: ts,
    updatedAt: ts,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    ...defaultMemoryGovernanceFields(),
  };
}

/** Resolver matching memory-text names to client nodes (exact, case-insensitive). */
function buildClientNameResolver(clients: Array<{ id: string; name: string }>): NameResolver {
  const byName = new Map<string, string>();
  for (const c of clients) byName.set(c.name.toLowerCase(), c.id);
  return (name: string) => {
    const id = byName.get(name.toLowerCase());
    return id ? { type: 'client', slug: id } : null;
  };
}
