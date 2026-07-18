import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { AppConfig } from '../config/config.schema.js';

/** Constant-time secret compare (avoids the non-constant-time `!==` in the older
 *  InternalServiceGuard). Length mismatch short-circuits without leaking timing. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Closes the raw-endpoint gate-bypass on POST /api/clio/tools/:name.
 *
 * That endpoint executes native tools — INCLUDING write tools (send_email,
 * save_memory, update_client_profile) — with NO compliance gate; the B2/B3/B4
 * approval gate lives in the MeriV2 orchestrator's registry, not here. Its only
 * legitimate caller is the orchestrator (which calls it AFTER its gate, over
 * server-to-server TLS); the browser never calls it. So a valid tenant-user
 * bearer alone could otherwise invoke any write tool directly and bypass the
 * approval workflow. This guard requires the same INTERNAL_SERVICE_SECRET the
 * other /internal/* routes use, sent by the orchestrator IN ADDITION to the
 * forwarded user bearer (the tenant-context middleware still validates the JWT,
 * so @CurrentTenant scoping is unchanged).
 *
 * Two-phase rollout to avoid a coordinated-deploy cliff (breaking every Meri
 * tool call fleet-wide):
 *   - OBSERVE (default, MERI_TOOLS_REQUIRE_SERVICE_SECRET unset/false): a
 *     missing/invalid secret is LOGGED but ALLOWED — lets us confirm every real
 *     caller sends it before enforcing.
 *   - ENFORCE (MERI_TOOLS_REQUIRE_SERVICE_SECRET=true): missing/invalid => 403.
 *
 * Fail-safe: if INTERNAL_SERVICE_SECRET is unset (mis-provisioned env), the guard
 * is a no-op — it never takes Meri's tools offline for a config gap.
 */
@Injectable()
export class ToolServiceSecretGuard implements CanActivate {
  private readonly logger = new Logger(ToolServiceSecretGuard.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get('INTERNAL_SERVICE_SECRET', { infer: true });
    if (!expected) return true; // not configured → cannot enforce; never block.

    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.headers['x-internal-service-secret'];
    if (typeof provided === 'string' && secretsMatch(provided, expected)) return true;

    if (this.config.get('MERI_TOOLS_REQUIRE_SERVICE_SECRET', { infer: true })) {
      throw new ForbiddenException('Tool execution requires an internal service identity');
    }
    // Observe phase: surface who is calling without the secret, then allow.
    this.logger.warn(
      `[tool-service-secret] observe: /api/clio/tools/${
        (req.params as { name?: string })?.name ?? '?'
      } called WITHOUT a valid internal service secret ` +
        `(allowed while MERI_TOOLS_REQUIRE_SERVICE_SECRET is off)`,
    );
    return true;
  }
}
