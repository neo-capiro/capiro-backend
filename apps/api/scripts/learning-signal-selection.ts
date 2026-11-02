/** Selection only. The existing service owns flags, tenant access and persistence. */
export type LearningSignalSelection =
  | { mode: 'batch'; tenantId: string | null }
  | { mode: 'signal'; tenantId: string; signalId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLearningSignalSelection(args: string[]): LearningSignalSelection {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      !['--tenant', '--signal'].includes(flag) ||
      values.has(flag) ||
      !value ||
      value.startsWith('--') ||
      value.trim() !== value
    ) {
      throw new Error('Expected unique --tenant <id> and optional --signal <id>.');
    }
    values.set(flag, value);
  }
  const tenantId = values.get('--tenant') ?? null;
  const signalId = values.get('--signal');
  if (signalId !== undefined) {
    if (!tenantId || !UUID.test(tenantId) || !UUID.test(signalId)) {
      throw new Error('--signal requires an explicit UUID --tenant and UUID --signal.');
    }
    return { mode: 'signal', tenantId, signalId };
  }
  return { mode: 'batch', tenantId };
}

interface Outcome {
  eligibility: string;
}
interface GenerationPort {
  generateForSignal(tenantId: string, signalId: string): Promise<Outcome | null>;
  processBatch(tenantId: string, limit: number): Promise<Outcome[]>;
}

export async function runLearningSignalSelection(
  selection: LearningSignalSelection,
  generation: GenerationPort,
  listTenantIds: () => Promise<string[]>,
) {
  const tenantIds = selection.tenantId ? [selection.tenantId] : await listTenantIds();
  let totalProcessed = 0;
  const byEligibility: Record<string, number> = {};
  for (const tenantId of tenantIds) {
    const outcomes =
      selection.mode === 'signal'
        ? [await generation.generateForSignal(tenantId, selection.signalId)]
        : await generation.processBatch(tenantId, 200);
    for (const outcome of outcomes) {
      if (outcome === null) continue;
      totalProcessed += 1;
      byEligibility[outcome.eligibility] = (byEligibility[outcome.eligibility] ?? 0) + 1;
    }
  }
  return { tenants: tenantIds.length, totalProcessed, byEligibility };
}
