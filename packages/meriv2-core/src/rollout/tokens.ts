export function parseRolloutTokens(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(/[,\s]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
}
