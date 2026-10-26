import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { isUuid } from '../../auth/read-delegation/read-delegation.contract.js';
import { parseRetainedReadContext, retainedReadObject, retainedReadSnapshot,
  assertRetainedReadSelectors } from '../retained-read-context.js';
import { parsePassiveMemoryWire, readPassiveMemorySource } from './meri-passive-memory-source.js';

type MemoryReader = Pick<import('../meri-tools.service.js').MeriToolsService, 'executeFromAuthenticatedUser'>;
const denied = () => new ForbiddenException('Passive memory page refused');

/** The canonical search owner enforces current governed-memory access. Meri
 * separately checks current eligibility of the exact returned page before use. */
export async function readPassiveMemoryPage(ctx: TenantContext, raw: unknown,
  correlation: unknown, verifiedServiceIdentity: boolean, deadlineMs: number,
  tools: MemoryReader, now: () => number = Date.now): Promise<unknown> {
  const context = parseRetainedReadContext(ctx, correlation, verifiedServiceIdentity);
  const normalized = retainedReadObject(context.normalizationContext, ['tenantId', 'userId']);
  if (normalized.tenantId !== ctx.tenantId || normalized.userId !== ctx.userId ||
      !Number.isSafeInteger(deadlineMs) || now() >= deadlineMs) throw denied();
  const wire = parsePassiveMemoryWire(raw);
  assertRetainedReadSelectors(wire.input, context);
  const source = await readPassiveMemorySource(ctx, wire, tools);
  // The trusted owner returns internal records (Dates and optional undefined
  // fields). Snapshot their ordinary HTTP JSON representation, not JS objects.
  let result: unknown;
  try {
    result = retainedReadSnapshot(JSON.parse(JSON.stringify(source)), 1_048_576);
  } catch { throw denied(); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw denied();
  const page = result as Record<string, unknown>;
  if (!(page.error === 'Provide a search query.' && Object.keys(page).length === 1)) {
    if (page.tool !== 'search_memory' || !Array.isArray(page.records) || page.records.length > 3) throw denied();
    const seen = new Set<string>();
    for (const item of page.records) {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          !isUuid(item.recordId) || seen.has(item.recordId)) throw denied();
      seen.add(item.recordId);
    }
  }
  if (now() >= deadlineMs) throw denied();
  return result;
}
