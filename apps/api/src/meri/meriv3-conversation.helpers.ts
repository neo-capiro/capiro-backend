export const MERIV3_REASONING_MODES = ['fast', 'standard', 'deep', 'max'] as const;
export type MeriV3ReasoningMode = (typeof MERIV3_REASONING_MODES)[number];

export function normalizeMeriV3ReasoningMode(value: unknown): MeriV3ReasoningMode {
  return typeof value === 'string' && (MERIV3_REASONING_MODES as readonly string[]).includes(value)
    ? (value as MeriV3ReasoningMode)
    : 'standard';
}

export function reasoningModeFromConversationMetadata(metadata: unknown): MeriV3ReasoningMode {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'standard';
  const meriv3 = (metadata as Record<string, unknown>).meriv3;
  if (!meriv3 || typeof meriv3 !== 'object' || Array.isArray(meriv3)) return 'standard';
  return normalizeMeriV3ReasoningMode((meriv3 as Record<string, unknown>).reasoningMode);
}

export function withMeriV3ReasoningMode(
  metadata: unknown,
  reasoningMode: MeriV3ReasoningMode,
): Record<string, unknown> {
  const root =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  const current =
    root.meriv3 && typeof root.meriv3 === 'object' && !Array.isArray(root.meriv3)
      ? (root.meriv3 as Record<string, unknown>)
      : {};
  return {
    ...root,
    meriv3: {
      ...current,
      reasoningMode,
    },
  };
}
