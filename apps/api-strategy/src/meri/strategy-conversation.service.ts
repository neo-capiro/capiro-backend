import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

/**
 * Who authored a message. `user` is the ONLY role a client may cause directly —
 * every other role is server-authored, so a caller can never forge a line that
 * reads as Meri.
 */
export const CHAT_ROLES = ['user', 'meri', 'system', 'watch'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

/**
 * What a message IS, beyond who said it. `message` is ordinary conversation;
 * the rest carry presentation or lifecycle meaning:
 *  - context_gap     — Phase 5's persistent "drafted on partial information"
 *                      line; stays until resolved or dismissed.
 *  - watch_applied   — Phase 4's Watch-acceptance confirmation (badge).
 *  - assistant_error — the model/orchestrator failed after the user's message
 *                      was already stored.
 */
export const CHAT_KINDS = ['message', 'context_gap', 'watch_applied', 'assistant_error'] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

export const CHAT_STATES = ['active', 'resolved', 'dismissed'] as const;
export type ChatState = (typeof CHAT_STATES)[number];

/** Aligned with AssistantDto.instruction (4000) — a stored line is never longer
 *  than the input that could have produced it, and a Meri reply is a chat
 *  bubble, not a document. */
const MAX_BODY = 4_000;
/** Aligned with AssistantDto.attachmentIds / StrategyAttachmentResolver. */
const MAX_ATTACHMENTS = 10;
const MAX_FILENAME = 200;
/** One context's history. Deep enough that no real thread truncates; bounded so
 *  a pathological thread can't return an unbounded payload. */
const MAX_MESSAGES = 500;

/** The immutable display snapshot of one attachment on a user message. */
export interface ChatAttachmentSnapshot {
  id: string;
  filename: string;
  kind: string;
  status: string;
}

/** The only action shape this phase supports (the prototype's `Open "<step>"`). */
export interface ChatOpenNodeAction {
  type: 'open_node';
  nodeId: string;
  title: string;
}

/** The normalized message the API returns. Deliberately omits tenantId and every
 *  internal diagnostic — this is the public wire shape. */
export interface PublicChatMessage {
  id: string;
  strategyId: string;
  nodeId: string | null;
  role: ChatRole;
  kind: ChatKind;
  body: string;
  attachments: ChatAttachmentSnapshot[];
  action: ChatOpenNodeAction | null;
  state: ChatState;
  createdByUserId: string | null;
  createdAt: string;
}

/** What a caller may append. `role` is chosen by the SERVER at each call site. */
export interface AppendMessageInput {
  strategyId: string;
  nodeId?: string | null;
  role: ChatRole;
  kind?: ChatKind;
  body: string;
  attachments?: ChatAttachmentSnapshot[];
  action?: ChatOpenNodeAction | null;
  state?: ChatState;
  clientMessageId?: string | null;
  createdByUserId?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The durable Meri conversation on a strategy (Phase 2).
 *
 * Threads are keyed by context: `nodeId = null` is the strategy thread, a node id
 * is that step's thread. Nothing here reads or writes the plan — appending a line
 * is deliberately separable from applying an edit, so MeriService can store the
 * user's message BEFORE the model call and still commit Meri's reply inside the
 * SAME transaction that commits the plan edit.
 *
 * Every method takes an explicit tenantId and either opens a withTenant tx or
 * accepts the caller's — the query hook injects `where.tenantId`, and writes set
 * it explicitly (create/createMany are NOT hook-scoped).
 */
@Injectable()
export class StrategyConversationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The messages in one context, oldest first. `nodeId` null/undefined selects
   * the strategy thread — NOT "all threads"; a step's conversation never leaks
   * into the strategy view and vice versa.
   */
  async list(tenantId: string, strategyId: string, nodeId: string | null): Promise<PublicChatMessage[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertContext(tx, strategyId, nodeId);
      return this.listIn(tx, strategyId, nodeId);
    });
  }

  /** list() against a caller-supplied tx (context already validated). */
  async listIn(tx: Tx, strategyId: string, nodeId: string | null): Promise<PublicChatMessage[]> {
    const rows = await tx.spStrategyChatMessage.findMany({
      where: { strategyId, nodeId },
      // id is the tiebreaker because createdAt is millisecond-resolution and a
      // user message + its reply can commit inside the same millisecond.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_MESSAGES,
    });
    return rows.map(toPublic);
  }

  /**
   * Append the user's own message, idempotently on (tenantId, clientMessageId).
   * A retried send — dropped response, double-click, React 18 double-effect —
   * returns the STORED message rather than posting a second bubble.
   *
   * Insert-then-catch rather than find-then-insert: the read-first form races
   * two concurrent retries into two rows, and the unique index is the only thing
   * that actually decides the winner.
   */
  async appendUserMessage(
    tenantId: string,
    clerkUserId: string,
    input: {
      strategyId: string;
      nodeId: string | null;
      body: string;
      attachments?: ChatAttachmentSnapshot[];
      clientMessageId: string;
    },
  ): Promise<PublicChatMessage> {
    return this.prisma.withTenantUser(tenantId, clerkUserId, async (tx) => {
      await this.assertContext(tx, input.strategyId, input.nodeId);
      try {
        return await this.appendIn(tx, tenantId, {
          strategyId: input.strategyId,
          nodeId: input.nodeId,
          role: 'user',
          kind: 'message',
          body: input.body,
          attachments: input.attachments,
          clientMessageId: input.clientMessageId,
          createdByUserId: clerkUserId,
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // The retry lost the race (or is a genuine re-send): the stored row is
        // authoritative. findFirst, not findUnique — the tenant-scope hook
        // injects a top-level where.tenantId, which findUnique's compound-unique
        // where does not accept.
        const existing = await tx.spStrategyChatMessage.findFirst({
          where: { clientMessageId: input.clientMessageId },
        });
        if (!existing) throw err;
        return toPublic(existing);
      }
    });
  }

  /**
   * Append a SERVER-authored message (Meri reply, context gap, Watch
   * confirmation, assistant error) inside the caller's transaction, so it
   * commits or rolls back with whatever else that transaction did.
   */
  async appendIn(tx: Tx, tenantId: string, input: AppendMessageInput): Promise<PublicChatMessage> {
    const role = assertEnum(input.role, CHAT_ROLES, 'role');
    const kind = assertEnum(input.kind ?? 'message', CHAT_KINDS, 'kind');
    const state = assertEnum(input.state ?? 'active', CHAT_STATES, 'state');
    const body = normalizeBody(input.body);
    const row = await tx.spStrategyChatMessage.create({
      data: {
        tenantId,
        strategyId: input.strategyId,
        nodeId: input.nodeId ?? null,
        role,
        kind,
        body,
        attachmentRefs: normalizeAttachments(input.attachments),
        action: normalizeAction(input.action),
        state,
        clientMessageId: input.clientMessageId ?? null,
        createdByUserId: input.createdByUserId ?? null,
      },
    });
    return toPublic(row);
  }

  /** Append a server-authored message in its own transaction. */
  async append(tenantId: string, input: AppendMessageInput): Promise<PublicChatMessage> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertContext(tx, input.strategyId, input.nodeId ?? null);
      return this.appendIn(tx, tenantId, input);
    });
  }

  /**
   * Dismiss one context-gap message. Scoped by tenant (the hook) AND strategy AND
   * kind, so this can never flip an ordinary message's state or reach another
   * tenant's row. Returns the updated message.
   */
  async dismissContextGap(
    tenantId: string,
    strategyId: string,
    messageId: string,
  ): Promise<PublicChatMessage> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertStrategy(tx, strategyId);
      const found = await tx.spStrategyChatMessage.findFirst({
        where: { id: messageId, strategyId, kind: 'context_gap' },
      });
      if (!found) throw new NotFoundException('Context note not found');
      if (found.state === 'dismissed') return toPublic(found);
      const updated = await tx.spStrategyChatMessage.update({
        where: { id: found.id },
        data: { state: 'dismissed' },
      });
      return toPublic(updated);
    });
  }

  // ---- validation ---------------------------------------------------------

  /** The strategy exists for this tenant (the hook adds tenantId to the where). */
  private async assertStrategy(tx: Tx, strategyId: string): Promise<void> {
    const strategy = await tx.spStrategy.findFirst({ where: { id: strategyId }, select: { id: true } });
    if (!strategy) throw new NotFoundException('Strategy not found');
  }

  /**
   * The strategy exists for this tenant AND, when a node context is requested,
   * the node belongs to that strategy.
   *
   * Deliberately accepts an ARCHIVED node: a step archived by a version restore
   * keeps its conversation readable (that is the whole reason node_id carries no
   * FK). Only the timeline decides what is selectable.
   */
  private async assertContext(tx: Tx, strategyId: string, nodeId: string | null): Promise<void> {
    await this.assertStrategy(tx, strategyId);
    if (!nodeId) return;
    const node = await tx.spNode.findFirst({ where: { id: nodeId, strategyId }, select: { id: true } });
    if (!node) throw new NotFoundException('Step not found on this strategy');
  }
}

