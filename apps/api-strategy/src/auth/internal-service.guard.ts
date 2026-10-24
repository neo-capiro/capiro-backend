import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { internalServiceSecretMatches } from '@capiro/shared';
const verified = new WeakSet<object>();
export const hasInternalServiceIdentity = (request: object): boolean => verified.has(request);
import type { Request } from 'express';

/** Same backend service boundary as Core. The saved job owns actor/client authority. */
@Injectable()
export class InternalServiceGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!internalServiceSecretMatches(request.headers['x-internal-service-secret'],
      this.config.get<string>('INTERNAL_SERVICE_SECRET'))) {
      throw new ForbiddenException('Invalid or missing internal service secret');
    }
    verified.add(request);
    return true;
  }
}
