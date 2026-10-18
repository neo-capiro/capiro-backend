import { ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { MeriToolsService } from '../meri-tools.service.js';
import type { RetainedSourceV02Admission } from './admission.js';
import { projectRetainedClientContext03 } from '../retained-client-context.js';
import { projectIdentityContactsRetainedSourceV02 } from './identity-contacts.js';
import { projectMailRetainedSourceV02, type MailRetainedOperationV02 } from './mail.js';
import {
  projectMeetingSourceV02, type MeetingV02Authority, type MeetingV02Operation,
} from './meetings.js';

const MAX_RETAINED_SOURCE_OUTPUT_BYTES = 16 * 1024 * 1024;
function boundedPage<T>(page: T): T {
  const serialized = JSON.stringify(page);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_RETAINED_SOURCE_OUTPUT_BYTES)
    throw new Error('Retained source output exceeds transport bound');
  return page;
}

/**
 * Release only family producers that obtain current owner facts on this same
 * call and validate the entire pinned result (0.3 for the client profile,
 * 0.2 for the other wired reads). Other families remain closed until
 * their source facts and full output validators are installed. Never fall
 * through to the legacy model-facing dispatcher.
 */
export async function readRetainedSourceV02(
  admission: RetainedSourceV02Admission,
  ctx: TenantContext,
  tools: MeriToolsService,
): Promise<unknown> {
  if (admission.operation.id === 'get_client_context') {
    try {
      const normalization = admission.normalizationContext;
      const resolution = normalization?.clientResolution;
      if (!normalization || Object.keys(normalization).length !== 2 ||
          typeof normalization.asOf !== 'string' ||
          !resolution || typeof resolution !== 'object' || Array.isArray(resolution) ||
          Object.keys(resolution).length !== 2 ||
          typeof (resolution as Record<string, unknown>).selector !== 'string' ||
          typeof (resolution as Record<string, unknown>).clientId !== 'string')
        throw new Error('Profile normalization context unavailable');
      // The result and the measured collection window come from one current
      // canonical owner call. The projector validates the entire 0.3 schema
      // plus Meri's pinned coverage, cursor and identity semantics.
      const owner = await tools.readRetainedClientContextSourceV03(ctx, admission);
      return boundedPage(projectRetainedClientContext03({
        operation: admission.operation,
        source: owner.result,
        readWindow: owner.readWindow,
        gatewayAsOf: normalization.asOf,
        expectedTenantId: admission.binding.tenantId,
        expectedClientId: admission.clientId,
        clientResolution: resolution as { selector: string; clientId: string },
        normalizedInput: admission.input,
      }));
    } catch {
      throw new ServiceUnavailableException({
        code: 'MERI_RETAINED_SOURCE_UNAVAILABLE', operation: admission.operation.id,
      });
    }
  }
  if (admission.operation.id === 'resolve_entity' || admission.operation.id === 'find_contacts') {
    try {
      const ownerRead = await tools.readRetainedIdentityContactsSourceV02(ctx, admission);
      return boundedPage(projectIdentityContactsRetainedSourceV02({ admission, ownerRead }));
    } catch {
      throw new ServiceUnavailableException({
        code: 'MERI_RETAINED_SOURCE_UNAVAILABLE', operation: admission.operation.id,
      });
    }
  }
  if (admission.operation.id === 'mail.list_messages' ||
      admission.operation.id === 'mail.search_messages' ||
      admission.operation.id === 'mail.read_thread') {
    try {
      const owner = await tools.readRetainedMailSourceV02(ctx, admission);
      return boundedPage(projectMailRetainedSourceV02({
        operation: admission.operation.id as MailRetainedOperationV02,
        binding: admission.binding,
        subject: admission.subject,
        selection: admission.input,
        ownerResult: owner.result,
        readAt: owner.readAt,
        requestId: randomUUID(),
        traceId: randomUUID(),
      }));
    } catch {
      throw new ServiceUnavailableException({
        code: 'MERI_RETAINED_SOURCE_UNAVAILABLE', operation: admission.operation.id,
      });
    }
  }
  if (admission.operation.id === 'meeting.list_upcoming_meetings' ||
      admission.operation.id === 'meeting.query_debriefs' ||
      admission.operation.id === 'meeting.read_client_meetings') {
    try {
      const owner = await tools.readRetainedMeetingSourceV02(ctx, admission);
      return boundedPage(projectMeetingSourceV02({
        operation: admission.operation.id as MeetingV02Operation,
        selection: admission.input,
        cursor: owner.cursor,
        authority: {
          requestId: randomUUID(), traceId: randomUUID(),
          binding: admission.binding,
          subject: admission.subject as MeetingV02Authority['subject'],
        },
        read: owner.read,
        result: owner.result,
        nowMs: Date.now(),
      }));
    } catch {
      throw new ServiceUnavailableException({
        code: 'MERI_RETAINED_SOURCE_UNAVAILABLE', operation: admission.operation.id,
      });
    }
  }
  if (admission.operation.id === 'read_monday_client_boards') {
    try {
      return boundedPage(await tools.readRetainedMondaySourceV02(ctx, admission));
    } catch {
      throw new ServiceUnavailableException({
        code: 'MERI_RETAINED_SOURCE_UNAVAILABLE', operation: admission.operation.id,
      });
    }
  }
  throw new ServiceUnavailableException({
    code: 'MERI_RETAINED_SOURCE_UNAVAILABLE',
    operation: admission.operation.id,
  });
}
