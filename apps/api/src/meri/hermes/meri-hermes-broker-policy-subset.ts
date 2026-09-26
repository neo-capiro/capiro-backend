/**
 * Phase 4 contract only. A caller must first authenticate and compile the
 * request-local worker view. No application path supplies one today.
 *
 * This is an exhaustive mapping of Meri's *known broker endpoints*, not a
 * claim that these names enumerate the worker's native tool catalog.
 */
import {
  MERI_HERMES_BROKER_TOOLS,
  type MeriHermesBrokerTool,
  type MeriHermesToolPolicy,
} from './hermes-runtime.contracts.js';
import { isCompiledMeriHermesToolViewV1, type MeriHermesToolViewV1 } from './meri-hermes-tool-view.js';

const BROKER_WORKER_TOOL_NAMES: Readonly<Record<MeriHermesBrokerTool, string | null>> = {
  meri_memory_search: 'meri_memory_search',
  meri_memory_propose: 'meri_memory_propose',
  meri_fetch_attachment: 'meri_fetch_attachment',
  meri_publish_artifact: 'meri_publish_artifact',
  meri_request_clarification: 'meri_request_clarification',
  // POST /turns is broker bookkeeping; there is no registered worker schema.
  meri_record_turn: null,
};

export class MeriHermesBrokerPolicySubsetError extends Error {
  constructor(readonly code: 'invalid_tool_view' | 'unmapped_meri_tool') {
    super(code);
  }
}

/**
 * Derive a broker ceiling from the selected worker view. Unknown Meri names
 * fail closed; unrelated native Hermes names do not imply broker access.
 */
export function brokerPolicySubsetForToolView(
  view: MeriHermesToolViewV1,
): MeriHermesToolPolicy {
  if (!isCompiledMeriHermesToolViewV1(view)) {
    throw new MeriHermesBrokerPolicySubsetError('invalid_tool_view');
  }
  const selected = new Set(view.toolNames);
  const knownMeriNames = new Set<string>(
    MERI_HERMES_BROKER_TOOLS.flatMap((name) => {
      const workerName = BROKER_WORKER_TOOL_NAMES[name];
      return workerName ? [workerName] : [];
    }),
  );
  for (const name of selected) {
    if (name.startsWith('meri_') && !knownMeriNames.has(name)) {
      throw new MeriHermesBrokerPolicySubsetError('unmapped_meri_tool');
    }
  }

  return {
    allow: MERI_HERMES_BROKER_TOOLS.filter((brokerTool) => {
      const workerName = BROKER_WORKER_TOOL_NAMES[brokerTool];
      return workerName !== null && selected.has(workerName);
    }),
    deny: [],
    readOnly: false,
  };
}
