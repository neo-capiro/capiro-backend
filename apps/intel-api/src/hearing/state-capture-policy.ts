/** Stable denial surfaced whenever a state proceeding reaches a capture boundary. */
export const STATE_CAPTURE_LINK_ONLY = 'STATE_CAPTURE_LINK_ONLY';

/** Shared truthy parse for LEGIWATCH_* runtime switches. */
export function isEnabledFlagValue(value: string | null | undefined): boolean {
  return ['1', 'true', 'on', 'enabled', 'yes'].includes((value ?? '').trim().toLowerCase());
}

/**
 * State (Florida) server capture switch, read per call so it can be toggled at
 * runtime and in specs. Off (default) keeps every state boundary fail-closed.
 */
export const stateCaptureEnabled = () =>
  isEnabledFlagValue(process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED);

/** Capture-eligible canonical hearings: federal only until state server capture is enabled. */
export const capturableHearingView = () =>
  stateCaptureEnabled() ? 'capturable_committee_hearing' : 'federal_committee_hearing';

/**
 * Florida proceedings stay link-only until Capiro has a separately reviewed
 * publisher agreement and a source-specific capture implementation.
 */
export function isFloridaStatePublisherUrl(value: string | null | undefined): boolean {
  const raw = value?.trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    // This is a denial detector, not a URL-safety validator: a malformed capture
    // source on an official Florida publisher host must still be recognized as
    // state traffic and blocked. The capture resolver applies its own stricter
    // canonical URL validation after this boundary.
    const host = url.hostname.toLowerCase();
    return (
      host === 'flsenate.gov' ||
      host.endsWith('.flsenate.gov') ||
      host === 'flhouse.gov' ||
      host.endsWith('.flhouse.gov') ||
      host === 'thefloridachannel.org' ||
      host.endsWith('.thefloridachannel.org')
    );
  } catch {
    return false;
  }
}
