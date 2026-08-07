import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ENGAGEMENT_RUNTIME_ACTION_KEY,
  type EngagementRuntimeActionMetadata,
} from './engagement-runtime-action.decorator.js';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';
import {
  runtimePolicyForHandler,
  sameRuntimeMetadata,
} from './engagement-runtime-route-policy.js';

export const ENGAGEMENT_DENIAL_BOUNDARY_HEADER = 'X-Capiro-Engagement-Denial-Boundary';
export const ENGAGEMENT_DENIAL_BOUNDARY_ROUTE_GUARD = 'route-guard';

interface HttpRequestLike {
  body?: unknown;
}

interface HttpResponseLike {
  setHeader?: (name: string, value: string) => void;
}

function recordRouteGuardDenial(context: ExecutionContext): void {
  const response = context.switchToHttp().getResponse<HttpResponseLike>();
  response?.setHeader?.(
    ENGAGEMENT_DENIAL_BOUNDARY_HEADER,
    ENGAGEMENT_DENIAL_BOUNDARY_ROUTE_GUARD,
  );
}

/**
 * `POST .../draft-artifacts/:artifactId/versions` is a dual-mode route:
 * manual/revert append a local immutable version; Improve is an AI generation.
 * Missing or malformed `editKind` fails closed as generation.
 */
export function conditionalRouteMetadata(
  controllerName: string,
  handlerName: string,
  body: unknown,
): EngagementRuntimeActionMetadata | undefined {
  if (controllerName !== 'EngagementController' || handlerName !== 'createDraftVersion') {
    return undefined;
  }
  const editKind =
    body && typeof body === 'object' && 'editKind' in body
      ? (body as { editKind?: unknown }).editKind
      : undefined;
  if (editKind === 'manual' || editKind === 'revert') return undefined;
  return { action: 'outreach_generate', requiresCallbacks: false, testMode: false };
}

/** Global only in EngagementApiAppModule; AppModule behavior is unchanged. */
@Injectable()
export class EngagementRuntimeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly policy: EngagementRuntimePolicyService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const controllerName = context.getClass().name;
    const handlerName = handler.name;

    const decorated = this.reflector.get<EngagementRuntimeActionMetadata>(
      ENGAGEMENT_RUNTIME_ACTION_KEY,
      handler,
    );
    const registered = runtimePolicyForHandler(controllerName, handlerName);

    if (decorated && registered && !sameRuntimeMetadata(decorated, registered)) {
      recordRouteGuardDenial(context);
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'ENGAGEMENT_RUNTIME_POLICY_MISMATCH',
        action: registered.action,
        message: 'The engagement-api route policy is inconsistent and has been disabled.',
      });
    }

    const request = context.switchToHttp().getRequest<HttpRequestLike>();
    const conditional = conditionalRouteMetadata(controllerName, handlerName, request?.body);
    const isLocalDraftEdit =
      controllerName === 'EngagementController' &&
      handlerName === 'createDraftVersion' &&
      conditional === undefined;
    if (isLocalDraftEdit) return true;

    const metadata = registered ?? decorated ?? conditional;
    if (!metadata) return true;

    // Stamp an independently verifiable boundary marker before throwing. The
    // Phase 2 live harness uses this to prove the controller/service/provider
    // was never entered, rather than inferring that from a 503 alone.
    if (
      !this.policy.externalActionAllowed(metadata.action, {
        testMode: metadata.testMode,
      })
    ) {
      recordRouteGuardDenial(context);
    }

    // Preserve the stable shadow error contract. When both controls are off,
    // external-action denial wins; callback denial remains effective in a
    // future active runtime with callbacks independently disabled.
    this.policy.assertExternalAction(metadata.action, {
      testMode: metadata.testMode,
    });
    if (metadata.requiresCallbacks) {
      if (!this.policy.snapshot().callbacksEnabled) recordRouteGuardDenial(context);
      this.policy.assertCallbacksEnabled(metadata.action);
    }

    return true;
  }
}
