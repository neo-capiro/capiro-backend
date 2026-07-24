import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  SpConflictState,
  SpFactState,
  type SpContextFact,
} from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { isoDate } from '../strategy/versioning.js';
import { StrategyAiCredentialResolver } from '../meri/strategy-ai-credential.resolver.js';
import { StrategyOrchestratorClient } from '../meri/strategy-orchestrator.client.js';
import type { StewardFactLine, StewardHealthConflict } from '../meri/meri.types.js';
import { TEMPLATE_KEY_BY_TYPE, type DocumentTypeValue } from './frontmatter.js';
import { locate, locateAll } from './markdown-locate.js';
import type { ContextUser } from './context-documents.service.js';

/**
 * Stage E: the Context Steward — extracts structured facts (with deterministic
 * sourceRef provenance) from ACTIVE context documents via the orchestrator's
 * /meri-api/steward-extract surface, detects conflicts against the existing
 * corpus, and serves the review lifecycle (reject fact / resolve / dismiss
 * conflict) plus the fact-level grounding health (A8 upgrade).
 *
 * HARD RULE: the Steward NEVER mutates strategy nodes — it writes ONLY the
 * sp_context_fact / sp_context_conflict tables (and their audit rows).
 *
 * ACCURACY-FIRST: every fact the LLM returns must carry a sourceRef that
 * RESOLVES against the stored markdown via the LLM-free locate() — a ref that
 * does not resolve DROPS the fact (counted, never persisted). Conflicts are
 * validated the same way: existingFactId must be an ACTIVE fact of this
 * tenant+client scope, and newFactIndex must map to a fact that SURVIVED the
 * ref validation.
 */

/**
 * The document types a client's grounding is incomplete without (A8 health):
 * no ACTIVE doc for one of these -> missingRequired -> status 'degraded'.
 * Values are document_type vocabulary (frontmatter.ts); the check maps them to
 * templateKeys via TEMPLATE_KEY_BY_TYPE.
 */
export const REQUIRED_TEMPLATE_KEYS = ['strategy_brief', 'client_constraints'] as const;

/** Max preview length per ref in the extraction inventory (wire-contract 1). */
const REF_PREVIEW_CHARS = 120;

