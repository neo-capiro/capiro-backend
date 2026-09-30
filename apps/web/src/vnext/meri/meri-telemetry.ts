function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Browser telemetry is linkage only. The API creates the authoritative trace,
 * tenant, actor, turn and run identities after authentication.
 */
export function createMeriBrowserTelemetryHeaders(): Record<string, string> {
  const browserRequestId = crypto.randomUUID();
  return {
    'x-capiro-browser-request-id': browserRequestId,
    traceparent: `00-${randomHex(16)}-${randomHex(8)}-01`,
  };
}
