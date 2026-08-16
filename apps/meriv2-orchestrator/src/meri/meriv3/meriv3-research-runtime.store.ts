import { AsyncLocalStorage } from 'node:async_hooks';

export interface MeriV3ResearchRuntimeConfig {
  forcedFirstTool: string;
  criticInstructions: string;
  synthesisInstructions: string;
}

export interface MeriV3ResearchRuntimeState extends MeriV3ResearchRuntimeConfig {
  firstToolConsumed: boolean;
  finalizationConsumed: boolean;
}

/**
 * Request-local controls for the comprehensive Research Director workflow.
 *
 * The browser cannot set these values. MeriV3RetrievalAssistantService creates
 * the state only after deterministic server-side classification. The Responses
 * client consumes it to force the first high-level recipe and to run a hidden
 * critic + artifact-quality synthesis after research completes.
 */
export class MeriV3ResearchRuntimeStore {
  private static readonly storage = new AsyncLocalStorage<MeriV3ResearchRuntimeState>();

  static run<T>(config: MeriV3ResearchRuntimeConfig, fn: () => T): T {
    return this.storage.run(
      {
        ...config,
        firstToolConsumed: false,
        finalizationConsumed: false,
      },
      fn,
    );
  }

  static current(): Readonly<MeriV3ResearchRuntimeState> | undefined {
    return this.storage.getStore();
  }

  static consumeForcedFirstTool(): string | null {
    const state = this.storage.getStore();
    if (!state || state.firstToolConsumed) return null;
    state.firstToolConsumed = true;
    return state.forcedFirstTool;
  }

  static beginFinalization(): MeriV3ResearchRuntimeConfig | null {
    const state = this.storage.getStore();
    if (!state || state.finalizationConsumed) return null;
    state.finalizationConsumed = true;
    return {
      forcedFirstTool: state.forcedFirstTool,
      criticInstructions: state.criticInstructions,
      synthesisInstructions: state.synthesisInstructions,
    };
  }
}