/** Shape check for uuid-typed filters (Postgres uuid — any hex version). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StewardHealthReport {
  status: 'ok' | 'degraded' | 'conflicted';
  factCounts: Record<SpFactState, number>;
  openConflicts: number;
  openMaterialConflicts: StewardHealthConflict[];
  staleDocs: Array<{ id: string; title: string; templateKey: string; validUntil: string | null }>;
  missingRequired: string[];
}

@Injectable()
export class StewardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly versioning: VersioningService,
    private readonly resolver: StrategyAiCredentialResolver,
    private readonly orchestrator: StrategyOrchestratorClient,
  ) {}

  /**
   * Extract facts from one ACTIVE context document. REPROCESS semantics: the
   * document's prior active facts are superseded and replaced by this run's
   * surviving set — extraction never accumulates duplicates for one document.
   * All writes happen in ONE withTenantUser tx (a failure rolls the whole run
   * back, prior facts included). EXCEPTION: an EMPTY extraction (the
   * orchestrator's fail-soft response to a model failure) is a NO-OP — prior
   * facts are kept, nothing is written or logged.
   */
  async extract(tenantId: string, user: ContextUser, documentId: string, bearer: string | undefined) {
    const doc = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spContextDocument.findFirst({ where: { id: documentId } }),
    );
    if (!doc) throw new NotFoundException('Context document not found');
    if (doc.state !== 'active') {
      throw new ConflictException(
        `Context document is ${doc.state} — only an active document can be extracted`,
      );
    }

    // LLM-free refs inventory: every heading + table row the model may cite,
    // each with a short verbatim preview. Only refs listed here can survive
    // the post-extraction locate() validation, by construction.
    const refs = buildRefsInventory(doc.content);

    const fm = (doc.frontmatter ?? {}) as Record<string, unknown>;
    const docAuthority = typeof fm.authority === 'string' ? fm.authority : null;
    const docAsOf = typeof fm.as_of === 'string' ? fm.as_of : null;
    // The Date an OMITTED fact asOf inherits at persist time (wire-contract 1:
    // null asOf = inherit the document's as_of), mirroring the authority fallback.
    const docAsOfDate = parseFactDate(docAsOf);

    // The corpus the orchestrator diffs against for conflicts: ACTIVE facts in
    // this client's scope (firm-null facts ground every client), EXCLUDING this
    // document's own facts (they are superseded by this reprocess anyway).
    const existing = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spContextFact.findMany({
        where: {
          ...clientScope(doc.clientId),
          state: 'active',
          documentId: { not: doc.id },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { document: { select: { title: true } } },
      }),
    );

    const aiProvider = await this.resolver.resolve(tenantId);
    // Wire-contract (1) request body — both sides must match exactly.
    const resp = await this.orchestrator.stewardExtract(
      {
        clientId: doc.clientId,
        documentId: doc.id,
        templateKey: doc.templateKey,
        authority: docAuthority,
        asOf: docAsOf,
        content: doc.content,
        refs,
        existingFacts: existing.map((f) => ({
          id: f.id,
          fact: f.fact,
          documentTitle: f.document.title,
          authority: f.authority,
          asOf: isoDate(f.asOf),
        })),
      },
      bearer,
      aiProvider,
    );
    const rawFacts = Array.isArray(resp.facts) ? resp.facts : [];
    const rawConflicts = Array.isArray(resp.conflicts) ? resp.conflicts : [];

    // FAIL-SOFT NO-OP: the orchestrator returns facts: [] with a diagnostic
    // summary when its model call fails (its documented contract: api-strategy
    // treats empty facts as a no-op). Honor it BEFORE the reprocess supersede —
    // an empty extraction must never retire the document's prior active facts,
    // or a transient LLM error would silently wipe the grounding corpus.
    if (rawFacts.length === 0) {
      return {
        inserted: 0,
        droppedRefs: 0,
        conflicts: 0,
        summary: typeof resp.summary === 'string' ? resp.summary : '',
      };
    }

    return this.prisma.withTenantUser(tenantId, user.clerkUserId, async (tx) => {
      // REPROCESS: retire this document's prior active facts first — the new
      // surviving set replaces them (retained as history, never deleted).
      await tx.spContextFact.updateMany({
        where: { documentId: doc.id, state: 'active' },
        data: { state: 'superseded' },
      });

      // Persist only facts whose sourceRef resolves against the STORED content
      // (never fabricate provenance). Track surviving rows by their ORIGINAL
      // index so conflict newFactIndex remapping works after drops.
      let droppedRefs = 0;
      const insertedByRawIndex = new Map<number, SpContextFact>();
      for (let i = 0; i < rawFacts.length; i++) {
        const f = rawFacts[i]!;
        const factText = typeof f?.fact === 'string' ? f.fact.trim() : '';
        const sourceRef = typeof f?.sourceRef === 'string' ? f.sourceRef : '';
        if (!factText || !sourceRef || locate(doc.content, sourceRef) === null) {
          droppedRefs++;
          continue;
        }
        const row = await tx.spContextFact.create({
          data: {
            tenantId,
            documentId: doc.id,
            clientId: doc.clientId,
            fact: factText,
            sourceRef,
            authority: typeof f.authority === 'string' && f.authority ? f.authority : docAuthority,
            // OMITTED asOf (null) inherits the document's as_of; a fact's own
            // date wins; a MALFORMED date still degrades to undated (never
            // fabricate a date the model did not assert).
            asOf: f.asOf == null ? docAsOfDate : parseFactDate(f.asOf),
            confidence: clampConfidence(f.confidence),
            state: 'active',
            citation: typeof f.citation === 'string' ? f.citation : null,
          },
        });
        insertedByRawIndex.set(i, row);
      }

      // Conflict validation: ONE tenant-scoped findMany resolves every claimed
      // existingFactId; a conflict is dropped unless BOTH ends check out.
      const claimedIds = [
        ...new Set(
          rawConflicts
            .map((c) => (typeof c?.existingFactId === 'string' ? c.existingFactId : ''))
            .filter((id) => UUID_RE.test(id)),
        ),
      ];
      const claimedRows = claimedIds.length
        ? await tx.spContextFact.findMany({ where: { id: { in: claimedIds } } })
        : [];
      // Eligible = ACTIVE and within this document's client scope (the same
      // scope existingFacts was drawn from: this client's facts + firm-null).
      const eligible = new Map(
        claimedRows
          .filter(
            (r) => r.state === 'active' && (r.clientId === doc.clientId || r.clientId === null),
          )
          .map((r) => [r.id, r] as const),
      );

      let conflicts = 0;
      for (const c of rawConflicts) {
        const newFact = Number.isInteger(c?.newFactIndex)
          ? insertedByRawIndex.get(c.newFactIndex)
          : undefined;
        const existingFact =
          typeof c?.existingFactId === 'string' ? eligible.get(c.existingFactId) : undefined;
        // Dropped new fact (fabricated ref) or ineligible existing fact
        // (unknown / other tenant / other client / not active) -> drop.
        if (!newFact || !existingFact) continue;
        await tx.spContextConflict.create({
          data: {
            tenantId,
            factAId: newFact.id,
            factBId: existingFact.id,
            material: c.material === true,
            state: 'open',
          },
        });
        conflicts++;
      }

      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: user.clerkUserId,
        authorKind: 'meri',
        action: 'steward.extracted',
        entityType: 'context_document',
        entityId: doc.id,
        after: { documentId: doc.id, inserted: insertedByRawIndex.size, droppedRefs, conflicts },
      });

      return {
        inserted: insertedByRawIndex.size,
        droppedRefs,
        conflicts,
        summary: typeof resp.summary === 'string' ? resp.summary : '',
      };
    });
  }

  /** List facts for the review UI (newest first, joined with their document). */
  async listFacts(
    tenantId: string,
    opts: { clientId?: string; documentId?: string; state?: string } = {},
  ) {
    if (opts.state && !(Object.values(SpFactState) as string[]).includes(opts.state)) {
      throw new BadRequestException(
        `Invalid state '${opts.state}' — expected one of: ${Object.values(SpFactState).join(', ')}`,
      );
    }
    // Both filters feed uuid-typed columns — 400 a bogus shape instead of a
    // Prisma P2023 500 (Stage C/D list idiom).
    for (const [field, value] of [
      ['clientId', opts.clientId],
      ['documentId', opts.documentId],
    ] as const) {
      if (value && !UUID_RE.test(value)) {
        throw new BadRequestException(`Invalid ${field} '${value}' — expected a UUID`);
      }
    }
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.spContextFact.findMany({
        where: {
          ...(opts.clientId ? { clientId: opts.clientId } : {}),
          ...(opts.documentId ? { documentId: opts.documentId } : {}),
          ...(opts.state ? { state: opts.state as SpFactState } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { document: { select: { title: true, templateKey: true } } },
      }),
    );
  }

  /** Reviewer verdict: an ACTIVE fact may be rejected (any other state 409s). */
  async rejectFact(tenantId: string, user: ContextUser, id: string) {
    return this.prisma.withTenantUser(tenantId, user.clerkUserId, async (tx) => {
      const fact = await tx.spContextFact.findFirst({ where: { id } });
      if (!fact) throw new NotFoundException('Fact not found');
      if (fact.state !== 'active') {
        throw new ConflictException(
          `Fact is ${fact.state} — only an active fact can be rejected`,
        );
      }
      const updated = await tx.spContextFact.update({
        where: { id },
        data: { state: 'rejected' },
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: user.clerkUserId,
        authorKind: 'person',
        action: 'fact.rejected',
        entityType: 'context_fact',
        entityId: id,
        before: { state: 'active' },
        after: { state: 'rejected' },
      });
      return updated;
    });
  }

  /**
   * List conflicts joined with both facts (newest first) — each side embedded
   * with the provenance a reviewer decides on: text, source-document title,
   * authority, and as-of date (the web ContextConflictFact shape).
   */
  async listConflicts(tenantId: string, opts: { clientId?: string; state?: string } = {}) {
    if (opts.state && !(Object.values(SpConflictState) as string[]).includes(opts.state)) {
      throw new BadRequestException(
        `Invalid state '${opts.state}' — expected one of: ${Object.values(SpConflictState).join(', ')}`,
      );
    }
    if (opts.clientId && !UUID_RE.test(opts.clientId)) {
      throw new BadRequestException(`Invalid clientId '${opts.clientId}' — expected a UUID`);
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const conflicts = await tx.spContextConflict.findMany({
        where: { ...(opts.state ? { state: opts.state as SpConflictState } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      const factIds = [...new Set(conflicts.flatMap((c) => [c.factAId, c.factBId]))];
      const facts = factIds.length
        ? await tx.spContextFact.findMany({
            where: { id: { in: factIds } },
            include: { document: { select: { title: true } } },
          })
        : [];
      const byId = new Map(facts.map((f) => [f.id, f] as const));
      // Embed each side with its provenance (not just the text) so the review
      // UI can show which document/authority/as-of asserts each fact.
      const embed = (factId: string) => {
        const f = byId.get(factId);
        if (!f) return null;
        return {
          id: f.id,
          fact: f.fact,
          documentTitle: f.document.title,
          authority: f.authority,
          asOf: isoDate(f.asOf),
          clientId: f.clientId,
        };
      };
      const joined = conflicts.map((c) => ({
        ...c,
        factA: embed(c.factAId),
        factB: embed(c.factBId),
        // The conflict rows carry no clientId — derive it from the facts (both
        // ends share a scope by construction; extraction enforces it).
        clientId: byId.get(c.factAId)?.clientId ?? byId.get(c.factBId)?.clientId ?? null,
      }));
      return opts.clientId ? joined.filter((c) => c.clientId === opts.clientId) : joined;
    });
  }

  /**
   * Resolve an OPEN conflict. When `controllingFactId` names one of the two
   * facts, the OTHER fact is rejected — the review action that settles which
   * source controls. Note + resolver stamped on the conflict row.
   */
  async resolveConflict(
    tenantId: string,
    user: ContextUser,
    id: string,
    opts: { note: string; controllingFactId?: string },
  ) {
    // The resolution note is the review trail's rationale — REQUIRED. Enforce
    // here too (not only in the DTO/web modal) so no caller path can resolve
    // a material conflict with an empty or whitespace-only note.
    const note = typeof opts.note === 'string' ? opts.note.trim() : '';
    if (!note) {
      throw new BadRequestException('note is required — a resolution must record its rationale');
    }
    return this.prisma.withTenantUser(tenantId, user.clerkUserId, async (tx) => {
      const conflict = await tx.spContextConflict.findFirst({ where: { id } });
      if (!conflict) throw new NotFoundException('Conflict not found');
      if (conflict.state !== 'open') {
        throw new ConflictException(
          `Conflict is ${conflict.state} — only an open conflict can be resolved`,
        );
      }
      let rejectedFactId: string | null = null;
      if (opts.controllingFactId) {
        if (
          opts.controllingFactId !== conflict.factAId &&
          opts.controllingFactId !== conflict.factBId
        ) {
          throw new BadRequestException(
            'controllingFactId must be one of the conflicting facts (factAId or factBId)',
          );
        }
        rejectedFactId =
          opts.controllingFactId === conflict.factAId ? conflict.factBId : conflict.factAId;
        // ACTIVE-ONLY invariant (mirror of rejectFact's 409): 'rejected' is a
        // reviewer verdict on a LIVE fact. A conflict row stays open after its
        // facts retire (reprocess supersede / document-supersede stale / a
        // facts-table reject), so Resolve can land on one whose loser is
        // already out of the corpus — that fact KEEPS its state (a mechanical
        // retirement must never be rewritten into a reviewer verdict), and
        // the audit trail records that nothing was rejected.
        const losing = await tx.spContextFact.findFirst({ where: { id: rejectedFactId } });
        if (losing?.state === 'active') {
          await tx.spContextFact.update({
            where: { id: rejectedFactId },
            data: { state: 'rejected' },
          });
        } else {
          rejectedFactId = null;
        }
      }
      const updated = await tx.spContextConflict.update({
        where: { id },
        data: {
          state: 'resolved',
          resolutionNote: note,
          resolvedByUserId: user.clerkUserId,
          resolvedAt: new Date(),
        },
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: user.clerkUserId,
        authorKind: 'person',
        action: 'conflict.resolved',
        entityType: 'context_conflict',
        entityId: id,
        before: { state: 'open' },
        after: {
          state: 'resolved',
          note,
          controllingFactId: opts.controllingFactId ?? null,
          rejectedFactId,
        },
      });
      return updated;
    });
  }

  /** Dismiss an OPEN conflict (not material after review — both facts stand). */
  async dismissConflict(tenantId: string, user: ContextUser, id: string) {
    return this.prisma.withTenantUser(tenantId, user.clerkUserId, async (tx) => {
      const conflict = await tx.spContextConflict.findFirst({ where: { id } });
      if (!conflict) throw new NotFoundException('Conflict not found');
      if (conflict.state !== 'open') {
        throw new ConflictException(
          `Conflict is ${conflict.state} — only an open conflict can be dismissed`,
        );
      }
      const updated = await tx.spContextConflict.update({
        where: { id },
        data: { state: 'dismissed', resolvedByUserId: user.clerkUserId, resolvedAt: new Date() },
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: user.clerkUserId,
        authorKind: 'person',
        action: 'conflict.dismissed',
        entityType: 'context_conflict',
        entityId: id,
        before: { state: 'open' },
        after: { state: 'dismissed' },
      });
      return updated;
    });
  }

  /**
   * Fact-level grounding health for a client (A8 upgrade). `clientId` null =
   * firm-wide scope. status: 'conflicted' when any open MATERIAL conflict is in
   * scope; 'degraded' when a required template has no active doc or an active
   * doc has gone stale; 'ok' otherwise.
   */
  async health(tenantId: string, clientId: string | null): Promise<StewardHealthReport> {
    if (clientId && !UUID_RE.test(clientId)) {
      throw new BadRequestException(`Invalid clientId '${clientId}' — expected a UUID`);
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const factStates = await tx.spContextFact.findMany({
        where: clientScope(clientId),
        select: { state: true },
      });
      const factCounts: Record<SpFactState, number> = {
        active: 0,
        superseded: 0,
        stale: 0,
        rejected: 0,
      };
      for (const f of factStates) factCounts[f.state]++;

      // Open conflicts, scoped via their facts (conflict rows carry no clientId).
      const open = await tx.spContextConflict.findMany({
        where: { state: 'open' },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      const conflictFactIds = [...new Set(open.flatMap((c) => [c.factAId, c.factBId]))];
      const conflictFacts = conflictFactIds.length
        ? await tx.spContextFact.findMany({ where: { id: { in: conflictFactIds } } })
        : [];
      const factById = new Map(conflictFacts.map((f) => [f.id, f] as const));
      const scoped = open.filter((c) => {
        const factA = factById.get(c.factAId);
        const factB = factById.get(c.factBId);
        // A conflict is only LIVE while BOTH facts are still active. Rejecting
        // one fact from the facts table, a reprocess superseding it, or a
        // document-supersede flipping it stale all settle the dispute without
        // touching the conflict row — the dead fact no longer rides in the
        // stewardFacts pack, so health must stop reporting the conflict (the
        // row stays 'open' in the review queue for an explicit verdict).
        if (factA?.state !== 'active' || factB?.state !== 'active') return false;
        const owner = factA.clientId ?? factB.clientId ?? null;
        return clientId ? owner === clientId || owner === null : owner === null;
      });
      const openMaterialConflicts: StewardHealthConflict[] = scoped
        .filter((c) => c.material)
        .map((c) => ({
          id: c.id,
          factAId: c.factAId,
          factBId: c.factBId,
          factA: factById.get(c.factAId)?.fact ?? '',
          factB: factById.get(c.factBId)?.fact ?? '',
        }));

      // Active docs in scope drive BOTH the staleness and the missing-required
      // checks (a firm-wide source of truth counts for every client).
      const docs = await tx.spContextDocument.findMany({
        where: {
          state: 'active',
          ...(clientId ? { OR: [{ clientId }, { clientId: null }] } : { clientId: null }),
        },
        select: { id: true, title: true, templateKey: true, validUntil: true },
      });
      const todayUtcMidnight = Date.parse(new Date().toISOString().slice(0, 10));
      const staleDocs = docs
        .filter((d) => d.validUntil !== null && d.validUntil.getTime() < todayUtcMidnight)
        .map((d) => ({
          id: d.id,
          title: d.title,
          templateKey: d.templateKey,
          validUntil: isoDate(d.validUntil),
        }));
      const activeKeys = new Set(docs.map((d) => d.templateKey));
      const missingRequired = REQUIRED_TEMPLATE_KEYS.filter(
        (t) => !activeKeys.has(TEMPLATE_KEY_BY_TYPE[t as DocumentTypeValue]),
      ) as string[];

      const status: StewardHealthReport['status'] = openMaterialConflicts.length
        ? 'conflicted'
        : missingRequired.length || staleDocs.length
          ? 'degraded'
          : 'ok';

      return {
        status,
        factCounts,
        openConflicts: scoped.length,
        openMaterialConflicts,
        staleDocs,
        missingRequired,
      };
    });
  }

  /**
   * Wire-contract (2) `stewardFacts` pack lines for a draft/assistant call:
   * ACTIVE facts in the client's scope (client's own + firm-null), 120 newest,
   * joined with their document's title + templateKey.
   */
  async factsForOrchestrator(tenantId: string, clientId: string | null): Promise<StewardFactLine[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spContextFact.findMany({
        where: { ...clientScope(clientId), state: 'active' },
        orderBy: { createdAt: 'desc' },
        take: 120,
        include: { document: { select: { title: true, templateKey: true } } },
      }),
    );
    return rows.map((f) => ({
      id: f.id,
      fact: f.fact,
      sourceRef: f.sourceRef,
      documentTitle: f.document.title,
      templateKey: f.document.templateKey,
      authority: f.authority,
      asOf: isoDate(f.asOf),
    }));
  }
}

/** Fact eligibility scope: the client's own facts plus firm-wide (client-null). */
function clientScope(clientId: string | null): Prisma.SpContextFactWhereInput {
  return clientId ? { OR: [{ clientId }, { clientId: null }] } : { clientId: null };
}

/**
 * Wire-contract (1) refs inventory: every heading + table row with a stable
 * ref and a <=120-char verbatim preview from locate(). Row refs resolve to the
 * FIRST table under a heading (markdown-locate contract), so only that table's
 * rows are enumerated.
 */
function buildRefsInventory(
  content: string,
): Array<{ ref: string; kind: 'heading' | 'row'; preview: string }> {
  const { sections, tables } = locateAll(content);
  const refs: Array<{ ref: string; kind: 'heading' | 'row'; preview: string }> = [];
  const previewOf = (ref: string): string | null => {
    const hit = locate(content, ref);
    return hit ? hit.content.slice(0, REF_PREVIEW_CHARS) : null;
  };
  for (const s of sections) {
    const preview = previewOf(s.ref);
    if (preview !== null) refs.push({ ref: s.ref, kind: 'heading', preview });
  }
  const seenSections = new Set<string>();
  for (const t of tables) {
    if (seenSections.has(t.sectionRef)) continue; // row refs hit the FIRST table only
    seenSections.add(t.sectionRef);
    const headingKey = t.sectionRef.slice('heading:'.length);
    for (let i = 1; i <= t.rowCount; i++) {
      const ref = `row:${headingKey}:${i}`;
      const preview = previewOf(ref);
      if (preview !== null) refs.push({ ref, kind: 'row', preview });
    }
  }
  return refs;
}

/**
 * parseDbDate-style calendar guard that returns null instead of throwing (LLM
 * output is semi-trusted; a bad asOf degrades to undated, never 500s the run).
 * Round-trips the UTC date part to reject V8's silent rollover (Feb 30 -> Mar 2).
 */
function parseFactDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length < 10) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    return null;
  }
  return d;
}

/** Clamp extraction confidence into [0,1]; non-numeric degrades to null. */
function clampConfidence(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.min(1, Math.max(0, value));
}
