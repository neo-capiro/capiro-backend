import { describe, expect, it } from 'vitest';
import { meriRuntimeStatus, meriRuntimeStatusText } from './meri-runtime-status.js';

describe('Meri runtime status', () => {
  it('keeps the selected mode separate from provider effort on live and reloaded turns', () => {
    const value = {
      reasoningMode: 'max',
      telemetry: {
        requestedReasoningEffort: 'max',
        effectiveReasoningEffort: 'high',
        reasoningFallbackReasons: ['max_unsupported'],
        partial: false,
      },
    };
    const status = meriRuntimeStatus(value);
    expect(status).toMatchObject({
      requestedEffort: 'max',
      effectiveEffort: 'high',
      adjusted: true,
    });
    expect(meriRuntimeStatusText(status)).toContain('Final effort: high');
  });
  it('does not claim omitted reasoning was Max', () => {
    const status = meriRuntimeStatus({
      telemetry: {
        requestedReasoningEffort: 'max',
        effectiveReasoningEffort: null,
        reasoningFallbackReasons: ['reasoning_unsupported'],
      },
    });
    expect(meriRuntimeStatusText(status)).toContain('not confirmed');
  });
  it('shows cancelled and interrupted partial responses without exposing provider errors', () => {
    expect(
      meriRuntimeStatusText(meriRuntimeStatus({ partial: true, finishReason: 'aborted' })),
    ).toBe('Stopped. This response is partial.');
    expect(
      meriRuntimeStatusText(
        meriRuntimeStatus({ partial: true, finishReason: 'internal-secret-error' }),
      ),
    ).toBe('This response is incomplete.');
  });
  it('does not invent runtime facts for legacy messages or show warnings for unchanged effort', () => {
    expect(meriRuntimeStatus({ reasoningMode: 'max' })).toBeUndefined();
    expect(
      meriRuntimeStatusText(
        meriRuntimeStatus({
          telemetry: {
            requestedReasoningEffort: 'max',
            effectiveReasoningEffort: 'max',
            reasoningFallbackReasons: [],
            partial: false,
          },
        }),
      ),
    ).toBeNull();
  });
});
