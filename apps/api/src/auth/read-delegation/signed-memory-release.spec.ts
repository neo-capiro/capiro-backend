import { describe, expect, it, jest } from '@jest/globals';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { assertSignedMemoryReservationAtRelease } from './read-delegation-request.js';

const runId = '55555555-5555-4555-8555-555555555555';
const callKey = 'call_1';
const argumentsSha256 = 'a'.repeat(64);
const memoryOperations = [
  { id: 'search_memory', version: '0.2.0' },
  { id: 'memory.list_own_proposals', version: '0.2.0' },
] as const;

function grant(operation: { id: string; version: string } | null = memoryOperations[0]) {
  return { kind: 'tool' as const, operation, runId, callKey, argumentsSha256 };
}

function reservation(operation: { id: string; version: string } = memoryOperations[0]) {
  return { invocation_id: callKey, run_id: runId, operation,
    arguments_sha256: argumentsSha256, state: 'UNKNOWN' };
}

function rows(value: unknown[]) {
  const query = jest.fn(async () => value);
  return { tx: { $queryRaw: query } as never, query };
}

describe('signed memory release rereads the original UNKNOWN reservation', () => {
  for (const operation of memoryOperations) {
    it(`accepts the exact ${operation.id}@${operation.version} reservation`, async () => {
      const { tx, query } = rows([reservation(operation)]);
      await expect(assertSignedMemoryReservationAtRelease(tx, grant(operation))).resolves.toBeUndefined();
      expect(query).toHaveBeenCalledTimes(1);
    });

    it(`refuses missing or changed ${operation.id} reservation facts`, async () => {
      const expected = reservation(operation);
      const changed = [
        [],
        [{ ...expected, invocation_id: 'other_call' }],
        [{ ...expected, run_id: '66666666-6666-4666-8666-666666666666' }],
        [{ ...expected, operation: { id: 'search_program_elements', version: '0.2.0' } }],
        [{ ...expected, operation: { id: operation.id, version: '0.1.0' } }],
        [{ ...expected, arguments_sha256: 'b'.repeat(64) }],
        [{ ...expected, state: 'COMPLETED' }],
        [expected, expected],
      ];
      for (const candidate of changed) {
        const { tx, query } = rows(candidate);
        await expect(assertSignedMemoryReservationAtRelease(tx, grant(operation)))
          .rejects.toBeInstanceOf(ForbiddenException);
        expect(query).toHaveBeenCalledTimes(1);
      }
    });
  }

  it('refuses non-tool and missing or malformed argument hash before querying', async () => {
    const invalid = [
      { ...grant(), kind: 'mode' as const },
      { ...grant(), argumentsSha256: null },
      { ...grant(), argumentsSha256: 'not-a-sha' },
    ];
    for (const candidate of invalid) {
      const { tx, query } = rows([reservation()]);
      await expect(assertSignedMemoryReservationAtRelease(tx, candidate))
        .rejects.toBeInstanceOf(ConflictException);
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('leaves unrelated read operations on their prior release path', async () => {
    const unrelated = [
      grant({ id: 'search_program_elements', version: '0.2.0' }),
      { ...grant({ id: 'read_client_documents', version: '0.2.0' }), argumentsSha256: null },
      { ...grant(null), kind: 'reference' as const, argumentsSha256: null },
    ];
    for (const candidate of unrelated) {
      const { tx, query } = rows([]);
      await expect(assertSignedMemoryReservationAtRelease(tx, candidate)).resolves.toBeUndefined();
      expect(query).not.toHaveBeenCalled();
    }
  });
});
