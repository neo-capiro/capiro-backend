import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** Whole canonical row plus transaction identity; no timestamp truncation or schema counter. */
export function memoryGovernanceVersionSql(alias: 'mi' | 'o'): Prisma.Sql {
  const row = Prisma.raw(alias);
  return Prisma.sql`('mv1:' || ${row}.xmin::text || ':' || md5(to_jsonb(${row})::text))`;
}

export function requireMemoryGovernanceVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^mv1:[0-9]+:[a-f0-9]{32}$/.test(value) || value.length > 64) {
    throw new BadRequestException(
      'expectedVersion must be the version returned by the current read.',
    );
  }
  return value;
}

/** Call only after locking and authorizing the canonical subject, before any effect or no-op result. */
export function assertMemoryGovernanceVersion(current: string, expected: string): void {
  if (current !== requireMemoryGovernanceVersion(expected)) {
    throw new ConflictException({
      code: 'MEMORY_VERSION_CONFLICT',
      message: 'Memory changed. Refresh before deciding again.',
    });
  }
}
