import type { BoardCursor } from './tracker-board.contracts.js';
export const b64encode = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

/** Mirrors feed.service.ts's b64decode: a malformed or stale cursor is ignored (page 1), never thrown. */
export const b64decode = (cur: string): BoardCursor | null => {
  try {
    const parsed = JSON.parse(Buffer.from(cur, 'base64url').toString('utf8')) as unknown;
    return parsed &&
      typeof (parsed as BoardCursor).t === 'string' &&
      typeof (parsed as BoardCursor).id === 'string' &&
      ((parsed as BoardCursor).c === undefined || typeof (parsed as BoardCursor).c === 'string')
      ? (parsed as BoardCursor)
      : null;
  } catch {
    return null;
  }
};
export function encodeBoardCursor(row: { trackedAt: Date; billId: string }): string {
  return b64encode({ t: row.trackedAt.toISOString(), id: row.billId } satisfies BoardCursor);
}

export function encodeTenantBoardCursor(row: {
  trackedAt: Date;
  billId: string;
  clientId: string;
}): string {
  return b64encode({
    t: row.trackedAt.toISOString(),
    id: row.billId,
    c: row.clientId,
  } satisfies BoardCursor);
}
