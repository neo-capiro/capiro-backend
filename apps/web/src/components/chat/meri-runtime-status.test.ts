import { describe, expect, it } from 'vitest';
import {
  meriRuntimeMessageContent,
  meriRuntimeStatus,
  meriRuntimeStatusText,
} from './meri-runtime-status.js';

describe('Meri runtime status', () => {
  it('keeps the selected mode separate from provider effort on live and reloaded turns', () => {
    const value = {
      reasoningMode: 'max',
      telemetry: {
        requestedModel: 'requested-model',
        effectiveModel: 'served-model',
        requestedReasoningEffort: 'max',
        effectiveReasoningEffort: 'high',
        reasoningFallbackReasons: ['max_unsupported'],
        partial: false,
      },
    };
    const status = meriRuntimeStatus(value);
    expect(status).toMatchObject({
      selectedMode: 'max',
      requestedModel: 'requested-model',
      effectiveModel: 'served-model',
      fallbackReasons: ['The provider does not support Max effort.'],
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
    expect(meriRuntimeStatus({ tier: 'deep' })).toBeUndefined();
    expect(meriRuntimeStatus({ reasoningMode: 'standard', tier: 'deep' })).toMatchObject({
      selectedMode: 'standard',
      effectiveEffort: null,
    });
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
  it('retains an explicit provider omission and hides unrecognized fallback error details', () => {
    const status = meriRuntimeStatus({
      reasoningMode: 'max',
      telemetry: {
        requestedModel: 'model-a',
        effectiveModel: 'model-a',
        requestedReasoningEffort: 'max',
        effectiveReasoningEffort: null,
        reasoningFallbackReasons: [
          'reasoning_parameter_unsupported',
          'private provider error content',
        ],
      },
    });
    expect(status).toMatchObject({ selectedMode: 'max', effectiveEffort: null, adjusted: true });
    expect(status?.fallbackReasons).toContain(
      'The provider does not accept an explicit reasoning effort.',
    );
    expect(JSON.stringify(status)).not.toContain('private provider error content');
  });
  it('replaces only the old generic placeholder for a saved stopped turn', () => {
    const legacy = 'MeriV3 could not complete this turn. Please try again.';
    const stopped = meriRuntimeStatus({ partial: true, finishReason: 'aborted' });
    expect(meriRuntimeMessageContent(legacy, stopped)).toBe(
      'Stopped before an answer was generated.',
    );
    expect(meriRuntimeMessageContent('The source could not be loaded.', stopped)).toBe(
      'The source could not be loaded.',
    );
    expect(
      meriRuntimeMessageContent(
        legacy,
        meriRuntimeStatus({ partial: true, finishReason: 'error' }),
      ),
    ).toBe(legacy);
  });
});
