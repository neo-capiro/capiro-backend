import {
  clientId,
  findingInput,
  harness,
  runId,
  sqlText,
  taskLease,
  tenantId,
} from '../../test/fixtures/client-profile-fill-completion-persistence.js';

const contentHash = '2f72b4ff597f99cb05d571ebcf10ce2b6c197b494d5253c06d052b9814d099f5';

it('locks the optional running lease before checking terminal identity or writing a finding', async () => {
  const h = harness();
  expect(await h.add(findingInput(), taskLease)).toBe(true);
  expect(h.phases).toEqual(['begin', 'lease', 'terminal', 'retire', 'insert', 'commit']);
  expect(h.prisma.withTenant).toHaveBeenCalledTimes(1);
  expect(h.callsOf('lease')[0]!.args).toEqual([
    taskLease.id,
    tenantId,
    clientId,
    runId,
    taskLease.workerId,
  ]);
  expect(sqlText(h.callsOf('lease')[0]!.sql)).toBe(
    sqlText(`SELECT id FROM client_profile_fill_extension_task
    WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
      AND run_id = $4::uuid AND status = 'running' AND worker_id = $5 FOR UPDATE`),
  );
  expect(new Set(h.calls.map((call) => call.transaction))).toEqual(new Set([1]));
});

it('returns false for a lost lease without checking terminal state or retiring/inserting findings', async () => {
  const h = harness({ leaseRows: [] });
  expect(await h.add(findingInput(), taskLease)).toBe(false);
  expect(h.phases).toEqual(['begin', 'lease', 'commit']);
  expect(h.callsOf('terminal')).toEqual([]);
  expect(h.callsOf('retire')).toEqual([]);
  expect(h.callsOf('insert')).toEqual([]);
});

it('retains null worker identity in the optional lease binding without inventing a fallback lease', async () => {
  const h = harness({ leaseRows: [] });
  expect(await h.add(findingInput(), { ...taskLease, workerId: null })).toBe(false);
  expect(h.callsOf('lease')[0]!.args[4]).toBeNull();
});

it.each([{ reviewedStatus: 'accepted' }, { reviewedStatus: 'rejected' }])(
  'preserves a terminal $reviewedStatus identity before retiring older pending findings',
  async ({ reviewedStatus }) => {
    const h = harness({ terminalRows: [{ id: reviewedStatus }] });
    expect(await h.add(findingInput(), taskLease)).toBe(false);
    expect(h.phases).toEqual(['begin', 'lease', 'terminal', 'commit']);
    expect(h.callsOf('terminal')[0]!.args).toEqual([tenantId, clientId, contentHash]);
    expect(h.callsOf('retire')).toEqual([]);
    expect(h.callsOf('insert')).toEqual([]);
  },
);

it('hashes before entering the transaction, including when the task lease has already been lost', async () => {
  const events: string[] = [];
  const input = findingInput();
  const proposal = input.proposedValue;
  Object.defineProperty(input, 'proposedValue', {
    get: () => {
      events.push('hash-read');
      return proposal;
    },
  });
  const h = harness({ leaseRows: [], onBegin: () => events.push('transaction-open') });
  expect(await h.add(input, taskLease)).toBe(false);
  expect(events).toEqual(['hash-read', 'transaction-open']);
});

it('preserves late payload reads after pending retirement while retaining the pretransaction content hash', async () => {
  const input = findingInput();
  const h = harness({
    onRetire: () => {
      input.proposedValue = { changedAfterRetirement: true };
      input.currentValue = false;
    },
  });
  expect(await h.add(input)).toBe(true);
  expect(h.callsOf('insert')[0]!.args[12]).toBe(contentHash);
  expect(h.callsOf('insert')[0]!.args[8]).toBe('{"changedAfterRetirement":true}');
  expect(h.callsOf('insert')[0]!.args[7]).toBe('false');
});

it('rejects a circular proposed value before opening even a lost-lease transaction', async () => {
  const proposedValue: Record<string, unknown> = {};
  proposedValue.self = proposedValue;
  const h = harness({ leaseRows: [] });
  await expect(h.add(findingInput({ proposedValue }), taskLease)).rejects.toThrow();
  expect(h.prisma.withTenant).not.toHaveBeenCalled();
  expect(h.phases).toEqual([]);
});

it('rejects a circular evidence payload after retirement inside the same rolled-back transaction', async () => {
  const evidence: unknown[] = [];
  evidence.push(evidence);
  const h = harness();
  await expect(h.add(findingInput({ evidence }))).rejects.toThrow();
  expect(h.phases).toEqual(['begin', 'terminal', 'retire', 'rollback']);
  expect(h.callsOf('insert')).toEqual([]);
  expect(h.transactions[0]!.status).toBe('rollback');
});

it.each([
  { operation: 'lease' },
  { operation: 'terminal' },
  { operation: 'retire' },
  { operation: 'insert' },
])(
  'propagates $operation errors without nesting or committing the finding transaction',
  async ({ operation }) => {
    const error = new Error(`${operation} unavailable`);
    const h = harness({ errorOperation: operation, error });
    await expect(h.add(findingInput(), taskLease)).rejects.toBe(error);
    expect(h.prisma.withTenant).toHaveBeenCalledTimes(1);
    expect(h.transactions[0]!.status).toBe('rollback');
    expect(h.phases.at(-1)).toBe('rollback');
    expect(new Set(h.calls.map((call) => call.transaction))).toEqual(new Set([1]));
  },
);

it.each([{ operation: 'mapping' }, { operation: 'cursor-read' }, { operation: 'cursor-write' }])(
  'propagates $operation errors in the same tenant transaction',
  async ({ operation }) => {
    const error = new Error(`${operation} unavailable`);
    const h = harness({ errorOperation: operation, error });
    const work =
      operation === 'mapping'
        ? h.mapping()
        : operation === 'cursor-read'
          ? h.readCursor()
          : h.writeCursor({ value: 1 });
    await expect(work).rejects.toBe(error);
    expect(h.transactions[0]!.status).toBe('rollback');
    expect(h.phases).toEqual(['begin', operation, 'rollback']);
  },
);

it('serializes cursor watermarks inside the transaction and rolls back circular inputs before any SQL write', async () => {
  const watermark: Record<string, unknown> = {};
  watermark.self = watermark;
  const h = harness();
  await expect(h.writeCursor(watermark)).rejects.toThrow();
  expect(h.prisma.withTenant).toHaveBeenCalledTimes(1);
  expect(h.phases).toEqual(['begin', 'rollback']);
  expect(h.calls).toEqual([]);
});
