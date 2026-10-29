import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { types } from 'node:util';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { ApplicationCurrentService } from '../auth/application-current.service.js';
import { MeriChatAttachmentReadService } from './meri-chat-attachment-read.service.js';
import { withMeriChatAttachmentReadScope } from './meri-chat-attachment-read-scope.js';
import {
  assertMeriToolRequestActive,
  meriToolRequestControl,
} from './meri-tool-request-control.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_OBSERVATION_MS = 30_000;
const invalid = () => new BadRequestException('Invalid attachment source request');
const changed = () => new ConflictException('Attachment source changed; restart the read');
function closed(raw: unknown, keys: string[]): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    types.isProxy(raw) ||
    Array.isArray(raw) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    throw invalid();
  const names = Reflect.ownKeys(raw);
  if (names.length !== keys.length || names.some((k) => typeof k !== 'string' || !keys.includes(k)))
    throw invalid();
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || !('value' in d) || !d.enumerable) throw invalid();
    out[key] = d.value;
  }
  return out;
}
function uuid(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID.test(raw)) throw invalid();
  return raw;
}
function instant(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    !Number.isFinite(Date.parse(raw)) ||
    new Date(raw).toISOString() !== raw
  )
    throw invalid();
  return raw;
}
export interface AttachmentSourceSelection {
  version: 2;
  currentTurn: { conversationId: string; selectedClientId: string | null };
  source: { kind: 'clio_conversation'; conversationId: string; conversationVersion?: string };
  observation?: { asOf: string; expiresAtMs: number };
  input?: Record<string, unknown>;
}
/** These fields select data. The signed-in actor and all authority come from Core. */
export function parseAttachmentSource(
  raw: unknown,
  read: boolean,
  now = Date.now(),
): AttachmentSourceSelection {
  const v = closed(
    raw,
    read
      ? ['version', 'currentTurn', 'source', 'observation', 'input']
      : ['version', 'currentTurn', 'source'],
  );
  if (v.version !== 2) throw invalid();
  const turn = closed(v.currentTurn, ['conversationId', 'selectedClientId']);
  const source = closed(
    v.source,
    read ? ['kind', 'conversationId', 'conversationVersion'] : ['kind', 'conversationId'],
  );
  if (source.kind !== 'clio_conversation') throw invalid();
  const selected: AttachmentSourceSelection = {
    version: 2,
    currentTurn: {
      conversationId: uuid(turn.conversationId),
      selectedClientId: turn.selectedClientId === null ? null : uuid(turn.selectedClientId),
    },
    source: { kind: 'clio_conversation', conversationId: uuid(source.conversationId) },
  };
  if (read) {
    selected.source.conversationVersion = instant(source.conversationVersion);
    const o = closed(v.observation, ['asOf', 'expiresAtMs']),
      asOf = instant(o.asOf),
      at = Date.parse(asOf);
    if (
      at > now ||
      now - at > MAX_OBSERVATION_MS ||
      !Number.isSafeInteger(o.expiresAtMs) ||
      (o.expiresAtMs as number) <= now ||
      (o.expiresAtMs as number) > at + MAX_OBSERVATION_MS
    )
      throw changed();
    selected.observation = { asOf, expiresAtMs: o.expiresAtMs as number };
    if (!v.input || typeof v.input !== 'object' || types.isProxy(v.input) || Array.isArray(v.input))
      throw invalid();
    const keys = Object.keys(v.input);
    if (
      keys.some(
        (k) =>
          ![
            'conversationId',
            'attachmentId',
            'query',
            'section',
            'rowStart',
            'characterOffset',
            'cursor',
            'limit',
          ].includes(k),
      )
    )
      throw invalid();
    const input = closed(v.input, keys);
    if (
      Object.hasOwn(input, 'conversationId') &&
      input.conversationId !== selected.source.conversationId
    )
      throw invalid();
    selected.input = { ...input, conversationId: selected.source.conversationId };
  }
  return selected;
}

/** A fixed native adapter to the existing legacy attachment reader, not another storage or credential owner. */
@Injectable()
export class MeriChatAttachmentSourceService {
  constructor(
    private readonly current: ApplicationCurrentService,
    private readonly reader: MeriChatAttachmentReadService,
  ) {}

  async execute(ctx: TenantContext, req: Request, raw: unknown, read: boolean) {
    const began = Date.now(),
      input = parseAttachmentSource(raw, read, began);
    assertMeriToolRequestActive();
    const selection = {
      conversationId: input.currentTurn.conversationId,
      clientId: input.currentTurn.selectedClientId,
    };
    const before = await this.current.read(ctx, req, selection);
    if (
      before.principal.tenantId !== ctx.tenantId ||
      before.principal.actorId !== ctx.userId ||
      before.conversationId !== selection.conversationId ||
      before.selectedClientId !== selection.clientId ||
      before.expiresAtMs <= Date.now()
    )
      throw new ForbiddenException('Attachment current context unavailable');
    const scope = {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      conversationId: input.source.conversationId,
      selectedClientId: selection.clientId,
      ...(input.observation
        ? {
            sourceObservation: {
              ...input.observation,
              conversationVersion: input.source.conversationVersion!,
            },
          }
        : {}),
    };
    return withMeriChatAttachmentReadScope(scope, async () => {
      const source = await this.reader.observeSource(ctx, input.source.conversationId);
      const result = read ? await this.reader.read(ctx, input.input!) : null;
      assertMeriToolRequestActive();
      const after = await this.current.read(ctx, req, {
        ...selection,
        expect: {
          identityRevision: before.identityRevision,
          membershipRevision: before.membershipRevision,
          contextRevision: before.contextRevision,
        },
      });
      if (
        after.principal.tenantId !== before.principal.tenantId ||
        after.principal.actorId !== before.principal.actorId ||
        after.identityRevision !== before.identityRevision ||
        after.membershipRevision !== before.membershipRevision ||
        after.contextRevision !== before.contextRevision ||
        after.conversationId !== selection.conversationId ||
        after.selectedClientId !== selection.clientId
      )
        throw new ForbiddenException('Attachment current context changed');
      const again = await this.reader.observeSource(ctx, input.source.conversationId);
      if (
        again.conversationVersion !== source.conversationVersion ||
        again.clientId !== source.clientId
      )
        throw changed();
      const checkedAtMs = Date.now(),
        expiresAtMs = Math.min(
          before.expiresAtMs,
          after.expiresAtMs,
          began + MAX_OBSERVATION_MS,
          input.observation?.expiresAtMs ?? Infinity,
          meriToolRequestControl()?.deadlineAt ?? Infinity,
        );
      if (expiresAtMs <= checkedAtMs) throw changed();
      assertMeriToolRequestActive();
      if (read) return result;
      return {
        version: 2,
        currentTurn: input.currentTurn,
        scope: { tenantId: ctx.tenantId, userId: ctx.userId, ...source },
        asOf: new Date(checkedAtMs).toISOString(),
        checkedAtMs,
        expiresAtMs,
      };
    });
  }
}
