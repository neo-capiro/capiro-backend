import { randomUUID } from 'node:crypto';
import { contextStageTimer, type ContextStage } from '../context/context-stage-timer.service.js';

const stageNotes: Record<ContextStage, string> = {
  resolver: 'Checking the client and information you can access.',
  retrieval: 'Retrieving authorized client information and evidence.',
  compile: 'Preparing the retrieved information for Meri.',
  persistence: 'Saving the source record for this response.',
  provider: 'Waiting for the LLM provider’s response.',
};

/** Observes real stages and stream frames. It never plans, retrieves, or invents tool work. */
export async function withMeriTurnProgress<T>(
  writer: { write(data: string): void },
  signal: AbortSignal | undefined,
  execute: (writer: { write(data: string): void }) => Promise<T>,
): Promise<T> {
  const runId = randomUUID();
  const startedAt = Date.now();
  let phase = 'preparing';
  let note = 'Checking this conversation before preparing a response.';
  let accepted = false;
  let finished = false;
  let visible = false;
  const stages: ContextStage[] = [];
  const tools: string[] = [];
  const progress = () => {
    if (finished || signal?.aborted) return;
    visible = true;
    try {
      writer.write(
        `data: ${JSON.stringify({
          type: 'progress',
          runId,
          phase,
          note,
          elapsedMs: Date.now() - startedAt,
          ...(!accepted ? { accepted: false } : {}),
        })}\n\n`,
      );
    } catch {
      // Progress is best effort. A closed socket must not throw from a timer
      // callback or replace a canonical stage's result with a display failure.
      stop();
    }
  };
  const setStage = (nextPhase: string, nextNote: string) => {
    phase = nextPhase;
    note = nextNote;
    if (visible) progress();
  };
  // Keep ordinary fast setup failures as classified JSON. Longer preparation
  // opens SSE with an explicitly unaccepted progress frame, never a fake start.
  const initial = setTimeout(progress, 1_000);
  const heartbeat = setInterval(progress, 5_000);
  const stop = () => {
    finished = true;
    clearTimeout(initial);
    clearInterval(heartbeat);
  };
  signal?.addEventListener('abort', stop, { once: true });
  const observedWriter = {
    write(data: string) {
      writer.write(data);
      for (const line of data.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (event.type === 'turn_accepted') {
          accepted = true;
          setStage('preparing', 'Your message is saved. Preparing Meri’s response.');
        } else if (event.type === 'start') {
          accepted = true;
          setStage('runtime', 'Waiting for Meri’s reasoning runtime.');
        } else if (event.type === 'runtime') {
          // Final provider telemetry follows the released answer too. It is
          // not evidence of another provider call while the API saves it.
          if (phase === 'answer') setStage('answer', 'Finishing the response.');
          else setStage('provider', stageNotes.provider);
        } else if (event.type === 'tool_call') {
          tools.push(String(event.tool ?? 'tool'));
          setStage('tools', 'Running the requested tools and checking their results.');
        } else if (event.type === 'sources') {
          const sources = Array.isArray(event.sources) ? event.sources : [];
          for (const source of sources) {
            const index = tools.indexOf(String(source?.tool ?? ''));
            if (index >= 0) tools.splice(index, 1);
          }
          if (!tools.length)
            setStage('provider', 'Waiting for Meri to continue from the tool results.');
        } else if (event.type === 'text') {
          setStage('answer', 'Receiving the response.');
        } else if (event.type === 'done' || event.type === 'error') {
          stop();
        }
      }
    },
  };
  try {
    signal?.throwIfAborted();
    return await contextStageTimer.observe(
      (stage, active) => {
        if (active) stages.push(stage);
        else {
          const index = stages.lastIndexOf(stage);
          if (index >= 0) stages.splice(index, 1);
        }
        const current = stages.at(-1);
        setStage(
          current ?? 'preparing',
          current ? stageNotes[current] : 'Preparing Meri’s response.',
        );
      },
      () => execute(observedWriter),
    );
  } finally {
    stop();
    signal?.removeEventListener('abort', stop);
  }
}
