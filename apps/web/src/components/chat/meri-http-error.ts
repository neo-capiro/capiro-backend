export const MERI_PROVIDER_CONFIGURATION_ERROR = 'MERI_PROVIDER_CONFIGURATION_ERROR';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Turn a failed `/stream` HTTP body into a user-visible sentence.
 * Nest's generic `{"statusCode":500,"message":"Internal server error"}` must
 * never be shown verbatim; a classified backend code should surface its
 * message instead of the raw JSON blob.
 */
export function formatMeriHttpError(status: number, body: string, statusText = ''): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return `Meri could not start this turn (HTTP ${status}${statusText ? `: ${statusText}` : ''}).`;
  }

  try {
    const parsed = asRecord(JSON.parse(trimmed) as unknown);
    if (parsed) {
      const code = typeof parsed.code === 'string' ? parsed.code : null;
      const rawMessage = parsed.message;
      const message =
        typeof rawMessage === 'string'
          ? rawMessage
          : Array.isArray(rawMessage)
            ? rawMessage.filter((item): item is string => typeof item === 'string').join('; ')
            : null;

      if (code === MERI_PROVIDER_CONFIGURATION_ERROR) {
        return (
          message || 'Meri is missing a usable AI provider configuration for this tenant.'
        );
      }
      if (message && !/^internal server error$/i.test(message)) {
        return code ? `${message} (${code})` : message;
      }
      if (code) return `Meri could not start this turn (${code}).`;
      return `Meri could not start this turn (HTTP ${status}).`;
    }
  } catch {
    /* not JSON — fall through */
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return `Meri could not start this turn (HTTP ${status}).`;
  }
  return `Error ${status}: ${trimmed}`;
}
