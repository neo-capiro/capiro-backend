/**
 * Server-side source rehydration (Phase 1 §3.b2).
 *
 * Every selected context item arrives from the browser as an ID plus, at most, a
 * user-typed instruction. The body is rehydrated HERE, from our own database and
 * S3, and any body the browser sent is ignored.
 *
 * That inversion is the point of the section. Before Phase 1 the wizard carried
 * the display text of each selected item back into the generation request, and
 * the server rendered it into the prompt. So the authority behind every factual
 * claim in an outreach email was a string the client could edit — and, worse, a
 * thin one: the "bill" item was a stale `latestActionText`, which is how a
 * stalled bill got drafted as advancing.
 *
 * The other half is TRUST SEPARATION. A resolver returns two different things:
 *
 *   directives  what the authenticated user told us to do (their per-item
 *               instruction, their custom note when they marked it an
 *               instruction). Rendered as an instruction.
 *   evidence    what a source SAYS. Rendered as spotlighted data, never as an
 *               instruction, no matter what it contains.
 *
 * A failed lookup becomes a SourceFailure. It never becomes an empty string:
 * "the model saw nothing" and "the model saw that we have no record" produce
 * very different drafts, and only the second is honest.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MeetingNotesCryptoService } from '../meeting-notes-crypto.service.js';
import { AttachmentContentService } from '../attachment-content.service.js';
import { intelAlertIdFromItemId } from '../outreach-context-enrichment.js';
import { OutreachTruthService } from './outreach-truth.service.js';
import { AlertPacketClientService, renderAlertPacketForOutreach } from './alert-packet-client.service.js';
import { canReadEncryptedEntry, ownMeetingWhere } from '../engagement-access.helpers.js';
import { activeMailMessageWhere, activeMailThreadWhere } from '../mail-message-state.js';
import {
  boundEvidenceText,
  sourceFailure,
  compareDirectives,
  compareEvidence,
  compareFailures,
  MAX_CUSTOM_NOTE_CHARS,
  MAX_USER_INSTRUCTION_CHARS,
  type AuthenticatedDirective,
  type EmailContextScope,
  type EvidenceItem,
  type EvidenceSourceRef,
  type EvidenceTrust,
  type SourceFailure,
} from './evidence-packet.types.js';
import {
  rankRelevantEmail,
  relevanceLabel,
  threadExcerpt,
  type EmailThreadCandidate,
} from './relevant-email-ranker.js';
import { freshnessThresholdDays, type GaPolicy } from './government-affairs-policy.registry.js';

/** The context-item kinds the wizard can send. Mirrors the web ContextKind union. */
export type ContextKind =
  | 'bill'
  | 'stateBill'
  | 'intel'
  | 'email'
  | 'meeting'
  | 'note'
  | 'document'
  | 'debrief'
  | 'prep'
  | 'programElement';

/**
 * The Phase 1 selected-item contract: IDs and authenticated instructions only.
 *
 * `body` and `title` are deliberately ABSENT. Under the gateway a legacy request
 * carrying them is rejected rather than quietly honored — see §3.b1.
 */
export interface SelectedContextItemRef {
  id: string;
  kind: ContextKind;
  scope: 'all' | string;
  /** An authenticated user directive for this item. */
  userInstruction?: string;
  /** Only valid for kind==='note': text the user authored. */
  customNoteText?: string;
  /**
   * For a custom note, whether the user marked it a FACT to use or an
   * INSTRUCTION to follow. Defaults to 'instruction' (§3.b2): treating typed
   * prose as an assertable fact by default is how "we discussed X at dinner"
   * turns into invented detail about the dinner.
   */
  noteUse?: 'fact' | 'instruction';
}

export interface ResolveSelectedItemsInput {
  items: SelectedContextItemRef[];
  clientId: string | null;
  emailScope: EmailContextScope;
  scanRequired: boolean;
  /** False when the ethical wall denies this user access to the client. */
  wallAllowsClient: boolean;
  audience: 'external' | 'internal';
  /** Lowercased recipient addresses, for email authorization/ranking. */
  recipientEmails: string[];
  /** The resolved GA policy — supplies per-evidence-type freshness thresholds. */
  policy: GaPolicy;
  /** Injected so resolution is deterministic in tests. */
  now: Date;
  /**
   * HP-05 (Gate L): the inbound request's own Authorization header, forwarded
   * so an 'intel' item can be rehydrated from intel-api's packet endpoint under
   * the caller's own identity — see AlertPacketClientService. Undefined is a
   * normal, honest state (not every caller of this service has one to forward
   * yet), and degrades exactly like a fetch failure would.
   */
  authHeader?: string;
}

export interface ResolveSelectedItemsResult {
  evidence: EvidenceItem[];
  directives: AuthenticatedDirective[];
  failures: SourceFailure[];
}

@Injectable()
export class EvidenceSourceService {
  private readonly logger = new Logger(EvidenceSourceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly truth: OutreachTruthService,
    private readonly notesCrypto: MeetingNotesCryptoService,
    private readonly attachments: AttachmentContentService,
    private readonly alertPacketClient: AlertPacketClientService,
  ) {}

  async resolveSelectedItems(
    ctx: TenantContext,
    input: ResolveSelectedItemsInput,
  ): Promise<ResolveSelectedItemsResult> {
    const evidence: EvidenceItem[] = [];
    const directives: AuthenticatedDirective[] = [];
    const failures: SourceFailure[] = [];

    for (const item of input.items) {
      // The per-item instruction is an AUTHENTICATED directive regardless of
      // whether the source resolves — the user typed it, and it is stamped with
      // their id here rather than being read back out of the request body.
      const instruction = clip(item.userInstruction, MAX_USER_INSTRUCTION_CHARS);
      if (instruction) {
        directives.push({
          id: `instruction:${item.id}`,
          kind: 'item_instruction',
          text: instruction,
          scope: item.scope,
          authenticatedUserId: ctx.userId,
        });
      }

      try {
        const resolved = await this.resolveOne(ctx, item, input);
        if (resolved.evidence) evidence.push(...resolved.evidence);
        if (resolved.directives) directives.push(...resolved.directives);
        if (resolved.failures) failures.push(...resolved.failures);
      } catch (e) {
        // A resolver THROWING is a bug or an outage, not a missing record — but
        // it still cannot degrade to silence. A user explicitly selected this
        // item, so its loss is critical.
        this.logger.warn(
          `evidence resolution failed for ${item.kind} ${item.id}: ${(e as Error).message}`,
        );
        failures.push(
          sourceFailure(
            item.kind,
            'SOURCE_RESOLUTION_ERROR',
            'critical',
            'A source you selected could not be loaded. Remove it or try again.',
            item.id,
          ),
        );
      }
    }

    evidence.sort(compareEvidence);
    directives.sort(compareDirectives);
    failures.sort(compareFailures);
    return { evidence, directives, failures };
  }

