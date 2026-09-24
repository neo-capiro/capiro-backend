/** Canonical lifecycle metadata seam for account-scoped budget documents. */
export const APPROPRIATION_ACCOUNT_METADATA_KEY_V1 = 'appropriationAccount' as const;

export function readAppropriationAccountMetadataV1(metadata: unknown): string | undefined {
  if (metadata == null || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>)[APPROPRIATION_ACCOUNT_METADATA_KEY_V1];
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `SourceDocument metadata.${APPROPRIATION_ACCOUNT_METADATA_KEY_V1} must be a nonblank string when present`,
    );
  }
  return value.trim();
}

export function appropriationAccountMetadataV1(
  account: string | null | undefined,
): Record<string, string> {
  const normalized = account?.trim();
  return normalized ? { [APPROPRIATION_ACCOUNT_METADATA_KEY_V1]: normalized } : {};
}
