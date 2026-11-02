/** Exact timestamptz(6) transport. Never accept Date objects (precision may already be lost). */
export function exactInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m || m[1]!.startsWith('0000') || +m[2]! > 23 || +m[3]! > 59 || +m[4]! > 59) return null;
  // Date is used ONLY for exact whole-second calendar/offset arithmetic. Fraction never enters it.
  const whole = `${m[1]}T${m[2]}:${m[3]}:${m[4]}`;
  const local = new Date(`${whole}.000Z`);
  if (!Number.isFinite(local.getTime()) || local.toISOString().slice(0, 19) !== whole) return null;
  const zone = m[6]!;
  const hours = zone === 'Z' ? 0 : +zone.slice(1, 3);
  const minutes = zone === 'Z' ? 0 : +zone.slice(4, 6);
  // Supported ISO offsets through +/-14:00; -00:00 denotes an unspecified offset and is rejected.
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0) || zone === '-00:00') return null;
  const offset = (hours * 60 + minutes) * (zone[0] === '-' ? -1 : 1);
  const utc = new Date(local.getTime() - offset * 60_000).toISOString();
  if (!/^\d{4}-/.test(utc) || utc.startsWith('0000')) return null;
  return `${utc.slice(0, 19)}.${(m[5] ?? '').padEnd(6, '0')}Z`;
}

export function requireExactInstant(value: unknown): string {
  const instant = exactInstant(value);
  if (instant === null) throw new Error('lossless explicit-offset microsecond instant required');
  return instant;
}

export function compareInstants(a: unknown, b: unknown): number {
  const left = requireExactInstant(a), right = requireExactInstant(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
