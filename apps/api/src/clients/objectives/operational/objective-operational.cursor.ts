import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJson, operationalFailure } from './objective-operational.rules.js';
import type { OperationalScope, OperationalSectionName } from './objective-operational.types.js';

interface Cursor {
  v: 1;
  tenant: string;
  actor: string;
  client: string;
  objective: string;
  revision: string;
  set: number;
  section: OperationalSectionName;
  snapshot: string;
  asOf: string;
  limit: number;
  offset: number;
}
/** Process-local integrity key; restarts/other instances reject old cursors with 409.
 * No credential, bearer or resource identity is granted by a cursor. */
export class ObjectiveOperationalCursors {
  private readonly key = randomBytes(32);
  decode(token: string): Cursor {
    try {
      const [payload, signature, ...extra] = token.split('.');
      if (extra.length || !payload || !signature || !/^[A-Za-z0-9_-]+$/.test(payload + signature))
        throw Error();
      const expected = createHmac('sha256', this.key).update(payload).digest();
      const actual = Buffer.from(signature, 'base64url');
      if (
        actual.toString('base64url') !== signature ||
        Buffer.from(payload, 'base64url').toString('base64url') !== payload
      )
        throw Error();
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
      const result = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Cursor;
      if (
        result.v !== 1 ||
        !Number.isSafeInteger(result.offset) ||
        result.offset < 1 ||
        !Number.isSafeInteger(result.limit) ||
        result.limit < 1 ||
        result.limit > 100 ||
        !Number.isSafeInteger(result.set) ||
        result.set < 0 ||
        !Number.isFinite(Date.parse(result.asOf))
      )
        throw Error();
      return result;
    } catch {
      operationalFailure('CURSOR_STALE');
    }
  }
  check(
    token: string,
    tenant: string,
    actor: string,
    scope: OperationalScope,
    set: number,
    section: OperationalSectionName,
    snapshot: string,
    asOf: string,
    limit: number,
  ): number {
    const value = this.decode(token);
    if (
      value.tenant !== tenant ||
      value.actor !== actor ||
      value.client !== scope.clientId ||
      value.objective !== scope.objectiveId ||
      value.revision !== scope.currentRevisionId ||
      value.set !== set ||
      value.section !== section ||
      value.snapshot !== snapshot ||
      value.asOf !== asOf ||
      value.limit !== limit
    ) {
      operationalFailure('CURSOR_STALE');
    }
    return value.offset;
  }
  encode(
    tenant: string,
    actor: string,
    scope: OperationalScope,
    set: number,
    section: OperationalSectionName,
    snapshot: string,
    asOf: string,
    limit: number,
    offset: number,
  ): string {
    const value: Cursor = {
      v: 1,
      tenant,
      actor,
      client: scope.clientId,
      objective: scope.objectiveId,
      revision: scope.currentRevisionId,
      set,
      section,
      snapshot,
      asOf,
      limit,
      offset,
    };
    const payload = Buffer.from(canonicalJson(value), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.key).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }
}
