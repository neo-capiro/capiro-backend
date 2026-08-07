import {
  normalizeMeriV3ReasoningMode,
  reasoningModeFromConversationMetadata,
  withMeriV3ReasoningMode,
} from './meriv3-conversation.helpers.js';

describe('MeriV3 conversation reasoning metadata', () => {
  test('defaults missing and invalid values to Standard', () => {
    expect(normalizeMeriV3ReasoningMode(undefined)).toBe('standard');
    expect(normalizeMeriV3ReasoningMode('ultra')).toBe('standard');
    expect(reasoningModeFromConversationMetadata(null)).toBe('standard');
    expect(
      reasoningModeFromConversationMetadata({ meriv3: { reasoningMode: 'not-a-mode' } }),
    ).toBe('standard');
  });

  test('reads an allowed mode from the server-owned conversation row', () => {
    expect(
      reasoningModeFromConversationMetadata({ meriv3: { reasoningMode: 'deep' } }),
    ).toBe('deep');
  });

  test('preserves unrelated metadata and MeriV3 keys when changing the mode', () => {
    expect(
      withMeriV3ReasoningMode(
        {
          brand: 'Meri',
          meriv3: { experiment: 'canary-a', reasoningMode: 'fast' },
        },
        'max',
      ),
    ).toEqual({
      brand: 'Meri',
      meriv3: { experiment: 'canary-a', reasoningMode: 'max' },
    });
  });
});
