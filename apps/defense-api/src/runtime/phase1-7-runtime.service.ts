import { Injectable } from '@nestjs/common';
import {
  Phase17RuntimeCoordinator,
  type Phase17RunInput,
  type Phase17RunResult,
  type Phase17RuntimePorts,
} from './phase1-7-runtime.contract.js';
import {
  createPhase17RuntimeAdapters,
  type Phase17RuntimeRoot,
} from './phase1-7-runtime.adapters.js';
import {
  PHASE17_RUNTIME_MANIFEST,
  type Phase17RuntimeManifest,
} from './phase1-7-runtime.manifest.js';

@Injectable()
export class Phase17RuntimeRegistryService {
  manifest(): Phase17RuntimeManifest {
    return PHASE17_RUNTIME_MANIFEST;
  }

  /**
   * Build inspect-only ports bound to the moved runtime-source tree by default.
   * HTTP surface must not gain promotion execution or parser-worker credentials
   * through this registry — adapters are fixture/hash only.
   */
  createProductionEquivalentPorts(
    root: Phase17RuntimeRoot = 'moved',
    repoRoot?: string,
  ): Phase17RuntimePorts {
    return createPhase17RuntimeAdapters({ root, repoRoot });
  }

  createInspectOnlyCoordinator(ports?: Phase17RuntimePorts): Phase17RuntimeCoordinator {
    return new Phase17RuntimeCoordinator(ports ?? this.createProductionEquivalentPorts());
  }

  /** Convenience inspect entry used by dual-path replay / operator tooling. */
  async inspect(
    input: Phase17RunInput,
    root: Phase17RuntimeRoot = 'moved',
  ): Promise<Phase17RunResult> {
    return this.createInspectOnlyCoordinator(this.createProductionEquivalentPorts(root)).inspect(
      input,
    );
  }
}