// ---- normalization ---------------------------------------------------------

function assertEnum<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new BadRequestException(`Invalid message ${field}`);
  }
  return value as T[number];
}

function normalizeBody(body: unknown): string {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) throw new BadRequestException('A message cannot be empty');
  return text.slice(0, MAX_BODY);
}

/**
 * Attachment snapshots are DISPLAY data supplied by the client for its own
 * uploads. They are stored verbatim-but-bounded and never re-resolved, so a
 * later rename or delete cannot rewrite what the thread says was sent. Rows
 * without a UUID id are dropped rather than stored as junk.
 */
function normalizeAttachments(
  attachments: ChatAttachmentSnapshot[] | undefined,
): Prisma.InputJsonValue | undefined {
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  const out = attachments
    .filter((a) => a && typeof a.id === 'string' && UUID_RE.test(a.id))
    .slice(0, MAX_ATTACHMENTS)
    .map((a) => ({
      id: a.id,
      filename: String(a.filename ?? 'document').slice(0, MAX_FILENAME),
      kind: String(a.kind ?? 'unsupported').slice(0, 40),
      status: String(a.status ?? 'unknown').slice(0, 40),
    }));
  return out.length ? (out as unknown as Prisma.InputJsonValue) : undefined;
}

/** Only `open_node` exists in this phase — anything else is dropped rather than
 *  stored as an action the web has no renderer for. */
