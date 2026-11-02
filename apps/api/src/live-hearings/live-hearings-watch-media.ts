import {
  strictOfficialSourceUrl,
  type BrowserSourceCandidate,
} from './live-hearings-browser-source.js';

export interface OfficialWatchMedia {
  url: string;
  type: 'video/mp4' | 'video/webm' | 'application/vnd.apple.mpegurl';
  officialPageUrl: string;
  expiresAt: string | null;
}

/** Read-only public watch projection. Never used as a capture/grant identity.
 * Only already approved, resolved, unsigned media is exposed; restricted,
 * expiring signed or unsupported sources keep their official-page fallback.
 */
export function selectOfficialWatchMedia(
  visibility: string,
  candidates: Array<
    BrowserSourceCandidate & { mediaType?: string | null; resolutionState: string }
  >,
  now = new Date(),
): OfficialWatchMedia | null {
  if (visibility !== 'public') return null;
  for (const candidate of candidates) {
    if (
      !['SERVER_CAPTURE_ALLOWED', 'BROWSER_CAPTURE_ONLY'].includes(candidate.capturePolicy) ||
      !['READY', 'LIVE', 'ENDED'].includes(candidate.resolutionState)
    )
      continue;
    const expiresAt = candidate.expiresAt == null ? null : new Date(candidate.expiresAt);
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now)) continue;
    const officialPageUrl = strictOfficialSourceUrl(
      candidate.officialPageUrl,
      candidate.provider,
    );
    if (!officialPageUrl || !candidate.mediaUrl) continue;
    try {
      const url = new URL(candidate.mediaUrl);
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        // Unknown query/fragment keys can carry publisher authorization too.
        url.search ||
        url.hash ||
        !host.includes('.') ||
        host.includes(':') ||
        /^[\d.]+$/.test(host) ||
        /(^|\.)(localhost|local|internal|lan|home|home\.arpa|test|invalid)$/.test(host)
      )
        continue;
      const extension = url.pathname.toLowerCase().split('.').at(-1);
      const type =
        extension === 'mp4'
          ? 'video/mp4'
          : extension === 'webm'
            ? 'video/webm'
            : extension === 'm3u8'
              ? 'application/vnd.apple.mpegurl'
              : null;
      if (!type) continue;
      return {
        url: url.href,
        type,
        officialPageUrl,
        expiresAt: expiresAt?.toISOString() ?? null,
      };
    } catch {
      /* An invalid candidate never removes the stable page fallback. */
    }
  }
  return null;
}
