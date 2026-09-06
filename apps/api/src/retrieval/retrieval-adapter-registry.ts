import type { RetrievalSourceAdapter } from './retrieval-source.adapter.js';
import type { SemanticDatasetDescriptor } from './retrieval-v2.types.js';

/** A catalog entry is deployable only when exactly one registered reader owns it. */
export function validateRetrievalAdapterRegistry(
  datasets: readonly SemanticDatasetDescriptor[],
  adapters: readonly RetrievalSourceAdapter[],
): readonly RetrievalSourceAdapter[] {
  const keys = new Set<string>();
  for (const adapter of adapters) {
    if (keys.has(adapter.key)) throw new Error(`Duplicate retrieval adapter key: ${adapter.key}`);
    if (typeof adapter.retrieve !== 'function') throw new Error(`Retrieval adapter has no callable reader: ${adapter.key}`);
    keys.add(adapter.key);
    for (const domain of adapter.domains) {
      if (!datasets.some((dataset) => dataset.domain === domain && dataset.adapterKey === adapter.key)) {
        throw new Error(`Retrieval adapter advertises uncataloged domain: ${adapter.key}/${domain}`);
      }
    }
  }
  for (const dataset of datasets) {
    const owners = adapters.filter((adapter) => adapter.domains.includes(dataset.domain));
    if (owners.length !== 1 || owners[0]!.key !== dataset.adapterKey) {
      throw new Error(`Retrieval catalog has no unique registered reader: ${dataset.domain}/${dataset.adapterKey}`);
    }
  }
  return adapters;
}