  // ── Per-kind dispatch ──────────────────────────────────────────────────────

  private async resolveOne(
    ctx: TenantContext,
    item: SelectedContextItemRef,
    input: ResolveSelectedItemsInput,
  ): Promise<Partial<ResolveSelectedItemsResult>> {
    switch (item.kind) {
      case 'bill':
        return this.resolveBill(item, input);
      case 'stateBill':
        return this.resolveStateBill(item, input);
      case 'programElement':
        return this.resolveProgramElement(item, input);
      case 'email':
        return this.resolveEmail(ctx, item, input);
      case 'document':
        // The wizard's Documents tab mixes three id shapes under one kind.
        if (item.id.startsWith('meetingnote-')) return this.resolveMeetingNote(ctx, item, input);
        if (item.id.startsWith('clientnote-')) return this.resolveClientNote(ctx, item, input);
        return this.resolveDocument(ctx, item, input);
      case 'debrief':
        return this.resolveDebrief(ctx, item, input);
      case 'prep':
        return this.resolvePrep(ctx, item, input);
      case 'note':
        return this.resolveCustomNote(ctx, item);
      case 'intel':
        // HP-05 (Gate L): 'intel' items ARE now rehydratable — from intel-api's
        // alert packet, fetched server-side under the caller's own identity.
        // Previously fell through to SOURCE_NOT_REHYDRATABLE unconditionally.
        return this.resolveIntelAlert(item, input);
      case 'meeting':
        // 'meeting' is a retired kind kept only so resuming an old saved draft
        // does not 400 — it has no server record to rehydrate by id.
        return {
          failures: [
            sourceFailure(
              item.kind,
              'SOURCE_NOT_REHYDRATABLE',
              'informational',
              'This legacy "past meeting" item is no longer a supported source. Select the meeting’s prep or debrief instead.',
              item.id,
            ),
          ],
        };
      default: {
        const exhaustive: never = item.kind;
        return {
          failures: [
            sourceFailure(
              String(exhaustive),
              'SOURCE_KIND_UNKNOWN',
              'important',
              'This context item type is not supported.',
              item.id,
            ),
          ],
        };
      }
    }
  }

  // ── Authoritative structured sources ──────────────────────────────────────

  private async resolveBill(
    item: SelectedContextItemRef,
    input: ResolveSelectedItemsInput,
  ): Promise<Partial<ResolveSelectedItemsResult>> {
    const billId = parsePrefixed(item.id, 'bill-');
    if (!billId) return { failures: [this.malformedId(item, 'bill')] };

    const block = await this.truth.billTruthBlock(billId);
    if (!block) {
      // CRITICAL, not a fallback to the client's thin body: a selected bill we
      // have no record of must stop the draft, because the alternative is the
      // model narrating from an unverified string.
      return {
        failures: [
          sourceFailure(
            'bill',
            'BILL_NOT_ON_RECORD',
            'critical',
            'Capiro has no record of the bill you selected, so its status cannot be verified. Remove it or pick another bill.',
            item.id,
          ),
        ],
      };
    }

    const asOf = isoOrNull(block.raw.statusAt) ?? isoOrNull(block.raw.latestActionDate);
    const ref = this.ref({
      sourceType: 'bill',
      sourceId: billId,
      title: block.raw.title ?? billId,
      trust: 'authoritative_structured',
      authoritativeAsOf: asOf,
      scope: item.scope,
      now: input.now,
      provenance: {
        status: block.raw.status ?? null,
        voteCount: block.raw.votes.length,
        committeeCount: block.raw.committees.length,
      },
    });
    return {
      evidence: [
        this.item(ref, block.text, item.scope, {
          structuredTruth: block.raw as unknown as Record<string, unknown>,
        }),
      ],
      failures: this.freshnessFailures('bill', item.id, asOf, input),
    };
  }

  private async resolveStateBill(
    item: SelectedContextItemRef,
    input: ResolveSelectedItemsInput,
  ): Promise<Partial<ResolveSelectedItemsResult>> {
    const id = parsePrefixed(item.id, 'state-bill-');
    if (!id) return { failures: [this.malformedId(item, 'stateBill')] };

    const block = await this.truth.stateBillTruthBlock(id);
    if (!block) {
      return {
        failures: [
          sourceFailure(
            'stateBill',
            'STATE_BILL_NOT_ON_RECORD',
            'critical',
            'Capiro has no record of the state bill you selected, so its status cannot be verified. Remove it or pick another bill.',
            item.id,
          ),
        ],
      };
    }

    const asOf = block.raw.statusAt ?? block.raw.latestActionDate;
    const ref = this.ref({
      sourceType: 'stateBill',
      sourceId: id,
      title: `${block.raw.state} ${block.raw.identifier} — ${block.raw.title}`,
      trust: 'authoritative_structured',
      authoritativeAsOf: asOf,
      scope: item.scope,
      now: input.now,
      provenance: {
        state: block.raw.state,
        status: block.raw.status,
        // Carried so the verifier can reject FEDERAL vocabulary applied to a
        // state measure without re-deriving the jurisdiction from prose.
        jurisdiction: 'state',
      },
    });
    return {
      evidence: [
        this.item(ref, block.text, item.scope, {
          structuredTruth: block.raw as unknown as Record<string, unknown>,
        }),
      ],
      failures: this.freshnessFailures('stateBill', item.id, asOf, input),
    };
  }

