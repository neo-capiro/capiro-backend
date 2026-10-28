import { Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import { ApplicationCurrentService } from '../auth/application-current.service.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import { resolveCurrentServedProcedure } from './meri-procedure-runtime.js';
import {
  resolveSelectedProcedureAdmission,
  type MeriSelectedProcedureAdmission,
  type MeriSelectedProcedureSelector,
} from './native-procedures/selected-procedure.js';
import type { MeriProcedureScope } from './skills/skill.types.js';

export interface ValidateMeriProcedureRuntimeInput {
  conversationId: string;
  clientId: string | null;
  scope: MeriProcedureScope;
  recordId: string;
  canonicalId: string;
  procedureVersion: number;
  manifestDigest: string;
  toolName: string;
}

export interface MeriProcedureRuntimeDecision {
  authorized: true;
  identity: {
    source: 'firm';
    recordId: string;
    canonicalId: string;
    version: number;
  };
  manifestDigest: string;
}

/**
 * Native selected-procedure crossing input (Wave5 MO01/ST16). The browser only
 * ever sends a selection; conversation/client identity comes from the
 * authenticated request, never from the selector.
 */
export interface AdmitMeriSelectedProcedureInput {
  conversationId: string;
  clientId: string | null;
  scope: MeriProcedureScope;
  /**
   * When present, the admission must grant that exact prepared tool. When
   * absent the admission certifies the whole granted set for a procedure-level
   * (activity) crossing, which is what a conversation run needs: it prepares no
   * single tool. The caller's own native tool policy still decides releases.
   */
  toolName?: string;
  selector: MeriSelectedProcedureSelector;
}

function unavailable(): never {
  throw new NotFoundException('Current procedure execution authority is unavailable');
}

/**
 * Revalidates one prepared procedure/tool invocation against the canonical,
 * uncached firm-skill owner and the authenticated conversation owner. This
 * endpoint can only reject or confirm the exact prepared identity; it returns
 * no instructions, evidence, credentials, or additional tool authority.
 */
@Injectable()
export class MeriProcedureRuntimeValidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly firmSkills: MeriFirmSkillsService,
    private readonly applicationCurrent: ApplicationCurrentService,
  ) {}

  async validate(
    ctx: TenantContext,
    input: ValidateMeriProcedureRuntimeInput,
  ): Promise<MeriProcedureRuntimeDecision> {
    const conversation = await this.currentOwnedConversation(ctx, input);
    if (!conversation) unavailable();

    let current;
    try {
      current = await resolveCurrentServedProcedure({
        tenantId: ctx.tenantId,
        clientId: conversation.clientId,
        reference: {
          source: 'firm',
          recordId: input.recordId,
          canonicalId: input.canonicalId,
          version: input.procedureVersion,
        },
        firmSkills: this.firmSkills,
      });
    } catch {
      unavailable();
    }

    const binding = current.binding;
    if (
      binding.identity.recordId !== input.recordId ||
      binding.identity.canonicalId !== input.canonicalId ||
      binding.identity.version !== input.procedureVersion ||
      binding.manifestDigest !== input.manifestDigest ||
      binding.scope !== input.scope ||
      binding.clientId !== input.clientId ||
      !binding.policy.allowedTools.includes(input.toolName)
    ) {
      unavailable();
    }

    // The canonical resolver is asynchronous and does not own conversation or
    // ethical-wall state. Re-read that owner immediately before a positive
    // decision so authority cannot be based only on its pre-resolver value.
    // A mutation after this final read remains the unavoidable response/use
    // window; this check deliberately does not retry or widen authority.
    if (!(await this.currentOwnedConversation(ctx, input))) unavailable();

    return {
      authorized: true,
      identity: { ...binding.identity },
      manifestDigest: binding.manifestDigest,
    };
  }

  /**
   * Native selected-procedure crossing for Wave5 MO01/ST16.
   *
   * Resolves one exact selected procedure — an exact tenant firm row or one of
   * the six canonical builtins — through the native resolver leaf and binds it
   * to the real current conversation/client authority, not to the selector.
   *
   * The current authority owner is traced BOTH before and after the
   * asynchronous canonical resolution: identity, membership and context
   * revisions must be identical on both sides, the prepared tool must be inside
   * the resolved read surface, and the conversation/wall owner is re-read at the
   * end. Any drift is a refusal. No instructions, tools or authority are minted
   * here, and there is no legacy clioConversation/meriv3 fallthrough.
   */
  async admitSelectedProcedure(
    ctx: TenantContext,
    req: Request,
    input: AdmitMeriSelectedProcedureInput,
  ): Promise<MeriSelectedProcedureAdmission> {
    const current = {
      conversationId: input.conversationId,
      clientId: input.clientId,
    };

    // 1. Trace the current identity path before resolution.
    const pre = await this.applicationCurrent.read(ctx, req, current);

    // 2. The conversation ownership + ethical-wall owner is still canonical.
    if (!(await this.currentOwnedConversation(ctx, input))) unavailable();

    // 3. Resolve the exact selector against the canonical owner and re-verify
    //    version + digest after that asynchronous read.
    let admission: MeriSelectedProcedureAdmission;
    try {
      admission = await resolveSelectedProcedureAdmission({
        ctx,
        clientId: input.clientId,
        selector: input.selector,
        firmSkills: this.firmSkills,
        now: Date.now(),
      });
    } catch {
      unavailable();
    }

    // 4. The prepared invocation must match the resolved identity exactly.
    if (
      admission.scope !== input.scope ||
      admission.clientId !== input.clientId ||
      (input.toolName !== undefined && !admission.policy.allowedTools.includes(input.toolName))
    ) {
      unavailable();
    }

    // 5. Re-trace the same identity path after resolution. A revision drift
    //    invalidates admission even though the canonical binding matched.
    const post = await this.applicationCurrent.read(ctx, req, current);
    if (
      pre.identityRevision !== post.identityRevision ||
      pre.membershipRevision !== post.membershipRevision ||
      pre.contextRevision !== post.contextRevision
    ) {
      unavailable();
    }

    // 6. Final conversation/wall re-read after every asynchronous read above.
    if (!(await this.currentOwnedConversation(ctx, input))) unavailable();

    return admission;
  }

  private currentOwnedConversation(
    ctx: TenantContext,
    input: Pick<ValidateMeriProcedureRuntimeInput, 'conversationId' | 'clientId'>,
  ): Promise<{ id: string; clientId: string | null } | null> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const owned = await tx.clioConversation.findFirst({
        where: {
          id: input.conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          archivedAt: null,
        },
        select: { id: true, clientId: true },
      });
      if (!owned || owned.clientId !== input.clientId) return null;
      if (
        owned.clientId &&
        !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, owned.clientId))
      ) {
        return null;
      }
      return owned;
    });
  }
}
