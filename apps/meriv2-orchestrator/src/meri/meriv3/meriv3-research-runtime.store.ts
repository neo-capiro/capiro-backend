import { AsyncLocalStorage } from 'node:async_hooks';
import {
  appendScheduleCorrections,
  collectScheduleDeadlines,
  renderScheduleConstraints,
  type ScheduleDeadlineFact,
} from '@capiro/shared';

export interface MeriV3ResearchRuntimeConfig {
  forcedFirstTool: string;
  criticInstructions: string;
  synthesisInstructions: string;
  scheduleMode?: 'off' | 'shadow' | 'enforce';
  asOf?: string;
}

export interface MeriV3ResearchRuntimeState extends MeriV3ResearchRuntimeConfig {
  firstToolConsumed: boolean;
  finalizationConsumed: boolean;
  scheduleDeadlines: ScheduleDeadlineFact[];
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
        scheduleDeadlines: [],
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
    const block = renderScheduleConstraints(
      state.asOf ?? new Date().toISOString(),
      state.scheduleDeadlines,
    );
    if (state.scheduleMode === 'shadow' && block) {
      console.warn(
        JSON.stringify({
          event: 'meri.evidence_accuracy.shadow',
          scheduleConstraints: block.slice(0, 2000),
        }),
      );
    }
    return {
      forcedFirstTool: state.forcedFirstTool,
      criticInstructions: state.criticInstructions,
      synthesisInstructions:
        state.scheduleMode === 'enforce' && block
          ? `${state.synthesisInstructions}\n\n${block}`
          : state.synthesisInstructions,
      scheduleMode: state.scheduleMode,
      asOf: state.asOf,
    };
  }

  static observeToolResult(result: unknown): void {
    const state = this.storage.getStore();
    if (!state || state.scheduleMode === 'off') return;
    const merged = [...state.scheduleDeadlines, ...collectScheduleDeadlines(result)];
    state.scheduleDeadlines = [...new Map(merged.map((fact) => [fact.id, fact])).values()];
  }

  static validateDraft(text: string): { text: string; issueCount: number } {
    const state = this.storage.getStore();
    if (!state || state.scheduleMode !== 'enforce') return { text, issueCount: 0 };
    const corrected = appendScheduleCorrections({
      text,
      asOf: state.asOf ?? new Date().toISOString(),
      deadlines: state.scheduleDeadlines,
    });
    return { text: corrected.text, issueCount: corrected.issues.length };
  }
}