function normalizeAction(
  action: ChatOpenNodeAction | null | undefined,
): Prisma.InputJsonValue | undefined {
  if (!action || action.type !== 'open_node') return undefined;
  if (typeof action.nodeId !== 'string' || !UUID_RE.test(action.nodeId)) return undefined;
  const title = String(action.title ?? '').trim();
  if (!title) return undefined;
  return { type: 'open_node', nodeId: action.nodeId, title: title.slice(0, 300) };
}

function readAttachments(value: unknown): ChatAttachmentSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const a = raw as Partial<ChatAttachmentSnapshot> | null;
    if (!a || typeof a.id !== 'string') return [];
    return [
      {
        id: a.id,
        filename: typeof a.filename === 'string' ? a.filename : 'document',
        kind: typeof a.kind === 'string' ? a.kind : 'unsupported',
        status: typeof a.status === 'string' ? a.status : 'unknown',
      },
    ];
  });
}

function readAction(value: unknown): ChatOpenNodeAction | null {
  const a = value as Partial<ChatOpenNodeAction> | null;
  if (!a || a.type !== 'open_node') return null;
  if (typeof a.nodeId !== 'string' || typeof a.title !== 'string') return null;
  return { type: 'open_node', nodeId: a.nodeId, title: a.title };
}

/** Row → wire shape. tenantId and clientMessageId are intentionally NOT exposed. */
function toPublic(row: {
  id: string;
  strategyId: string;
  nodeId: string | null;
  role: string;
  kind: string;
  body: string;
  attachmentRefs: unknown;
  action: unknown;
  state: string;
  createdByUserId: string | null;
  createdAt: Date;
}): PublicChatMessage {
  return {
    id: row.id,
    strategyId: row.strategyId,
    nodeId: row.nodeId,
    role: (CHAT_ROLES as readonly string[]).includes(row.role) ? (row.role as ChatRole) : 'system',
    kind: (CHAT_KINDS as readonly string[]).includes(row.kind) ? (row.kind as ChatKind) : 'message',
    body: row.body,
    attachments: readAttachments(row.attachmentRefs),
    action: readAction(row.action),
    state: (CHAT_STATES as readonly string[]).includes(row.state) ? (row.state as ChatState) : 'active',
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** P2002 on (tenant_id, client_message_id) — a retried user send. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
