export interface HearingVideoReference {
  url: string;
  providerHint?: string;
}

export function normalizeOfficialUrl(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || /^(?:javascript|data):/i.test(normalized)) return undefined;
  return normalized;
}
