export type SaveTargetKind = 'draft-config' | 'packet-document';

export interface SaveTarget {
  key: string;
  kind: SaveTargetKind;
  label: string;
  persist: () => Promise<unknown>;
}

export interface SaveTargetFailure {
  key: string;
  kind: SaveTargetKind;
  label: string;
  error: unknown;
}

export interface SaveOutcome {
  ok: boolean;
  attempted: string[];
  succeeded: string[];
  failed: SaveTargetFailure[];
}

/**
 * Persist every independent target and report the exact durable result. This
 * helper deliberately never converts a rejected mutation into success.
 */
export async function settleSaveTargets(targets: readonly SaveTarget[]): Promise<SaveOutcome> {
  if (!targets.length) return { ok: true, attempted: [], succeeded: [], failed: [] };
  const settled = await Promise.allSettled(targets.map((target) => target.persist()));
  const succeeded: string[] = [];
  const failed: SaveTargetFailure[] = [];
  settled.forEach((result, index) => {
    const target = targets[index]!;
    if (result.status === 'fulfilled') succeeded.push(target.key);
    else failed.push({ key: target.key, kind: target.kind, label: target.label, error: result.reason });
  });
  return {
    ok: failed.length === 0,
    attempted: targets.map((target) => target.key),
    succeeded,
    failed,
  };
}

export function shouldCreateAutosaveCheckpoint(
  outcome: SaveOutcome,
  hadChanges: boolean,
  lastCheckpointAt: number,
  now: number,
  checkpointIntervalMs: number,
): boolean {
  return (
    hadChanges &&
    outcome.ok &&
    outcome.attempted.length > 0 &&
    now - lastCheckpointAt > checkpointIntervalMs
  );
}

/** Bounded recovery text for the user's clipboard; no network side effect. */
export function serializeUnsavedWorkspace(input: {
  docTitle: string;
  config: unknown;
  packetBodies: Record<string, unknown>;
  failedKeys: readonly string[];
}): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      reason: 'workspace_save_failed',
      failedTargets: [...input.failedKeys],
      docTitle: input.docTitle,
      config: input.config,
      packetBodies: input.packetBodies,
    },
    null,
    2,
  ).slice(0, 2_000_000);
}
