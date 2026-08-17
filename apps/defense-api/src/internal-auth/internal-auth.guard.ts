import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  INTERNAL_AUTH_HEADERS,
  sha256Hex,
  verifyInternalRequest,
} from './internal-auth-core.js';
import { INTERNAL_SERVICE_ONLY } from './internal-service.decorator.js';

interface KeyMap {
  readonly [caller: string]: string;
}

function oneHeader(req: Request, name: string): string {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0]?.trim() ?? '';
  return typeof value === 'string' ? value.trim() : '';
}

@Injectable()
export class InternalAuthGuard implements CanActivate {
  private readonly replay = new Map<string, number>();

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(INTERNAL_SERVICE_ONLY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const caller = oneHeader(req, INTERNAL_AUTH_HEADERS.caller);
    const allowlist = new Set(
      (this.config.get<string>('DEFENSE_INTERNAL_SERVICE_ALLOWLIST') ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );
    if (!caller || !allowlist.has(caller)) {
      throw new ForbiddenException('Internal service caller is not allowed');
    }

    const keys = this.readKeys();
    const secret = keys[caller];
    if (!secret) throw new UnauthorizedException('Internal service key is unavailable');

    const timestamp = oneHeader(req, INTERNAL_AUTH_HEADERS.timestamp);
    const nonce = oneHeader(req, INTERNAL_AUTH_HEADERS.nonce);
    const contentSha256 = oneHeader(req, INTERNAL_AUTH_HEADERS.contentSha256);
    const signature = oneHeader(req, INTERNAL_AUTH_HEADERS.signature);
    const body = req.rawBody ?? Buffer.alloc(0);

    if (sha256Hex(body) !== contentSha256.toLowerCase()) {
      throw new UnauthorizedException('Internal request body digest mismatch');
    }

    const result = verifyInternalRequest({
      caller,
      timestamp,
      nonce,
      method: req.method,
      pathWithQuery: req.originalUrl,
      contentSha256,
      signature,
      secret,
      maxSkewSeconds: Number(
        this.config.get<string>('DEFENSE_INTERNAL_AUTH_MAX_SKEW_SECONDS') ?? '60',
      ),
    });
    if (!result.ok) throw new UnauthorizedException(`Internal auth failed: ${result.reason}`);

    this.rejectReplay(caller, timestamp, nonce);
    return true;
  }

  private readKeys(): KeyMap {
    const raw = this.config.get<string>('DEFENSE_INTERNAL_SERVICE_KEYS_JSON') ?? '{}';
    try {
      const parsed = JSON.parse(raw) as KeyMap;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private rejectReplay(caller: string, timestamp: string, nonce: string): void {
    const now = Date.now();
    const ttlMs =
      Number(
        this.config.get<string>('DEFENSE_INTERNAL_AUTH_REPLAY_TTL_SECONDS') ?? '120',
      ) * 1000;

    for (const [key, expiresAt] of this.replay) {
      if (expiresAt <= now) this.replay.delete(key);
    }

    const key = `${caller}|${timestamp}|${nonce}`;
    if (this.replay.has(key)) throw new UnauthorizedException('Internal request replayed');
    if (this.replay.size >= 10_000) this.replay.clear();
    this.replay.set(key, now + ttlMs);
  }
}