  private async resolveProgramElement(
    item: SelectedContextItemRef,
    input: ResolveSelectedItemsInput,
  ): Promise<Partial<ResolveSelectedItemsResult>> {
    const peCode = parsePrefixed(item.id, 'pe-');
    if (!peCode) return { failures: [this.malformedId(item, 'programElement')] };

    const block = await this.truth.peTruthBlock(peCode);
    if (!block) {
      return {
        failures: [
          sourceFailure(
            'programElement',
            'PE_NOT_ON_RECORD',
            'critical',
            `Capiro has no budget record for program element ${peCode}, so no dollar figure for it can be verified. Remove it or pick another program element.`,
            item.id,
          ),
        ],
      };
    }

    const currentFy = block.raw.currentCycleFy;
    const ref = this.ref({
      sourceType: 'programElement',
      sourceId: peCode,
      title: block.raw.title ?? peCode,
      trust: 'authoritative_structured',
      // A budget series' as-of is its cycle, not a timestamp; represent the
      // current cycle FY as its start so freshness math has something real.
      authoritativeAsOf: currentFy ? `${currentFy - 1}-10-01` : null,
      scope: item.scope,
      now: input.now,
      provenance: {
        peCode: block.raw.peCode,
        currentCycleFy: currentFy ?? null,
        yearCount: block.raw.years.length,
      },
    });
    return {
      evidence: [
        this.item(ref, block.text, item.scope, {
          structuredTruth: block.raw as unknown as Record<string, unknown>,
        }),
      ],
    };
  }

  /**
   * HP-05 (Gate L): a LegiWatch alert, rehydrated from intel-api's alert packet
   * rather than trusted from whatever the browser last rendered. Requires a
   * clientId — an alert packet is meaningless without one, and
   * AlertPacketService.build (intel-api) independently proves the alert
   * belongs to that client within the tenant.
   */
  private async resolveIntelAlert(
    item: SelectedContextItemRef,
    input: ResolveSelectedItemsInput,
  ): Promise<Partial<ResolveSelectedItemsResult>> {
    const alertId = parsePrefixed(item.id, 'alert-');
    if (!alertId) return { failures: [this.malformedId(item, 'intel')] };
    if (!input.clientId) {
      return {
        failures: [
          sourceFailure(
            'intel',
            'INTEL_ALERT_NO_CLIENT',
            'critical',
            'A LegiWatch alert item requires a client to verify against.',
            item.id,
          ),
        ],
      };
    }

    const packet = await this.alertPacketClient.fetchAlertPacket(
      input.authHeader,
      input.clientId,
      alertId,
    );
    if (!packet) {
      return {
        failures: [
          sourceFailure(
            'intel',
            'INTEL_ALERT_NOT_ON_RECORD',
            'critical',
            'Capiro could not verify the LegiWatch alert you selected, so it was not used as evidence. Remove it or try again.',
            item.id,
          ),
        ],
      };
    }

    const text = renderAlertPacketForOutreach(packet);
    const asOf = packet.event?.occurredAt ?? packet.event?.effectiveAt ?? null;
    const ref = this.ref({
      sourceType: 'intel',
      sourceId: alertId,
      title: packet.event?.whatChanged || 'LegiWatch alert',
      trust: 'authoritative_structured',
      authoritativeAsOf: asOf,
      scope: item.scope,
      now: input.now,
      clientId: input.clientId,
      provenance: {
        evidenceCount: packet.officialEvidence?.length ?? 0,
        missingFieldCount: packet.confidence?.missingFields?.length ?? 0,
      },
    });
    return {
      evidence: [
        this.item(ref, text, item.scope, {
          structuredTruth: packet as unknown as Record<string, unknown>,
        }),
      ],
      failures: this.freshnessFailures('intel', item.id, asOf, input),
    };
  }

  // ── Email ─────────────────────────────────────────────────────────────────

  /**
   * A user-selected thread. Still authorized: explicit selection proves intent,
   * not entitlement — the wall, the mailbox scope, and the client boundary all
   * still apply, and its body is external_untrusted no matter that the user
   * picked it.
   */
  private async resolveEmail(
    ctx: TenantContext,
    item: SelectedContextItemRef,
    input: ResolveSelectedItemsInput,
  ): Promise<Partial<ResolveSelectedItemsResult>> {
    const threadId = parsePrefixed(item.id, 'mail-');
    if (!threadId) return { failures: [this.malformedId(item, 'email')] };

    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.mailThread.findFirst({
        where: { id: threadId, tenantId: ctx.tenantId, ...activeMailThreadWhere() },
        select: {
          id: true,
          subject: true,
          snippet: true,
          lastMessageAt: true,
          clientId: true,
          status: true,
          associationScore: true,
          associationReason: true,
          connection: { select: { createdByUserId: true } },
          metadata: true,
          messages: {
            where: activeMailMessageWhere(),
            orderBy: [{ receivedAt: 'desc' }, { sentAt: 'desc' }, { createdAt: 'desc' }],
            take: 2,
            select: { fromName: true, fromEmail: true, sentAt: true, receivedAt: true, bodyText: true },
          },
          participants: true,
        },
      }),
    );

    if (!row) {
      return {
        failures: [
          sourceFailure(
            'email',
            'EMAIL_THREAD_NOT_FOUND',
            'critical',
            'An email thread you selected is no longer available. Remove it and regenerate.',
            item.id,
          ),
        ],
      };
    }

    const candidate = toThreadCandidate(row);
    const ranked = rankRelevantEmail([{ ...candidate, explicitlySelected: true }], {
      clientId: input.clientId,
      recipientEmails: input.recipientEmails,
      topicTerms: [],
      scope: input.emailScope,
      userId: ctx.userId,
      wallAllowsClient: input.wallAllowsClient,
      audience: input.audience,
      now: input.now,
    });

