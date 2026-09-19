/** Return the HTTP status carried by the request libraries used in the app. */
export function httpErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;

  const response = (error as { response?: unknown }).response;
  if (response && typeof response === 'object') {
    const status = (response as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

export function isAuthenticationOrAccessError(error: unknown): boolean {
  const status = httpErrorStatus(error);
  return status === 401 || status === 403;
}

/**
 * Preserve the app's existing single retry for transient failures while never
 * replaying a request the server has definitively rejected for auth/access.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return !isAuthenticationOrAccessError(error) && failureCount < 1;
}
