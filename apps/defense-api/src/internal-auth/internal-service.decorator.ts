import { SetMetadata } from '@nestjs/common';

export const INTERNAL_SERVICE_ONLY = 'defense.internal-service-only';

export const InternalServiceOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(INTERNAL_SERVICE_ONLY, true);
