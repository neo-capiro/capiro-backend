import { BadRequestException } from '@nestjs/common';
export type ProfileCapabilityLifecycle =
  | 'in_service'
  | 'in_development'
  | 'planned'
  | 'unspecified';
export function profileCapabilityLifecycle(value: unknown): ProfileCapabilityLifecycle | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  switch (value) {
    case 'in_service':
      return 'in_service';
    case 'in_development':
      return 'in_development';
    case 'planned':
      return 'planned';
    case 'unspecified':
      return 'unspecified';
    default:
      throw new BadRequestException('Invalid capability lifecycle');
  }
}
