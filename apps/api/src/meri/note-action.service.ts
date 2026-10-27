import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { z } from 'zod';
import { ApplicationCurrentService } from '../auth/application-current.service.js';
import { EngagementService } from '../engagement/engagement.service.js';
import { MeriActionProposalService } from './meri-action-proposal.service.js';
import { retainedReadSnapshot, readRetainedReadDeadline } from './retained-read-context.js';
import { assertMeriToolRequestActive } from './meri-tool-request-control.js';
import { hasVerifiedToolServiceIdentity } from './tool-service-secret.guard.js';
import { assertMeriToolAllowed } from './meri-tool-allowlist.js';
import {
  NOTE_ACTION,
  NOTE_ACTION_MAX_BYTES,
  notePrepareContextSchema,
  noteRequest,
  noteRequestSchema,
  noteScopeSchema,
  noteSelectionSchema,
  type NoteActionAccess,
} from './note-action.contract.js';

const prepare = z
  .object({
    version: z.literal(1),
    context: notePrepareContextSchema,
    request: noteRequestSchema,
  })
  .strict();
const observe = z
  .object({
    version: z.literal(1),
    proposalId: z.string().uuid(),
    context: noteScopeSchema,
  })
  .strict();
const denied = () => new ForbiddenException('Note action access unavailable');

@Injectable()
export class NoteActionService {
  constructor(
    private readonly current: ApplicationCurrentService,
    private readonly proposals: MeriActionProposalService,
    private readonly engagement: EngagementService,
  ) {}

  private async access(
    ctx: TenantContext,
    req: Request,
    context: z.infer<typeof noteSelectionSchema> & Partial<z.infer<typeof noteScopeSchema>>,
    mode: NoteActionAccess['mode'],
  ): Promise<NoteActionAccess> {
    if (
      !hasVerifiedToolServiceIdentity(req) ||
      req.headers['x-capiro-impersonate-tenant'] !== undefined
    )
      throw denied();
    const deadline = readRetainedReadDeadline(req);
    const check = () => {
      assertMeriToolRequestActive();
      if (Date.now() >= deadline) throw denied();
    };
    const selection = {
      conversationId: context.conversationId,
      clientId: context.selectedClientId,
    };
    const expected =
      context.identityRevision === undefined
        ? undefined
        : {
            identityRevision: context.identityRevision,
            membershipRevision: context.membershipRevision!,
            contextRevision: context.contextRevision!,
          };
    check();
    const first = await this.current.read(ctx, req, {
      ...selection,
      ...(expected && mode === 'execute' ? { expect: expected } : {}),
    });
    if (
      expected &&
      (first.identityRevision !== expected.identityRevision ||
        first.contextRevision !== expected.contextRevision ||
        (mode === 'execute' && first.membershipRevision !== expected.membershipRevision))
    )
      throw denied();
    check();
    const scope = {
      ...context,
      identityRevision: first.identityRevision,
      membershipRevision: first.membershipRevision,
      contextRevision: first.contextRevision,
    };
    const current = this.current;
    return {
      scope,
      mode,
      clientIds: first.clientIds,
      async assertCurrent() {
        check();
        await current.read(ctx, req, {
          ...selection,
          expect: {
            identityRevision: scope.identityRevision,
            membershipRevision: scope.membershipRevision,
            contextRevision: scope.contextRevision,
          },
        });
        check();
      },
    };
  }

  /**
   * A requested meeting is resolved through the canonical EngagementService owner
   * (ownership + current client visibility) BEFORE anything is written, and the
   * meeting's actual client must fit the caller's current context. The canonical
   * client is then bound into the stored request, so the ledger, the receipt and
   * any later read all refer to the same client the owner will write against.
   * Read-only: the meeting owner already asserts the client is currently visible,
   * so this adds no authority.
   */
  private async bindMeetingClient(
    ctx: TenantContext,
    access: NoteActionAccess,
    request: { meetingId?: string; clientId?: string },
  ) {
    const meetingId = request.meetingId!;
    const meeting = (await this.engagement.getMeeting(ctx, meetingId)) as
      | { id?: string; clientId?: string | null }
      | null;
    const clientId = typeof meeting?.clientId === 'string' ? meeting.clientId : null;
    if (!meeting || meeting.id !== meetingId || !clientId) throw denied();
    if (access.scope.selectedClientId !== null && access.scope.selectedClientId !== clientId)
      throw denied();
    if (request.clientId !== undefined && request.clientId !== clientId) throw denied();
    if (!access.clientIds.includes(clientId)) throw denied();
    return clientId;
  }

  async prepare(ctx: TenantContext, req: Request, raw: unknown) {
    const parsed = prepare.safeParse(retainedReadSnapshot(raw, NOTE_ACTION_MAX_BYTES));
    if (!parsed.success) throw new BadRequestException('Invalid note request');
    const request = noteRequest(NOTE_ACTION, parsed.data.request);
    assertMeriToolAllowed(NOTE_ACTION);
    const access = await this.access(ctx, req, parsed.data.context, 'execute');
    const clientId = request.meetingId
      ? await this.bindMeetingClient(ctx, access, request)
      : request.clientId;
    const result = await this.proposals.create(ctx, {
      tool: NOTE_ACTION,
      input: {
        body: request.body,
        ...(request.title ? { title: request.title } : {}),
        ...(clientId ? { clientId } : {}),
        ...(request.meetingId ? { meetingId: request.meetingId } : {}),
        ...(request.confidential !== undefined ? { confidential: request.confidential } : {}),
        ...(request.accessLevel ? { accessLevel: request.accessLevel } : {}),
        // The current attended conversation is supplied by this owner, never by the caller.
        conversationId: parsed.data.context.conversationId,
      },
      conversationId: parsed.data.context.conversationId,
      surface: 'chat',
      // save_note is a static PASS (`internal_artifacts.pass`): it executes once,
      // directly, in the ordinary proposal owner. It is never an approval card.
      requireApproval: false,
    },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      access,
    );
    if (
      result.disposition !== 'executed' &&
      result.disposition !== 'failed' &&
      result.disposition !== 'blocked' &&
      result.disposition !== 'pending_approval'
    )
      throw denied();
    // The receipt is released through a fresh observation read. A save can itself
    // advance the current revisions (a client document/note is an effect), so the
    // release re-derives the caller's current identity, conversation and context
    // binding and withholds the receipt when that authority is gone. Fresh read
    // revisions can never be fed back into the write above.
    const released = await this.access(ctx, req, parsed.data.context, 'observe');
    return this.proposals.readNote(ctx, result.proposal.proposalId, released);
  }

  async read(ctx: TenantContext, req: Request, raw: unknown) {
    const parsed = observe.safeParse(retainedReadSnapshot(raw, 8192));
    if (!parsed.success) throw new BadRequestException('Invalid note observation');
    const { context, proposalId } = parsed.data;
    const access = await this.access(ctx, req, context, 'observe');
    const result = await this.proposals.readNote(ctx, proposalId, access);
    await access.assertCurrent();
    return result;
  }
}
