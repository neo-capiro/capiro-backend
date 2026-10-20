import { canonicalSha256, isSha } from './read-delegation.contract.js';

/** Exact immutable Meri PR162 tariff contract. No caller-controlled mode. */
export const MERI_DOCUMENT_TEXT_ONLY_SOURCE = 'dee9ac55546d9a59dc6bba79cd4fc2cbba869000';
export const DOCUMENT_TEXT_ONLY_ROUTE = '/api/clio/tools/read_client_documents';
export interface DocumentTextOnlyPricing {
  mode: 'source_text_only';
  route: typeof DOCUMENT_TEXT_ONLY_ROUTE;
  coreSourceCommit: string;
  coreImageDigest: string;
  configurationSha256: string;
}
export interface DocumentTextOnlyAllocation {
  allocationSha256: string;
  profileVersion: '1.1.0';
  chargeMicrousd: 1;
  documentPricing: DocumentTextOnlyPricing;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
const documentOperation = (value: unknown) => exact(value, ['id', 'version']) &&
  value.id === 'read_client_documents' && value.version === '0.2.0';

/** The caller supplies ONLY the original allocation already verified under
 * readMeriAdmittedRun's budget lock. Incompatible or absent document pricing
 * leaves documents unavailable without changing other read family admission. */
export function readDocumentTextOnlyAllocation(raw: unknown, allocationSha256: string): DocumentTextOnlyAllocation | null {
  try {
    if (!record(raw) || !isSha(allocationSha256) || canonicalSha256(raw) !== allocationSha256 ||
        !record(raw.manifest) || raw.manifest.contractVersion !== '0.2.0' ||
        raw.manifest.profile !== 'meri.general_reads' || raw.manifest.profileVersion !== '1.1.0' ||
        !['contractVersion', 'profile', 'profileVersion', 'allowedOperations', 'budgets', 'maxAggregateOutputBytes', 'documentPricing']
          .every((key) => Object.hasOwn(raw.manifest as object, key)) ||
        Object.keys(raw.manifest).some((key) => !['contractVersion', 'profile', 'profileVersion', 'allowedOperations',
          'budgets', 'maxAggregateOutputBytes', 'documentPricing', 'tariffAssumptions'].includes(key)) ||
        !record(raw.budgets) || canonicalSha256(raw.manifest.budgets) !== canonicalSha256(raw.budgets) ||
        !isSha(raw.manifestSha256) || canonicalSha256(raw.manifest) !== raw.manifestSha256 ||
        !Array.isArray(raw.manifest.allowedOperations) ||
        raw.manifest.allowedOperations.filter(documentOperation).length !== 1 ||
        !record(raw.schedule) || !Array.isArray(raw.schedule.operations)) return null;
    const charges = raw.schedule.operations.filter((item) => record(item) && documentOperation(item.operation));
    if (charges.length !== 1 || !exact(charges[0], ['operation', 'chargeMicrousd']) ||
        charges[0].chargeMicrousd !== 1) return null;
    const pricing = raw.manifest.documentPricing;
    if (!exact(pricing, ['mode', 'route', 'coreSourceCommit', 'coreImageDigest', 'configurationSha256']) ||
        pricing.mode !== 'source_text_only' || pricing.route !== DOCUMENT_TEXT_ONLY_ROUTE ||
        typeof pricing.coreSourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(pricing.coreSourceCommit) ||
        typeof pricing.coreImageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(pricing.coreImageDigest) ||
        !isSha(pricing.configurationSha256)) return null;
    return Object.freeze({ allocationSha256, profileVersion: '1.1.0', chargeMicrousd: 1,
      documentPricing: Object.freeze({ ...pricing }) as unknown as DocumentTextOnlyPricing });
  } catch { return null; }
}
