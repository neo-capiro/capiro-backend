/**
 * Minimal `--key[=value]` flag reader shared by the LegiWatch Live Hearings
 * discovery jobs. Lives in scripts/lib (like hearing-time did) because it is
 * only ever used by the job wrappers, and it is a separate file so five scripts
 * do not each carry their own slightly different parser.
 */

/** Raw value of `--name` / `--name=value`; 'true' for a bare flag. */
export function flag(name: string, argv: string[] = process.argv.slice(2)): string | undefined {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? 'true' : hit.slice(eq + 1);
}

/** True only for an explicitly present flag. */
export function boolFlag(name: string, argv?: string[]): boolean {
  return flag(name, argv) === 'true';
}

/**
 * Non-negative numeric flag. Throws on a malformed value rather than silently
 * falling back — a typo in a cron's `--limit` must fail the run, not quietly
 * change its scope.
 */
export function numFlag(name: string, fallback: number, argv?: string[]): number {
  const raw = flag(name, argv);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
  return n;
}
