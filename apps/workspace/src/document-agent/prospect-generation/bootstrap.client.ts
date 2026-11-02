import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { canonicalWorkspaceSnapshot } from '@capiro/shared';
import {
  workspaceGenerationConversationId,
  type WorkspaceProspectGenerationSource,
} from '@capiro/shared/workspace-prospect-generation-source';
import { nativeGenerationOrigin } from '../native-generation-conversation.client.js';

/** Only Core registers the native conversation. No network request is made
 * while a Workspace transaction or draft lock is held. */
@Injectable()
export class ProspectGenerationBootstrapClient {
  configured() {
    try {
      nativeGenerationOrigin(process.env.API_BASE_URL ?? '');
      return Boolean(
        process.env.INTERNAL_SERVICE_SECRET ?? process.env.MERI_CONTROL_SERVICE_SECRET,
      );
    } catch {
      return false;
    }
  }

  async register(
    tenantId: string,
    actorId: string,
    source: WorkspaceProspectGenerationSource,
    credential: string,
  ) {
    if (!credential || /\s/.test(credential))
      throw new UnauthorizedException('A current session is required');
    const base = process.env.API_BASE_URL,
      secret = process.env.INTERNAL_SERVICE_SECRET ?? process.env.MERI_CONTROL_SERVICE_SECRET;
    if (!base || !secret)
      throw new ServiceUnavailableException('Core generation registration is unavailable');
    let origin: URL;
    try {
      origin = nativeGenerationOrigin(base);
    } catch {
      throw new ServiceUnavailableException('Core generation registration is unavailable');
    }
    try {
      const response = await fetch(
        new URL('/api/clio/conversations/workspace-generation', origin),
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
          headers: {
            authorization: `Bearer ${credential}`,
            'x-internal-service-secret': secret,
            'content-type': 'application/json',
          },
          body: JSON.stringify(source),
        },
      );
      if ([401, 403, 404].includes(response.status))
        throw new ForbiddenException('Current generation source access was not confirmed');
      if (response.status === 409)
        throw new ConflictException({ code: 'WORKSPACE_GENERATION_SOURCE_CONFLICT' });
      if (!response.ok || !response.body)
        throw new ServiceUnavailableException('Core generation registration is unavailable');
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > 8192) throw new Error('Oversized registration');
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (
        !value ||
        Object.keys(value).sort().join() !==
          'actorId,conversationId,schemaVersion,source,tenantId' ||
        value.schemaVersion !== 1 ||
        value.tenantId !== tenantId ||
        value.actorId !== actorId ||
        value.conversationId !== workspaceGenerationConversationId(source.requestId) ||
        canonicalWorkspaceSnapshot(value.source) !== canonicalWorkspaceSnapshot(source)
      )
        throw new Error('Registration mismatch');
      return value.conversationId as string;
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException('Core generation registration was not confirmed');
    }
  }
}
