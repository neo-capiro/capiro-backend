import { BadRequestException } from '@nestjs/common';
export function workflowInput<T>(read: () => T): T {
  try { return read(); } catch { throw new BadRequestException('Invalid site workflow request'); }
}
