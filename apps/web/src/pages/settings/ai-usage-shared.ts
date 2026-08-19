/**
 * UI-free AI-usage helpers — extracted from AiUsagePage.tsx (antd) so the
 * vNext Settings module shares them (extraction pattern, purge Phase 2).
 * AiUsagePage re-exports; its public API is unchanged.
 */

/** Surface the API's message (e.g. a validation error) from an axios error. */
export function apiErrorMessage(err: unknown): string {
  const data = (err as { response?: { data?: { message?: string | string[] } } })?.response?.data;
  if (data?.message) return Array.isArray(data.message) ? data.message.join('; ') : data.message;
  return err instanceof Error ? err.message : 'Request failed';
}
