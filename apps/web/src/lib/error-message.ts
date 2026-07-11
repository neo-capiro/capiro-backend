/**
 * Extract the most useful human message from an API/network error (W4.4).
 * Prefers the SERVER's response body — a NestJS error is `{ message: string |
 * string[], statusCode }`, so a 404/503 carries a real reason there — and only
 * falls back to axios's generic `err.message` ("Request failed with status code
 * 503") when the body has nothing. Duck-typed (no hard axios dependency) so it
 * works for any thrown value. Used by the district-brief composer + the
 * facilities editor so both surface the actual server message, not a generic one.
 */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  const anyErr = err as {
    response?: { data?: unknown };
    message?: unknown;
  };
  const data = anyErr?.response?.data;
  if (typeof data === 'string' && data.trim()) return data.trim();
  if (data && typeof data === 'object') {
    const rec = data as { message?: unknown; error?: unknown };
    const m = rec.message ?? rec.error;
    if (typeof m === 'string' && m.trim()) return m.trim();
    // NestJS validation errors arrive as a string[].
    if (Array.isArray(m) && m.length && m.every((x) => typeof x === 'string')) {
      return (m as string[]).join('; ');
    }
  }
  if (typeof anyErr?.message === 'string' && anyErr.message.trim()) return anyErr.message.trim();
  return fallback;
}
