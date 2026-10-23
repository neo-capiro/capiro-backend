import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { isUuid, sha256Hex } from '../../auth/read-delegation/read-delegation.contract.js';
import type { MeriReadDelegationGrant } from '../../auth/read-delegation/read-delegation-request.js';
import { admitPassiveMemoryPage } from './meri-memory-page-admission.js';
import { readPassiveMemorySource, type PassiveMemoryReader } from './meri-passive-memory-source.js';

const denied = () => new ForbiddenException('Passive memory page refused');
const MAX_RESULT_BYTES = 1_048_576; // Meri's existing client-knowledge response ceiling.

export interface TaskBoundPassiveMemoryPage {
  result: unknown;
  /** Correlation only. The separately admitted one-use helper must bind these
   * values and independently recheck the original grant before eligibility. */
  eligibility: Readonly<{
    parentTokenJti: string;
    parentBodySha256: string;
    callKey: string;
    clientId: string | null;
    scopeKind?: 'general';
    argumentsSha256: string;
    requestSha256: string;
    resultSha256: string;
    records: readonly Readonly<{ memoryItemId: string; recordSha256: string }>[];
    hardExpiryMs: number;
  }>;
}

/** Source-only composition for a middleware-consumed, signed page grant. This
 * does not issue a helper credential or mount a route. The eventual controller
 * must supply the real delegated pre-byte release recheck and withhold `result`
 * until an independent one-use eligibility receipt has passed. */
export async function readTaskBoundPassiveMemoryPage(
  ctx: TenantContext,
  raw: unknown,
  grant: MeriReadDelegationGrant | undefined,
  authenticatedCorrelation: unknown,
  tools: PassiveMemoryReader,
  releaseDelegatedRead: () => Promise<void>,
  now: () => number = Date.now,
): Promise<TaskBoundPassiveMemoryPage> {
  if (typeof releaseDelegatedRead !== 'function') throw denied();
  const admitted = admitPassiveMemoryPage(ctx, raw, grant, authenticatedCorrelation, now());
  const ownerResult = await readPassiveMemorySource(ctx, admitted.wire, tools, admitted.scopeKind);

  // Snapshot the exact page that would be sent to Meri. Its existing adapter
  // hashes the complete result and each unmodified record before asking the
  // native owner for current eligibility; no filtering or recounting occurs.
  let encoded: string;
  let result: unknown;
  try {
    encoded = canonicalizeCoreRetainedJson(ownerResult);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_RESULT_BYTES) throw denied();
    result = JSON.parse(encoded) as unknown;
  } catch { throw denied(); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw denied();
  const page = result as Record<string, unknown>;
  let records: Readonly<{ memoryItemId: string; recordSha256: string }>[];
  if (page.error === 'Provide a search query.' && Object.keys(page).length === 1) {
    records = [];
  } else {
    if (page.tool !== 'search_memory' || !Array.isArray(page.records) || page.records.length > 3) throw denied();
    const seen = new Set<string>();
    records = page.records.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw denied();
      const row = entry as Record<string, unknown>;
      if (!isUuid(row.recordId) || seen.has(row.recordId)) throw denied();
      if (admitted.scopeKind === 'general') {
        const payload = row.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            (payload as Record<string, unknown>).clientId !== null) throw denied();
      }
      seen.add(row.recordId);
      return Object.freeze({ memoryItemId: row.recordId, recordSha256: sha256Hex(canonicalizeCoreRetainedJson(entry)) });
    });
    if (admitted.scopeKind === 'general' && (!Array.isArray(page.results) || page.results.some((r: unknown) =>
      !r || typeof r !== 'object' || Array.isArray(r) || (r as Record<string, unknown>).clientId !== null))) throw denied();
  }
  if (now() >= admitted.hardExpiryMs) throw denied();
  await releaseDelegatedRead();
  if (now() >= admitted.hardExpiryMs) throw denied();
  return Object.freeze({ result, eligibility: Object.freeze({
    parentTokenJti: admitted.parentTokenJti, parentBodySha256: admitted.parentBodySha256,
    callKey: admitted.callKey, clientId: admitted.clientId,
    ...(admitted.scopeKind === 'general' ? { scopeKind: 'general' as const } : {}),
    argumentsSha256: admitted.argumentsSha256, requestSha256: admitted.requestSha256,
    resultSha256: sha256Hex(encoded), records: Object.freeze(records), hardExpiryMs: admitted.hardExpiryMs,
  }) });
}
