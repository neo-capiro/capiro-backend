import { Controller, Header, Inject, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import type { ObjectiveAdmissionHttpRequest } from './objective-workload-admission-ingress.js';
import type { createObjectiveAdmissionRuntime } from './objective-workload-admission-runtime.js';

export const OBJECTIVE_ADMISSION_RUNTIME = Symbol('OBJECTIVE_ADMISSION_RUNTIME');
type Runtime = ReturnType<typeof createObjectiveAdmissionRuntime>;

/** The HTTP boundary never recreates a signed entity from parsed request.body.
 * Bootstrap does not capture this route's rawBody yet; absence stays closed.
 * An eventual raw-body parser allocation is separate from activation/authority.
 */
export function objectiveAdmissionHttpRequest(request: Request): ObjectiveAdmissionHttpRequest {
  const unavailable = (): never => { throw new ServiceUnavailableException('Objective workload admission unavailable'); };
  if (!Array.isArray(request.rawHeaders) || request.rawHeaders.length % 2 !== 0) return unavailable();
  const authorization: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index], value = request.rawHeaders[index + 1];
    if (typeof name !== 'string' || typeof value !== 'string') return unavailable();
    if (name.toLowerCase() === 'authorization') authorization.push(value);
  }
  // Node may normalize/discard repeated Authorization fields. Inspect the
  // transport's original header list before trusting the normalized value.
  if (authorization.length !== 1 || authorization[0] !== request.headers.authorization) return unavailable();
  const entity = Object.getOwnPropertyDescriptor(request, 'rawBody');
  if (!entity || !('value' in entity) || !Buffer.isBuffer(entity.value)) return unavailable();
  return { method: request.method, originalUrl: request.originalUrl,
    authorization: authorization[0], rawBody: entity.value };
}

@Controller('internal/objective-workload-authority')
export class ObjectiveWorkloadAdmissionController {
  constructor(@Inject(OBJECTIVE_ADMISSION_RUNTIME) private readonly issue: Runtime) {}

  @Post('decisions')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  async decide(@Req() request: Request) {
    try { return await this.issue(objectiveAdmissionHttpRequest(request)); }
    catch { throw new ServiceUnavailableException('Objective workload admission unavailable'); }
  }
}
