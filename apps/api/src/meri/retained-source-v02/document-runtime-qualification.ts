import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { canonicalSha256, isSha } from '../../auth/read-delegation/read-delegation.contract.js';
import { DOCUMENT_TEXT_ONLY_ROUTE, type DocumentTextOnlyAllocation } from '../../auth/read-delegation/read-delegation-document-pricing.js';

/** Deliberately unregistered by default. A deployment owner must implement this
 * using independent current image/effective-configuration readback. Environment
 * declarations, release headers, OCI labels and Meri assertions are insufficient.
 * Every call must collect current provenance again; never return cached evidence
 * as a fresh observation. This reader grants no task or allocation authority. */
export abstract class RetainedDocumentRuntimeIdentityReader {
  abstract readCurrent(): Promise<unknown>;
}

export interface RetainedDocumentRuntimeIdentity {
  sourceHead: string;
  imageDigest: string;
  configurationSha256: string;
}
function refuse(): never { throw new Error('Current retained document runtime qualification unavailable'); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Expected pricing comes ONLY from Core's locked original ADMITTED allocation.
 * The separate runtime reader supplies independently measured current provenance.
 * Returning a digest permits a second fresh observation before source release. */
export function qualifyDocumentTextOnlyRuntime(expected: DocumentTextOnlyAllocation | null | undefined,
  current: unknown): string {
  let allocation: unknown, runtime: unknown;
  try {
    allocation = JSON.parse(canonicalizeCoreRetainedJson(expected));
    runtime = JSON.parse(canonicalizeCoreRetainedJson(current));
  } catch { refuse(); }
  if (!exact(allocation, ['allocationSha256', 'profileVersion', 'chargeMicrousd', 'documentPricing']) ||
      !isSha(allocation.allocationSha256) || allocation.profileVersion !== '1.1.0' || allocation.chargeMicrousd !== 1 ||
      !exact(runtime, ['sourceHead', 'imageDigest', 'configurationSha256'])) refuse();
  const pricing = allocation.documentPricing;
  if (!exact(pricing, ['mode', 'route', 'coreSourceCommit', 'coreImageDigest', 'configurationSha256']) ||
      pricing.mode !== 'source_text_only' || pricing.route !== DOCUMENT_TEXT_ONLY_ROUTE ||
      typeof pricing.coreSourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(pricing.coreSourceCommit) ||
      typeof pricing.coreImageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(pricing.coreImageDigest) ||
      !isSha(pricing.configurationSha256) ||
      runtime.sourceHead !== pricing.coreSourceCommit || runtime.imageDigest !== pricing.coreImageDigest ||
      runtime.configurationSha256 !== pricing.configurationSha256) refuse();
  return canonicalSha256({ allocation, runtime });
}