    if (!ranked.included.length) {
      const reason = ranked.excluded[0]?.reason ?? 'no_relationship';
      // Ethical-wall denial must NOT reveal the subject or any content — the
      // message names no source detail at all.
      return {
        failures: [this.emailExclusionFailure(item.id, reason)],
      };
    }

    const top = ranked.included[0]!;
    const asOf = isoOrNull(row.lastMessageAt);
    const ref = this.ref({
      sourceType: 'email',
      sourceId: row.id,
      title: row.subject || 'Email thread',
      trust: 'external_untrusted',
      authoritativeAsOf: asOf,
      scope: item.scope,
      now: input.now,
      clientId: row.clientId,
      provenance: {
        mailboxScope: input.emailScope,
        relevance: relevanceLabel(top.score),
        score: top.score,
        closed: top.closed,
        contradicted: top.contradicted,
        explicitlySelected: true,
      },
    });
    return {
      evidence: [
        this.item(ref, threadExcerpt(top.thread), item.scope, {
          relevanceScore: top.score,
          relevanceReasons: top.reasons,
        }),
      ],
      failures: this.freshnessFailures('email', item.id, asOf, input),
    };
  }

  /**
   * AUTO-SUGGESTED relevant email (§3.d). Separate from resolveEmail because
   * these were not user-selected: they are ranked, capped, and every inclusion
   * carries its reasons so the UI can explain itself.
   */
  async resolveRelevantEmail(
    ctx: TenantContext,
    input: {
      clientId: string | null;
      recipientEmails: string[];
      topicTerms: string[];
      emailScope: EmailContextScope;
      wallAllowsClient: boolean;
      audience: 'external' | 'internal';
      scope: 'all' | string;
      policy: GaPolicy;
      now: Date;
      /** Already-selected thread ids, so a suggestion never duplicates them. */
      excludeThreadIds?: string[];
    },
  ): Promise<{ evidence: EvidenceItem[]; failures: SourceFailure[] }> {
    if (!input.wallAllowsClient) {
      return {
        evidence: [],
        failures: [
          sourceFailure(
            'email',
            'EMAIL_WALL_DENIED',
            'important',
            'Prior correspondence for this client is restricted for your account, so none was used.',
          ),
        ],
      };
    }
    if (!input.recipientEmails.length && !input.clientId) return { evidence: [], failures: [] };

    const exclude = new Set(input.excludeThreadIds ?? []);
    // Query breadth is bounded by SCOPE, not filtered afterwards: under 'mine'
    // the owner predicate is in the WHERE clause, so a colleague's thread is
    // never even read. Post-filtering would put restricted rows in memory.
    const rows = await this.prisma
      .withTenant(ctx.tenantId, (tx) =>
        tx.mailThread.findMany({
          // AND-composed rather than spread into sibling keys: two `OR` keys in
          // one object would silently overwrite each other, and the one that
          // survived would be the breadth predicate — i.e. the scope restriction
          // could be the one that got dropped.
          where: {
            AND: [
              { tenantId: ctx.tenantId },
              input.emailScope === 'mine' || !input.clientId
                ? { connection: { createdByUserId: ctx.userId } }
                : // firm_shared: the caller's own mail, PLUS threads explicitly
                  // filed under this client. Never a participant-domain sweep.
                  {
                    OR: [
                      { connection: { createdByUserId: ctx.userId } },
                      { clientId: input.clientId },
                    ],
                  },
              activeMailThreadWhere(),
            ],
          },
          orderBy: { lastMessageAt: 'desc' },
          take: 60,
          select: {
            id: true,
            subject: true,
            snippet: true,
            lastMessageAt: true,
            clientId: true,
            status: true,
            associationScore: true,
            associationReason: true,
            connection: { select: { createdByUserId: true } },
            metadata: true,
            messages: {
              where: activeMailMessageWhere(),
              orderBy: [{ receivedAt: 'desc' }, { sentAt: 'desc' }, { createdAt: 'desc' }],
              take: 2,
              select: { fromName: true, fromEmail: true, sentAt: true, receivedAt: true, bodyText: true },
            },
            participants: true,
          },
        }),
      )
      .catch((e) => {
        this.logger.warn(`relevant-email query failed: ${(e as Error).message}`);
        return null;
      });

    if (rows == null) {
      return {
        evidence: [],
        failures: [
          sourceFailure(
            'email',
            'EMAIL_LOOKUP_FAILED',
            'important',
            'Prior correspondence could not be loaded, so the draft is not informed by it.',
          ),
        ],
      };
    }

    const candidates = rows.filter((r) => !exclude.has(r.id)).map(toThreadCandidate);
    const ranked = rankRelevantEmail(candidates, {
      clientId: input.clientId,
      recipientEmails: input.recipientEmails,
      topicTerms: input.topicTerms,
      scope: input.emailScope,
      userId: ctx.userId,
      wallAllowsClient: input.wallAllowsClient,
      audience: input.audience,
      now: input.now,
    });

    const evidence: EvidenceItem[] = [];
    for (const r of ranked.included) {
      const asOf = isoOrNull(r.thread.lastMessageAt);
      const ref = this.ref({
        sourceType: 'email',
        sourceId: r.thread.id,
        title: r.thread.subject || 'Email thread',
        trust: 'external_untrusted',
        authoritativeAsOf: asOf,
        scope: input.scope,
        now: input.now,
        clientId: r.thread.clientId,
        provenance: {
          mailboxScope: input.emailScope,
          relevance: relevanceLabel(r.score),
          score: r.score,
          closed: r.closed,
          contradicted: r.contradicted,
          explicitlySelected: false,
        },
      });
      evidence.push(
        this.item(ref, threadExcerpt(r.thread), input.scope, {
          relevanceScore: r.score,
          relevanceReasons: r.reasons,
        }),
      );
    }
    return { evidence, failures: [] };
  }

  // ── Documents ─────────────────────────────────────────────────────────────

  private async resolveDocument(
    ctx: TenantContext,
    item: SelectedContextItemRef,
    input: ResolveSelectedItemsInput,
  ): Promise<Partial<ResolveSelectedItemsResult>> {
    const attachmentId = parsePrefixed(item.id, 'doc-');
    if (!attachmentId) return { failures: [this.malformedId(item, 'document')] };

    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementAttachment.findFirst({
        where: { id: attachmentId, tenantId: ctx.tenantId },
      }),
    );
    if (!row) {
      return {
        failures: [
          sourceFailure(
            'document',
            'DOCUMENT_NOT_FOUND',
            'critical',
            'A document you selected is no longer available. Remove it and regenerate.',
            item.id,
          ),
        ],
      };
    }

    // Cross-client guard: a document filed under a DIFFERENT client is excluded,
    // and because it was explicitly selected, that exclusion is critical.
    if (input.clientId && row.clientId && row.clientId !== input.clientId) {
      return {
        failures: [
          sourceFailure(
            'document',
            'DOCUMENT_OTHER_CLIENT',
            'critical',
            'A document you selected belongs to a different client and cannot be used for this campaign.',
            item.id,
          ),
        ],
      };
    }

    const readiness = this.attachments.readiness(
      {
        id: row.id,
        fileName: row.fileName,
        contentType: row.contentType,
        lifecycleStatus: row.lifecycleStatus,
        scanStatus: row.scanStatus,
        verifiedContentType: row.verifiedContentType,
      },
      input.scanRequired,
    );
    if (!readiness.usable) {
      return {
        failures: [
          sourceFailure(
            'document',
            readiness.code ?? 'ATTACHMENT_NOT_READY',
            'critical',
            readiness.disclosure ?? 'This document is not available for use yet.',
            item.id,
          ),
        ],
      };
    }

    if (!this.attachments.isExtractableDocument(row.fileName, row.contentType)) {
      return {
        failures: [
          sourceFailure(
            'document',
            'DOCUMENT_NOT_EXTRACTABLE',
            'important',
            `"${row.fileName}" is not a text document, so its contents could not be used.`,
            item.id,
          ),
        ],
      };
    }

    const bytes = await this.attachmentBytes(ctx, row.bucket, row.s3Key);
    if (!bytes) {
      return {
        failures: [
          sourceFailure(
            'document',
            'DOCUMENT_READ_FAILED',
            'critical',
            `"${row.fileName}" could not be read from storage. Re-upload it or remove it from the campaign.`,
            item.id,
          ),
        ],
      };
    }

    const extraction = await this.attachments
      .extractBounded(bytes, row.fileName, row.contentType)
      .catch((e) => {
        this.logger.warn(`document extraction failed for ${row.id}: ${(e as Error).message}`);
        return null;
      });

    if (!extraction || extraction.status === 'empty') {
      // A password-protected or image-only PDF extracts to nothing. That is NOT
      // evidence, and it must not become an empty string in the packet.
      return {
        failures: [
          sourceFailure(
            'document',
            'DOCUMENT_NO_TEXT',
            'critical',
            `No readable text could be extracted from "${row.fileName}" (it may be password-protected or a scanned image), so it was not used.`,
            item.id,
          ),
        ],
      };
    }

    const failures: SourceFailure[] = [];
    if (extraction.status === 'truncated') {
      // Visible, not silent: the model is told, and so is the reviewer.
      failures.push(
        sourceFailure(
          'document',
          'DOCUMENT_TRUNCATED',
          'informational',
          `"${row.fileName}" is longer than the extraction limit, so only its first portion was used.`,
          item.id,
        ),
      );
    }
    if (readiness.disclosure) {
      failures.push(
        sourceFailure('document', 'ATTACHMENT_UNSCANNED', 'informational', readiness.disclosure, item.id),
      );
    }

    const bounded = boundEvidenceText(extraction.text);
    const asOf = isoOrNull(row.createdAt);
    const ref = this.ref({
      sourceType: 'document',
      sourceId: row.id,
      title: row.fileName,
      trust: 'external_untrusted',
      authoritativeAsOf: asOf,
      scope: item.scope,
      now: input.now,
      clientId: row.clientId,
      provenance: {
        extractionSource: extraction.source,
        chars: bounded.text.length,
        truncated: extraction.metadata.truncated || bounded.truncated,
        pageLimitHit: extraction.metadata.pageLimitHit,
        rowLimitHit: extraction.metadata.rowLimitHit,
        scanStatus: row.scanStatus,
      },
    });
    return {
      evidence: [
        this.item(
          ref,
          extraction.metadata.truncated || bounded.truncated
            ? `[TRUNCATED — only the first portion of this document is shown]\n${bounded.text}`
            : bounded.text,
          item.scope,
        ),
      ],
      failures,
    };
  }

  private async resolveClientNote(
    ctx: TenantContext,
    item: SelectedContextItemRef,
    input: ResolveSelectedItemsInput,
  ): Promise<Partial<ResolveSelectedItemsResult>> {
    const clientId = parsePrefixed(item.id, 'clientnote-');
    if (!clientId) return { failures: [this.malformedId(item, 'document')] };

    if (input.clientId && clientId !== input.clientId) {
      return {
        failures: [
          sourceFailure(
            'clientNote',
            'CLIENT_NOTE_OTHER_CLIENT',
            'critical',
            'A client profile note you selected belongs to a different client.',
            item.id,
          ),
        ],
      };
    }

    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: { id: true, name: true, intakeData: true, updatedAt: true },
      }),
    );
    const notes = (row?.intakeData as { profileNotes?: unknown } | null)?.profileNotes;
    const text = typeof notes === 'string' ? notes.trim() : '';
    if (!row || !text) {
      return {
        failures: [
          sourceFailure(
            'clientNote',
            'CLIENT_NOTE_EMPTY',
            'important',
            'The client profile note you selected is empty or unavailable.',
            item.id,
          ),
        ],
      };
    }

    const bounded = boundEvidenceText(text);
    const ref = this.ref({
      sourceType: 'clientNote',
      sourceId: row.id,
      title: `${row.name} — profile notes`,
      // Firm-authored prose about our own client: a server record, not external
      // data, and not authoritative structured truth.
      trust: 'server_record',
      authoritativeAsOf: isoOrNull(row.updatedAt),
      scope: item.scope,
      now: input.now,
      clientId: row.id,
      provenance: { truncated: bounded.truncated },
    });
    return { evidence: [this.item(ref, bounded.text, item.scope)] };
  }

  // ── Meeting artifacts ─────────────────────────────────────────────────────

  private async resolveMeetingNote(
    ctx: TenantContext,
    item: SelectedContextItemRef,
    input: ResolveSelectedItemsInput,
  ): Promise<Partial<ResolveSelectedItemsResult>> {
    const noteId = parsePrefixed(item.id, 'meetingnote-');
    if (!noteId) return { failures: [this.malformedId(item, 'note')] };

    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meetingNote.findFirst({
        where: { id: noteId, tenantId: ctx.tenantId, meeting: ownMeetingWhere(ctx.userId) },
        include: { meeting: { select: { clientId: true, subject: true, startsAt: true } } },
      }),
    );
    if (!row) {
      return {
        failures: [
          sourceFailure(
            'meetingNote',
            'MEETING_NOTE_NOT_ACCESSIBLE',
            'critical',
            'A meeting note you selected is no longer available to you.',
            item.id,
          ),
        ],
      };
    }
    if (!canReadEncryptedEntry(ctx, row)) {
      return {
        failures: [
          sourceFailure(
            'meetingNote',
            'MEETING_NOTE_RESTRICTED',
            'critical',
            'A meeting note you selected is restricted, so it was not used.',
            item.id,
          ),
        ],
      };
    }

    const body = this.safeDecrypt(row);
    if (!body) {
      return {
        failures: [
          sourceFailure(
            'meetingNote',
            'MEETING_NOTE_UNREADABLE',
            'critical',
            'A meeting note you selected could not be decrypted, so it was not used.',
            item.id,
          ),
        ],
      };
    }

    const bounded = boundEvidenceText(body);
    const asOf = isoOrNull(row.meeting?.startsAt) ?? isoOrNull(row.createdAt);
    const ref = this.ref({
      sourceType: 'meetingNote',
      sourceId: row.id,
      title: row.meeting?.subject ? `Note: ${row.meeting.subject}` : 'Meeting note',
      // Human-written notes about what happened. Firm-authored, so not external
      // — but still a recollection, so not authoritative structured truth.
      trust: 'server_record',
      authoritativeAsOf: asOf,
      scope: item.scope,
      now: input.now,
      clientId: row.clientId ?? row.meeting?.clientId ?? null,
      provenance: { truncated: bounded.truncated },
    });
    return {
      evidence: [this.item(ref, bounded.text, item.scope)],
      failures: this.freshnessFailures('note', item.id, asOf, input),
    };
  }

  private async resolveDebrief(
    ctx: TenantContext,
    item: SelectedContextItemRef,
    input: ResolveSelectedItemsInput,
  ): Promise<Partial<ResolveSelectedItemsResult>> {
    const id = parsePrefixed(item.id, 'debrief-');
    if (!id) return { failures: [this.malformedId(item, 'debrief')] };

    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meetingDebrief.findFirst({
        where: { id, tenantId: ctx.tenantId },
        include: { meeting: { select: { clientId: true, subject: true, startsAt: true } } },
      }),
    );
    if (!row) {
      return {
        failures: [
          sourceFailure(
            'debrief',
            'DEBRIEF_NOT_FOUND',
            'critical',
            'A meeting debrief you selected is no longer available.',
            item.id,
          ),
        ],
      };
    }
    if (!canReadEncryptedEntry(ctx, row)) {
      return {
        failures: [
          sourceFailure(
            'debrief',
            'DEBRIEF_RESTRICTED',
            'critical',
            'A meeting debrief you selected is restricted, so it was not used.',
            item.id,
          ),
        ],
      };
    }
    if (input.clientId) {
      const debriefClient = row.clientId ?? row.meeting?.clientId ?? null;
      if (debriefClient && debriefClient !== input.clientId) {
        return {
          failures: [
            sourceFailure(
              'debrief',
              'DEBRIEF_OTHER_CLIENT',
              'critical',
              'A meeting debrief you selected belongs to a different client.',
              item.id,
            ),
          ],
        };
      }
    }

    const body = this.safeDecrypt(row);
    if (!body) {
      return {
        failures: [
          sourceFailure(
            'debrief',
            'DEBRIEF_UNREADABLE',
            'critical',
            'A meeting debrief you selected could not be decrypted, so it was not used.',
            item.id,
          ),
        ],
      };
    }

    const bounded = boundEvidenceText(body);
    const asOf = isoOrNull(row.meeting?.startsAt) ?? isoOrNull(row.createdAt);
    const ref = this.ref({
      sourceType: 'debrief',
      sourceId: row.id,
      title: row.meeting?.subject ? `Debrief: ${row.meeting.subject}` : 'Meeting debrief',
      trust: 'server_record',
      authoritativeAsOf: asOf,
      scope: item.scope,
      now: input.now,
      clientId: row.clientId ?? row.meeting?.clientId ?? null,
      provenance: { status: row.status, truncated: bounded.truncated },
    });
    return {
      evidence: [this.item(ref, bounded.text, item.scope)],
      failures: this.freshnessFailures('debrief', item.id, asOf, input),
    };
  }

  private async resolvePrep(
    ctx: TenantContext,
    item: SelectedContextItemRef,
    input: ResolveSelectedItemsInput,
  ): Promise<Partial<ResolveSelectedItemsResult>> {
    const id = parsePrefixed(item.id, 'prep-');
    if (!id) return { failures: [this.malformedId(item, 'prep')] };

    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meetingPrep.findFirst({
        where: { id, tenantId: ctx.tenantId, meeting: ownMeetingWhere(ctx.userId) },
        include: { meeting: { select: { clientId: true, subject: true, startsAt: true } } },
      }),
    );
    if (!row) {
      return {
        failures: [
          sourceFailure(
            'prep',
            'PREP_NOT_ACCESSIBLE',
            'critical',
            'A meeting prep you selected is no longer available to you.',
            item.id,
          ),
        ],
      };
    }

    const lines: string[] = [];
    if (row.summary?.trim()) lines.push(`Summary: ${row.summary.trim()}`);
    pushList(lines, 'Agenda', row.agenda);
    pushList(lines, 'Talking points', row.talkingPoints);
    pushList(lines, 'Risks', row.risks);
    pushList(lines, 'Follow-ups', row.followUps);
    const text = lines.join('\n');
    if (!text.trim()) {
      return {
        failures: [
          sourceFailure(
            'prep',
            'PREP_EMPTY',
            'important',
            'The meeting prep you selected has no content, so it was not used.',
            item.id,
          ),
        ],
      };
    }

    const bounded = boundEvidenceText(text);
    const asOf = isoOrNull(row.meeting?.startsAt) ?? isoOrNull(row.createdAt);
    const ref = this.ref({
      sourceType: 'prep',
      sourceId: row.id,
      title: row.meeting?.subject ? `Prep: ${row.meeting.subject}` : 'Meeting prep',
      trust: 'server_record',
      authoritativeAsOf: asOf,
      scope: item.scope,
      now: input.now,
      clientId: row.clientId ?? row.meeting?.clientId ?? null,
      provenance: {
        status: row.status,
        // A prep is a PLAN for a meeting. It proves what we intended to raise,
        // never that the meeting happened or that anyone agreed — the verifier
        // reads this flag for the attendance/commitment checks.
        isPlanNotOutcome: true,
        truncated: bounded.truncated,
      },
    });
    return {
      evidence: [this.item(ref, bounded.text, item.scope)],
      failures: this.freshnessFailures('prep', item.id, asOf, input),
    };
  }

  // ── User-authored note ────────────────────────────────────────────────────

  /**
   * A custom note is the ONE channel where the user's own words enter the prompt.
   *
   * It defaults to a DIRECTIVE ("do this") rather than a fact ("this is true"),
   * and the user must explicitly opt into fact treatment. The default matters:
   * "dinner last week went well" as an instruction produces a warm reference,
   * whereas as a fact it licenses the model to narrate a dinner it knows nothing
   * about. Either way it cannot override the system contract.
   */
  private async resolveCustomNote(
    ctx: TenantContext,
    item: SelectedContextItemRef,
  ): Promise<Partial<ResolveSelectedItemsResult>> {
    const text = clip(item.customNoteText, MAX_CUSTOM_NOTE_CHARS);
    if (!text) {
      // Whitespace-only note: omit silently rather than raising a failure. The
      // user simply left the box empty; that is not a broken source.
      return {};
    }

    if (item.noteUse === 'fact') {
      const ref: EvidenceSourceRef = {
        sourceType: 'note',
        sourceId: item.id,
        title: 'Your note',
        trust: 'user_authored',
        retrievedAt: new Date(0).toISOString(),
        recipientKeys: item.scope === 'all' ? [] : [item.scope],
        authoritativeAsOf: null,
        sourceCreatedAt: null,
        provenance: { authoredBy: 'user', markedAs: 'fact' },
      };
      return {
        evidence: [
          {
            ref,
            evidenceText: text,
            scope: item.scope,
          },
        ],
      };
    }

    return {
      directives: [
        {
          id: `note:${item.id}`,
          kind: 'custom_note',
          text,
          scope: item.scope,
          authenticatedUserId: ctx.userId,
        },
      ],
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async attachmentBytes(
    _ctx: TenantContext,
    bucket: string,
    s3Key: string,
  ): Promise<Buffer | null> {
    // Reading S3 is the ONE thing this service cannot do itself without pulling
    // the S3 client in; the reader is injected by the module as a callback so
    // this stays unit-testable with a plain function.
    if (!this.s3Reader) {
      this.logger.warn('no attachment byte reader configured — document evidence unavailable');
      return null;
    }
    return this.s3Reader(bucket, s3Key).catch((e) => {
      this.logger.warn(`attachment read failed for ${s3Key}: ${(e as Error).message}`);
      return null;
    });
  }

  /**
   * Injected S3 reader. Set once at module init by EngagementModule so this
   * service does not depend on EngagementService (which would be a cycle) nor
   * construct a second S3 client.
   */
  private s3Reader: ((bucket: string, key: string) => Promise<Buffer>) | null = null;

  setAttachmentReader(reader: (bucket: string, key: string) => Promise<Buffer>): void {
    this.s3Reader = reader;
  }

  private safeDecrypt(e: { bodyCiphertext: string; iv: string; authTag: string }): string | null {
    try {
      const text = this.notesCrypto.decrypt(e);
      return text?.trim() || null;
    } catch {
      return null;
    }
  }

  private malformedId(item: SelectedContextItemRef, sourceType: string): SourceFailure {
    return sourceFailure(
      sourceType,
      'SOURCE_ID_MALFORMED',
      'critical',
      'A selected context item had an unrecognized identifier and could not be loaded.',
      item.id,
    );
  }

  private emailExclusionFailure(itemId: string, reason: string): SourceFailure {
    switch (reason) {
      case 'ethical_wall_denied':
        // Deliberately content-free: naming the thread would itself leak.
        return sourceFailure(
          'email',
          'EMAIL_WALL_DENIED',
          'critical',
          'You do not have access to correspondence for this client, so the thread you selected was not used.',
          itemId,
        );
      case 'different_client':
        return sourceFailure(
          'email',
          'EMAIL_OTHER_CLIENT',
          'critical',
          'An email thread you selected belongs to a different client and cannot be used for this campaign.',
          itemId,
        );
      case 'not_own_mailbox':
        return sourceFailure(
          'email',
          'EMAIL_NOT_OWN_MAILBOX',
          'critical',
          'That email thread is in a colleague’s mailbox. Only your own mail can be used unless firm-shared client history is enabled.',
          itemId,
        );
      case 'not_firm_shared':
        return sourceFailure(
          'email',
          'EMAIL_NOT_FIRM_SHARED',
          'critical',
          'That email thread is not shared for this client, so it was not used.',
          itemId,
        );
      case 'deleted_or_restricted':
        return sourceFailure(
          'email',
          'EMAIL_RESTRICTED',
          'critical',
          'An email thread you selected has been deleted or restricted.',
          itemId,
        );
      default:
        return sourceFailure(
          'email',
          'EMAIL_NO_RELATIONSHIP',
          'important',
          'An email thread you selected has no connection to this client or these recipients, so it was not used.',
          itemId,
        );
    }
  }

  /**
   * Raise a staleness failure when a source is older than its policy threshold.
   *
   * Recorded as `important` rather than `critical`: a stale bill status is
   * usable WITH an as-of caveat, and the verifier's stale_source_caveat check is
   * what enforces that the caveat actually appears in the draft. Blocking here
   * would make an ordinary two-week-old status unusable.
   */
  private freshnessFailures(
    evidenceType: string,
    sourceId: string,
    asOf: string | null,
    input: ResolveSelectedItemsInput,
  ): SourceFailure[] {
    if (!asOf) {
      if (!input.policy.requiresAsOfDates) return [];
      return [
        sourceFailure(
          evidenceType,
          'SOURCE_NO_AS_OF_DATE',
          'important',
          'A source you selected has no known as-of date, so any status or figure drawn from it must be caveated.',
          sourceId,
        ),
      ];
    }
    const asOfMs = new Date(asOf).getTime();
    if (Number.isNaN(asOfMs)) return [];
    const ageDays = (input.now.getTime() - asOfMs) / 86_400_000;
    const threshold = freshnessThresholdDays(input.policy, evidenceType);
    if (ageDays <= threshold) return [];
    return [
      sourceFailure(
        evidenceType,
        'SOURCE_STALE',
        'important',
        `A source you selected is ${Math.round(ageDays)} days old (over the ${threshold}-day limit for this kind of source). The draft must state its as-of date.`,
        sourceId,
      ),
    ];
  }

  private ref(o: {
    sourceType: string;
    sourceId: string;
    title: string;
    trust: EvidenceTrust;
    authoritativeAsOf: string | null;
    scope: 'all' | string;
    now: Date;
    clientId?: string | null;
    provenance?: Record<string, string | number | boolean | null>;
  }): EvidenceSourceRef {
    return {
      sourceType: o.sourceType,
      sourceId: o.sourceId,
      title: o.title,
      clientId: o.clientId ?? null,
      recipientKeys: o.scope === 'all' ? [] : [o.scope],
      sourceCreatedAt: null,
      authoritativeAsOf: o.authoritativeAsOf,
      // `now` is injected, so two identical requests produce an identical packet
      // hash. A live `new Date()` here would make the hash change every call and
      // defeat both the determinism test and the prompt cache.
      retrievedAt: o.now.toISOString(),
      trust: o.trust,
      ...(o.provenance ? { provenance: o.provenance } : {}),
    };
  }

  private item(
    ref: EvidenceSourceRef,
    text: string,
    scope: 'all' | string,
    extra?: Partial<Pick<EvidenceItem, 'structuredTruth' | 'relevanceScore' | 'relevanceReasons'>>,
  ): EvidenceItem {
    return { ref, evidenceText: text, scope, ...(extra ?? {}) };
  }
}

// ── Module-local pure helpers ───────────────────────────────────────────────

function parsePrefixed(id: string, prefix: string): string | null {
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length).trim();
  return rest.length ? rest : null;
}

