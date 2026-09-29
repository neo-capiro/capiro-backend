import { createHash, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import type { MeriChatAttachmentReadScope } from './meri-chat-attachment-read-scope.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AttachmentTransportEnvelope {
  version: 1;
  input: Record<string, unknown>;
  currentTurn: MeriChatAttachmentReadScope;
}

function secretMatches(provided: string, expected: string): boolean {
  const actual = createHash('sha256').update(provided, 'utf8').digest();
  const wanted = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(actual, wanted);
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseEnvelope(value: unknown): AttachmentTransportEnvelope {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !['version', 'input', 'currentTurn'].includes(key))
  ) {
    throw new BadRequestException('Trusted chat attachment transport context is required');
  }
  const currentTurn = value.currentTurn;
  if (
    value.version !== 1 ||
    !object(value.input) ||
    !object(currentTurn) ||
    Object.keys(currentTurn).some(
      (key) => !['tenantId', 'userId', 'conversationId', 'selectedClientId'].includes(key),
    ) ||
    typeof currentTurn.tenantId !== 'string' ||
    !UUID.test(currentTurn.tenantId) ||
    typeof currentTurn.userId !== 'string' ||
    !UUID.test(currentTurn.userId) ||
    typeof currentTurn.conversationId !== 'string' ||
    !UUID.test(currentTurn.conversationId) ||
    (currentTurn.selectedClientId !== null &&
      (typeof currentTurn.selectedClientId !== 'string' ||
        !UUID.test(currentTurn.selectedClientId)))
  ) {
    throw new BadRequestException('Trusted chat attachment transport context is invalid');
  }
  return value as unknown as AttachmentTransportEnvelope;
}

/** Strict admission applies only to the served prior-attachment read. */
export function admitMeriChatAttachmentTransport(
  name: string,
  rawBody: unknown,
  ctx: TenantContext,
  req: Request,
): { input: Record<string, unknown>; scope?: MeriChatAttachmentReadScope } {
  if (name !== 'read_chat_attachments') {
    return { input: object(rawBody) ? rawBody : {} };
  }
  const expected = process.env.INTERNAL_SERVICE_SECRET?.trim();
  const rawHeader = req.headers['x-internal-service-secret'];
  const provided = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader)?.trim() ?? '';
  if (!expected) {
    throw new ForbiddenException('Internal service identity is not configured for this route');
  }
  if (!provided || !secretMatches(provided, expected)) {
    throw new ForbiddenException('This route requires a valid internal service identity');
  }
  const envelope = parseEnvelope(rawBody);
  if (
    envelope.currentTurn.tenantId !== ctx.tenantId ||
    envelope.currentTurn.userId !== ctx.userId
  ) {
    throw new ForbiddenException('Trusted chat attachment actor context does not match');
  }
  const suppliedConversation = envelope.input.conversationId;
  if (
    suppliedConversation !== undefined &&
    suppliedConversation !== envelope.currentTurn.conversationId
  ) {
    throw new BadRequestException('Chat attachment input does not match the current conversation');
  }
  return {
    input: { ...envelope.input, conversationId: envelope.currentTurn.conversationId },
    scope: Object.freeze({ ...envelope.currentTurn }),
  };
}
