/** Stable denial surfaced whenever a state proceeding reaches a capture boundary. */
export const STATE_CAPTURE_LINK_ONLY = 'STATE_CAPTURE_LINK_ONLY';

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