function clip(v: string | undefined, max: number): string | null {
  const t = (v ?? '').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trim()}…` : t;
}

function isoOrNull(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function pushList(into: string[], label: string, value: unknown): void {
  const items = Array.isArray(value)
    ? value
        .map((v) =>
          typeof v === 'string'
            ? v
            : v && typeof v === 'object' && 'text' in (v as Record<string, unknown>)
              ? String((v as { text: unknown }).text)
              : null,
        )
        .filter((s): s is string => Boolean(s && s.trim()))
    : [];
  if (!items.length) return;
  into.push(`${label}:`);
  for (const i of items) into.push(`- ${i.trim()}`);
}

/** Normalize a MailThread row into the ranker's candidate shape. */
function toThreadCandidate(row: {
  id: string;
  subject: string | null;
  snippet: string | null;
  lastMessageAt: Date | null;
  clientId: string | null;
  status: string;
  associationScore: number | null;
  associationReason: string | null;
  connection: { createdByUserId: string | null } | null;
  metadata: unknown;
  participants: unknown;
  messages: Array<{
    fromName: string | null;
    fromEmail: string | null;
    sentAt: Date | null;
    receivedAt: Date | null;
    bodyText: string | null;
  }>;
}): EmailThreadCandidate {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const participantEmails = Array.isArray(row.participants)
    ? (row.participants as Array<Record<string, unknown>>)
        .map((p) => (typeof p?.email === 'string' ? p.email.trim().toLowerCase() : ''))
        .filter(Boolean)
    : [];
  return {
    id: row.id,
    subject: row.subject,
    snippet: row.snippet,
    lastMessageAt: row.lastMessageAt,
    clientId: row.clientId,
    // An association recorded ONLY by the heuristic scorer (a score with no
    // explicit clientId) is the weak-inference case the ranker penalizes.
    inferredClientOnly: row.clientId == null && row.associationScore != null,
    participantEmails,
    ownerUserId: row.connection?.createdByUserId ?? null,
    firmShared: meta.firmShared === true,
    deleted: meta.deleted === true,
    restricted: meta.restricted === true,
    closed: row.status === 'closed' || row.status === 'resolved',
    contradicted: meta.contradicted === true,
    direction: typeof meta.direction === 'string' ? (meta.direction as 'inbound') : null,
    // A purely-received message may have no sentAt; fall back to receivedAt
    // so the excerpt still gets a usable date instead of showing none.
    messages: row.messages.map((m) => ({
      fromName: m.fromName,
      fromEmail: m.fromEmail,
      sentAt: m.sentAt ?? m.receivedAt,
      bodyText: m.bodyText,
    })),
  };
}
