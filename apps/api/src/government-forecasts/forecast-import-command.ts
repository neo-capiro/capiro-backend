import { createHash } from 'node:crypto';
import { parseUnifiedAgenda } from './unified-agenda.js';

export const FORECAST_IMPORT_USAGE = `Unified Agenda publisher-window import
Usage: tsx scripts/sync-government-forecasts.ts --input <xml> --edition <YYYYMM>
  --sha256 <exact snapshot hash> --observed-at <UTC timestamp> [--apply]
Default: parse/validate locally and report counts; no database connection.
--apply: archive source and atomically append revisions/observations in the configured DATABASE_URL.
Reconcile an unknown outcome using the same hash and original observed-at; never invent a new observation.
--record-failure --observed-at <UTC timestamp> --apply: record a definite source-check failure only.
Exit 0: success/help; exit 1: failure. No scheduler, network fetch or confirmed calendar event is created.`;

export function parseImportArgs(args: string[], now: Date) {
  if (args.length === 1 && args[0] === '--help') return { help: true } as const;
  const values = new Map<string, string>();
  let apply = false,
    failure = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply' && !apply) {
      apply = true;
      continue;
    }
    if (arg === '--record-failure' && !failure) {
      failure = true;
      continue;
    }
    const value = args[i + 1];
    if (
      arg === undefined ||
      !['--input', '--edition', '--sha256', '--observed-at'].includes(arg) ||
      values.has(arg) ||
      !value ||
      value.startsWith('--')
    )
      throw new Error('Invalid import arguments');
    values.set(arg, value);
    i++;
  }
  const observed = values.get('--observed-at') ?? '';
  const observedAt = new Date(observed);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(observed) ||
    !Number.isFinite(observedAt.getTime()) ||
    observedAt.getTime() > now.getTime() ||
    observedAt.toISOString() !==
      (observed.length === 20 ? observed.replace('Z', '.000Z') : observed)
  )
    throw new Error('Provide the actual UTC source observation time');
  if (failure) {
    if (!apply || values.size !== 1)
      throw new Error('Failure mode accepts only observation time and --apply');
    return { help: false, failure: true, apply: true, observedAt } as const;
  }
  const input = values.get('--input'),
    edition = values.get('--edition'),
    sha256 = values.get('--sha256');
  if (!input || !edition || !/^\d{6}$/.test(edition) || !sha256 || !/^[a-f0-9]{64}$/.test(sha256))
    throw new Error('Input, exact edition and SHA256 are required');
  return { help: false, failure: false, apply, input, edition, sha256, observedAt } as const;
}

export function qualifyImport(xml: string, input: { edition: string; sha256: string }) {
  if (createHash('sha256').update(xml).digest('hex') !== input.sha256)
    throw new Error('Source hash mismatch');
  const snapshot = parseUnifiedAgenda(xml, { edition: input.edition });
  if (
    snapshot.rejected.some((x) => x.reason === 'edition_mismatch') ||
    (!snapshot.candidates.length &&
      !snapshot.withdrawnRins.length &&
      !snapshot.completedMilestones.length &&
      snapshot.rejected.length)
  )
    throw new Error('Source snapshot is unqualified');
  return snapshot;
}
